import { describe, expect, it } from "vitest";
import { initialOutbox, outboxReducer, pendingUnits, type OutboxState } from "./outbox";

const error = { code: "BUSY", message: "The pool is busy." };
const run = (actions: Parameters<typeof outboxReducer>[1][], start: OutboxState = initialOutbox) =>
  actions.reduce(outboxReducer, start);

/*
 * The outbox holds allocations the user has submitted but the server hasn't confirmed. Each is
 * keyed by its Idempotency-Key, which is created once and NEVER changes for that allocation,
 * so retrying after a timeout can't double count.
 */
describe("outboxReducer", () => {
  it("starts empty with nothing pending and no notices", () => {
    expect(initialOutbox.items).toEqual([]);
    expect(initialOutbox.notices).toEqual([]);
    expect(pendingUnits(initialOutbox)).toEqual([]);
  });

  it("add: a new allocation is 'sending', newest first", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "add", key: "b", units: 10 },
    ]);
    expect(s.items.map((i) => [i.key, i.status, i.units])).toEqual([
      ["b", "sending", 10],
      ["a", "sending", 5],
    ]);
  });

  it("adding the same key twice does not create a second item", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "add", key: "a", units: 5 },
    ]);
    expect(s.items).toHaveLength(1);
  });

  it("sent: removes the item", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "sent", key: "a" },
    ]);
    expect(s.items).toEqual([]);
  });

  it("failed: keeps the item, marks it failed with the error, and stops counting it as pending", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "add", key: "b", units: 10 },
      { type: "failed", key: "a", error },
    ]);
    expect(s.items.find((i) => i.key === "a")).toMatchObject({ status: "failed", error });
    expect(pendingUnits(s)).toEqual([10]); // only what is still being sent
  });

  it("retry: back to 'sending' with the SAME key and units, and counts attempts", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "failed", key: "a", error },
      { type: "retry", key: "a" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ key: "a", units: 5, status: "sending", attempts: 2 });
    expect(s.items[0]?.error).toBeUndefined();
    expect(pendingUnits(s)).toEqual([5]);
  });

  it("retry only applies to a failed item", () => {
    const s = run([
      { type: "add", key: "a", units: 5 },
      { type: "retry", key: "a" },
    ]);
    expect(s.items[0]).toMatchObject({ status: "sending", attempts: 1 });
  });

  it("dismiss: drops a failed item, but never one that is still being sent", () => {
    const sending = run([
      { type: "add", key: "a", units: 5 },
      { type: "dismiss", key: "a" },
    ]);
    expect(sending.items).toHaveLength(1);
    const failed = run([
      { type: "add", key: "a", units: 5 },
      { type: "failed", key: "a", error },
      { type: "dismiss", key: "a" },
    ]);
    expect(failed.items).toEqual([]);
  });

  it("actions for an unknown key change nothing", () => {
    const s = run([{ type: "add", key: "a", units: 5 }]);
    expect(run([{ type: "sent", key: "zzz" }, { type: "failed", key: "zzz", error }, { type: "retry", key: "zzz" }], s)).toEqual(s);
  });
});

/*
 * Two different bad outcomes:
 *   failed     = we couldn't get an answer (no connection, busy). The entry may still be valid, so the
 *                row stays as "Not sent" with a Retry button (same key).
 *   rolledBack = the server REJECTED it (pool full, not allowed...). Retrying can't help, so the
 *                optimistic row is removed, the metric goes back, and a notice says why.
 */
describe("rolledBack", () => {
  const rejection = { code: "CAPACITY_EXCEEDED", message: "The pool is full." };

  it("removes the optimistic item, so its units stop counting (the metric rolls back)", () => {
    const s = run([
      { type: "add", key: "a", units: 20 },
      { type: "add", key: "b", units: 5 },
      { type: "rolledBack", key: "a", error: rejection },
    ]);
    expect(s.items.map((i) => i.key)).toEqual(["b"]);
    expect(pendingUnits(s)).toEqual([5]);
  });

  it("records a notice with the units and the reason", () => {
    const s = run([
      { type: "add", key: "a", units: 20 },
      { type: "rolledBack", key: "a", error: rejection },
    ]);
    expect(s.notices).toEqual([{ key: "a", units: 20, code: "CAPACITY_EXCEEDED", message: "The pool is full." }]);
  });

  it("can roll back an item that had already failed once (e.g. a retry that was then rejected)", () => {
    const s = run([
      { type: "add", key: "a", units: 20 },
      { type: "failed", key: "a", error: { code: "NETWORK", message: "No connection." } },
      { type: "retry", key: "a" },
      { type: "rolledBack", key: "a", error: rejection },
    ]);
    expect(s.items).toEqual([]);
    expect(s.notices).toHaveLength(1);
  });

  it("newest notice first; dismissNotice removes just that one", () => {
    const s = run([
      { type: "add", key: "a", units: 1 },
      { type: "add", key: "b", units: 2 },
      { type: "rolledBack", key: "a", error: rejection },
      { type: "rolledBack", key: "b", error: rejection },
    ]);
    expect(s.notices.map((n) => n.key)).toEqual(["b", "a"]);
    expect(run([{ type: "dismissNotice", key: "b" }], s).notices.map((n) => n.key)).toEqual(["a"]);
  });

  it("an unknown key changes nothing", () => {
    const s = run([{ type: "add", key: "a", units: 1 }]);
    expect(run([{ type: "rolledBack", key: "zzz", error: rejection }, { type: "dismissNotice", key: "zzz" }], s)).toEqual(s);
  });

  it("a rolled-back item is gone for good: a later 'sent' or 'retry' for its key does nothing", () => {
    const s = run([
      { type: "add", key: "a", units: 1 },
      { type: "rolledBack", key: "a", error: rejection },
      { type: "retry", key: "a" },
      { type: "sent", key: "a" },
    ]);
    expect(s.items).toEqual([]);
  });
});
