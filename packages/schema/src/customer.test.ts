import { describe, expect, it } from "vitest";
import { Address, CUSTOMER_PII_FIELDS, Customer, newId } from "./index.js";

describe("Customer and Address", () => {
  const customer = {
    id: newId("cus"),
    kind: "guest",
    email: "a@example.com",
    name: null,
    phone: null,
    taxId: { type: "eu_vat", value: "DE123456789" },
    defaultAddressId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    anonymisedAt: null,
  };

  it("accepts guest and registered customers, rejects other kinds and bad email", () => {
    expect(Customer.safeParse(customer).success).toBe(true);
    expect(
      Customer.safeParse({ ...customer, kind: "registered" }).success,
    ).toBe(true);
    expect(Customer.safeParse({ ...customer, kind: "vip" }).success).toBe(
      false,
    );
    expect(Customer.safeParse({ ...customer, email: "nope" }).success).toBe(
      false,
    );
  });

  it("lists PII fields that all exist on Customer", () => {
    for (const f of CUSTOMER_PII_FIELDS) expect(f in customer).toBe(true);
  });

  it("requires uppercase ISO country and non-empty required lines", () => {
    const a = {
      id: newId("addr"),
      name: "A",
      line1: "1 St",
      city: "X",
      country: "US",
    };
    expect(Address.safeParse(a).success).toBe(true);
    expect(Address.safeParse({ ...a, country: "us" }).success).toBe(false);
    expect(Address.safeParse({ ...a, city: " " }).success).toBe(false);
  });
});
