-- ============================================================================
-- Like-for-like sales filters: "without new items" and "without new customers".
--
-- New item     = B2B activation date (stg_soft1_mtrl.cccdateportal) on or after
--                p_new_items_since. The dashboard sends 1 Jan of the COMPARISON
--                year, so 2026 vs 2025 drops everything launched since 1/1/2025
--                from both periods and compares the same range of items.
-- New customer = customer card opened in the ERP (stg_soft1_trdr.inserted_date)
--                on or after p_new_customers_since (the current period's start).
--
-- Every RPC gains both parameters with DEFAULT NULL, and NULL means "no filter",
-- so callers that predate this migration get exactly what they got before.
-- The document-level RPCs keep their original queries untouched on the
-- no-filter path (see 2026-09-26_fix-sales-summary-plan.sql for why the plans
-- matter) and only take the new path when a filter is on.
--
-- Document totals come from FINDOC.NETAMNT, which has no item dimension. With
-- the item filter on, each document keeps the share of its line value that is
-- NOT new items:  netamnt * (1 - new_lineval / total_lineval).  Scaling the
-- header amount rather than summing lines keeps header discounts and the
-- credit-note sign exactly as the unfiltered totals have them.
--
-- Computing that share on the fly took 7.4 s for company-wide 2026 YTD, so it
-- is precomputed per document and activation year in mv_crm_doc_item_years
-- (452k rows, 31 MB, ~20 s to build) and refreshed together with
-- mv_crm_sku_sales by refresh_mv_crm_sku_sales(), which crm-sync already calls
-- after every sync. With the matview the same query takes ~0.9 s.
-- ============================================================================

BEGIN;

SET LOCAL statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- 1. Per-document line value by item activation year (0 = no activation date)
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW public.mv_crm_doc_item_years AS
SELECT l.findoc,
       COALESCE(CASE WHEN m.cccdateportal >= DATE '2000-01-01'
                     THEN EXTRACT(YEAR FROM m.cccdateportal)::smallint END,
                0::smallint) AS act_year,
       SUM(l.netlineval) AS lineval,
       SUM(l.qty)        AS qty
FROM stg_soft1_findoc f
JOIN stg_soft1_mtrlines l ON l.company = f.company AND l.findoc = f.findoc
LEFT JOIN stg_soft1_mtrl m ON m.company = l.company AND m.mtrl = l.mtrl
WHERE f.company = 1000
  AND f.series = ANY (ARRAY[7061, 7062, 7080, 7063, 7064, 9962, 9964, 7067])
GROUP BY 1, 2;

-- Unique index: required for REFRESH ... CONCURRENTLY, and serves the findoc lookups.
CREATE UNIQUE INDEX mv_crm_doc_item_years_uidx
  ON public.mv_crm_doc_item_years (findoc, act_year) INCLUDE (lineval, qty);
-- A matview built inside this transaction has no statistics until autovacuum
-- sees it after COMMIT; without them the first filtered calls plan badly.
ANALYZE public.mv_crm_doc_item_years;

REVOKE ALL ON public.mv_crm_doc_item_years FROM PUBLIC, anon;
GRANT SELECT ON public.mv_crm_doc_item_years TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_crm_sku_sales()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'   -- kept from the live definition; OR REPLACE would drop it
AS $function$
BEGIN
  SET LOCAL statement_timeout = '10min';
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_crm_sku_sales;
  -- Piggybacks here so crm-sync (deployed on the E:\crm machine) needs no change.
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_crm_doc_item_years;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Filtered document source: vw_crm_sales with both filters applied.
--    Same columns as vw_crm_sales, netamnt already reduced by the new-item share.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crm_sales_docs_filtered(
  p_from date,
  p_to date,                         -- inclusive
  p_new_items_since date,
  p_new_customers_since date
)
RETURNS TABLE(trdr text, trndate timestamp, series integer, findoc bigint,
              netamnt numeric, new_item_qty numeric, salesman_code text, trdbranch integer)
LANGUAGE sql
STABLE
AS $function$
  WITH d AS (
    SELECT s.trdr, s.trndate, s.series, s.findoc, s.netamnt, s.salesman_code, s.trdbranch
    FROM vw_crm_sales s
    WHERE s.trndate >= p_from
      AND s.trndate < (p_to + 1)
      AND (p_new_customers_since IS NULL OR NOT EXISTS (
            SELECT 1 FROM stg_soft1_trdr t
            WHERE t.company = 1000
              AND t.trdr_id = s.trdr::integer
              AND t.inserted_date >= p_new_customers_since))
  ),
  sh AS (
    SELECT y.findoc,
           SUM(y.lineval) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since))
             / NULLIF(SUM(y.lineval), 0)                                          AS new_share,
           SUM(y.qty) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since)) AS new_qty
    FROM mv_crm_doc_item_years y
    WHERE p_new_items_since IS NOT NULL
      AND y.findoc IN (SELECT d.findoc FROM d)
    GROUP BY y.findoc
  )
  SELECT d.trdr, d.trndate, d.series, d.findoc,
         d.netamnt * (1 - COALESCE(sh.new_share, 0)),
         COALESCE(sh.new_qty, 0),
         d.salesman_code, d.trdbranch
  FROM d
  LEFT JOIN sh ON sh.findoc = d.findoc;
$function$;

REVOKE ALL ON FUNCTION public.crm_sales_docs_filtered(date, date, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_sales_docs_filtered(date, date, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Document-level RPCs
-- ---------------------------------------------------------------------------
DROP FUNCTION public.get_sales_summary(date, date, text, text);
CREATE FUNCTION public.get_sales_summary(
  p_from date,
  p_to date,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book',
  p_new_items_since date DEFAULT NULL,
  p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(trdr text, total_netamnt numeric, invoice_count bigint)
LANGUAGE plpgsql
SET statement_timeout TO '30s'
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    -- Unfiltered: the original queries, unchanged.
    IF p_mode = 'sales' THEN
      RETURN QUERY
        SELECT s.trdr, SUM(s.netamnt), COUNT(DISTINCT s.findoc)
        FROM vw_crm_sales s
        LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
        WHERE s.trndate >= p_from
          AND s.trndate < (p_to + INTERVAL '1 day')
          AND s.netamnt IS NOT NULL
          AND (p_salesman_code IS NULL
               OR COALESCE(s.salesman_code,
                           CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END) = p_salesman_code)
        GROUP BY s.trdr;
    ELSE
      RETURN QUERY
        SELECT s.trdr, SUM(s.netamnt), COUNT(DISTINCT s.findoc)
        FROM vw_crm_sales s
        WHERE s.trndate >= p_from
          AND s.trndate < (p_to + INTERVAL '1 day')
          AND s.netamnt IS NOT NULL
          AND (p_salesman_code IS NULL OR EXISTS (
                SELECT 1 FROM vw_crm_customers c
                WHERE c.trdr_id = s.trdr::integer
                  AND c.salesman_code = p_salesman_code))
        GROUP BY s.trdr;
    END IF;
  ELSIF p_mode = 'sales' THEN
    RETURN QUERY
      SELECT s.trdr, SUM(s.netamnt), COUNT(DISTINCT s.findoc)
      FROM crm_sales_docs_filtered(p_from, p_to, p_new_items_since, p_new_customers_since) s
      LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
      WHERE s.netamnt IS NOT NULL
        AND (p_salesman_code IS NULL
             OR COALESCE(s.salesman_code,
                         CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END) = p_salesman_code)
      GROUP BY s.trdr;
  ELSE
    RETURN QUERY
      SELECT s.trdr, SUM(s.netamnt), COUNT(DISTINCT s.findoc)
      FROM crm_sales_docs_filtered(p_from, p_to, p_new_items_since, p_new_customers_since) s
      WHERE s.netamnt IS NOT NULL
        AND (p_salesman_code IS NULL OR EXISTS (
              SELECT 1 FROM vw_crm_customers c
              WHERE c.trdr_id = s.trdr::integer
                AND c.salesman_code = p_salesman_code))
      GROUP BY s.trdr;
  END IF;
END;
$function$;

DROP FUNCTION public.get_sales_by_area(date, date, text, text);
CREATE FUNCTION public.get_sales_by_area(
  p_from date,
  p_to date,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book',
  p_new_items_since date DEFAULT NULL,
  p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(area text, total_netamnt numeric, customer_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '30s'
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    RETURN QUERY
      SELECT c.area, SUM(s.netamnt) AS total_netamnt, COUNT(DISTINCT s.trdr) AS customer_count
      FROM vw_crm_sales s
      INNER JOIN vw_crm_customers c ON s.trdr::integer = c.trdr_id
      WHERE s.trndate >= p_from
        AND s.trndate < (p_to + INTERVAL '1 day')
        AND s.netamnt IS NOT NULL
        AND (
          p_salesman_code IS NULL
          OR CASE WHEN p_mode = 'sales'
               THEN COALESCE(s.salesman_code,
                             CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END)
               ELSE c.salesman_code
             END = p_salesman_code
        )
      GROUP BY c.area
      ORDER BY 2 DESC;
  ELSE
    RETURN QUERY
      SELECT c.area, SUM(s.netamnt) AS total_netamnt, COUNT(DISTINCT s.trdr) AS customer_count
      FROM crm_sales_docs_filtered(p_from, p_to, p_new_items_since, p_new_customers_since) s
      INNER JOIN vw_crm_customers c ON s.trdr::integer = c.trdr_id
      WHERE s.netamnt IS NOT NULL
        AND (
          p_salesman_code IS NULL
          OR CASE WHEN p_mode = 'sales'
               THEN COALESCE(s.salesman_code,
                             CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END)
               ELSE c.salesman_code
             END = p_salesman_code
        )
      GROUP BY c.area
      ORDER BY 2 DESC;
  END IF;
END;
$function$;

DROP FUNCTION public.get_sales_by_city(date, date, text, text, text);
CREATE FUNCTION public.get_sales_by_city(
  p_from date,
  p_to date,
  p_area text DEFAULT NULL,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book',
  p_new_items_since date DEFAULT NULL,
  p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(area text, city text, total_netamnt numeric, customer_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '30s'
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    -- Original is inclusive of p_to via "<= p_to" on a timestamp, i.e. it stops
    -- at midnight of p_to. Kept as is so unfiltered numbers do not move.
    RETURN QUERY
      SELECT c.area, c.city, SUM(s.netamnt) AS total_netamnt, COUNT(DISTINCT s.trdr) AS customer_count
      FROM vw_crm_sales s
      INNER JOIN vw_crm_customers c ON s.trdr::integer = c.trdr_id
      WHERE s.trndate >= p_from
        AND s.trndate <= p_to
        AND s.netamnt IS NOT NULL
        AND (p_area IS NULL OR c.area = p_area)
        AND (
          p_salesman_code IS NULL
          OR CASE WHEN p_mode = 'sales'
               THEN COALESCE(s.salesman_code,
                             CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END)
               ELSE c.salesman_code
             END = p_salesman_code
        )
      GROUP BY c.area, c.city
      ORDER BY 3 DESC;
  ELSE
    RETURN QUERY
      SELECT c.area, c.city, SUM(s.netamnt) AS total_netamnt, COUNT(DISTINCT s.trdr) AS customer_count
      FROM crm_sales_docs_filtered(p_from, p_to, p_new_items_since, p_new_customers_since) s
      INNER JOIN vw_crm_customers c ON s.trdr::integer = c.trdr_id
      WHERE s.netamnt IS NOT NULL
        AND (p_area IS NULL OR c.area = p_area)
        AND (
          p_salesman_code IS NULL
          OR CASE WHEN p_mode = 'sales'
               THEN COALESCE(s.salesman_code,
                             CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END)
               ELSE c.salesman_code
             END = p_salesman_code
        )
      GROUP BY c.area, c.city
      ORDER BY 3 DESC;
  END IF;
END;
$function$;

-- Monthly totals. /sales/monthly aggregates raw FINDOC rows in JS; with a filter
-- on it calls this instead. Same series and the same half-open [p_from, p_to)
-- window as the JS path, so switching paths does not move the unfiltered months.
CREATE FUNCTION public.get_sales_monthly(
  p_from date,
  p_to date,                         -- exclusive, as in the JS path
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book',
  p_new_items_since date DEFAULT NULL,
  p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(month text, netamnt numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '30s'
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
    SELECT to_char(s.trndate, 'YYYY-MM'), SUM(s.netamnt)
    FROM crm_sales_docs_filtered(p_from, p_to - 1, p_new_items_since, p_new_customers_since) s
    LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
    WHERE s.series = ANY (ARRAY[7061, 7062, 7080, 7063, 7064, 9962])
      AND s.netamnt IS NOT NULL
      AND (
        p_salesman_code IS NULL
        OR CASE WHEN p_mode = 'sales'
             THEN COALESCE(s.salesman_code,
                           CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END)
             ELSE c.salesman_code
           END = p_salesman_code
      )
    GROUP BY 1
    ORDER BY 1;
END;
$function$;

-- Customer card totals. Only the item filter applies to a single customer.
-- Same base/filtered/dispatch pattern as the item-level RPCs below. The filtered
-- body computes the new-item share only for this customer's documents: going
-- through crm_sales_docs_filtered() instead computed it for every document in
-- the company first and took 7.8 s.
ALTER FUNCTION public.get_customer_sales_totals(text, date, date, date, date)
  RENAME TO crm_customer_sales_totals_base;

CREATE FUNCTION public.crm_customer_sales_totals_filtered(
  p_trdr_code text,
  p_from date,
  p_to date,
  p_prev_from date,
  p_prev_to date,
  p_new_items_since date
)
RETURNS TABLE(current_net numeric, prev_net numeric, current_qty numeric, prev_qty numeric,
              current_credit_net numeric, prev_credit_net numeric,
              current_credit_qty numeric, prev_credit_qty numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH raw_docs AS (
    SELECT s.findoc, s.trndate, s.series, s.netamnt
    FROM vw_crm_sales s
    WHERE s.trdr IN (
        SELECT trdr_id::text FROM stg_soft1_trdr
        WHERE trdr_code = p_trdr_code AND company = 1000
      )
      AND s.trndate >= LEAST(p_from, p_prev_from)
      AND s.trndate <  GREATEST(p_to, p_prev_to) + 1
  ),
  sh AS (
    SELECT y.findoc,
           SUM(y.lineval) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since))
             / NULLIF(SUM(y.lineval), 0) AS new_share
    FROM mv_crm_doc_item_years y
    WHERE y.findoc IN (SELECT findoc FROM raw_docs)
    GROUP BY y.findoc
  ),
  docs AS (
    SELECT d.findoc, d.trndate, d.series, d.netamnt * (1 - COALESCE(sh.new_share, 0)) AS netamnt
    FROM raw_docs d LEFT JOIN sh ON sh.findoc = d.findoc
  ),
  lines AS (
    SELECT d.trndate, d.series, ml.qty
    FROM docs d
    JOIN stg_soft1_mtrlines ml ON ml.findoc = d.findoc AND ml.company = 1000
    LEFT JOIN stg_soft1_mtrl m ON m.company = 1000 AND m.mtrl = ml.mtrl
    WHERE m.cccdateportal IS NULL OR m.cccdateportal < p_new_items_since
  )
  SELECT
    COALESCE((SELECT SUM(netamnt) FROM docs WHERE trndate >= p_from      AND trndate < p_to      + 1), 0),
    COALESCE((SELECT SUM(netamnt) FROM docs WHERE trndate >= p_prev_from AND trndate < p_prev_to + 1), 0),
    COALESCE((SELECT SUM(CASE WHEN series IN (7063,7064,9962) THEN -qty ELSE qty END) FROM lines WHERE trndate >= p_from      AND trndate < p_to      + 1), 0),
    COALESCE((SELECT SUM(CASE WHEN series IN (7063,7064,9962) THEN -qty ELSE qty END) FROM lines WHERE trndate >= p_prev_from AND trndate < p_prev_to + 1), 0),
    COALESCE((SELECT -SUM(netamnt) FROM docs  WHERE series IN (7063,7064,9962) AND trndate >= p_from      AND trndate < p_to      + 1), 0),
    COALESCE((SELECT -SUM(netamnt) FROM docs  WHERE series IN (7063,7064,9962) AND trndate >= p_prev_from AND trndate < p_prev_to + 1), 0),
    COALESCE((SELECT  SUM(qty)     FROM lines WHERE series IN (7063,7064,9962) AND trndate >= p_from      AND trndate < p_to      + 1), 0),
    COALESCE((SELECT  SUM(qty)     FROM lines WHERE series IN (7063,7064,9962) AND trndate >= p_prev_from AND trndate < p_prev_to + 1), 0);
$function$;

CREATE FUNCTION public.get_customer_sales_totals(
  p_trdr_code text,
  p_from date,
  p_to date,
  p_prev_from date,
  p_prev_to date,
  p_new_items_since date DEFAULT NULL
)
RETURNS TABLE(current_net numeric, prev_net numeric, current_qty numeric, prev_qty numeric,
              current_credit_net numeric, prev_credit_net numeric,
              current_credit_qty numeric, prev_credit_qty numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $function$
BEGIN
  IF p_new_items_since IS NULL THEN
    RETURN QUERY SELECT * FROM crm_customer_sales_totals_base(p_trdr_code, p_from, p_to, p_prev_from, p_prev_to);
  ELSE
    RETURN QUERY EXECUTE
      'SELECT * FROM crm_customer_sales_totals_filtered($1,$2,$3,$4,$5,$6)'
      USING p_trdr_code, p_from, p_to, p_prev_from, p_prev_to, p_new_items_since;
  END IF;
END;
$function$;
-- ---------------------------------------------------------------------------
-- 4. Item-level RPCs on mv_crm_sku_sales: filter the lines directly.
-- ---------------------------------------------------------------------------
-- The original function, renamed and otherwise untouched: the wrapper below calls
-- it when no filter is on, so unfiltered results AND plans stay exactly as they were.
ALTER FUNCTION public.get_category_sales(date, date, date, date, text, text, text, text) RENAME TO crm_category_sales_base;
CREATE FUNCTION public.crm_category_sales_filtered(
  p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL,
  p_city text DEFAULT NULL, p_customer_code text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(customer_code text, category_id integer, category_code text, parent_code text,
              level integer, full_name text, short_name text, net_revenue numeric,
              total_qty numeric, invoice_count bigint, prev_revenue numeric, prev_qty numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH filtered_customers AS (
    SELECT c.code FROM vw_crm_customers c
    WHERE c.is_active = true
    AND (p_salesman_code IS NULL OR c.salesman_code = p_salesman_code)
    AND (p_area IS NULL OR c.area = p_area)
    AND (p_city IS NULL OR c.city = p_city)
    AND (p_customer_code IS NULL OR c.code = p_customer_code)
    AND (p_new_customers_since IS NULL OR c.inserted_date IS NULL OR c.inserted_date < p_new_customers_since)
  ),
  new_items AS (
    SELECT m.mtrl FROM stg_soft1_mtrl m
    WHERE m.company = 1000 AND m.cccdateportal >= p_new_items_since
  ),
  current_period AS (
    SELECT s.category_id, SUM(s.netlineval) AS net_revenue, SUM(s.qty) AS total_qty,
      COUNT(DISTINCT s.customer_code || '-' || s.trndate::date::text) AS invoice_count
    FROM mv_crm_sku_sales s JOIN filtered_customers fc ON fc.code = s.customer_code
    WHERE s.trndate >= p_from AND s.trndate <= p_to
      AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (SELECT mtrl FROM new_items))
    GROUP BY s.category_id
  ),
  prev_period AS (
    SELECT s.category_id, SUM(s.netlineval) AS prev_revenue, SUM(s.qty) AS prev_qty
    FROM mv_crm_sku_sales s JOIN filtered_customers fc ON fc.code = s.customer_code
    WHERE s.trndate >= p_prev_from AND s.trndate <= p_prev_to
      AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (SELECT mtrl FROM new_items))
    GROUP BY s.category_id
  )
  SELECT p_customer_code AS customer_code, cp.category_id, c.category_code, c.parent_code, c.level,
    c.full_name, c.short_name, cp.net_revenue, cp.total_qty, cp.invoice_count,
    COALESCE(pp.prev_revenue, 0), COALESCE(pp.prev_qty, 0)
  FROM current_period cp LEFT JOIN prev_period pp ON pp.category_id = cp.category_id
  JOIN crm_category_master c ON c.soft1_id = cp.category_id
  ORDER BY cp.net_revenue DESC;
$function$;

-- The original function, renamed and otherwise untouched: the wrapper below calls
-- it when no filter is on, so unfiltered results AND plans stay exactly as they were.
ALTER FUNCTION public.get_sku_sales(date, date, text, text, text, integer, text) RENAME TO crm_sku_sales_base;
CREATE FUNCTION public.crm_sku_sales_filtered(
  p_from date, p_to date, p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL,
  p_city text DEFAULT NULL, p_category_id integer DEFAULT NULL, p_customer_code text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(mtrl_id text, sku_code text, sku_name text, category_id integer, revenue numeric, qty numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH filtered_customers AS (
    SELECT c.code FROM vw_crm_customers c
    WHERE c.is_active = true
    AND (p_salesman_code IS NULL OR c.salesman_code = p_salesman_code)
    AND (p_area IS NULL OR c.area = p_area)
    AND (p_city IS NULL OR c.city = p_city)
    AND (p_customer_code IS NULL OR c.code = p_customer_code)
    AND (p_new_customers_since IS NULL OR c.inserted_date IS NULL OR c.inserted_date < p_new_customers_since)
  )
  SELECT s.mtrl_id, s.sku_code, s.sku_name, s.category_id, SUM(s.netlineval) AS revenue, SUM(s.qty) AS qty
  FROM mv_crm_sku_sales s JOIN filtered_customers fc ON fc.code = s.customer_code
  WHERE s.trndate >= p_from AND s.trndate <= p_to
  AND (p_category_id IS NULL OR s.category_id = p_category_id)
  AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (
        SELECT m.mtrl FROM stg_soft1_mtrl m
        WHERE m.company = 1000 AND m.cccdateportal >= p_new_items_since))
  GROUP BY s.mtrl_id, s.sku_code, s.sku_name, s.category_id ORDER BY revenue DESC;
$function$;

-- The original function, renamed and otherwise untouched: the wrapper below calls
-- it when no filter is on, so unfiltered results AND plans stay exactly as they were.
ALTER FUNCTION public.get_top_customers_by_category(date, date, date, date, integer, text, text, text, integer) RENAME TO crm_top_customers_by_category_base;
CREATE FUNCTION public.crm_top_customers_by_category_filtered(
  p_from date, p_to date, p_prev_from date, p_prev_to date, p_category_id integer,
  p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL, p_city text DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(customer_code text, customer_name text, city text, area text, revenue numeric,
              qty numeric, prev_revenue numeric, prev_qty numeric, growth_pct numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH filtered_customers AS (
    SELECT c.code, c.name, c.city, c.area FROM vw_crm_customers c
    WHERE c.is_active = true
    AND (p_salesman_code IS NULL OR c.salesman_code = p_salesman_code)
    AND (p_area IS NULL OR c.area = p_area)
    AND (p_city IS NULL OR c.city = p_city)
    AND (p_new_customers_since IS NULL OR c.inserted_date IS NULL OR c.inserted_date < p_new_customers_since)
  ),
  new_items AS (
    SELECT m.mtrl FROM stg_soft1_mtrl m
    WHERE m.company = 1000 AND m.cccdateportal >= p_new_items_since
  ),
  current_period AS (
    SELECT fc.code, fc.name, fc.city, fc.area, SUM(s.netlineval) AS revenue, SUM(s.qty) AS qty
    FROM mv_crm_sku_sales s JOIN filtered_customers fc ON fc.code = s.customer_code
    WHERE s.trndate >= p_from AND s.trndate <= p_to AND s.category_id = p_category_id
      AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (SELECT mtrl FROM new_items))
    GROUP BY fc.code, fc.name, fc.city, fc.area
  ),
  prev_period AS (
    SELECT s.customer_code, SUM(s.netlineval) AS prev_revenue, SUM(s.qty) AS prev_qty
    FROM mv_crm_sku_sales s JOIN filtered_customers fc ON fc.code = s.customer_code
    WHERE s.trndate >= p_prev_from AND s.trndate <= p_prev_to AND s.category_id = p_category_id
      AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (SELECT mtrl FROM new_items))
    GROUP BY s.customer_code
  )
  SELECT cp.code, cp.name, cp.city, cp.area, cp.revenue, cp.qty,
    COALESCE(pp.prev_revenue, 0), COALESCE(pp.prev_qty, 0),
    CASE WHEN COALESCE(pp.prev_revenue, 0) > 0 THEN ((cp.revenue - pp.prev_revenue) / pp.prev_revenue * 100) ELSE NULL END
  FROM current_period cp LEFT JOIN prev_period pp ON pp.customer_code = cp.code
  ORDER BY cp.revenue DESC LIMIT p_limit;
$function$;

-- The original function, renamed and otherwise untouched: the wrapper below calls
-- it when no filter is on, so unfiltered results AND plans stay exactly as they were.
ALTER FUNCTION public.get_customer_category_rank(date, date, text, integer, text) RENAME TO crm_customer_category_rank_base;
CREATE FUNCTION public.crm_customer_category_rank_filtered(
  p_from date, p_to date, p_customer_code text, p_category_id integer, p_area text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(rank bigint, total_customers bigint, percentile numeric, revenue numeric, qty numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH filtered_customers AS (
    SELECT c.code
    FROM vw_crm_customers c
    WHERE c.is_active = true
    AND (p_area IS NULL OR c.area = p_area)
    AND (p_new_customers_since IS NULL OR c.inserted_date IS NULL OR c.inserted_date < p_new_customers_since)
  ),
  all_revenues AS (
    SELECT
      s.customer_code,
      SUM(s.netlineval) AS revenue,
      SUM(s.qty) AS qty
    FROM mv_crm_sku_sales s
    JOIN filtered_customers fc ON fc.code = s.customer_code
    WHERE s.trndate >= p_from AND s.trndate <= p_to
    AND s.category_id = p_category_id
    AND (p_new_items_since IS NULL OR s.mtrl_id NOT IN (
          SELECT m.mtrl FROM stg_soft1_mtrl m
          WHERE m.company = 1000 AND m.cccdateportal >= p_new_items_since))
    GROUP BY s.customer_code
  ),
  this_customer AS (
    SELECT revenue, qty FROM all_revenues WHERE customer_code = p_customer_code
  )
  SELECT
    (SELECT COUNT(*) + 1 FROM all_revenues WHERE revenue > (SELECT revenue FROM this_customer))::bigint AS rank,
    COUNT(*)::bigint AS total_customers,
    ROUND(
      (SELECT COUNT(*) + 1 FROM all_revenues WHERE revenue > (SELECT revenue FROM this_customer))::numeric
      / NULLIF(COUNT(*), 0) * 100
    , 1) AS percentile,
    (SELECT revenue FROM this_customer) AS revenue,
    (SELECT qty FROM this_customer) AS qty
  FROM all_revenues;
$function$;

-- Public entry points keep their names. Folding both paths into one SQL
-- function made the UNFILTERED path 3-10x slower (e.g. top customers 1.4 s ->
-- 121 s): the extra optional predicates change the generic plan's row
-- estimates. Dispatching between two separately planned functions avoids that.
-- The *_filtered functions carry no SET clause so they can be inlined, and are
-- reached through EXECUTE so each call is planned with its real values: planned
-- generically, the per-customer category call took 4 s instead of 0.1 s.
CREATE FUNCTION public.get_category_sales(
  p_from date, p_to date, p_prev_from date, p_prev_to date,
  p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL,
  p_city text DEFAULT NULL, p_customer_code text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(customer_code text, category_id integer, category_code text, parent_code text,
              level integer, full_name text, short_name text, net_revenue numeric,
              total_qty numeric, invoice_count bigint, prev_revenue numeric, prev_qty numeric)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '30s'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    RETURN QUERY SELECT * FROM crm_category_sales_base(
      p_from, p_to, p_prev_from, p_prev_to, p_salesman_code, p_area, p_city, p_customer_code);
  ELSE
    RETURN QUERY EXECUTE
      'SELECT * FROM crm_category_sales_filtered($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'
      USING p_from, p_to, p_prev_from, p_prev_to, p_salesman_code, p_area, p_city, p_customer_code,
            p_new_items_since, p_new_customers_since;
  END IF;
END;
$function$;

CREATE FUNCTION public.get_sku_sales(
  p_from date, p_to date, p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL,
  p_city text DEFAULT NULL, p_category_id integer DEFAULT NULL, p_customer_code text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(mtrl_id text, sku_code text, sku_name text, category_id integer, revenue numeric, qty numeric)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '30s'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    RETURN QUERY SELECT * FROM crm_sku_sales_base(
      p_from, p_to, p_salesman_code, p_area, p_city, p_category_id, p_customer_code);
  ELSE
    RETURN QUERY EXECUTE
      'SELECT * FROM crm_sku_sales_filtered($1,$2,$3,$4,$5,$6,$7,$8,$9)'
      USING p_from, p_to, p_salesman_code, p_area, p_city, p_category_id, p_customer_code,
            p_new_items_since, p_new_customers_since;
  END IF;
END;
$function$;

CREATE FUNCTION public.get_top_customers_by_category(
  p_from date, p_to date, p_prev_from date, p_prev_to date, p_category_id integer,
  p_salesman_code text DEFAULT NULL, p_area text DEFAULT NULL, p_city text DEFAULT NULL,
  p_limit integer DEFAULT 10,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(customer_code text, customer_name text, city text, area text, revenue numeric,
              qty numeric, prev_revenue numeric, prev_qty numeric, growth_pct numeric)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '30s'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    RETURN QUERY SELECT * FROM crm_top_customers_by_category_base(
      p_from, p_to, p_prev_from, p_prev_to, p_category_id, p_salesman_code, p_area, p_city, p_limit);
  ELSE
    RETURN QUERY EXECUTE
      'SELECT * FROM crm_top_customers_by_category_filtered($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
      USING p_from, p_to, p_prev_from, p_prev_to, p_category_id, p_salesman_code, p_area, p_city, p_limit,
            p_new_items_since, p_new_customers_since;
  END IF;
END;
$function$;

CREATE FUNCTION public.get_customer_category_rank(
  p_from date, p_to date, p_customer_code text, p_category_id integer, p_area text DEFAULT NULL,
  p_new_items_since date DEFAULT NULL, p_new_customers_since date DEFAULT NULL
)
RETURNS TABLE(rank bigint, total_customers bigint, percentile numeric, revenue numeric, qty numeric)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '30s'
AS $function$
BEGIN
  IF p_new_items_since IS NULL AND p_new_customers_since IS NULL THEN
    RETURN QUERY SELECT * FROM crm_customer_category_rank_base(
      p_from, p_to, p_customer_code, p_category_id, p_area);
  ELSE
    RETURN QUERY EXECUTE
      'SELECT * FROM crm_customer_category_rank_filtered($1,$2,$3,$4,$5,$6,$7)'
      USING p_from, p_to, p_customer_code, p_category_id, p_area,
            p_new_items_since, p_new_customers_since;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Grants — recreated functions get PUBLIC EXECUTE by default; restore the
--    exact ACLs they had before (captured 2026-09-29 from pg_proc.proacl).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_sales_summary(date, date, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_summary(date, date, text, text, date, date) TO PUBLIC, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_by_area(date, date, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_by_area(date, date, text, text, date, date) TO PUBLIC, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_by_city(date, date, text, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_by_city(date, date, text, text, text, date, date) TO PUBLIC, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sales_monthly(date, date, text, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sales_monthly(date, date, text, text, date, date) TO authenticated, service_role;

-- Was: no PUBLIC, authenticated + service_role only (SECURITY DEFINER, called from the browser).
REVOKE ALL ON FUNCTION public.get_customer_sales_totals(text, date, date, date, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_totals(text, date, date, date, date, date) TO authenticated, service_role;
-- Reached only through the SECURITY DEFINER wrapper; nobody else needs it.
REVOKE ALL ON FUNCTION public.crm_customer_sales_totals_filtered(text, date, date, date, date, date) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_category_sales(date, date, date, date, text, text, text, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_category_sales(date, date, date, date, text, text, text, text, date, date) TO PUBLIC, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_sku_sales(date, date, text, text, text, integer, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sku_sales(date, date, text, text, text, integer, text, date, date) TO PUBLIC, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_top_customers_by_category(date, date, date, date, integer, text, text, text, integer, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_top_customers_by_category(date, date, date, date, integer, text, text, text, integer, date, date) TO PUBLIC, authenticated, service_role;

-- Was: PUBLIC, authenticated, anon, service_role.
GRANT EXECUTE ON FUNCTION public.get_customer_category_rank(date, date, text, integer, text, date, date) TO PUBLIC, authenticated, anon, service_role;

-- The wrappers are SECURITY INVOKER, so callers need EXECUTE on what they
-- dispatch to. The *_base functions keep their original ACLs through the rename.
GRANT EXECUTE ON FUNCTION public.crm_category_sales_filtered(date, date, date, date, text, text, text, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_sku_sales_filtered(date, date, text, text, text, integer, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_top_customers_by_category_filtered(date, date, date, date, integer, text, text, text, integer, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_customer_category_rank_filtered(date, date, text, integer, text, date, date) TO authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
