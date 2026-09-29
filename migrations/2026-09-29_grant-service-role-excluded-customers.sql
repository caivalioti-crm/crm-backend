-- ============================================================================
-- service_role must be able to read crm_excluded_customers.
--
-- 2026-09-29_sales-mode-drop-excluded-customers.sql made get_sales_summary
-- (SECURITY INVOKER, called by crm-backend as service_role) read this table
-- directly. service_role had no SELECT on it (ACL was Dxtm only), so every
-- /api/erp/sales call failed with 42501 "permission denied for table
-- crm_excluded_customers" and the dashboard showed EUR 0 for ~10 minutes.
-- The dry run missed it because it ran as postgres.
--
-- Applied by hand on 2026-09-29 13:47 as the fix; recorded here so a rebuild
-- keeps it. service_role bypasses RLS, so nothing else is needed.
-- ============================================================================

GRANT SELECT ON public.crm_excluded_customers TO service_role;
