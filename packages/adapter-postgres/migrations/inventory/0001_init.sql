create table stock (variant_id text collate "C" primary key, quantity integer not null);
create table reservations (
  id text collate "C" primary key,
  variant_id text collate "C" not null,
  cart_id text not null,
  quantity integer not null check (quantity > 0),
  expires_at timestamptz not null,
  status text not null check (status in ('active', 'committed', 'released'))
);
create index reservations_active on reservations (variant_id) where status = 'active';
