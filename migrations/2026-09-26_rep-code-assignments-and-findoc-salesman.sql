-- ============================================================================
-- Rep attribution over time.
--
-- Problem this fixes: vw_crm_sales carried no salesman, so revenue was linked to
-- a rep only through the customer's CURRENT salesman_code, which crm-sync
-- overwrites from Softone TRDR on every run. Every route change therefore
-- rewrote history. Measured before this migration: 43,766 docs invoiced by 1610
-- (ΝΕΡΗΣ) were being credited to 1721 (ΒΑΚΟΥΦΤΣΗΣ) purely because those
-- customers had since moved to his book.
--
-- Two parts:
--   1. crm_rep_code_assignments — who held a Softone person code, and when.
--   2. stg_soft1_findoc.salesman_code — the salesman stamped on each invoice,
--      which is immutable and already person-level (FINDOC.SALESMAN = PRSN.PRSN).
--
-- Part 2 alone fixes attribution for every normal case. Part 1 covers the case
-- where a code outlives its original owner — created on 2026-09-26 when
-- crm-temp@eaivaliotis.gr took over code 1721 after Vakouftshs left, so new
-- invoices are stamped 1721 but are not his work.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Who held which code, and when
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS crm_rep_code_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salesman_code text NOT NULL,                              -- Softone PRSN.PRSN as text
  user_id       uuid REFERENCES crm_user_profiles(id),      -- NULL for pre-CRM / ERP-only reps
  display_name  text NOT NULL,                              -- always set, so history reads without a CRM account
  valid_from    date NOT NULL,
  valid_to      date,                                       -- NULL = current holder
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rep_assign_range_ck CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- one holder per code at any instant; half-open [from, to)
  CONSTRAINT rep_assign_no_overlap EXCLUDE USING gist (
    salesman_code WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE INDEX IF NOT EXISTS idx_rep_assign_code_from
  ON crm_rep_code_assignments (salesman_code, valid_from);

COMMENT ON TABLE crm_rep_code_assignments IS
  'Tenure of Softone person codes (PRSN.PRSN). Join invoice salesman_code + trndate into [valid_from, valid_to) to attribute revenue to the person who actually held the code at the time.';

-- Seed. valid_from is the code''s first invoice in FINDOC (company 1000);
-- valid_to is set only where the ERP person record is inactive.
INSERT INTO crm_rep_code_assignments (salesman_code, user_id, display_name, valid_from, valid_to, note) VALUES
  ('1584', '242f4067-c18e-4436-87b7-caba5822e4bb', 'ΕΤΑΙΡΕΙΑ',      DATE '2021-01-02', NULL,              'house account'),
  ('33',   NULL,                                   'ΧΡΗΣΤΟΥ ΕΛΕΝΗ', DATE '2021-01-04', DATE '2025-04-12', 'left before CRM; ERP person inactive'),
  ('29',   '6a712bc5-e102-4e85-b223-8dee292770a5', 'ΤΣΟΓΙΑΝΝΗΣ',    DATE '2021-01-14', NULL,              NULL),
  ('31',   '3f4862c4-c19a-4ecd-8f83-4a3df0dc3d1d', 'ΦΛΩΡΑ',         DATE '2021-01-15', NULL,              NULL),
  ('1610', NULL,                                   'ΝΕΡΗΣ',         DATE '2021-05-05', DATE '2026-07-11', 'left 2026-07; book absorbed into 1721'),
  ('1721', '04773249-105a-49a2-a46f-3851008830e2', 'ΒΑΚΟΥΦΤΣΗΣ',    DATE '2023-10-24', DATE '2026-09-26', 'left 2026-09-26'),
  ('1735', 'c1e7a98d-220d-4b0a-af09-ab549c9891a6', 'ΜΑΚΡΗΣ',        DATE '2023-11-21', NULL,              'CRM profile has no salesman_code set'),
  ('1795', NULL,                                   'ΝΕΡΗΣ-ΑΘΗΝΑ',   DATE '2025-01-22', NULL,              'ERP active but no invoices since 2025-05-09'),
  ('1614', '8a56b7e2-e8b7-490e-bf66-004f57a9ccef', 'ΣΕΛΙΔΗΣ',       DATE '2025-01-27', NULL,              NULL),
  ('1849', '0862b970-07fa-4a8c-b873-4be3234a0055', 'ΧΑΡΤΟΦΥΛΑΚΑΣ',  DATE '2026-01-29', NULL,              NULL),
  ('1853', NULL,                                   'ΠΕΡΙΚΛΗΣ',      DATE '2026-03-06', NULL,              '6 docs only; not linked to the coords CRM account'),
  -- the handover this table exists for
  ('1721', '34c613b7-73d0-40e0-b89d-12078ee82b0d', 'CRM Temp (route 1721)', DATE '2026-09-26', NULL,
           'temp cover after Vakouftshs; invoices still stamped 1721 until Softone reassigns')
ON CONFLICT DO NOTHING;

ALTER TABLE crm_rep_code_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rep_assign_read ON crm_rep_code_assignments;
CREATE POLICY rep_assign_read ON crm_rep_code_assignments
  FOR SELECT TO authenticated USING (true);

-- mirror the grant pattern used by the other crm_ tables; service_role must be
-- named explicitly, a PUBLIC grant does not reach it
GRANT SELECT ON crm_rep_code_assignments TO authenticated;
GRANT ALL    ON crm_rep_code_assignments TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The salesman stamped on each invoice
-- ---------------------------------------------------------------------------
ALTER TABLE stg_soft1_findoc ADD COLUMN IF NOT EXISTS salesman_code text;

CREATE INDEX IF NOT EXISTS idx_findoc_salesman_trndate
  ON stg_soft1_findoc (salesman_code, trndate);

COMMENT ON COLUMN stg_soft1_findoc.salesman_code IS
  'FINDOC.SALESMAN from Softone (= PRSN.PRSN), stamped at invoice time. Use this for revenue attribution, never the customer''s current salesman_code.';

-- vw_crm_sales gains the column. Appending at the end keeps CREATE OR REPLACE
-- valid for the dependent view vw_crm_customers.
CREATE OR REPLACE VIEW vw_crm_sales AS
 SELECT f.trdr,
    f.trndate,
    f.series,
    f.findoc,
    f.company,
    f.sosource,
        CASE
            WHEN f.series = ANY (ARRAY[7063, 7064, 9962]) THEN - n.netamnt
            ELSE n.netamnt
        END AS netamnt,
    f.salesman_code
   FROM stg_soft1_findoc f
     LEFT JOIN stg_soft1_findoc_netamnt n ON f.findoc = n.findoc AND f.company = n.company
  WHERE f.company = 1000 AND (f.series = ANY (ARRAY[7061, 7062, 7080, 7063, 7064, 9962, 9964, 7067]));

-- ---------------------------------------------------------------------------
-- 3. The view that answers "who earned this"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_crm_sales_attributed AS
 SELECT s.trdr,
        s.trndate,
        s.series,
        s.findoc,
        s.company,
        s.sosource,
        s.netamnt,
        s.salesman_code,
        a.user_id      AS rep_user_id,
        COALESCE(a.display_name, 'code ' || COALESCE(s.salesman_code, '?')) AS rep_name
   FROM vw_crm_sales s
   LEFT JOIN crm_rep_code_assignments a
          ON a.salesman_code = s.salesman_code
         AND s.trndate::date >= a.valid_from
         AND (a.valid_to IS NULL OR s.trndate::date < a.valid_to);

COMMENT ON VIEW vw_crm_sales_attributed IS
  'vw_crm_sales with the person who held the invoice''s salesman code on the invoice date. rep_user_id is NULL for pre-CRM reps; rep_name is always populated.';

GRANT SELECT ON vw_crm_sales_attributed TO authenticated;
GRANT ALL    ON vw_crm_sales_attributed TO service_role;

COMMIT;
