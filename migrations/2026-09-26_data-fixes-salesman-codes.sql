-- ============================================================================
-- Data fixes applied by hand on 2026-09-26, recorded so a rebuild from this
-- folder does not lose them.
--
-- These touch rows, not schema. Every statement is guarded so it is a no-op
-- when already applied or when the target row does not exist (e.g. on a fresh
-- database where the profile rows have not been restored yet). Re-running is
-- safe and will report UPDATE 0.
--
-- Background: the CRM keys reps on Softone's PRSN.PRSN (29, 31, 1584, 1614,
-- 1721, 1735, 1849), NOT on PRSN.CODE (102, 103, 105, 111, 121, 122, 127).
-- Both fixes below are that distinction being got wrong once each.
-- ============================================================================

BEGIN;

-- 1. Makris had no salesman_code at all, so he appeared in the planning
--    suggestions picker (filters on role) but not in the new-visit picker or
--    /api/erp/reps (both require a code). His Softone person code is 1735.
--    Small book: 3 customers, 2 active.
UPDATE crm_user_profiles
   SET salesman_code = '1735'
 WHERE id = 'c1e7a98d-220d-4b0a-af09-ab549c9891a6'
   AND salesman_code IS NULL;

-- 2. One visit of his was stamped '122' — that is PRSN.CODE for ΜΑΚΡΗΣ, while
--    every other visit in the table uses PRSN.PRSN. Same person either way, so
--    this corrects a code-system mismatch rather than reassigning the work.
--    Guarded on user_id as well so it cannot touch anyone else's row.
UPDATE crm_visits
   SET salesman_code = '1735'
 WHERE id = '4da9a439-ad6a-4cc5-bf42-38811cf76660'
   AND salesman_code = '122'
   AND user_id = 'c1e7a98d-220d-4b0a-af09-ab549c9891a6';

-- 3. Keep the tenure row's note honest now that his profile carries the code.
--    Seeded by 2026-09-26_rep-code-assignments-and-findoc-salesman.sql.
UPDATE crm_rep_code_assignments
   SET note = 'CRM profile salesman_code set 2026-09-26'
 WHERE salesman_code = '1735'
   AND note IS DISTINCT FROM 'CRM profile salesman_code set 2026-09-26';

COMMIT;

-- ---------------------------------------------------------------------------
-- Deliberately NOT fixed here:
--
--   2 visits by the Admin account (2026-05-12, 2026-05-26) with a blank
--   salesman_code. Admin has no rep code by design and these look like setup
--   tests, but whether to delete or reassign them is a call about real field
--   history, so it is left to a human.
--
--   The offboarding of Vakouftshs (profile disabled, salesman_code cleared)
--   and the handover of code 1721 to crm-temp are NOT replayed here. Those are
--   operational events, not fixes, and re-running them against a restored
--   database could disable the wrong account. crm_rep_code_assignments already
--   records that tenure change.
-- ---------------------------------------------------------------------------
