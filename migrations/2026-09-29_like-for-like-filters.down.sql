-- Rollback for 2026-09-29_like-for-like-filters.sql. Restores the definitions
-- captured live on 2026-09-29 before it was applied.
BEGIN;

-- Item-level + customer totals: the originals survive as *_base; rename them back.
DROP FUNCTION public.get_category_sales(date, date, date, date, text, text, text, text, date, date);
DROP FUNCTION public.crm_category_sales_filtered(date, date, date, date, text, text, text, text, date, date);
ALTER FUNCTION public.crm_category_sales_base(date, date, date, date, text, text, text, text) RENAME TO get_category_sales;

DROP FUNCTION public.get_sku_sales(date, date, text, text, text, integer, text, date, date);
DROP FUNCTION public.crm_sku_sales_filtered(date, date, text, text, text, integer, text, date, date);
ALTER FUNCTION public.crm_sku_sales_base(date, date, text, text, text, integer, text) RENAME TO get_sku_sales;

DROP FUNCTION public.get_top_customers_by_category(date, date, date, date, integer, text, text, text, integer, date, date);
DROP FUNCTION public.crm_top_customers_by_category_filtered(date, date, date, date, integer, text, text, text, integer, date, date);
ALTER FUNCTION public.crm_top_customers_by_category_base(date, date, date, date, integer, text, text, text, integer) RENAME TO get_top_customers_by_category;

DROP FUNCTION public.get_customer_category_rank(date, date, text, integer, text, date, date);
DROP FUNCTION public.crm_customer_category_rank_filtered(date, date, text, integer, text, date, date);
ALTER FUNCTION public.crm_customer_category_rank_base(date, date, text, integer, text) RENAME TO get_customer_category_rank;

DROP FUNCTION public.get_customer_sales_totals(text, date, date, date, date, date);
DROP FUNCTION public.crm_customer_sales_totals_filtered(text, date, date, date, date, date);
ALTER FUNCTION public.crm_customer_sales_totals_base(text, date, date, date, date) RENAME TO get_customer_sales_totals;

-- Document-level: recreate the originals.
DROP FUNCTION public.get_sales_summary(date, date, text, text, date, date);
DROP FUNCTION public.get_sales_by_area(date, date, text, text, date, date);
DROP FUNCTION public.get_sales_by_city(date, date, text, text, text, date, date);
DROP FUNCTION public.get_sales_monthly(date, date, text, text, date, date);
DROP FUNCTION public.crm_sales_docs_filtered(date, date, date, date);

CREATE OR REPLACE FUNCTION public.get_sales_summary(p_from date, p_to date, p_salesman_code text DEFAULT NULL::text, p_mode text DEFAULT 'book'::text)
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

CREATE OR REPLACE FUNCTION public.get_sales_by_area(p_from date, p_to date, p_salesman_code text DEFAULT NULL::text, p_mode text DEFAULT 'book'::text)
 RETURNS TABLE(area text, total_netamnt numeric, customer_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  ORDER BY total_netamnt DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_by_city(p_from date, p_to date, p_area text DEFAULT NULL::text, p_salesman_code text DEFAULT NULL::text, p_mode text DEFAULT 'book'::text)
 RETURNS TABLE(area text, city text, total_netamnt numeric, customer_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  ORDER BY total_netamnt DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_sales_summary(date, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_summary(date, date, text, text) TO PUBLIC, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_sales_by_area(date, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_by_area(date, date, text, text) TO PUBLIC, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_sales_by_city(date, date, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sales_by_city(date, date, text, text, text) TO PUBLIC, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_mv_crm_sku_sales()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  SET LOCAL statement_timeout = '10min';
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_crm_sku_sales;
END;
$function$;

DROP MATERIALIZED VIEW public.mv_crm_doc_item_years;

NOTIFY pgrst, 'reload schema';

COMMIT;