create table webhook_endpoints (id text collate "C" primary key, doc jsonb not null);
create table webhook_deliveries (id text collate "C" primary key, doc jsonb not null);
create index webhook_deliveries_due on webhook_deliveries ((doc->>'nextAttemptAt') collate "C") where doc->>'status' = 'pending';
create index webhook_deliveries_endpoint on webhook_deliveries ((doc->>'endpointId'), id desc);
