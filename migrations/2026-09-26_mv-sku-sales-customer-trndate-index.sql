-- ============================================================================
-- Index the category / SKU hot path.
--
-- get_category_sales, get_sku_sales and get_top_customers_by_category all join
-- mv_crm_sku_sales (1.14M rows) on customer_code and then filter by trndate.
-- The only usable index was mv_crm_sku_sales_customer_idx on customer_code
-- alone, so each nested-loop iteration read a customer's ENTIRE history and
-- discarded most of it: ~595 rows fetched, ~505 removed by the date filter,
-- 490 iterations at ~39ms.
--
-- get_category_sales for one rep over 2026 YTD: 14,863 ms.
-- With this index:                                  1,058 ms.
--
-- INCLUDE carries the three aggregated columns so the common case is an
-- index-only scan. Costs ~54 MB and makes REFRESH MATERIALIZED VIEW slightly
-- slower, which is a good trade for 14x on every category query.
--
-- Nothing here is about attribution mode - this is a pre-existing problem and
-- it speeds up the current behaviour just as much.
--
-- Created CONCURRENTLY against the live database so the matview was never
-- locked. Note CONCURRENTLY cannot run inside a transaction block, hence no
-- BEGIN/COMMIT in this file.
-- ============================================================================

SET statement_timeout = '0';

CREATE INDEX CONCURRENTLY IF NOT EXISTS mv_crm_sku_sales_customer_trndate_idx
  ON public.mv_crm_sku_sales (customer_code, trndate)
  INCLUDE (category_id, netlineval, qty);
