create table product_search (
  id text collate "C" primary key,
  created_at text collate "C" not null,
  collection_ids text[] not null,
  option_tokens text[] not null,
  delivery_types text[] not null,
  prices jsonb not null,
  available boolean not null,
  tsv tsvector not null
);
create index product_search_tsv on product_search using gin (tsv);
create index product_search_collections on product_search using gin (collection_ids);
create index product_search_options on product_search using gin (option_tokens);
