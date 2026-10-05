/**
 * Placeholder for the V2 finance screen.
 *
 * Replaced wholesale in Phase 8. The presentation contract it must satisfy --
 * delivery and discount lines are components ALREADY INSIDE gross sales, and
 * labelling them in a way that invites addition is the defect -- is preserved
 * verbatim in docs/rebuild-phase-0-inventory.md and in
 * supabase/test/verify_finance.sql, which is the authoritative version.
 *
 * V1's `scripts/finance-wording.test.mjs` asserted that contract against the V1
 * screen source. It was removed with the screen it guarded, deliberately rather
 * than left failing: a test whose subject no longer exists is not a safety net,
 * it is noise that trains you to ignore red.
 */

/*
 * Gross sales is the sum of order totals. An order total is
 * items - discount + delivery, so the delivery and discount lines are
 * components ALREADY INSIDE gross sales. Adding them double-counts delivery.
 */