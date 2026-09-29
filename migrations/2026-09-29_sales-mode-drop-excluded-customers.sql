-- ============================================================================
-- "Οι πωλήσεις μου" (sales mode) now leaves out the customers in
-- crm_excluded_customers, like "Το πελατολόγιό μου" (book mode) always has.
--
-- Book mode only ever counts customers in vw_crm_customers, which drops the
-- excluded list. Sales mode LEFT JOINed that view and so kept their invoices.
-- For an admin with no rep filter the two modes should be identical, yet 2026
-- YTD differed by exactly EUR 150.10 over one customer: 3799 ΜΙΝΕΡΙ Α ΦΑΡΜ
-- (one invoice, 2026-03-27), which is on the excluded list.
--
-- Changed: get_sales_summary's two sales-mode branches and
-- crm_sales_docs_filtered, which feeds every filtered revenue RPC. Area and city
-- already INNER JOIN vw_crm_customers, so they needed nothing.
-- Signatures are unchanged, so CREATE OR REPLACE keeps the grants.
--
-- Rollback: re-run the CREATE statements for crm_sales_docs_filtered and
-- get_sales_summary from 2026-09-29_like-for-like-filters.sql, as
-- CREATE OR REPLACE.
-- ============================================================================

BEGIN;

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

CREATE OR REPLACE FUNCTION public.get_sales_summary(
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
    IF p_mode = 'sales' THEN
      RETURN QUERY
        SELECT s.trdr, SUM(s.netamnt), COUNT(DISTINCT s.findoc)
        FROM vw_crm_sales s
        LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
        WHERE s.trndate >= p_from
          AND s.trndate < (p_to + INTERVAL '1 day')
          AND s.netamnt IS NOT NULL
          -- Same customer set as book mode: the excluded list stays out.
          AND NOT EXISTS (
                SELECT 1 FROM crm_excluded_customers e
                JOIN stg_soft1_trdr t ON t.trdr_code = e.trdr_code AND t.company = 1000
                WHERE t.trdr_id = s.trdr::integer)
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
    -- crm_sales_docs_filtered already leaves the excluded list out.
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

NOTIFY pgrst, 'reload schema';

COMMIT;
