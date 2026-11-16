create index orders_customer on orders ((doc->>'customerId'));
