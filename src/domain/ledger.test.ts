import { describe, expect, it } from "vitest";
import { activeBalance, statusTimeline, type DomainEntry } from "./ledger";
import { deriveStatus } from "./status";

/*
 * Semantics these tests pin down:
 *
 * - An entry counts toward the balance during the HALF-OPEN interval
 *   [effectiveAt, expiresAt). So at exactly `expiresAt` it is already gone, and at
 *   exactly `effectiveAt` it already counts. expiresAt === null means never expires.
 * - An entry whose expiresAt <= effectiveAt is never active.
 * - An adjustment is just a signed entry. It takes effect at ITS OWN effectiveAt, so a
 *   supervisor who backdates it to the adjusted entry's time changes every point from
 *   then on, and no earlier point. (Adjustments are stored with the same expiresAt as
 *   the entry they adjust, so the two drop out together.)
 * - Nothing is clamped: a balance can go negative.
 * - statusTimeline has one point per INSTANT at which the balance changes (an entry
 *   taking effect or expiring). Events at the same instant are merged into one point,
 *   and an instant whose events cancel out produces no point.
 */

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
/** `min` minutes after a fixed base time. No clock is read anywhere in these tests. */
const at = (min: number) => new Date(T0 + min * 60_000);
const msBefore = (d: Date) => new Date(d.getTime() - 1);
const msAfter = (d: Date) => new Date(d.getTime() + 1);

const alloc = (seq: number, effMin: number, units: number, expMin: number | null): DomainEntry => ({
  seq,
  kind: "ALLOCATION",
  units,
  effectiveAt: at(effMin),
  expiresAt: expMin === null ? null : at(expMin),
  refSeq: null,
});

const adj = (
  seq: number,
  effMin: number,
  units: number,
  expMin: number | null,
  refSeq: number,
): DomainEntry => ({
  seq,
  kind: "ADJUSTMENT",
  units,
  effectiveAt: at(effMin),
  expiresAt: expMin === null ? null : at(expMin),
  refSeq,
});

describe("activeBalance", () => {
  it("is 0 for no entries", () => {
    expect(activeBalance([], at(0))).toBe(0);
  });

  it("sums entries that have taken effect", () => {
    const entries = [alloc(1, 0, 30, null), alloc(2, 10, 25, null)];
    expect(activeBalance(entries, at(5))).toBe(30);
    expect(activeBalance(entries, at(15))).toBe(55);
  });

  it("counts an entry that takes effect exactly at the check time", () => {
    const entries = [alloc(1, 10, 25, null)];
    expect(activeBalance(entries, msBefore(at(10)))).toBe(0);
    expect(activeBalance(entries, at(10))).toBe(25);
  });

  it("does NOT count an entry that expires exactly at the check time", () => {
    const entries = [alloc(1, 0, 40, 60)];
    expect(activeBalance(entries, msBefore(at(60)))).toBe(40);
    expect(activeBalance(entries, at(60))).toBe(0);
    expect(activeBalance(entries, msAfter(at(60)))).toBe(0);
  });

  it("ignores future entries", () => {
    const entries = [alloc(1, 0, 30, null), alloc(2, 100, 50, null)];
    expect(activeBalance(entries, at(99))).toBe(30);
    expect(activeBalance(entries, at(100))).toBe(80);
  });

  it("never drops an entry whose tier never expires, however far ahead we look", () => {
    const entries = [alloc(1, 0, 30, null), alloc(2, 0, 20, 60)];
    expect(activeBalance(entries, at(60))).toBe(30);
    expect(activeBalance(entries, new Date("2100-01-01T00:00:00Z"))).toBe(30);
  });

  it("never counts an entry that expires the moment it takes effect (0-minute expiry)", () => {
    const entries = [alloc(1, 10, 99, 10)];
    expect(activeBalance(entries, msBefore(at(10)))).toBe(0);
    expect(activeBalance(entries, at(10))).toBe(0);
    expect(activeBalance(entries, msAfter(at(10)))).toBe(0);
  });

  it("never counts an entry whose expiry is before it takes effect", () => {
    const entries = [alloc(1, 10, 99, 5)];
    for (const m of [0, 5, 7, 10, 20]) expect(activeBalance(entries, at(m))).toBe(0);
  });

  it("applies adjustments as signed entries (negative reduces, positive increases)", () => {
    const entries = [alloc(1, 0, 50, null), adj(2, 5, -15, null, 1), adj(3, 6, 10, null, 1)];
    expect(activeBalance(entries, at(4))).toBe(50);
    expect(activeBalance(entries, at(5))).toBe(35);
    expect(activeBalance(entries, at(6))).toBe(45);
  });

  it("an adjustment that expires with its entry leaves no residue", () => {
    const entries = [alloc(1, 0, 30, 60), adj(2, 5, -10, 60, 1)];
    expect(activeBalance(entries, at(30))).toBe(20);
    expect(activeBalance(entries, at(60))).toBe(0);
  });

  it("can go negative: nothing is clamped", () => {
    const entries = [alloc(1, 0, 10, null), adj(2, 1, -25, null, 1)];
    expect(activeBalance(entries, at(1))).toBe(-15);
  });

  it("does not depend on input order", () => {
    const entries = [
      alloc(1, 0, 30, 90),
      alloc(2, 10, 25, null),
      adj(3, 20, -5, 90, 1),
      alloc(4, 200, 40, null),
    ];
    const reversed = [...entries].reverse();
    for (const m of [0, 10, 20, 89, 90, 150, 200]) {
      expect(activeBalance(reversed, at(m))).toBe(activeBalance(entries, at(m)));
    }
  });

  it("does not mutate its inputs", () => {
    const entries = Object.freeze([Object.freeze(alloc(1, 0, 30, 60))]);
    const when = at(30);
    expect(() => activeBalance(entries, when)).not.toThrow();
    expect(when.getTime()).toBe(at(30).getTime());
  });
});

describe("statusTimeline", () => {
  it("is empty for no entries", () => {
    expect(statusTimeline([])).toEqual([]);
  });

  it("has one point per entry that takes effect, with the status at that moment", () => {
    const entries = [
      alloc(1, 0, 15, null), //  15 -> CRITICAL
      alloc(2, 10, 10, null), // 25 -> LOW
      alloc(3, 20, 30, null), // 55 -> NORMAL
      alloc(4, 30, 50, null), // 105 -> HIGH
    ];
    expect(statusTimeline(entries)).toEqual([
      { at: at(0), balance: 15, status: "CRITICAL" },
      { at: at(10), balance: 25, status: "LOW" },
      { at: at(20), balance: 55, status: "NORMAL" },
      { at: at(30), balance: 105, status: "HIGH" },
    ]);
  });

  it("lands on the right side of every threshold boundary", () => {
    // 19 -> 20 -> 49 -> 50 -> 99 -> 100, one unit at a time around each cutoff
    const entries = [
      alloc(1, 0, 19, null),
      alloc(2, 1, 1, null), //   20
      alloc(3, 2, 29, null), //  49
      alloc(4, 3, 1, null), //   50
      alloc(5, 4, 49, null), //  99
      alloc(6, 5, 1, null), //   100
    ];
    expect(statusTimeline(entries).map((p) => [p.balance, p.status])).toEqual([
      [19, "CRITICAL"],
      [20, "LOW"],
      [49, "LOW"],
      [50, "NORMAL"],
      [99, "NORMAL"],
      [100, "HIGH"],
    ]);
  });

  it("adds a point when an entry expires, and the status drops with it", () => {
    const entries = [alloc(1, 0, 60, 120)];
    expect(statusTimeline(entries)).toEqual([
      { at: at(0), balance: 60, status: "NORMAL" },
      { at: at(120), balance: 0, status: "CRITICAL" },
    ]);
  });

  it("at the instant an entry expires, the point already excludes it", () => {
    const entries = [alloc(1, 0, 60, 120)];
    const expiryPoint = statusTimeline(entries).find((p) => p.at.getTime() === at(120).getTime());
    expect(expiryPoint?.balance).toBe(0);
  });

  it("never adds an expiry point for a tier that never expires", () => {
    const points = statusTimeline([alloc(1, 0, 60, null)]);
    expect(points).toEqual([{ at: at(0), balance: 60, status: "NORMAL" }]);
  });

  it("merges events at the same instant into one point", () => {
    // A expires at 100, exactly when B takes effect: one point, balance 60 - 60 + 30
    const entries = [alloc(1, 0, 60, 100), alloc(2, 100, 30, null)];
    expect(statusTimeline(entries)).toEqual([
      { at: at(0), balance: 60, status: "NORMAL" },
      { at: at(100), balance: 30, status: "LOW" },
    ]);
  });

  it("emits no point for an instant whose events cancel out", () => {
    const entries = [alloc(1, 0, 40, 100), alloc(2, 100, 40, null)];
    expect(statusTimeline(entries)).toEqual([{ at: at(0), balance: 40, status: "LOW" }]);
  });

  it("produces nothing for an entry that is never active", () => {
    expect(statusTimeline([alloc(1, 10, 99, 10)])).toEqual([]);
    expect(statusTimeline([alloc(1, 10, 99, 5)])).toEqual([]);
  });

  it("includes entries in the far future: the timeline does not depend on today's date", () => {
    const far = new Date("2100-01-01T00:00:00Z");
    const entries: DomainEntry[] = [
      alloc(1, 0, 60, null),
      { seq: 2, kind: "ALLOCATION", units: 50, effectiveAt: far, expiresAt: null, refSeq: null },
    ];
    const points = statusTimeline(entries);
    expect(points).toHaveLength(2);
    expect(points[1]).toEqual({ at: far, balance: 110, status: "HIGH" });
  });

  it("is ordered by time whatever order the entries arrive in", () => {
    const entries = [alloc(3, 20, 30, null), alloc(1, 0, 15, 50), alloc(2, 10, 10, null)];
    const times = statusTimeline(entries).map((p) => p.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(statusTimeline([...entries].reverse())).toEqual(statusTimeline(entries));
  });

  it("does not mutate its input (not even by sorting it in place)", () => {
    const entries = Object.freeze([
      Object.freeze(alloc(2, 10, 10, null)),
      Object.freeze(alloc(1, 0, 15, null)),
    ]);
    expect(() => statusTimeline(entries)).not.toThrow();
    expect(entries.map((e) => e.seq)).toEqual([2, 1]);
  });

  describe("a supervisor adjustment to a past entry", () => {
    const A = alloc(1, 0, 30, null);
    const B = alloc(2, 10, 25, null);
    const C = alloc(3, 20, 20, null);
    const before = statusTimeline([A, B, C]);

    it("baseline", () => {
      expect(before).toEqual([
        { at: at(0), balance: 30, status: "LOW" },
        { at: at(10), balance: 55, status: "NORMAL" },
        { at: at(20), balance: 75, status: "NORMAL" },
      ]);
    });

    it("backdated to B's time: changes B's moment and everything after, leaves earlier points alone", () => {
      const after = statusTimeline([A, B, C, adj(4, 10, -10, null, 2)]);

      // earlier point: identical
      expect(after[0]).toEqual(before[0]);

      // B's moment and the later point are recalculated, and B's status flips NORMAL -> LOW
      expect(after).toEqual([
        { at: at(0), balance: 30, status: "LOW" },
        { at: at(10), balance: 45, status: "LOW" },
        { at: at(20), balance: 65, status: "NORMAL" },
      ]);
      expect(after.map((p) => p.balance)).not.toEqual(before.map((p) => p.balance));
    });

    it("effective between B and C: B's point is untouched, a new point appears, C's is recalculated", () => {
      const after = statusTimeline([A, B, C, adj(4, 15, -10, null, 2)]);

      expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
      expect(after).toEqual([
        { at: at(0), balance: 30, status: "LOW" },
        { at: at(10), balance: 55, status: "NORMAL" },
        { at: at(15), balance: 45, status: "LOW" },
        { at: at(20), balance: 65, status: "NORMAL" },
      ]);
    });

    it("a positive adjustment can lift a later status across a threshold", () => {
      const after = statusTimeline([A, B, C, adj(4, 10, 30, null, 2)]);
      expect(after.map((p) => [p.balance, p.status])).toEqual([
        [30, "LOW"],
        [85, "NORMAL"],
        [105, "HIGH"],
      ]);
      expect(after[0]).toEqual(before[0]);
    });

    it("an adjustment on an expiring entry drops out together with it", () => {
      const entries = [alloc(1, 0, 60, 100), adj(2, 50, -20, 100, 1)];
      expect(statusTimeline(entries)).toEqual([
        { at: at(0), balance: 60, status: "NORMAL" },
        { at: at(50), balance: 40, status: "LOW" },
        { at: at(100), balance: 0, status: "CRITICAL" },
      ]);
    });
  });

  it("agrees with activeBalance and deriveStatus at every point (and 1ms before it)", () => {
    const entries = [
      alloc(1, 0, 30, 90),
      alloc(2, 10, 25, null),
      adj(3, 20, -5, 90, 1),
      alloc(4, 45, 60, 45), //  never active
      alloc(5, 60, 40, 120),
      alloc(6, 90, 15, null), // lands exactly when seq 1 and 3 expire
      alloc(7, 5000, 70, null), // far ahead
    ];
    const points = statusTimeline(entries);
    expect(points.length).toBeGreaterThan(3);

    let previous = 0;
    for (const p of points) {
      expect(activeBalance(entries, p.at)).toBe(p.balance);
      expect(deriveStatus(p.balance)).toBe(p.status);
      expect(activeBalance(entries, msBefore(p.at))).toBe(previous);
      expect(p.balance).not.toBe(previous); // a point exists only where the balance changes
      previous = p.balance;
    }
  });
});
