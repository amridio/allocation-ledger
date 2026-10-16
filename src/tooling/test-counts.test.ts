import { describe, expect, it } from "vitest";
import { diffCounts, parseVitestJson, problemsOf, summarize, type Suite } from "./test-counts";

const suite = (o: Record<string, [number, number?]>): Suite =>
  Object.fromEntries(Object.entries(o).map(([file, [total, skipped = 0]]) => [file, { total, skipped }]));

describe("parseVitestJson: per-file counts from a vitest JSON report", () => {
  const report = {
    testResults: [
      { name: "/repo/src/a.test.ts", assertionResults: [{ status: "passed" }, { status: "failed" }, { status: "skipped" }] },
      { name: "/repo/src/b.test.ts", assertionResults: [{ status: "passed" }, { status: "todo" }, { status: "pending" }] },
      { name: "/repo/src/empty.test.ts", assertionResults: [] },
    ],
  };

  it("counts every test, with skipped / todo / pending counted as skipped, keyed by repo-relative path", () => {
    expect(parseVitestJson(report, "/repo")).toEqual({
      "src/a.test.ts": { total: 3, skipped: 1 },
      "src/b.test.ts": { total: 3, skipped: 2 },
      "src/empty.test.ts": { total: 0, skipped: 0 },
    });
  });

  it("a failing test still counts (this check is about tests going missing, not about passing)", () => {
    expect(parseVitestJson({ testResults: [{ name: "/repo/x.test.ts", assertionResults: [{ status: "failed" }] }] }, "/repo")["x.test.ts"]).toEqual({
      total: 1,
      skipped: 0,
    });
  });
});

describe("diffCounts + problemsOf: what a commit may not do silently", () => {
  it("no change, no problems", () => {
    const s = suite({ "a.test.ts": [5], "b.test.ts": [2] });
    expect(problemsOf(diffCounts(s, s))).toEqual([]);
  });

  it("a deleted test is a problem, naming the file and both counts", () => {
    const d = diffCounts(suite({ "a.test.ts": [5] }), suite({ "a.test.ts": [4] }));
    expect(problemsOf(d)).toEqual(["a.test.ts: 5 -> 4 tests (1 fewer)"]);
  });

  it("a deleted test FILE is a problem, even if other files gained as many tests", () => {
    const d = diffCounts(suite({ "a.test.ts": [5], "b.test.ts": [3] }), suite({ "b.test.ts": [8] }));
    expect(problemsOf(d)).toEqual(["a.test.ts: file removed (it had 5 tests)"]);
  });

  it("a test turned into .skip is a problem, though the total did not change", () => {
    const d = diffCounts(suite({ "a.test.ts": [5, 0] }), suite({ "a.test.ts": [5, 1] }));
    expect(problemsOf(d)).toEqual(["a.test.ts: skipped tests 0 -> 1"]);
  });

  it("swapping one test for another in the same file is not flagged (the count is the same)", () => {
    // limitation of a count: this check catches deletions, it can't tell WHICH test a rename replaced
    const s = suite({ "a.test.ts": [5] });
    expect(problemsOf(diffCounts(s, s))).toEqual([]);
  });

  it("more tests, new files and un-skipped tests are fine (but the baseline must be refreshed)", () => {
    const d = diffCounts(suite({ "a.test.ts": [5, 1] }), suite({ "a.test.ts": [7, 0], "new.test.ts": [3] }));
    expect(problemsOf(d)).toEqual([]);
    expect(d.addedFiles).toEqual(["new.test.ts"]);
    expect(d.totalBefore).toBe(5);
    expect(d.totalAfter).toBe(10);
  });

  it("reports every problem, in file order", () => {
    const d = diffCounts(suite({ "b.test.ts": [4], "a.test.ts": [2] }), suite({ "b.test.ts": [1] }));
    expect(problemsOf(d)).toEqual(["a.test.ts: file removed (it had 2 tests)", "b.test.ts: 4 -> 1 tests (3 fewer)"]);
  });
});

describe("summarize: the line shown at every commit", () => {
  it("says before -> after with a signed difference", () => {
    expect(summarize("unit", diffCounts(suite({ "a.test.ts": [323] }), suite({ "a.test.ts": [330] })))).toBe("unit: 323 -> 330 (+7)");
    expect(summarize("int", diffCounts(suite({ "a.test.ts": [146] }), suite({ "a.test.ts": [146] })))).toBe("int: 146 -> 146 (no change)");
    expect(summarize("unit", diffCounts(suite({ "a.test.ts": [10] }), suite({ "a.test.ts": [9] })))).toBe("unit: 10 -> 9 (-1)");
  });
});
