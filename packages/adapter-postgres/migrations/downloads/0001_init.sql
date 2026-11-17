create table assets (id text collate "C" primary key, doc jsonb not null);
create table grants (id text collate "C" primary key, doc jsonb not null);
create index grants_order on grants ((doc->>'orderId'));
create index grants_access on grants ((doc->>'accessHash'));
