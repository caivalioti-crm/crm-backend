-- ============================================================================
-- Keep the `coords` role out of sales data on the Supabase REST API too.
--
-- middleware/auth.js already limits a coords profile to /api/me and the
-- coordinates endpoints of crm-backend. But the browser also talks to Supabase
-- directly with the user's own JWT, and as `authenticated` a coords user could
-- call the SECURITY DEFINER sales RPCs (get_customer_sales_totals,
-- get_sales_by_area/city, get_sales_monthly, ...) or read mv_crm_sku_sales,
-- bypassing crm-backend entirely.
--
-- PostgREST runs db_pre_request before every request. This one rejects a
-- coords user unless the request is a read of one of the four relations the
-- customer map needs, none of which carries money:
--   vw_crm_customers           phone for the map popup
--   crm_category_master        category names for the filter
--   mv_customer_l1_categories  customer_code -> L1 category (no amounts)
--   mv_customer_l2_categories  customer_code -> L2 category (no amounts)
--
-- It FAILS OPEN for everyone else: anything unexpected while working out who
-- the caller is returns without raising, so a bug here can never lock out
-- reps, managers or crm-backend (service_role). Only a positively identified
-- coords profile is ever refused.
--
-- Rollback:
--   ALTER ROLE authenticator RESET pgrst.db_pre_request;
--   NOTIFY pgrst, 'reload config';
--   DROP FUNCTION public.crm_pre_request();
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.crm_pre_request()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_coords boolean := false;
BEGIN
  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM crm_user_profiles p
      WHERE p.id = NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
        AND p.role = 'coords'
    ) INTO v_is_coords;
  EXCEPTION WHEN OTHERS THEN
    RETURN;   -- fail open: never block a request because of a lookup problem
  END;

  IF NOT v_is_coords THEN
    RETURN;
  END IF;

  IF current_setting('request.method', true) IN ('GET', 'HEAD')
     AND current_setting('request.path', true) IN (
       '/vw_crm_customers',
       '/crm_category_master',
       '/mv_customer_l1_categories',
       '/mv_customer_l2_categories')
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'This account is limited to the coordinates tool'
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.crm_pre_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_pre_request() TO anon, authenticated, service_role;

ALTER ROLE authenticator SET pgrst.db_pre_request TO 'public.crm_pre_request';

COMMIT;

NOTIFY pgrst, 'reload config';
