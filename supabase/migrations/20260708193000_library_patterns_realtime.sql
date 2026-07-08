-- Enable Supabase Realtime for the private library so a change on one client pushes to the
-- user's other open sessions instantly (RLS still scopes events per user). Idempotent.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'library_patterns'
  ) then
    alter publication supabase_realtime add table public.library_patterns;
  end if;
end $$;
