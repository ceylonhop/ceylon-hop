-- ════════════════════════════════════════════════════════════════════════════
--  Ceylon Hop — CLEAR TEST DATA (go-live reset)
-- ════════════════════════════════════════════════════════════════════════════
--
--  ⚠️  DESTRUCTIVE. This wipes ALL bookings, customers, payments, tasks, shared
--      seat inventory and ops rows. It does NOT touch the `corridor` table
--      (seeded route reference data the shared-booking flow needs).
--
--  WHEN TO RUN: once, immediately before go-live, while every row in the
--  database is still test data (sandbox PayHere proofs, e2e bookings, demo
--  rows). After real customers exist, DO NOT run this — take a backup first and
--  delete selectively instead.
--
--  HOW TO RUN:
--    • Supabase → SQL Editor → paste → Run, OR
--    • psql "$DATABASE_URL" -f api/scripts/clear-test-data.sql
--
--  Safe to run on the FREE tier (no backups there) only because, pre-launch,
--  there is nothing of value to lose. Confirm you are pointed at the right
--  project before running.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- One statement: TRUNCATE all transactional + ops tables together so foreign
-- keys never block us. CASCADE also clears any dependent rows not listed here.
-- `corridor` is intentionally omitted — it is seeded reference data.
TRUNCATE TABLE
  customers,
  bookings,
  transfer_request,
  trip_request,
  shared_request,
  quotes,
  payments,
  concierge_tasks,
  shared_departure,   -- resets seat inventory: test holds no longer pre-consume real availability
  ride_ops,
  notification_log,
  alert_log
RESTART IDENTITY CASCADE;

COMMIT;

-- Sanity check (run after): every cleared table should report 0; corridor keeps its seeds.
-- SELECT 'bookings' t, count(*) FROM bookings
-- UNION ALL SELECT 'payments', count(*) FROM payments
-- UNION ALL SELECT 'customers', count(*) FROM customers
-- UNION ALL SELECT 'shared_departure', count(*) FROM shared_departure
-- UNION ALL SELECT 'corridor (kept)', count(*) FROM corridor;
