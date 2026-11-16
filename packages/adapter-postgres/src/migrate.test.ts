import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";

const url = process.env.TEST_DATABASE_URL;
const realDir = new URL("../migrations/", import.meta.url);

/**
 * Upgrade harness for every release: apply the previous release's migrations to a
 * scratch schema, insert data, then apply the new migration set and assert the
 * data survived. To add a release, copy the `vN` block with the new migration file.
 */
describe.skipIf(!url)("upgrade migrations", () => {
  const schema = `upgrade_${process.pid}`;
  const admin = postgres(url ?? "", { onnotice: () => {} });
  const client = postgres(url ?? "", {
    onnotice: () => {},
    connection: { search_path: schema },
  });
  afterAll(async () => {
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await Promise.all([client.end(), admin.end()]);
  });

  it("keeps data across an additive migration and re-running is a no-op", async () => {
    await admin.unsafe(`create schema ${schema}`);
    await migrate(client, realDir); // previous release
    await client`insert into products values ('prod_a', ${client.json({ title: "Mug" })})`;

    const next = new URL(
      `${pathToFileURL(await mkdtemp(join(tmpdir(), "mig-")))}/`,
    );
    await cp(realDir, next, { recursive: true });
    await writeFile(
      new URL("products/0002_title_index.sql", next),
      "create index products_title on products ((doc->>'title'));",
    );
    await migrate(client, next);
    await migrate(client, next);

    expect(await client`select doc from products where id = 'prod_a'`).toEqual([
      { doc: { title: "Mug" } },
    ]);
    expect(await client`select count(*)::int as n from _migrations`).toEqual([
      { n: 14 },
    ]);
  });
});
