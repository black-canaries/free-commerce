import { describe, expect, it } from "vitest";
import { ProviderError } from "../providers/error";
import { type CheckoutDeps, completeCheckout } from "./checkout.fake";
import {
  createSagaRunner,
  type Saga,
  type SagaStore,
  type Span,
} from "./runner";
import { createFakeSagaStore } from "./store.fake";

function setup(failAt?: string, failWith?: Error) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const call = async (name: string, key: string) => {
    if (failAt === name) throw failWith ?? new Error(`${name} failed`);
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
    ["reserve", ["release"]],
    ["pay", ["cancel", "release"]],
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

/** Store that throws once at `rev`, either before or after persisting it (a crash). */
function crashingStore(rev: number, when: "before" | "after"): SagaStore {
  const inner = createFakeSagaStore();
  let fired = false;
  const crash = (r: number, at: string) => {
    if (!fired && r === rev && at === when) {
      fired = true;
      throw new Error("crash");
    }
  };
  return {
    load: (id) => inner.load(id),
    async save(run) {
      crash(run.rev, "before");
      await inner.save(run);
      crash(run.rev, "after");
    },
  };
}

describe("runner mechanics", () => {
  const unavailable = new ProviderError("p", "unavailable", "x");
  const flaky = (failures: number, code: "unavailable" | "rejected") => {
    const keys: string[] = [];
    const saga: Saga<null> = {
      name: "s",
      steps: [
        {
          name: "a",
          retries: 2,
          run: async (c) => {
            keys.push(c.key);
            if (keys.length <= failures)
              throw new ProviderError("p", code, "x");
            return keys.length;
          },
        },
      ],
    };
    return { saga, keys };
  };

  it("retries retryable errors up to the limit, with the same key", async () => {
    const ok = flaky(2, "unavailable");
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    expect((await runner.start(ok.saga, "r", null)).status).toBe("completed");
    expect(ok.keys).toEqual(["r:a", "r:a", "r:a"]);
    const bad = flaky(3, "unavailable");
    expect((await runner.start(bad.saga, "r2", null)).status).toBe(
      "compensated",
    );
    expect(bad.keys).toHaveLength(3);
  });

  it("does not retry non-retryable errors", async () => {
    const { saga, keys } = flaky(1, "rejected");
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    expect((await runner.start(saga, "r", null)).status).toBe("compensated");
    expect(keys).toHaveLength(1);
  });

  it("an ambiguous payment failure still cancels the payment (undo gets no result)", async () => {
    const { runner, saga, calls } = setup("pay", unavailable);
    const run = await runner.start(saga, "r1", input);
    expect(run.status).toBe("compensated");
    expect(calls).toEqual(["reserve", "cancel", "release"]);
  });

  it("re-driving after a crash re-executes the unrecorded step with the same key", async () => {
    const keys: string[] = [];
    const saga: Saga<null> = {
      name: "s",
      steps: [{ name: "a", run: async (c) => void keys.push(c.key) }],
    };
    const runner = createSagaRunner({ store: crashingStore(2, "before") });
    await expect(runner.start(saga, "r", null)).rejects.toThrow("crash");
    expect((await runner.start(saga, "r", null)).status).toBe("completed");
    expect(keys).toEqual(["r:a", "r:a"]);
  });

  it("a webhook retry after a crash following the resume save still completes", async () => {
    const { saga, calls } = setup();
    const runner = createSagaRunner({ store: crashingStore(5, "after") });
    await runner.start(saga, "r1", input); // revs 1-4, paused
    await expect(
      runner.resume(saga, "r1", "payment.succeeded", 1),
    ).rejects.toThrow("crash");
    expect(calls).toEqual(["reserve", "pay"]);
    const run = await runner.resume(saga, "r1", "payment.succeeded", 1);
    expect(run.status).toBe("completed");
    expect(calls).toEqual(["reserve", "pay", "confirm"]);
  });

  it("of two concurrent resumes exactly one wins; the loser hits the stale-rev guard", async () => {
    const { runner, saga, calls } = setup();
    await runner.start(saga, "r1", input);
    const results = await Promise.allSettled([
      runner.resume(saga, "r1", "payment.succeeded", 1),
      runner.resume(saga, "r1", "payment.succeeded", 1),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(calls.filter((c) => c === "confirm")).toHaveLength(1);
  });

  const stuck = (state: { failB: boolean }, undone: string[]): Saga<null> => ({
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
          if (state.failB) throw new Error("stuck");
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
  });

  it("compensation_failed still runs the rest, and start() re-drives it", async () => {
    const undone: string[] = [];
    const state = { failB: true };
    const saga = stuck(state, undone);
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    const run = await runner.start(saga, "r", null);
    expect(run.status).toBe("compensation_failed");
    expect(run.error).toContain("compensate b: stuck");
    expect(undone).toEqual(["a"]);
    state.failB = false;
    expect((await runner.start(saga, "r", null)).status).toBe("compensated");
    expect(undone).toEqual(["a", "b"]);
  });

  it("persists each undo, so a crash mid-compensation does not redo it", async () => {
    const undone: string[] = [];
    const saga = stuck({ failB: false }, undone);
    const store = crashingStore(5, "after"); // revs: 1 start, 2 a, 3 b, 4 compensating, 5 b undone
    const runner = createSagaRunner({ store });
    await expect(runner.start(saga, "r", null)).rejects.toThrow("crash");
    const mid = await store.load("r");
    expect([mid?.status, mid?.steps.b?.compensated]).toEqual([
      "compensating",
      true,
    ]);
    expect((await runner.start(saga, "r", null)).status).toBe("compensated");
    expect(undone).toEqual(["b", "a"]);
  });

  it("guards run identity: input, saga name, ids and step names", async () => {
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    const step = { name: "a", run: async () => 1 };
    const saga: Saga<{ n: number }> = { name: "s", steps: [step] };
    await runner.start(saga, "r", { n: 1 });
    await expect(runner.start(saga, "r", { n: 2 })).rejects.toThrow(
      "different input",
    );
    const other = { name: "t", steps: [step] };
    await expect(runner.start(other, "r", { n: 1 })).rejects.toThrow(
      "belongs to s",
    );
    await expect(runner.resume(other, "r", "e", 1)).rejects.toThrow(
      "belongs to s",
    );
    await expect(runner.expire(other, "r")).rejects.toThrow("belongs to s");
    await expect(runner.start(saga, "a:b", { n: 1 })).rejects.toThrow("unique");
    await expect(
      runner.start({ name: "s", steps: [step, step] }, "x", { n: 1 }),
    ).rejects.toThrow("unique");
    await expect(
      runner.start(
        { name: "s", steps: [{ name: "a:b", run: async () => 1 }] },
        "x",
        { n: 1 },
      ),
    ).rejects.toThrow("unique");
  });

  it("steps cannot mutate recorded results", async () => {
    const saga: Saga<null> = {
      name: "s",
      steps: [
        { name: "a", run: async () => ({ n: 1 }) },
        {
          name: "b",
          run: async (c) => {
            (c.results.a as { n: number }).n = 99;
          },
        },
      ],
    };
    const runner = createSagaRunner({ store: createFakeSagaStore() });
    expect((await runner.start(saga, "r", null)).steps.a?.result).toEqual({
      n: 1,
    });
  });

  it("the store rejects a stale write", async () => {
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
