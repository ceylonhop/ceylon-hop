-- Enable Row-Level Security on every table in `public`.
--
-- Supabase's Security Advisor flags all 25 tables as `rls_disabled_in_public`: the schema is
-- exposed through PostgREST, and Supabase's default grants give the `anon` and `authenticated`
-- roles full CRUD on it. With RLS off, nothing filters rows — anyone holding the project's
-- anon key could read or delete `payments`, `customers` and `bookings` wholesale.
--
-- Nothing we ship exposes that key: there is no Supabase client anywhere in the front-end or
-- the API, no anon key and no supabase.co URL in the repo, and the API connects straight to
-- Postgres with a connection string. So this is not a live breach — it is one leaked or
-- future-pasted key away from being one, and the key is designed to be publishable.
--
-- NO POLICIES ARE ADDED, deliberately. RLS with no policy denies every row to every role that
-- is subject to it, which is exactly right here: PostgREST is not a surface we use, so `anon`
-- should see nothing at all. The API is unaffected because it connects as `postgres`, and that
-- role has rolbypassrls = true (verified on ceylon-hop-staging, 2026-08-19: current_user
-- postgres, rolsuper false, rolbypassrls TRUE). It is also the table owner, which bypasses RLS
-- again unless FORCE ROW LEVEL SECURITY is set — which this migration does not set.
--
-- Looped rather than listed: a hand-written list of 25 tables silently misses whichever one is
-- added next, and the whole point is that nothing in `public` is left open. Enabling RLS twice
-- is a no-op, so re-running is harmless.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
