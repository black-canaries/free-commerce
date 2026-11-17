/** @experimental A fact that happened in the domain. `id` is stable across redeliveries (subscribers dedupe on it). */
export type DomainEvent = {
  id: string;
  type: string;
  occurredAt: string;
  payload: unknown;
};

/** @experimental */
export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * @experimental Pending events, written through a transaction-bound `Repositories.outbox`
 * so they commit with the domain change.
 */
export interface Outbox {
  /** Idempotent by `event.id`. */
  add(event: DomainEvent): Promise<void>;
  /** Undelivered events in insertion order. */
  pending(limit: number): Promise<DomainEvent[]>;
  /** Idempotent. */
  markDelivered(id: string): Promise<void>;
}

/** @experimental In-process bus. */
export interface EventBus {
  /** `"*"` subscribes to every event type. */
  subscribe(type: string, handler: EventHandler): void;
  /** Runs every matching handler; rejects with the first error after all have run. */
  publish(event: DomainEvent): Promise<void>;
}

/** @experimental */
export function createEventBus(): EventBus {
  const handlers = new Map<string, EventHandler[]>();
  return {
    subscribe(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    async publish(event) {
      const results = await Promise.allSettled(
        [...(handlers.get(event.type) ?? []), ...(handlers.get("*") ?? [])].map(
          (h) => h(event),
        ),
      );
      for (const r of results) if (r.status === "rejected") throw r.reason;
    },
  };
}

/**
 * @experimental Delivery is at-least-once, so wrap handlers with side effects.
 * `seen` must be as durable as the effect (e.g. written in the same transaction).
 */
export function idempotent(
  seen: {
    has(id: string): boolean | Promise<boolean>;
    add(id: string): unknown;
  },
  handler: EventHandler,
): EventHandler {
  return async (event) => {
    if (await seen.has(event.id)) return;
    await handler(event);
    await seen.add(event.id);
  };
}

/**
 * @experimental Delivers pending events to the bus in order, marking each delivered
 * after its handlers succeed. A handler failure stops the batch (later events wait,
 * preserving order) and rethrows; the event stays pending and is retried on the next
 * call. A crash between publish and mark redelivers that event.
 */
export async function relayOutbox(
  outbox: Outbox,
  bus: EventBus,
  batch = 100,
): Promise<number> {
  const events = await outbox.pending(batch);
  for (const event of events) {
    await bus.publish(event);
    await outbox.markDelivered(event.id);
  }
  return events.length;
}
