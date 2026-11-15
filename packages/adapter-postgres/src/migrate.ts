import { readdir, readFile } from "node:fs/promises";
import type { Sql } from "postgres";

const defaultDir = new URL("../migrations/", import.meta.url);

/**
 * @experimental Applies pending forward-only SQL migrations from
 * `<dir>/<module>/*.sql`, in module then file-name order, each in its own
 * transaction, recorded in `_migrations`. Safe to re-run and to call concurrently.
 */
export async function migrate(client: Sql, dir: URL = defaultDir) {
  await client`create table if not exists _migrations (module text, name text, primary key (module, name))`;
  const modules = (await readdir(dir)).sort();
  for (const module of modules) {
    const files = (await readdir(new URL(`${module}/`, dir))).sort();
    for (const name of files.filter((f) => f.endsWith(".sql"))) {
      const text = await readFile(new URL(`${module}/${name}`, dir), "utf8");
      await client.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(7243002)`;
        const done =
          await tx`select 1 from _migrations where module = ${module} and name = ${name}`;
        if (done.length > 0) return;
        await tx.unsafe(text);
        await tx`insert into _migrations values (${module}, ${name})`;
      });
    }
  }
}
