-- ChromaBay pattern lifecycle — cloud foundation (Phase 4 backend).
-- Maps to PATTERN_LIFECYCLE.md: the account is a synced keyring (owner_keys) + your
-- library; the gallery is content-addressed patterns with upvotes. Lineage columns exist
-- but are unused until the gallery phase actually needs them (kept nullable, no behaviour).
-- Nothing here touches the app's local-first flow; it is inert until the client opts in.

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user (public identity)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user appears.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- owner_keys: the synced keyring — the owner keys a user holds for their devices.
-- Logging in on any client pulls these down → "own all your devices, everywhere".
-- ---------------------------------------------------------------------------
create table if not exists public.owner_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_label text,
  public_key   text not null,          -- the key a device stores in its owner set
  created_at   timestamptz not null default now(),
  unique (user_id, public_key)
);

-- ---------------------------------------------------------------------------
-- patterns: gallery entries. blob = the SerializedPattern. content_hash for dedup;
-- parent_id for fork lineage (both deferred-use, present so we don't re-migrate later).
-- ---------------------------------------------------------------------------
create table if not exists public.patterns (
  id           uuid primary key default gen_random_uuid(),
  author       uuid references auth.users(id) on delete set null,
  name         text not null,
  blob         jsonb not null,
  content_hash text,
  parent_id    uuid references public.patterns(id) on delete set null,
  tags         text[] not null default '{}',
  upvote_count int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists patterns_content_hash_idx on public.patterns (content_hash);
create index if not exists patterns_created_idx       on public.patterns (created_at desc);
create index if not exists patterns_upvotes_idx       on public.patterns (upvote_count desc);

-- ---------------------------------------------------------------------------
-- upvotes: one per (user, pattern); maintain patterns.upvote_count via trigger.
-- ---------------------------------------------------------------------------
create table if not exists public.upvotes (
  user_id    uuid not null references auth.users(id) on delete cascade,
  pattern_id uuid not null references public.patterns(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, pattern_id)
);

create or replace function public.sync_upvote_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT') then
    update public.patterns set upvote_count = upvote_count + 1 where id = new.pattern_id;
  elsif (tg_op = 'DELETE') then
    update public.patterns set upvote_count = greatest(0, upvote_count - 1) where id = old.pattern_id;
  end if;
  return null;
end; $$;
drop trigger if exists upvotes_count on public.upvotes;
create trigger upvotes_count after insert or delete on public.upvotes
  for each row execute function public.sync_upvote_count();

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.owner_keys enable row level security;
alter table public.patterns   enable row level security;
alter table public.upvotes    enable row level security;

-- profiles: world-readable, self-writable
drop policy if exists profiles_read       on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_read        on public.profiles for select using (true);
create policy profiles_insert_self on public.profiles for insert with check (auth.uid() = id);
create policy profiles_update_self on public.profiles for update using (auth.uid() = id);

-- owner_keys: strictly private to the user
drop policy if exists keys_select_own on public.owner_keys;
drop policy if exists keys_insert_own on public.owner_keys;
drop policy if exists keys_delete_own on public.owner_keys;
create policy keys_select_own on public.owner_keys for select using (auth.uid() = user_id);
create policy keys_insert_own on public.owner_keys for insert with check (auth.uid() = user_id);
create policy keys_delete_own on public.owner_keys for delete using (auth.uid() = user_id);

-- patterns: world-readable; only the author may write/delete
drop policy if exists patterns_read       on public.patterns;
drop policy if exists patterns_insert_own on public.patterns;
drop policy if exists patterns_update_own on public.patterns;
drop policy if exists patterns_delete_own on public.patterns;
create policy patterns_read       on public.patterns for select using (true);
create policy patterns_insert_own on public.patterns for insert with check (auth.uid() = author);
create policy patterns_update_own on public.patterns for update using (auth.uid() = author);
create policy patterns_delete_own on public.patterns for delete using (auth.uid() = author);

-- upvotes: user manages only their own vote rows
drop policy if exists upvotes_select_own on public.upvotes;
drop policy if exists upvotes_insert_own on public.upvotes;
drop policy if exists upvotes_delete_own on public.upvotes;
create policy upvotes_select_own on public.upvotes for select using (auth.uid() = user_id);
create policy upvotes_insert_own on public.upvotes for insert with check (auth.uid() = user_id);
create policy upvotes_delete_own on public.upvotes for delete using (auth.uid() = user_id);
