-- ============================================================================
-- Tier 1: give the revenue RPCs an attribution mode.
--
--   p_mode = 'book'   the customer's CURRENT rep  (legacy behaviour)
--   p_mode = 'sales'  the rep who wrote the invoice
--
-- 'book' answers "what did my customers buy, whoever sold it" — right for
-- planning. 'sales' answers "what did I sell" — right for performance and
-- commission. Both are legitimate; the dashboard exposes them as a toggle and
-- defaults to 'sales'.
--
-- 'sales' resolves the code as COALESCE(invoice salesman, customer's current
-- rep WHEN the document is a branch document). The fallback keeps totals whole:
-- Softone leaves SALESMAN NULL on branch documents (~EUR 91k/yr), and without
-- it those rows would silently vanish from every rep's number in sales mode.
-- vw_crm_sales_attributed.attribution_source marks the borrowed ones.
--
-- OVERLOADS ARE DROPPED, NOT REPLACED. Each of these had a shorter overload
-- that was ALREADY unreachable through named arguments — calling
-- get_sales_summary(p_from => ..., p_to => ...) errors today with "function is
-- not unique", because p_salesman_code carries a DEFAULT. Keeping them while
-- adding p_mode would have made the 3-argument calls in routes/erp.js
-- ambiguous too. routes/erp.js is the only caller anywhere (checked across
-- crm-frontend, crm-sync, crm-analytics, inv-dashboard and pda-scanner), so
-- collapsing each to a single signature is safe and removes the ambiguity.
--
-- Each function keeps the SECURITY/search_path/timeout settings it had; this
-- migration deliberately does not change privilege semantics. Note that
-- get_sales_summary alone was neither SECURITY DEFINER nor search_path-pinned —
-- preserved as found, but worth revisiting separately.
--
-- NOT CHANGED: get_customer_revenue_map takes no rep parameter at all — it
-- returns revenue per customer with no rep filtering — so a mode would have no
-- effect. Scoping map revenue to one rep's own sales is a new feature, not a
-- toggle, and is out of scope here.
-- ============================================================================

BEGIN;

-- ── get_sales_summary ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_sales_summary(date, date);
DROP FUNCTION IF EXISTS public.get_sales_summary(date, date, text);

CREATE FUNCTION public.get_sales_summary(
  p_from date,
  p_to date,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book'
)
RETURNS TABLE(trdr text, total_netamnt numeric, invoice_count bigint)
LANGUAGE sql
SET statement_timeout TO '30s'
AS $function$
  SELECT s.trdr, SUM(s.netamnt) AS total_netamnt, COUNT(DISTINCT s.findoc) AS invoice_count
  FROM vw_crm_sales s
  LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
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
  GROUP BY s.trdr;
$function$;

-- ── get_sales_by_area ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_sales_by_area(date, date);
DROP FUNCTION IF EXISTS public.get_sales_by_area(date, date, text);

CREATE FUNCTION public.get_sales_by_area(
  p_from date,
  p_to date,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book'
)
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

-- ── get_sales_by_city ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_sales_by_city(date, date, text);
DROP FUNCTION IF EXISTS public.get_sales_by_city(date, date, text, text);

CREATE FUNCTION public.get_sales_by_city(
  p_from date,
  p_to date,
  p_area text DEFAULT NULL,
  p_salesman_code text DEFAULT NULL,
  p_mode text DEFAULT 'book'
)
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

GRANT EXECUTE ON FUNCTION public.get_sales_summary(date, date, text, text)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_by_area(date, date, text, text)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_by_city(date, date, text, text, text) TO authenticated, service_role;

COMMIT;
