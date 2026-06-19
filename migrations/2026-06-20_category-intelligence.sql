-- Category Intelligence expansion — New Items & Offers tabs
-- Run on the Supabase (app) database. Safe/idempotent.

-- 1. New MTRL flags (synced by crm-sync/sync.js → syncMtrl)
--    Run BEFORE deploying the updated sync.js, else the upsert errors on unknown columns.
ALTER TABLE stg_soft1_mtrl
  ADD COLUMN IF NOT EXISTS cccisnew     boolean DEFAULT false,  -- new item
  ADD COLUMN IF NOT EXISTS cccisoffer   boolean DEFAULT false,  -- on offer
  ADD COLUMN IF NOT EXISTS maxprcdisc   numeric,                -- max price discount cap (offers require IS NULL)
  ADD COLUMN IF NOT EXISTS cccagrotiko  boolean DEFAULT false,  -- vehicle type: agricultural
  ADD COLUMN IF NOT EXISTS cccsuv       boolean DEFAULT false,  -- vehicle type: SUV
  ADD COLUMN IF NOT EXISTS cccklouba    boolean DEFAULT false,  -- vehicle type: van
  ADD COLUMN IF NOT EXISTS cccepivatiko boolean DEFAULT false,  -- vehicle type: passenger car
  ADD COLUMN IF NOT EXISTS cccfortigo   boolean DEFAULT false;  -- vehicle type: truck

-- 2. Per-(customer, item) feedback that survives an item losing its new/offer flag.
--    Two independent booleans: discussed (συζητήθηκε) + interested (ενδιαφέρει).
CREATE TABLE IF NOT EXISTS crm_customer_item_interest (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_code text    NOT NULL,
  mtrl          text    NOT NULL,
  list_type     text    NOT NULL CHECK (list_type IN ('new','offer')),
  discussed     boolean NOT NULL DEFAULT false,
  interested    boolean,                 -- null = not yet answered, true/false otherwise
  notes         text,
  captured_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_code, mtrl, list_type)
);

CREATE INDEX IF NOT EXISTS idx_cust_item_interest_customer
  ON crm_customer_item_interest (customer_code);

-- 3. Let the backend (service_role) read the brand materialized views, so all
--    relevance (brand ∩ category) can be computed server-side. Read-only, reversible.
GRANT SELECT ON mv_customer_brand_profile  TO service_role;
GRANT SELECT ON mv_category_brand_coverage TO service_role;
