import type { SagaRun, SagaStore } from "./runner";

/** @experimental In-memory `SagaStore` for tests; enforces the `rev` rule like a real adapter must. */
export function createFakeSagaStore(): SagaStore {
  const runs = new Map<string, SagaRun>();
  return {
    async load(id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    async save(run) {
      if (run.rev !== (runs.get(run.id)?.rev ?? 0) + 1)
        throw new Error(`saga run ${run.id}: stale revision ${run.rev}`);
      runs.set(run.id, structuredClone(run));
    },
  };
}
