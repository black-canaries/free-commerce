create table addresses (id text collate "C" primary key, doc jsonb not null);
create index addresses_customer on addresses ((doc->>'customerId'));
