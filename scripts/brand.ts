import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type Brand = {
  name: string;
  slug: string;
  scope: string;
  cli: string;
  envPrefix: string;
  domain: string;
  repo: string;
  previous: string[];
};

// Never rewritten or checked: this file's data, the name ADR and the lockfile.
const ALLOW = [
  "brand.json",
  "docs/adr/0001-name-and-namespace.md",
  "pnpm-lock.yaml",
  "scripts/brand.test.ts",
];

export const deriveBrand = (
  old: Brand,
  name: string,
  scope?: string,
): Brand => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    ...old,
    name,
    slug,
    scope: scope ?? `@${slug}`,
    cli: slug,
    envPrefix: slug.toUpperCase().replace(/-/g, "_"),
    previous: [...old.previous, old.name],
  };
};

// Scope first: it contains the slug.
export const renameText = (text: string, from: Brand, to: Brand): string =>
  [
    [from.scope, to.scope],
    [from.name, to.name],
    [from.slug, to.slug],
    [from.envPrefix, to.envPrefix],
  ].reduce((t, [a, b]) => (a && b ? t.replaceAll(a, b) : t), text);

// Hard-coded names in source: a brand name anywhere except as a package scope.
export const findHardCoded = (text: string, brand: Brand): boolean =>
  [brand.name, ...brand.previous, brand.envPrefix]
    .concat(brand.slug)
    .some((n) =>
      new RegExp(`(?<!@)${n}`, "i").test(text.replaceAll(brand.scope, "")),
    );

const tracked = () =>
  execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (f) =>
        f && !ALLOW.includes(f) && !/\.(png|jpe?g|webp|ico|woff2?)$/.test(f),
    );

const check = (brand: Brand) => {
  const bad = tracked().filter(
    (f) =>
      /^(packages|apps)\/.*\/src\//.test(f) &&
      findHardCoded(readFileSync(f, "utf8"), brand),
  );
  if (bad.length)
    throw new Error(`Hard-coded brand name in:\n${bad.join("\n")}`);
};

const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

const rename = (brand: Brand, args: string[]) => {
  const to = flag(args, "--to");
  if (!to)
    throw new Error("usage: pnpm rename --to <name> [--scope @x] [--write]");
  const next = deriveBrand(brand, to, flag(args, "--scope"));
  const write = args.includes("--write");
  for (const f of tracked()) {
    const text = readFileSync(f, "utf8");
    const out = renameText(text, brand, next);
    if (out === text) continue;
    console.log(`${write ? "rewrote" : "would rewrite"} ${f}`);
    if (write) writeFileSync(f, out);
  }
  if (write) writeFileSync("brand.json", `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `${write ? "Done" : "Preview only (add --write)"}. Set domain/repo in brand.json yourself, then run pnpm install.`,
  );
};

const main = () => {
  const [cmd, ...args] = process.argv.slice(2);
  const brand: Brand = JSON.parse(readFileSync("brand.json", "utf8"));
  if (cmd === "check") check(brand);
  else if (cmd === "rename") rename(brand, args);
  else
    throw new Error(
      "usage: brand.ts check | rename --to <name> [--scope @x] [--write]",
    );
};

if (import.meta.main) main();
