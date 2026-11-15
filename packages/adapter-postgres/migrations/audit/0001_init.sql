create table audit (id text collate "C" primary key, doc jsonb not null);
create index audit_actor on audit ((doc->'actor'->>'id'), id desc);
