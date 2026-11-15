create table audit (id text collate "C" primary key, doc jsonb not null);
create index audit_actor on audit ((doc->'actor'->>'id'), id desc);
create function audit_append_only() returns trigger language plpgsql as $$
begin raise exception 'audit entries are append-only'; end $$;
create trigger audit_no_change before update or delete on audit
  for each row execute function audit_append_only();
