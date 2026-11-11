import { describe, expect, it } from "vitest";
import { ProviderError } from "../providers/error";
import { type CheckoutDeps, completeCheckout } from "./checkout.fake";
import { createSagaRunner, type Saga, type Span } from "./runner";
import { createFakeSagaStore } from "./store.fake";

function setup(failAt?: string) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const call = async (name: string, key: string) => {
    if (failAt === name) throw new Error(`${name} failed`);
    if (!seen.has(key)) calls.push(name); // providers dedupe on key
    seen.add(key);
    return `${name}-id`;
  };
  const deps: CheckoutDeps = {
    reserveStock: (k) => call("reserve", k),
    releaseStock: async (k) => void (await call("release", k)),
    createPayment: (k) => call("pay", k),
    cancelPayment: async (k) => void (await call("cancel", k)),
    confirmOrder: (k) => call("confirm", k),
  };
  let t = 0;
  const spans: { name: string; status?: number; ended: boolean }[] = [];
  const runner = createSagaRunner({
    store: createFakeSagaStore(),
    now: () => t,
    tracer: {
      startSpan(name, o) {
        const s = {
          name: `${name}:${o?.attributes?.["saga.step"]}`,
          ended: false,
        } as {
          name: string;
          status?: number;
          ended: boolean;
        };
        spans.push(s);
        return {
          end: () => {
            s.ended = true;
          },
          setStatus: (x) => {
            s.status = x.code;
          },
          recordException: () => undefined,
        } satisfies Span;
      },
    },
  });
  return {
    runner,
    calls,
    spans,
    saga: completeCheckout(deps),
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const input = { cartId: "cart_1", amount: 1000 };

describe("completeCheckout saga", () => {
  it("runs to the pause, then completes on the webhook", async () => {
    const { runner, saga, calls } = setup();
    const paused = await runner.start(saga, "r1", input);
    expect(paused.status).toBe("paused");
    expect(calls).toEqual(["reserve", "pay"]);
    const done = await runner.resume(saga, "r1", "payment.succeeded", {
      ok: true,
    });
    expect(done.status).toBe("completed");
    expect(done.steps["await-payment"]?.result).toEqual({ ok: true });
    expect(calls).toEqual(["reserve", "pay", "confirm"]);
  });

  it("ignores duplicate, wrong-event and unknown-state webhooks", async () => {
    const { runner, saga, calls } = setup();
    await runner.start(saga, "r1", input);
    expect((await runner.resume(saga, "r1", "other", 1)).status).toBe("paused");
    await runner.resume(saga, "r1", "payment.succeeded", 1);
    const again = await runner.resume(saga, "r1", "payment.succeeded", 2);
    expect(again.steps["await-payment"]?.result).toBe(1);
    expect(calls.filter((c) => c === "confirm")).toHaveLength(1);
    await expect(runner.resume(saga, "nope", "x", 1)).rejects.toThrow(
      "not found",
    );
  });

  it.each([
    ["reserve", []],
    ["pay", ["release"]],
    ["confirm", ["cancel", "release"]],
  ])(
    "failure at %s compensates completed steps in reverse",
    async (failAt, undo) => {
      const { runner, saga, calls } = setup(failAt);
      let run = await runner.start(saga, "r1", input);
      if (run.status === "paused")
        run = await runner.resume(saga, "r1", "payment.succeeded", 1);
      expect(run.status).toBe("compensated");
      expect(run.error).toContain(`${failAt} failed`);
      expect(calls.filter((c) => ["release", "cancel"].includes(c))).toEqual(
        undo,
      );
    },
  );

  it("pause timeout compensates in reverse (expire and late webhook)", async () => {
    for (const late of [false, true]) {
      const { runner, saga, calls, advance } = setup();
      await runner.start(saga, "r1", input);
      expect((await runner.expire(saga, "r1")).status).toBe("paused"); // too early
      advance(30 * 60_000);
      const run = late
        ? await runner.resume(saga, "r1", "payment.succeeded", 1)
        : await runner.expire(saga, "r1");
      expect(run.status).toBe("compensated");
      expect(run.error).toContain("timed out");
      expect(calls).toEqual(["reserve", "pay", "cancel", "release"]);
      expect(
        (await runner.resume(saga, "r1", "payment.succeeded", 1)).status,
      ).toBe("compensated");
    }
  });

  it("re-starting the same run id never re-executes recorded steps", async () => {
    const { runner, saga, calls } = setup();
    await runner.start(saga, "r1", input);
    await runner.start(saga, "r1", input);
    await runner.resume(saga, "r1", "payment.succeeded", 1);
    await runner.start(saga, "r1", input);
    expect(calls).toEqual(["reserve", "pay", "confirm"]);
  });

  it("emits one ended span per step and per compensation, error status on failure", async () => {
    const { runner, saga, spans } = setup("confirm");
    await runner.start(saga, "r1", input);
    await runner.resume(saga, "r1", "payment.succeeded", 1);
    expect(spans.map((s) => [s.name, s.status])).toEqual([
      ["saga.step:reserve-stock", 1],
      ["saga.step:create-payment", 1],
      ["saga.step:confirm-order", 2],
      ["saga.compensate:create-payment", 1],
      ["saga.compensate:reserve-stock", 1],
    ]);
    expect(spans.every((s) => s.ended)).toBe(true);
  });
});

describe("runner mechanics", () => {
  const flaky = (failures: number, code: "unavailable" | "rejected") => {
    let n = 0;
    const saga: Saga<null> = {
      name: "s",
      steps: [
        {
          name: "a",
          retries: 2,
          run: async () => {
            if (n++ < failures) throw new ProviderError("p", code, "x");
            return n;
          },
        },
      ],
    };
    return { saga, attempts: () => n };
  };

  it("retries retryable errors up to the limit, with the same key", async () => {
    const ok = flaky(2, "unavailable");
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    expect((await runner.start(ok.saga, "r", null)).status).toBe("completed");
    expect(ok.attempts()).toBe(3);
    const bad = flaky(3, "unavailable");
    expect((await runner.start(bad.saga, "r2", null)).status).toBe(
      "compensated",
    );
    expect(bad.attempts()).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    const { saga, attempts } = flaky(1, "rejected");
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    expect((await runner.start(saga, "r", null)).status).toBe("compensated");
    expect(attempts()).toBe(1);
  });

  it("reports compensation_failed but still runs the remaining compensations", async () => {
    const undone: string[] = [];
    const saga: Saga<null> = {
      name: "s",
      steps: [
        {
          name: "a",
          run: async () => 1,
          compensate: async () => void undone.push("a"),
        },
        {
          name: "b",
          run: async () => 1,
          compensate: async () => {
            throw new Error("stuck");
          },
        },
        {
          name: "c",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const run = await createSagaRunner({ store: createFakeSagaStore() }).start(
      saga,
      "r",
      null,
    );
    expect(run.status).toBe("compensation_failed");
    expect(run.error).toContain("compensate b: stuck");
    expect(undone).toEqual(["a"]);
  });

  it("resumes a crashed compensation without redoing finished undo steps", async () => {
    const store = createFakeSagaStore();
    const undone: string[] = [];
    let failB = true;
    const saga: Saga<null> = {
      name: "s",
      steps: [
        {
          name: "a",
          run: async () => 1,
          compensate: async () => void undone.push("a"),
        },
        {
          name: "b",
          run: async () => 1,
          compensate: async () => {
            if (failB) throw new Error("x");
            undone.push("b");
          },
        },
        {
          name: "c",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const runner = createSagaRunner({ store });
    await runner.start(saga, "r", null);
    // simulate a crash mid-compensation: reopen the run as "compensating"
    const run = await store.load("r");
    if (!run) throw new Error("missing");
    run.status = "compensating";
    run.rev += 1;
    await store.save(run);
    failB = false;
    const after = await runner.start(saga, "r", null);
    expect(after.status).toBe("compensated");
    expect(undone).toEqual(["a", "b"]);
  });

  it("rejects a stale concurrent write", async () => {
    const store = createFakeSagaStore();
    const run = {
      id: "r",
      saga: "s",
      input: null,
      status: "running" as const,
      rev: 1,
      steps: {},
    };
    await store.save(run);
    await expect(store.save({ ...run })).rejects.toThrow("stale");
  });
});
