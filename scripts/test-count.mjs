// Did a test silently disappear? Counts the tests in both suites (a real vitest run, so it.each rows are
// counted), compares them with the counts in the last commit (test-counts.json at HEAD), and fails if any file
// lost tests, a file went missing, or tests were turned into skips. Pure logic: src/tooling/test-counts.ts.
//
//   npm run test:count                 check (what the pre-commit hook runs: see .githooks/pre-commit)
//   npm run test:count -- --update     rewrite test-counts.json with today's counts (then `git add` it)
//   ALLOW_TEST_REMOVAL=1 git commit    a deliberate removal: the commit's diff of test-counts.json shows it
//   SKIP_INT_COUNT=1                   don't run the integration suite (needs Docker Postgres); said loudly
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diffCounts, parseVitestJson, problemsOf, summarize } from "../src/tooling/test-counts.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = "test-counts.json";
const args = new Set(process.argv.slice(2));
const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const parse = (text) => (text === null ? null : JSON.parse(text));

// A commit that touches no code or tests can't lose a test: don't spend 30 s on it.
if (args.has("--hook") && !args.has("--update")) {
  const staged = (git("diff", "--cached", "--name-only") ?? "").split("\n").filter(Boolean);
  if (!staged.some((f) => /^(src\/|prisma\/|vitest|package(-lock)?\.json|test-counts\.json)/.test(f))) {
    console.log("test-count: no code staged, skipped.");
    process.exit(0);
  }
}

function countSuite(name, config) {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "test-count-")), `${name}.json`);
  const cmd = ["vitest", "run", ...(config ? ["--config", config] : []), "--reporter=json", `--outputFile=${out}`];
  spawnSync("npx", cmd, { cwd: ROOT, stdio: "ignore", env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
  if (!existsSync(out)) {
    console.error(`test-count: the ${name} suite did not produce a report.${name === "int" ? " Is Postgres up? (docker compose up -d --wait), or SKIP_INT_COUNT=1" : ""}`);
    process.exit(1);
  }
  const suite = parseVitestJson(JSON.parse(readFileSync(out, "utf8")), ROOT);
  if (Object.keys(suite).length === 0) {
    console.error(`test-count: the ${name} suite ran no tests at all (setup failed?). Run \`npm run ${name === "int" ? "test:int" : "test"}\` to see why.`);
    process.exit(1);
  }
  return suite;
}

const skipInt = process.env.SKIP_INT_COUNT === "1";
const after = { unit: countSuite("unit"), int: skipInt ? null : countSuite("int", "vitest.int.config.ts") };
const stringify = (c) => JSON.stringify({ unit: c.unit, int: c.int }, (_k, v) => v, 2) + "\n";
const sorted = (suite) => Object.fromEntries(Object.entries(suite).sort(([a], [b]) => (a < b ? -1 : 1)));

const head = parse(git("show", `HEAD:${BASELINE}`)); // "before": the last commit
const staged = parse(git("show", `:${BASELINE}`)) ?? (existsSync(path.join(ROOT, BASELINE)) ? parse(readFileSync(path.join(ROOT, BASELINE), "utf8")) : null);

if (skipInt) console.warn("test-count: WARNING: SKIP_INT_COUNT=1, the integration suite was NOT counted.");

if (args.has("--update")) {
  const next = { unit: sorted(after.unit), int: sorted(after.int ?? staged?.int ?? {}) };
  writeFileSync(path.join(ROOT, BASELINE), stringify(next));
  const before = head ?? staged;
  for (const name of ["unit", "int"]) {
    if (name === "int" && skipInt) continue;
    if (before?.[name]) console.log(summarize(name, diffCounts(before[name], next[name])));
    else console.log(`${name}: ${Object.values(next[name]).reduce((n, f) => n + f.total, 0)} tests (first baseline)`);
  }
  for (const name of ["unit", "int"]) for (const p of before?.[name] ? problemsOf(diffCounts(before[name], next[name])) : []) console.warn(`  REMOVED  [${name}] ${p}`);
  console.log(`wrote ${BASELINE}: git add it, so the commit shows the change.`);
  process.exit(0);
}

let failed = false;
const before = head ?? staged;
for (const name of ["unit", "int"]) {
  if (after[name] === null) continue;
  if (!before?.[name]) {
    console.log(`${name}: ${Object.values(after[name]).reduce((n, f) => n + f.total, 0)} tests (no earlier baseline to compare with)`);
  } else {
    const diff = diffCounts(before[name], after[name]);
    console.log(summarize(name, diff));
    for (const p of problemsOf(diff)) {
      console.error(`  LOST  [${name}] ${p}`);
      failed = true;
    }
  }
  // the baseline in the commit must say what the suite really contains, so the next commit compares with the truth
  const recorded = staged?.[name];
  const stale = !recorded || JSON.stringify(sorted(recorded)) !== JSON.stringify(sorted(after[name]));
  if (stale) {
    console.error(`  STALE [${name}] ${BASELINE} doesn't match the suite: run \`npm run test:count -- --update\` and \`git add ${BASELINE}\``);
    failed = true;
  }
}

if (failed && process.env.ALLOW_TEST_REMOVAL === "1") {
  const lost = ["unit", "int"].some((n) => after[n] && before?.[n] && problemsOf(diffCounts(before[n], after[n])).length > 0);
  const stale = ["unit", "int"].some((n) => after[n] && JSON.stringify(sorted(staged?.[n] ?? {})) !== JSON.stringify(sorted(after[n])));
  if (lost && !stale) {
    console.warn("test-count: tests were removed, allowed by ALLOW_TEST_REMOVAL=1. The diff of test-counts.json records it.");
    process.exit(0);
  }
  if (lost) console.error("test-count: ALLOW_TEST_REMOVAL=1 only applies once test-counts.json is updated and staged too.");
}
if (failed) {
  console.error("\ntest-count: FAILED. A test went missing (or was skipped), or the baseline is stale.");
  console.error("If the removal is deliberate: `npm run test:count -- --update`, `git add test-counts.json`, then `ALLOW_TEST_REMOVAL=1 git commit`.");
  process.exit(1);
}
console.log("test-count: ok.");
