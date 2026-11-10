-- Enable row level security on every table in public. Touches no rows; reversible per table with
--   ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY;
--
-- ORDER MATTERS: run this only AFTER the server client (src/lib/supabase.ts) uses the service-role key
-- and that build is live. Until then the app reads and writes through the anon key, and RLS with no
-- policies would deny every query.
--
-- No policies are created on purpose. The only caller is the server (service-role key, bypasses RLS);
-- the public anon key must not be able to read or write anything. Idempotent: already-enabled tables
-- are skipped, and tables created by hand outside the migrations are covered because the list comes
-- from the catalog, not from this repo.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
      -- skip tables owned by an extension (we cannot alter those, and a failure would roll back the whole block)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    RAISE NOTICE 'RLS enabled on public.%', r.relname;
  END LOOP;
END $$;
