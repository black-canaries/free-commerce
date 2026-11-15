import { authConformance } from "@free-commerce/core/testing";
import { describe, expect, it } from "vitest";
import { createBetterAuth } from "./index.js";

const make = () => createBetterAuth({ secret: "s".repeat(40) });

authConformance("better-auth", make);

describe("better-auth adapter", () => {
  it("mints realm-prefixed ids", async () => {
    const auth = make();
    const input = {
      email: "a@example.com",
      password: "correct horse",
      name: "A",
    };
    expect((await auth.signUp("customer", input)).userId).toMatch(/^cus_/);
    expect((await auth.signUp("admin", input)).userId).toMatch(/^adm_/);
  });

  it("rejects a short secret", () => {
    expect(() => createBetterAuth({ secret: "short" })).toThrow(RangeError);
  });
});
