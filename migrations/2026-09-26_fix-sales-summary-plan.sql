-- ============================================================================
-- Fix a planner regression introduced with p_mode.
--
-- Putting the mode switch in the WHERE clause as
--   CASE WHEN p_mode = 'sales' THEN <invoice rep> ELSE <customer rep> END = p_salesman_code
-- looks harmless, but p_mode is a PARAMETER, so PostgreSQL cannot fold the CASE
-- at plan time. The rep filter therefore cannot be pushed down into the scan of
-- stg_soft1_trdr, and the plan joins ~44k invoice rows to the customer view
-- first and filters afterwards.
--
-- Measured on 2026 YTD for code 1721:
--   book   4,624 ms      sales  1,656 ms      admin (no rep filter)  1,765 ms
-- The dashboard issues this twice (current + comparison period), so the
-- Performance panel was waiting ~9 s.
--
-- Substituting literals for the parameters makes the same query run in 130 ms,
-- which is what identified the cause: with a literal the CASE folds away and the
-- filter reaches the scan.
--
-- Fix: branch in PL/pgSQL so each mode is planned as its own query. The 'book'
-- branch is restored to the original EXISTS form it had before p_mode existed.
--
--   book   4,624 -> 193 ms      sales  1,656 -> 224 ms      admin  1,765 -> 854 ms
--
-- Verified to return byte-identical results first: book 803,928 over 416 rows,
-- sales 774,997 over 561 rows, admin 3,521,036 over 1,401 rows.
--
-- get_sales_by_area and get_sales_by_city are deliberately left alone. They
-- INNER JOIN the customer view, so the planner still filters early, and they
-- measure 210-370 ms in both modes.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_sales_summary(
  p_from date,
  p_to date,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book'
)
RETURNS TABLE(trdr text, total_netamnt numeric, invoice_count bigint)
LANGUAGE plpgsql
SET statement_timeout TO '30s'
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_mode = 'sales' THEN
    -- Credit the rep who wrote the invoice. Branch documents carry no salesman
    -- in Softone, so they fall back to the parent customer's rep; without that
    -- fallback ~EUR 91k/yr would vanish from rep totals entirely.
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
    -- Credit whoever holds the customer now. EXISTS rather than a join: this is
    -- the shape the function had before p_mode, and it is what lets the planner
    -- push the rep filter down into stg_soft1_trdr.
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
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_sales_summary(date, date, text, text) TO authenticated, service_role;

COMMIT;
