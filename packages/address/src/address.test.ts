import type { Address } from "@free-commerce/schema";
import { describe, expect, it } from "vitest";
import { formatAddress, validateAddress } from "./index.js";

const base = { id: "addr_01J0000000000000000000000A", name: "Ann Lee" };
const addr = (a: Omit<Address, "id" | "name">): Address => ({ ...base, ...a });

const valid: [string, Address, string[]][] = [
  [
    "US",
    addr({
      line1: "1600 Pennsylvania Ave NW",
      city: "Washington",
      region: "DC",
      postalCode: "20500",
      country: "US",
    }),
    ["Ann Lee", "1600 Pennsylvania Ave NW", "Washington, DC 20500"],
  ],
  [
    "GB",
    addr({
      line1: "10 Downing St",
      city: "London",
      postalCode: "SW1A 2AA",
      country: "GB",
    }),
    ["Ann Lee", "10 Downing St", "London", "SW1A 2AA"],
  ],
  [
    "DE",
    addr({
      line1: "Unter den Linden 1",
      city: "Berlin",
      postalCode: "10117",
      country: "DE",
    }),
    ["Ann Lee", "Unter den Linden 1", "10117 Berlin"],
  ],
  [
    "JP",
    addr({
      line1: "1-1 Chiyoda",
      city: "Chiyoda-ku",
      region: "Tokyo",
      postalCode: "100-0001",
      country: "JP",
    }),
    ["Ann Lee", "1-1 Chiyoda", "Chiyoda-ku, Tokyo 100-0001"],
  ],
  [
    "BR",
    addr({
      line1: "Av Paulista 1000",
      city: "São Paulo",
      region: "SP",
      postalCode: "01310-100",
      country: "BR",
    }),
    ["Ann Lee", "Av Paulista 1000", "São Paulo - SP", "01310-100"],
  ],
];

const of = (country: string): Address => {
  const found = valid.find(([c]) => c === country);
  if (!found) throw new Error(country);
  return found[1];
};

describe("address", () => {
  it.each(valid)("%s validates and formats", (_c, a, lines) => {
    expect(validateAddress(a)).toEqual({ ok: true });
    expect(formatAddress(a)).toEqual(lines);
  });

  it.each([
    ["US", "2050", "20500"],
    ["GB", "12345", "SW1A 2AA"],
    ["DE", "1011", "10117"],
    ["JP", "1000001x", "100-0001"],
    ["BR", "1234", "01310-100"],
  ])("%s rejects bad postal code naming the field", (country, bad, good) => {
    const a = of(country);
    expect(validateAddress({ ...a, postalCode: bad })).toEqual({
      ok: false,
      issues: [{ field: "postalCode", code: "invalid" }],
    });
    expect(validateAddress({ ...a, postalCode: good })).toEqual({ ok: true });
  });

  it.each(["US", "JP", "BR"])("%s requires a region", (country) => {
    const { region: _r, ...a } = of(country);
    expect(validateAddress(a)).toEqual({
      ok: false,
      issues: [{ field: "region", code: "required" }],
    });
  });

  it("requires a postal code where the country has a format", () => {
    const { postalCode: _p, ...a } = of("DE");
    expect(validateAddress(a)).toEqual({
      ok: false,
      issues: [{ field: "postalCode", code: "required" }],
    });
  });

  it("rejects unknown countries", () => {
    expect(
      validateAddress(addr({ line1: "x", city: "y", country: "ZZ" })),
    ).toEqual({
      ok: false,
      issues: [{ field: "country", code: "invalid" }],
    });
  });

  it("places line2 after the street and company before it", () => {
    const a = {
      ...of("US"),
      line2: "Apt 4",
      company: "Acme",
    };
    expect(formatAddress(a)).toEqual([
      "Ann Lee",
      "Acme",
      "1600 Pennsylvania Ave NW",
      "Apt 4",
      "Washington, DC 20500",
    ]);
  });
});
