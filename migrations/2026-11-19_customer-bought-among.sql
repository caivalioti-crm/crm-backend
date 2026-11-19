-- ============================================================================
-- Disk IO fix (Supabase "depleting Disk IO Budget" warning, 18/11/2026).
--
-- routes/intelligence.js customerBoughtAmong() pulled every MTRLINES row of every
-- candidate item (all customers) and then looked up their FINDOCs 200 at a time:
-- one New Items / Offers screen = thousands of PostgREST calls (6.2M findoc
-- lookups since May). Now one RPC that starts from the customer's own documents.
--
-- Applied directly on 19/11/2026 together with these index changes (run outside a
-- transaction, CONCURRENTLY):
--   CREATE INDEX CONCURRENTLY idx_mtrlines_company_mtrl       ON stg_soft1_mtrlines (company, mtrl) INCLUDE (findoc);
--   CREATE INDEX CONCURRENTLY idx_mtrlines_findoc_company_cov ON stg_soft1_mtrlines (findoc, company) INCLUDE (mtrl);
--   CREATE INDEX CONCURRENTLY idx_findoc_company_trdr_cov     ON stg_soft1_findoc (company, trdr) INCLUDE (findoc, trndate);
--   CREATE INDEX CONCURRENTLY idx_custbalance_cuscode_company ON stg_soft1_custbalance (cuscode, company);
--   CREATE INDEX CONCURRENTLY idx_visit_categories_visit      ON crm_visit_categories (visit_id);
--   DROP INDEX CONCURRENTLY idx_findoc_company_findoc;   -- duplicate of the PK
--   DROP INDEX CONCURRENTLY idx_findoc_company_trdr;     -- replaced by _cov
--   DROP INDEX CONCURRENTLY idx_mtrlines_findoc_company; -- replaced by _cov
--
-- Rollback: revert routes/intelligence.js, then DROP FUNCTION below.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.customer_bought_among(
  p_trdr text, p_mtrls text[], p_recent_cutoff date DEFAULT NULL)
RETURNS TABLE (mtrl text, recent boolean)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.mtrl,
         bool_or(p_recent_cutoff IS NOT NULL AND f.trndate >= p_recent_cutoff) AS recent
  FROM stg_soft1_findoc f
  JOIN stg_soft1_mtrlines l ON l.findoc = f.findoc AND l.company = f.company
  WHERE f.company = 1000
    AND f.trdr = p_trdr
    AND l.mtrl = ANY (p_mtrls)
  GROUP BY l.mtrl
$$;

REVOKE ALL ON FUNCTION public.customer_bought_among(text, text[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_bought_among(text, text[], date) TO service_role;
