import {
  outboxConformance,
  repositoryConformance,
} from "@free-commerce/adapter-testkit";
import { apiKeyStoreConformance } from "@free-commerce/core/testing";
import postgres from "postgres";
import { afterAll, describe, it } from "vitest";
import { createPostgresApiKeyStore, createPostgresDatabase } from "./index";
import { migrate } from "./migrate";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  // CI must never silently skip: the Postgres suite is required there.
  if (process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI");
  describe.skip("Database conformance: postgres", () => {
    it("skipped: set TEST_DATABASE_URL, e.g. postgres://postgres:postgres@localhost:55432/postgres (docker run -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine)", () => {});
  });
} else {
  const client = postgres(url, { onnotice: () => {} });
  afterAll(() => client.end());
  const make = async () => {
    await migrate(client);
    await client`truncate products, carts, orders, customers, addresses, stock, reservations, outbox, discounts, redemptions, roles, audit, api_keys, assets, grants, webhook_endpoints, webhook_deliveries`;
    return createPostgresDatabase(client);
  };
  repositoryConformance("postgres", make);
  outboxConformance("postgres", make);
  apiKeyStoreConformance("postgres", async () => {
    await make();
    return createPostgresApiKeyStore(client);
  });
}
