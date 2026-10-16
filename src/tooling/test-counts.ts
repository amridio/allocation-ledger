/*
 * Pure logic for the "did a test silently disappear?" check (scripts/test-count.mjs runs the suites and
 * calls this). A count can't tell WHICH test a rename replaced, but it does catch the real accident:
 * a test, a file or a whole describe block deleted (or turned into .skip) without anyone noticing.
 */

export interface FileCount {
  total: number;
  skipped: number;
}
/** Repo-relative test file -> its counts. */
export type Suite = Record<string, FileCount>;
export interface Counts {
  unit: Suite;
  int: Suite;
}

interface VitestJson {
  testResults: { name: string; assertionResults: { status: string }[] }[];
}

/** Per-file counts from `vitest run --reporter=json`. Failed tests still count; skipped / todo / pending count as skipped. */
export function parseVitestJson(report: VitestJson, root: string): Suite {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const suite: Suite = {};
  for (const file of report.testResults) {
    const name = file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name;
    const skipped = file.assertionResults.filter((t) => t.status === "skipped" || t.status === "todo" || t.status === "pending").length;
    suite[name] = { total: file.assertionResults.length, skipped };
  }
  return suite;
}

export interface SuiteDiff {
  removedFiles: { file: string; total: number }[];
  addedFiles: string[];
  decreased: { file: string; before: number; after: number }[];
  skippedIncreased: { file: string; before: number; after: number }[];
  totalBefore: number;
  totalAfter: number;
}

const sum = (s: Suite) => Object.values(s).reduce((n, f) => n + f.total, 0);

export function diffCounts(before: Suite, after: Suite): SuiteDiff {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diff: SuiteDiff = { removedFiles: [], addedFiles: [], decreased: [], skippedIncreased: [], totalBefore: sum(before), totalAfter: sum(after) };
  for (const file of files) {
    const b = before[file];
    const a = after[file];
    if (b && !a) diff.removedFiles.push({ file, total: b.total });
    else if (!b && a) diff.addedFiles.push(file);
    else if (b && a) {
      if (a.total < b.total) diff.decreased.push({ file, before: b.total, after: a.total });
      if (a.skipped > b.skipped) diff.skippedIncreased.push({ file, before: b.skipped, after: a.skipped });
    }
  }
  return diff;
}

/** Everything a commit may not do silently, one line each, in file order. Empty = fine. */
export function problemsOf(diff: SuiteDiff): string[] {
  const lines: { file: string; text: string }[] = [
    ...diff.removedFiles.map((r) => ({ file: r.file, text: `${r.file}: file removed (it had ${r.total} tests)` })),
    ...diff.decreased.map((d) => ({ file: d.file, text: `${d.file}: ${d.before} -> ${d.after} tests (${d.before - d.after} fewer)` })),
    ...diff.skippedIncreased.map((s) => ({ file: s.file, text: `${s.file}: skipped tests ${s.before} -> ${s.after}` })),
  ];
  return lines.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)).map((l) => l.text);
}

export function summarize(name: string, diff: SuiteDiff): string {
  const delta = diff.totalAfter - diff.totalBefore;
  return `${name}: ${diff.totalBefore} -> ${diff.totalAfter} (${delta === 0 ? "no change" : delta > 0 ? `+${delta}` : String(delta)})`;
}
