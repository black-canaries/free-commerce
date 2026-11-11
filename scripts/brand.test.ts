import { describe, expect, it } from "vitest";
import { deriveBrand, findHardCoded, renameText } from "./brand.ts";

const old = {
  name: "Free-commerce",
  slug: "free-commerce",
  scope: "@free-commerce",
  cli: "free-commerce",
  envPrefix: "FREE_COMMERCE",
  domain: "",
  repo: "",
  previous: [],
};

describe("brand", () => {
  const next = deriveBrand(old, "Acme Shop");

  it("rewrites scope, name, slug and env prefix consistently", () => {
    const text =
      'import "@free-commerce/core"; FREE_COMMERCE_URL; Free-commerce; free-commerce add';
    expect(renameText(text, old, next)).toBe(
      'import "@acme-shop/core"; ACME_SHOP_URL; Acme Shop; acme-shop add',
    );
  });

  it("honours an explicit scope", () => {
    expect(
      renameText(
        "@free-commerce/core free-commerce",
        old,
        deriveBrand(old, "Acme", "@acme-co"),
      ),
    ).toBe("@acme-co/core acme");
  });

  it("flags a hard-coded name but allows the package scope", () => {
    expect(findHardCoded('const t = "Free-commerce";', old)).toBe(true);
    expect(findHardCoded('import "@free-commerce/core";', old)).toBe(false);
  });

  it("remembers the previous name so it keeps being flagged", () => {
    expect(
      findHardCoded("Free-commerce", { ...next, previous: [old.name] }),
    ).toBe(true);
  });
});
