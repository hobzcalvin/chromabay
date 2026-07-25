-- Account deletion (App Store Guideline 5.1.1(v): an app with account creation must let users
-- delete their account in-app). The client can't delete its own auth.users row with the anon
-- key, so this SECURITY DEFINER function (owned by a privileged role) does it for the CALLER
-- only — it operates strictly on auth.uid(), so a signed-in user can delete only themselves.
--
-- Deleting auth.users cascades profiles / owner_keys / upvotes / library_patterns (all FK'd
-- ON DELETE CASCADE). We ALSO remove the user's public gallery patterns (patterns.author is
-- ON DELETE SET NULL, which would otherwise leave authorless rows) and their own upvotes, so
-- account deletion truly removes their data.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- The caller's own data (explicit — belt-and-suspenders alongside the FK cascades).
  delete from public.upvotes          where user_id = uid;  -- their votes on others' patterns
  delete from public.patterns         where author  = uid;  -- their gallery entries (else set-null)
  delete from public.library_patterns where user_id = uid;  -- their synced library
  delete from public.owner_keys       where user_id = uid;  -- their device keyring
  delete from public.profiles         where id      = uid;

  -- The account itself. Cascades any remaining FK'd rows.
  delete from auth.users where id = uid;
end;
$$;

-- Only a signed-in user may call it (and it self-scopes to auth.uid()).
revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
