-- ============================================================================
-- "Without new items" must not depend on when mv_crm_doc_item_years was last
-- refreshed.
--
-- The matview is refreshed only by refresh_mv_crm_sku_sales(), i.e. once a
-- night at the end of sync.js. Meanwhile:
--   * the intraday sync (sync-orders.js, :30 past every hour 08:30-19:30)
--     writes new FINDOC/MTRLINES all day, and
--   * refresh.js (E:\crm, 22:10) raw-refreshes mv_crm_sku_sales without going
--     through that RPC, so on a night sync.js fails (11 in a row, 18-28/09)
--     this matview is never refreshed at all.
-- A document missing from the matview got no share row and was counted as
-- 100% old items.
--
-- Fix: documents not (yet) in the matview get their share computed live from
-- MTRLINES + MTRL, with exactly the matview's definition. That is a few hundred
-- documents on a normal day, so it is cheap; the matview stays the fast path.
--   * crm_sales_docs_filtered and crm_customer_sales_totals_filtered take the
--     union explicitly, per document set, so the plan stays per-query.
--   * vw_crm_doc_item_years gives the same union to crm-backend's JS paths
--     (customer monthly and branch breakdowns), which read it with a findoc
--     IN (...) list that the planner pushes into both branches.
--
-- Rollback: re-run the two CREATE OR REPLACE statements from
-- 2026-09-29_sales-mode-drop-excluded-customers.sql (crm_sales_docs_filtered)
-- and 2026-09-29_like-for-like-filters.sql (crm_customer_sales_totals_filtered),
-- then DROP VIEW public.vw_crm_doc_item_years.
-- ============================================================================

BEGIN;

-- Same shape and rules as mv_crm_doc_item_years, for the documents it lacks.
CREATE OR REPLACE VIEW public.vw_crm_doc_item_years AS
SELECT y.findoc, y.act_year, y.lineval, y.qty
FROM mv_crm_doc_item_years y
UNION ALL
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
  AND NOT EXISTS (SELECT 1 FROM mv_crm_doc_item_years y2 WHERE y2.findoc = f.findoc)
GROUP BY l.findoc, 2;

REVOKE ALL ON public.vw_crm_doc_item_years FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vw_crm_doc_item_years TO service_role;

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
      AND NOT EXISTS (
            SELECT 1 FROM crm_excluded_customers e
            JOIN stg_soft1_trdr t ON t.trdr_code = e.trdr_code AND t.company = 1000
            WHERE t.trdr_id = s.trdr::integer)
      AND (p_new_customers_since IS NULL OR NOT EXISTS (
            SELECT 1 FROM stg_soft1_trdr t
            WHERE t.company = 1000
              AND t.trdr_id = s.trdr::integer
              AND t.inserted_date >= p_new_customers_since))
  ),
  y AS (
    -- Fast path: the matview.
    SELECT y.findoc, y.act_year, y.lineval, y.qty
    FROM mv_crm_doc_item_years y
    WHERE p_new_items_since IS NOT NULL
      AND y.findoc IN (SELECT d.findoc FROM d)
    UNION ALL
    -- Documents the matview has not seen yet (intraday, or a missed refresh).
    SELECT l.findoc,
           COALESCE(CASE WHEN m.cccdateportal >= DATE '2000-01-01'
                         THEN EXTRACT(YEAR FROM m.cccdateportal)::smallint END, 0::smallint),
           SUM(l.netlineval), SUM(l.qty)
    FROM d
    JOIN stg_soft1_mtrlines l ON l.company = 1000 AND l.findoc = d.findoc
    LEFT JOIN stg_soft1_mtrl m ON m.company = 1000 AND m.mtrl = l.mtrl
    WHERE p_new_items_since IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mv_crm_doc_item_years y2 WHERE y2.findoc = d.findoc)
    GROUP BY l.findoc, 2
  ),
  sh AS (
    SELECT y.findoc,
           SUM(y.lineval) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since))
             / NULLIF(SUM(y.lineval), 0)                                          AS new_share,
           SUM(y.qty) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since)) AS new_qty
    FROM y
    GROUP BY y.findoc
  )
  SELECT d.trdr, d.trndate, d.series, d.findoc,
         d.netamnt * (1 - COALESCE(sh.new_share, 0)),
         COALESCE(sh.new_qty, 0),
         d.salesman_code, d.trdbranch
  FROM d
  LEFT JOIN sh ON sh.findoc = d.findoc;
$function$;

CREATE OR REPLACE FUNCTION public.crm_customer_sales_totals_filtered(
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
  y AS (
    SELECT y.findoc, y.act_year, y.lineval
    FROM mv_crm_doc_item_years y
    WHERE y.findoc IN (SELECT findoc FROM raw_docs)
    UNION ALL
    SELECT l.findoc,
           COALESCE(CASE WHEN m.cccdateportal >= DATE '2000-01-01'
                         THEN EXTRACT(YEAR FROM m.cccdateportal)::smallint END, 0::smallint),
           SUM(l.netlineval)
    FROM raw_docs r
    JOIN stg_soft1_mtrlines l ON l.company = 1000 AND l.findoc = r.findoc
    LEFT JOIN stg_soft1_mtrl m ON m.company = 1000 AND m.mtrl = l.mtrl
    WHERE NOT EXISTS (SELECT 1 FROM mv_crm_doc_item_years y2 WHERE y2.findoc = r.findoc)
    GROUP BY l.findoc, 2
  ),
  sh AS (
    SELECT y.findoc,
           SUM(y.lineval) FILTER (WHERE y.act_year >= EXTRACT(YEAR FROM p_new_items_since))
             / NULLIF(SUM(y.lineval), 0) AS new_share
    FROM y
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

NOTIFY pgrst, 'reload schema';

COMMIT;
