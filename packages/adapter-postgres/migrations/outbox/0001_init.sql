create table outbox (
  seq bigserial primary key,
  id text collate "C" not null unique,
  event jsonb not null,
  delivered_at timestamptz
);
create index outbox_pending on outbox (seq) where delivered_at is null;
