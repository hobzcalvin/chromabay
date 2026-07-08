-- Private per-user pattern library for cross-client sync (PATTERN_LIFECYCLE.md §3/§5).
-- Distinct from public.patterns (the PUBLIC gallery): this is owner-only. Last-writer-wins by
-- `updated_ms` (the client's Date.now()), with `deleted` tombstones so removals propagate and
-- don't resurrect. `id` is a client-minted UUID (stable pattern identity).
create table if not exists public.library_patterns (
  id         uuid primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default '',
  blob       jsonb,                       -- SerializedPattern; null on a tombstone
  deleted    boolean not null default false,
  updated_ms bigint  not null default 0,  -- LWW clock (client epoch ms)
  created_at timestamptz not null default now()
);
create index if not exists library_patterns_user_idx on public.library_patterns (user_id);

alter table public.library_patterns enable row level security;
drop policy if exists lib_select_own on public.library_patterns;
drop policy if exists lib_insert_own on public.library_patterns;
drop policy if exists lib_update_own on public.library_patterns;
drop policy if exists lib_delete_own on public.library_patterns;
create policy lib_select_own on public.library_patterns for select using (auth.uid() = user_id);
create policy lib_insert_own on public.library_patterns for insert with check (auth.uid() = user_id);
create policy lib_update_own on public.library_patterns for update using (auth.uid() = user_id);
create policy lib_delete_own on public.library_patterns for delete using (auth.uid() = user_id);
