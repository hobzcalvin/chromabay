-- Author-scoped gallery names: a user can't have two published patterns with the same name,
-- but different users can share a name (shown as "Name · by author"). Enables upsert-by-name.
create unique index if not exists patterns_author_name_uidx on public.patterns (author, name);
