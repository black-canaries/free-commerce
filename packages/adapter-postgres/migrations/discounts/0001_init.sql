create table discounts (id text collate "C" primary key, doc jsonb not null);
create unique index discounts_code on discounts ((doc->>'code'));
create table redemptions (
  id text collate "C" primary key,
  code_id text collate "C" not null,
  customer_key text
);
create index redemptions_code on redemptions (code_id);
