create table api_keys (id text collate "C" primary key, doc jsonb not null);
create unique index api_keys_hash on api_keys ((doc->>'hash'));
