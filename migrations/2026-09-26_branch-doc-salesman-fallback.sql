-- ============================================================================
-- INTERIM: attribute branch documents to the customer's current rep.
--
-- Softone does not stamp SALESMAN on invoices written against a customer branch
-- (TRDBRANCH set). In 2026 that is 1,668 documents worth ~EUR 92k across 66
-- branches and every rep. TRDBRANCH.SALESMAN exists but is empty on all 66, so
-- there is nothing in the ERP to fall back to.
--
-- Until that is fixed at source, those documents borrow the rep currently
-- assigned to the parent customer.
--
-- READ THIS BEFORE RELYING ON IT. The borrowed rep is the customer's CURRENT
-- rep, which is mutable — the exact failure mode the invoice-level column was
-- added to remove. These rows WILL move between reps when a book changes hands.
-- That is why every row carries attribution_source: filter to 'invoice' for
-- anything that must be stable (commission, rep comparison over time), and
-- treat 'branch_fallback' as an estimate.
--
-- TO REVERT once Softone stamps these properly: re-run the
-- vw_crm_sales_attributed definition from
-- 2026-09-26_rep-code-assignments-and-findoc-salesman.sql, which has no
-- fallback. Nothing else here needs undoing — no base table is modified.
-- ============================================================================

BEGIN;

-- expose trdbranch so the fallback can be limited to genuine branch documents
-- rather than every row that happens to lack a salesman
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
    f.salesman_code,
    f.trdbranch
   FROM stg_soft1_findoc f
     LEFT JOIN stg_soft1_findoc_netamnt n ON f.findoc = n.findoc AND f.company = n.company
  WHERE f.company = 1000 AND (f.series = ANY (ARRAY[7061, 7062, 7080, 7063, 7064, 9962, 9964, 7067]));

-- dropped rather than replaced: the new columns sit mid-list and CREATE OR
-- REPLACE cannot reorder. Safe today because nothing reads this view yet —
-- check pg_depend before doing this again once the dashboard is pointed at it.
DROP VIEW IF EXISTS vw_crm_sales_attributed;

CREATE VIEW vw_crm_sales_attributed AS
 WITH base AS (
   SELECT s.trdr, s.trndate, s.series, s.findoc, s.company, s.sosource,
          s.netamnt, s.salesman_code, s.trdbranch,
          -- the code we will actually attribute on
          COALESCE(s.salesman_code,
                   CASE WHEN s.trdbranch IS NOT NULL THEN c.salesman_code END) AS effective_code,
          CASE
            WHEN s.salesman_code IS NOT NULL                                THEN 'invoice'
            WHEN s.trdbranch IS NOT NULL AND c.salesman_code IS NOT NULL    THEN 'branch_fallback'
            ELSE 'none'
          END AS attribution_source
     FROM vw_crm_sales s
     LEFT JOIN vw_crm_customers c ON c.trdr_id = s.trdr::integer
 )
 SELECT b.trdr,
        b.trndate,
        b.series,
        b.findoc,
        b.company,
        b.sosource,
        b.netamnt,
        b.salesman_code,          -- NULL when Softone stamped nothing
        b.trdbranch,
        b.effective_code AS attributed_code,
        b.attribution_source,     -- 'invoice' | 'branch_fallback' | 'none'
        a.user_id        AS rep_user_id,
        COALESCE(a.display_name, 'code ' || COALESCE(b.effective_code, '?')) AS rep_name
   FROM base b
   LEFT JOIN crm_rep_code_assignments a
          ON a.salesman_code = b.effective_code
         AND b.trndate::date >= a.valid_from
         AND (a.valid_to IS NULL OR b.trndate::date < a.valid_to);

COMMENT ON VIEW vw_crm_sales_attributed IS
  'Sales with the rep who held the invoice''s salesman code on the invoice date. attribution_source = invoice (stamped by Softone, stable) | branch_fallback (borrowed from the customer''s CURRENT rep because Softone left branch documents unstamped — mutable, treat as an estimate) | none. Filter to invoice for commission and any comparison over time.';

GRANT SELECT ON vw_crm_sales_attributed TO authenticated;
GRANT ALL    ON vw_crm_sales_attributed TO service_role;

COMMIT;
