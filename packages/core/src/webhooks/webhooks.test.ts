import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isPrivateAddress,
  signWebhook,
  verifyWebhook,
  webhookUrlProblem,
} from "./webhooks";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("signature", () => {
  const input = async (over: Record<string, unknown> = {}) => ({
    secret: "whsec_abc",
    id: "evt_1",
    timestamp: "1700000000",
    body: '{"a":1}',
    now: 1700000010,
    signature: await signWebhook("whsec_abc", "evt_1", 1700000000, '{"a":1}'),
    ...over,
  });

  it("verifies what signWebhook produced, including among several signatures", async () => {
    const i = await input();
    expect(await verifyWebhook(i)).toBe(true);
    expect(
      await verifyWebhook({ ...i, signature: `v1,AAAA ${i.signature}` }),
    ).toBe(true);
  });

  it("is the documented HMAC-SHA256 over id.timestamp.body", async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("whsec_abc"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode('evt_1.1700000000.{"a":1}'),
      ),
    );
    expect((await input()).signature).toBe(
      `v1,${btoa(String.fromCharCode(...mac))}`,
    );
  });

  it.each([
    ["body", { body: '{"a":2}' }],
    ["id", { id: "evt_2" }],
    ["secret", { secret: "whsec_other" }],
    ["timestamp", { timestamp: "1700000001" }],
    ["stale timestamp", { now: 1700000000 + 301 }],
    ["future timestamp", { now: 1700000000 - 301 }],
    ["garbage signature", { signature: "v1,%%%" }],
    ["unknown version", { signature: "v2,AAAA" }],
  ])("rejects a changed %s", async (_name, over) => {
    expect(await verifyWebhook(await input(over))).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips, never stores the plaintext and uses a fresh IV", async () => {
    const a = await encryptSecret(KEY, "whsec_x");
    expect(a).not.toContain("whsec_x");
    expect(a).not.toBe(await encryptSecret(KEY, "whsec_x"));
    expect(await decryptSecret(KEY, a)).toBe("whsec_x");
  });

  it("fails with the wrong key or a tampered ciphertext", async () => {
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
    const a = await encryptSecret(KEY, "whsec_x");
    await expect(decryptSecret(other, a)).rejects.toThrow();
    await expect(decryptSecret(KEY, `${a.slice(0, -4)}AAAA`)).rejects.toThrow();
    await expect(encryptSecret("c2hvcnQ=", "x")).rejects.toThrow("32 bytes");
  });
});

describe("SSRF guard", () => {
  it.each([
    "https://example.com/hook",
    "https://hooks.example.co.uk:8443/a?b=1",
    "https://8.8.8.8/x",
    "https://[2606:4700:4700::1111]/x",
  ])("allows %s", (url) => expect(webhookUrlProblem(url)).toBeNull());

  it.each([
    "http://example.com/hook",
    "ftp://example.com",
    "not a url",
    "https://user:pw@example.com/",
    "https://localhost/x",
    "https://app.localhost/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://intranet/x",
    "https://127.0.0.1/x",
    "https://127.1/x",
    "https://2130706433/x",
    "https://0x7f.0.0.1/x",
    "https://0.0.0.0/x",
    "https://10.1.2.3/x",
    "https://172.16.0.1/x",
    "https://172.31.255.255/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x",
    "https://224.0.0.1/x",
    "https://[::1]/x",
    "https://[::]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:169.254.169.254]/x",
    "https://[fe80::1]/x",
    "https://[fc00::1]/x",
    "https://[fd12:3456::1]/x",
    "https://[64:ff9b::7f00:1]/x",
    "https://[2002:7f00:1::1]/x",
  ])("rejects %s", (url) => expect(webhookUrlProblem(url)).not.toBeNull());

  it("lets dev mode use http and local hosts, but still not credentials", () => {
    expect(webhookUrlProblem("http://localhost:3000/hook", true)).toBeNull();
    expect(webhookUrlProblem("ftp://localhost/", true)).not.toBeNull();
    expect(webhookUrlProblem("http://u:p@localhost/", true)).not.toBeNull();
  });

  it("classifies bare addresses (resolver output)", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});
