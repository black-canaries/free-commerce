import { ProviderError } from "../providers/error";

/** @experimental Structural subset of OpenTelemetry's `Span`; an OTel tracer satisfies it. */
export interface Span {
  end(): void;
  /** `code` follows OTel's `SpanStatusCode`: 0 unset, 1 ok, 2 error. */
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: unknown): void;
}

/** @experimental Structural subset of OpenTelemetry's `Tracer`. */
export interface Tracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): Span;
}

const noopSpan: Span = {
  end: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
};
const noopTracer: Tracer = { startSpan: () => noopSpan };

/** @experimental What a step sees. `key` is stable across retries and restarts: pass it to providers as their idempotency key. */
export interface StepContext<I> {
  input: I;
  /** Recorded results of earlier steps, by step name. */
  results: Readonly<Record<string, unknown>>;
  key: string;
}

interface StepBase<I> {
  name: string;
  /** Undoes this step; receives its recorded result, or `undefined` when this step itself failed (maybe ambiguously). Must be idempotent. */
  compensate?: (ctx: StepContext<I>, result: unknown) => Promise<void>;
  /** Extra attempts after the first, only for retryable `ProviderError`s. Default 0. */
  retries?: number;
}

/** @experimental */
export type Step<I> =
  | (StepBase<I> & { run: (ctx: StepContext<I>) => Promise<unknown> })
  | (StepBase<I> & { waitFor: { event: string; timeoutMs: number } });

/** @experimental */
export interface Saga<I> {
  name: string;
  steps: readonly Step<I>[];
}

/** @experimental */
export type SagaStatus =
  | "running"
  | "paused"
  | "completed"
  | "compensating"
  | "compensated"
  | "compensation_failed";

/** @experimental JSON-serialisable persisted state of one saga run. */
export interface SagaRun {
  id: string;
  saga: string;
  input: unknown;
  status: SagaStatus;
  /** Bumped on every save; stores reject a save whose `rev` is not stored `rev + 1`. */
  rev: number;
  steps: Record<string, { result: unknown; compensated: boolean }>;
  waiting?: { step: string; event: string; deadline: number };
  error?: string;
}

/** @experimental Persistence for saga runs. `load`/`save` must copy; `save` must enforce the `rev` rule. */
export interface SagaStore {
  load(runId: string): Promise<SagaRun | null>;
  save(run: SagaRun): Promise<void>;
}

/** @experimental */
export interface SagaRunnerDeps {
  store: SagaStore;
  tracer?: Tracer;
  /** Epoch milliseconds. */
  now?: () => number;
}

/** JSON with sorted keys: stores may reorder object keys, so compare inputs canonically. */
const canonical = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function withRetries<T>(
  retries: number,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof ProviderError && e.retryable;
      if (!retryable || attempt >= retries) throw e;
    }
  }
}

/** @experimental Resumable saga runner; see ADR 0010. */
export function createSagaRunner({
  store,
  tracer = noopTracer,
  now = Date.now,
}: SagaRunnerDeps) {
  async function persist(run: SagaRun) {
    run.rev += 1;
    await store.save(run);
  }

  async function traced<T>(
    name: string,
    run: SagaRun,
    step: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = tracer.startSpan(name, {
      attributes: { "saga.run": run.id, "saga.step": step },
    });
    try {
      const result = await fn();
      span.setStatus({ code: 1 });
      return result;
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: 2, message: message(e) });
      throw e;
    } finally {
      span.end();
    }
  }

  const context = <I>(
    run: SagaRun,
    step: Step<I>,
    suffix = "",
  ): StepContext<I> => ({
    input: structuredClone(run.input) as I,
    results: Object.fromEntries(
      Object.entries(run.steps).map(([k, v]) => [k, structuredClone(v.result)]),
    ),
    key: `${run.id}:${step.name}${suffix}`,
  });

  /** Returns true when it undid the step (caller persists the flag). */
  async function compensateStep<I>(run: SagaRun, step: Step<I>) {
    const done = run.steps[step.name];
    if (!done || done.compensated || !step.compensate) return false;
    const { compensate } = step;
    await traced("saga.compensate", run, step.name, () =>
      withRetries(step.retries ?? 0, () =>
        compensate(
          context(run, step, ":compensate"),
          structuredClone(done.result),
        ),
      ),
    );
    done.compensated = true;
    return true;
  }

  async function compensate<I>(saga: Saga<I>, run: SagaRun) {
    run.status = "compensating";
    await persist(run);
    const failures: string[] = [];
    for (const step of [...saga.steps].reverse()) {
      let undone = false;
      try {
        undone = await compensateStep(run, step);
      } catch (e) {
        failures.push(`compensate ${step.name}: ${message(e)}`);
      }
      // Outside the try: a store outage must not be reported as a failed undo.
      if (undone) await persist(run);
    }
    run.status = failures.length ? "compensation_failed" : "compensated";
    // Re-drives repeat old failures; keep each message once.
    const fresh = failures.filter((f) => !run.error?.includes(f));
    if (fresh.length) run.error = [run.error, ...fresh].join("; ");
    await persist(run);
    return run;
  }

  function execute<I>(run: SagaRun, step: Step<I> & { run: unknown }) {
    const { run: fn } = step as Extract<Step<I>, { run: unknown }>;
    return traced("saga.step", run, step.name, () =>
      withRetries(step.retries ?? 0, () => fn(context(run, step))),
    );
  }

  async function advance<I>(saga: Saga<I>, run: SagaRun) {
    for (const step of saga.steps) {
      if (run.steps[step.name]) continue;
      if ("waitFor" in step) {
        const { event, timeoutMs } = step.waitFor;
        run.status = "paused";
        run.waiting = { step: step.name, event, deadline: now() + timeoutMs };
        await persist(run);
        return run;
      }
      let result: unknown;
      try {
        result = await execute(run, step);
      } catch (e) {
        run.error = `${step.name}: ${message(e)}`;
        // The failure may be ambiguous (e.g. a timeout after the charge went
        // through), so the step's own undo runs too, with no result.
        run.steps[step.name] = { result: undefined, compensated: false };
        return compensate(saga, run);
      }
      // Outside the try: a store failure is not a step failure; the run stays
      // `running` and a later start/resume re-executes the step (same key).
      run.steps[step.name] = { result, compensated: false };
      await persist(run);
    }
    run.status = "completed";
    await persist(run);
    return run;
  }

  function timeout<I>(
    saga: Saga<I>,
    run: SagaRun,
    waiting: { step: string; event: string },
  ) {
    run.error = `${waiting.step}: timed out waiting for ${waiting.event}`;
    run.waiting = undefined;
    return compensate(saga, run);
  }

  async function load<I>(saga: Saga<I>, runId: string) {
    const run = await store.load(runId);
    if (run && run.saga !== saga.name)
      throw new Error(
        `saga run ${runId} belongs to ${run.saga}, not ${saga.name}`,
      );
    return run;
  }

  async function loadOrThrow<I>(saga: Saga<I>, runId: string) {
    const run = await load(saga, runId);
    if (!run) throw new Error(`saga run not found: ${runId}`);
    return run;
  }

  /** Names feed idempotency keys (`run:step:compensate`), so they must be unique and colon-free. */
  function validate<I>(saga: Saga<I>, runId: string) {
    const names = [runId, ...saga.steps.map((s) => s.name)];
    if (
      names.some((n) => !n || n.includes(":")) ||
      new Set(names.slice(1)).size !== saga.steps.length
    )
      throw new Error(
        `saga ${saga.name}: run id and step names must be non-empty, unique and contain no ":"`,
      );
  }

  const recorded = <I>(saga: Saga<I>, run: SagaRun, event: string) =>
    saga.steps.some(
      (s) => "waitFor" in s && s.waitFor.event === event && run.steps[s.name],
    );

  return {
    /**
     * Starts a run, or re-drives an existing one with the same `runId`:
     * recorded steps are never re-executed, so this is the idempotent entry point.
     */
    async start<I>(saga: Saga<I>, runId: string, input: I): Promise<SagaRun> {
      validate(saga, runId);
      const run = await load(saga, runId);
      if (!run) {
        const fresh: SagaRun = {
          id: runId,
          saga: saga.name,
          input,
          status: "running",
          rev: 0,
          steps: {},
        };
        await persist(fresh);
        return advance(saga, fresh);
      }
      if (canonical(run.input) !== canonical(input))
        throw new Error(
          `saga run ${runId} already exists with a different input`,
        );
      if (run.status === "running") return advance(saga, run);
      // Also retries `compensation_failed`: undone steps are flagged and skipped.
      if (run.status === "compensating" || run.status === "compensation_failed")
        return compensate(saga, run);
      return run;
    },

    /**
     * Delivers an external event (e.g. a verified payment webhook) to a paused run.
     * Duplicate, unexpected or late-for-a-finished-run events are no-ops; an event
     * arriving after the deadline compensates instead of continuing.
     */
    async resume<I>(
      saga: Saga<I>,
      runId: string,
      event: string,
      payload: unknown,
    ): Promise<SagaRun> {
      const run = await loadOrThrow(saga, runId);
      // Crash after the event was recorded: a webhook retry re-drives the run.
      if (run.status === "running" && recorded(saga, run, event))
        return advance(saga, run);
      const waiting = run.waiting;
      if (run.status !== "paused" || !waiting || waiting.event !== event)
        return run;
      if (now() >= waiting.deadline) return timeout(saga, run, waiting);
      run.steps[waiting.step] = { result: payload, compensated: false };
      run.waiting = undefined;
      run.status = "running";
      await persist(run);
      return advance(saga, run);
    },

    /** Compensates a paused run whose deadline has passed; call from a sweeper. Otherwise a no-op. */
    async expire<I>(saga: Saga<I>, runId: string): Promise<SagaRun> {
      const run = await loadOrThrow(saga, runId);
      const waiting = run.waiting;
      if (run.status !== "paused" || !waiting || now() < waiting.deadline)
        return run;
      return timeout(saga, run, waiting);
    },
  };
}
