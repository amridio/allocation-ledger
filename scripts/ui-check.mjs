// Real-browser checks (playwright-core + the preinstalled Chromium): npm run ui:check
//
// Starts the PRODUCTION server against the ops_test database, builds fixtures, and checks the UI at a
// phone size and a desktop size: layout, touch-target sizes, text contrast, "status is never colour
// alone", first open with no loading state, and the real flows (log an allocation, retry, adjust,
// expiry at the exact moment). It never touches the dev database.
//
// Output: PASS/FAIL per check and screenshots in $UI_CHECK_SHOTS (default ./ui-check-output).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { chromium } from "playwright-core";
import { assertSafeTestDatabase } from "../src/server/testing/test-db-guard.ts";

try {
  process.loadEnvFile();
} catch {
  /* no .env: rely on the real environment */
}
const TEST_URL = process.env.TEST_DATABASE_URL;
assertSafeTestDatabase(TEST_URL, process.env.DATABASE_URL);

const SHOTS = path.resolve(process.env.UI_CHECK_SHOTS ?? "ui-check-output");
mkdirSync(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------- tiny check runner
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}\n      ${String(err?.message ?? err).split("\n").join("\n      ")}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
/** The other site's 777 units, as a standalone number (the run id is base36 and could contain "777" by chance). */
const leaksFar = (html) => /(^|[^0-9a-z_])777([^0-9a-z_]|$)/i.test(html);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- servers
const servers = [];
const NEXT_BIN = path.resolve("node_modules/next/dist/bin/next");
async function startServer(port, env) {
  // Refuse to run against something that is already listening: it would be a stale server, not ours.
  const isUp = () => fetch(`http://localhost:${port}/`).then(() => true, () => false);
  for (let i = 0; i < 20 && (await isUp()); i++) await sleep(250); // a previous run may still be shutting down
  const taken = await isUp();
  if (taken) throw new Error(`port ${port} is already in use (a leftover server?). Stop it and run again.`);

  // `node next start` directly (no npx/sh wrapper) in its own process group, so we can kill all of it.
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    env: { ...process.env, DATABASE_URL: TEST_URL, APP_TIMEZONE: "UTC", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.status < 500 && child.exitCode === null) return { port, base: `http://localhost:${port}`, log: () => log };
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`server on ${port} did not start:\n${log}`);
}
const stopServers = () =>
  servers.forEach((s) => {
    try {
      process.kill(-s.pid, "SIGTERM"); // the whole process group
    } catch {
      /* already gone */
    }
  });
process.on("exit", stopServers);

// ---------------------------------------------------------------- fixtures (raw SQL into ops_test)
const db = new pg.Client({ connectionString: TEST_URL });
await db.connect();
const HOUR = 3_600_000;
const id = (name) => `${name}_${RUN}`;

async function seed() {
  const q = (sql, params) => db.query(sql, params);
  await q(`INSERT INTO tier (id, name, expiry_minutes) VALUES ($1, $1, 1440)`, [id("tier")]);
  for (const [pool, cap] of [["main", 500], ["zed", 500], ["far", 500]]) {
    await q(`INSERT INTO pool (id, name, capacity, updated_at) VALUES ($1, $2, $3, now())`, [id(`pool_${pool}`), `Site ${pool.toUpperCase()} ${RUN}`, cap]);
  }
  const person = (key, name, role, pool) =>
    q(`INSERT INTO operator (id, name, role, tier_id, pool_id) VALUES ($1, $2, $3::"Role", $4, $5)`, [id(key), name, role, id("tier"), id(`pool_${pool}`)]);
  await person("ada", "Ada Okafor", "OPERATOR", "main");
  await person("ben", "Ben Lindqvist", "OPERATOR", "main");
  await person("cy", "Cy Navarro", "OPERATOR", "main");
  await person("eli", "Eli Park", "SUPERVISOR", "main");
  await person("zed", "Zed Quinn", "OPERATOR", "zed");
  await person("far", "Far Away", "OPERATOR", "far");

  let n = 0;
  const entry = async (op, pool, units, effectiveMs, expiresMs) => {
    n += 1;
    await q(
      `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, idempotency_key)
       VALUES ('ALLOCATION', $1, $2, $1, $3, $4, $5, $6)`,
      [id(op), id(`pool_${pool}`), units, new Date(effectiveMs), expiresMs === null ? null : new Date(expiresMs), `fx-${RUN}-${n}`],
    );
    await q(`UPDATE pool SET balance = balance + $1 WHERE id = $2`, [units, id(`pool_${pool}`)]);
  };
  const now = Date.now();
  // Ada: a history that passes through all four statuses and has upcoming expiries
  await entry("ada", "main", 10, now - 30 * HOUR, null); //          10   CRITICAL
  await entry("ada", "main", 20, now - 26 * HOUR, now - 2 * HOUR); // 30   LOW   (expired)
  await entry("ada", "main", 15, now - 20 * HOUR, null); //          45   LOW
  await entry("ada", "main", 30, now - 10 * HOUR, now + 3 * HOUR); // 75   NORMAL
  await entry("ada", "main", 60, now - 5 * HOUR, now + 10 * HOUR); // 135  HIGH   <- the one supervisors adjust
  await entry("ada", "main", 10, now - 1 * HOUR, null);
  // Ben: low numbers, so logging moves his status
  await entry("ben", "main", 5, now - 2 * HOUR, null);
  // Cy: 25 one-unit entries so the pool log has more than one page
  for (let i = 0; i < 25; i++) await entry("cy", "main", 1, now - (40 + i) * 60_000, null);
  // the other site
  await entry("far", "far", 777, now - HOUR, null);
}

// ---------------------------------------------------------------- browser helpers
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
    const exe = path.join(root, dir, "chrome-linux", "chrome");
    if (existsSync(exe)) return exe;
  }
  throw new Error(`no Chromium under ${root}`);
}

const visibleScript = `
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && el.getClientRects().length > 0;
  };
`;

/** Every interactive control that is on screen, with its size. */
const controls = (page) =>
  page.evaluate(`(() => { ${visibleScript}
    return [...document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, summary")]
      .filter(visible)
      .map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), label: (el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) }; });
  })()`);

/** Contrast of every piece of visible text against its real background. */
const contrastReport = (page) =>
  page.evaluate(`(() => { ${visibleScript}
    const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { chain.push(c); if (c.a === 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (const c of chain.reverse()) base = blend(c, base); return base; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      const text = node.textContent.trim(); if (!text) continue;
      const el = node.parentElement; if (!el || !visible(el) || el.closest("[class~=sr-only]")) continue;
      const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
      const solid = blend(fg, bg);
      out.push({ text: text.slice(0, 40), ratio: ratio(solid, bg), size: parseFloat(getComputedStyle(el).fontSize), tag: el.tagName.toLowerCase() });
    }
    return out;
  })()`);

/** Anything that pokes out of the card it sits in (a number crossing a border, text running off the edge). */
const spills = (page) =>
  page.evaluate(`(() => { ${visibleScript}
    const out = [];
    const cards = document.querySelectorAll('[data-testid="activity-row"], [data-testid="pending-row"], [data-testid="timeline-point"], [data-testid="metric-card"], [data-testid="notice"], [data-testid="adjust-dialog"], [data-testid="activity-log"]');
    for (const card of cards) {
      if (!visible(card)) continue;
      const box = card.getBoundingClientRect();
      for (const el of card.querySelectorAll("*")) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push({ card: card.getAttribute("data-testid"), text: (el.textContent || "").trim().slice(0, 30), overBy: Math.round(Math.max(r.right - box.right, box.left - r.left)) });
      }
    }
    return out;
  })()`);

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

/** Pages through the log ("Load older entries") until a row containing `text` is on screen. */
async function revealRow(page, text) {
  const row = page.locator('[data-testid="activity-row"][data-kind="ALLOCATION"]', { hasText: text }).first();
  for (let i = 0; i < 6 && !(await row.isVisible()); i++) {
    const more = page.locator('[data-testid="load-more"]');
    assert(await more.isVisible(), `no row with "${text}" and nothing more to load`);
    const before = await page.locator('[data-testid="activity-row"]').count();
    await more.click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="activity-row"]').length > n, before);
  }
  assert(await row.isVisible(), `row "${text}" never appeared`);
  return row;
}
const metricText = (page) => page.locator('[data-testid="metric-value"]').first().innerText();
const statusWord = (page) => page.locator('[data-testid="metric-status"]').first().innerText();

// ---------------------------------------------------------------- main
console.log(`Using test database ${new URL(TEST_URL).pathname.slice(1)}; screenshots in ${SHOTS}`);
execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: "ignore" });
await seed();

const main = await startServer(3120, { ENABLE_USER_SWITCHER: "true", UI_POLL_MS: "3000" });
const slow = await startServer(3121, { ENABLE_USER_SWITCHER: "true", UI_POLL_MS: "60000" }); // polling can't hide the exact-expiry refetch
const off = await startServer(3122, { ENABLE_USER_SWITCHER: "false", UI_POLL_MS: "3000" });

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const newContext = (base, kind, userKey) =>
  browser.newContext({
    baseURL: base,
    viewport: kind === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: kind === "mobile" ? 2 : 1,
    isMobile: kind === "mobile",
    hasTouch: kind === "mobile",
    ...(userKey ? { storageState: { cookies: [{ name: "uid", value: id(userKey), domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] } } : {}),
  });

try {
  // ======================================================== first open: nothing to wait for
  await check("first open: the very first HTML response already contains the numbers (no JavaScript needed)", async () => {
    const ctx = await browser.newContext({ baseURL: main.base, javaScriptEnabled: false, extraHTTPHeaders: { cookie: `uid=${id("ada")}` } });
    const page = await ctx.newPage();
    const response = await page.goto("/");
    const html = await response.text();
    assert(response.status() === 200, `status ${response.status()}`);
    assert(/data-testid="metric-value"[^>]*>125</.test(html), "the metric value (125) is not in the server-rendered HTML");
    assert(html.includes("Ada Okafor"), "the operator's name is not in the HTML");
    assert(html.includes('data-testid="activity-row"'), "no activity rows in the HTML");
    assert(!/Loading|animate-spin|aria-busy="true"/.test(html), "the first response contains a loading state");
    await ctx.close();
  });

  // ======================================================== operator on a phone
  const phone = await newContext(main.base, "mobile", "ada");
  const m = await phone.newPage();
  await m.goto("/");
  await m.waitForSelector('[data-testid="metric-value"]');
  await shot(m, "01-mobile-operator");

  await check("mobile: metric on top, then the activity log, with the Log allocation button pinned at the bottom", async () => {
    const metric = await m.locator('[data-testid="metric-card"]').boundingBox();
    const log = await m.locator('[data-testid="activity-log"]').boundingBox();
    const bar = await m.locator('[data-testid="action-bar"]').boundingBox();
    assert(metric && log && bar, "missing a section");
    assert(metric.y < log.y, `metric (y=${metric.y}) is not above the log (y=${log.y})`);
    assert(Math.abs(bar.y + bar.height - 844) <= 1, `action bar bottom is ${bar.y + bar.height}, viewport is 844`);
    assert(log.y > metric.y + metric.height - 1, "the log should come after the metric card");
    const desktopForm = await m.locator('[data-testid="desktop-form"]').isVisible();
    assert(!desktopForm, "the desktop form is visible on a phone");
    const open = await m.locator('[data-testid="open-log-sheet"]').boundingBox();
    assert(open && open.x >= 0 && open.x + open.width <= 390, "button is cut off horizontally");
  });

  await check("mobile: no horizontal scrolling", async () => {
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `page is ${overflow}px wider than the screen`);
  });

  await check("mobile: nothing spills out of its card (units, text and badges stay inside the borders)", async () => {
    const out = await spills(m);
    assert(out.length === 0, `${out.length} element(s) poke out of their card: ${JSON.stringify(out.slice(0, 4))}`);
  });

  await check("mobile: the metric number is at least 48px (it is 72px)", async () => {
    const size = await m.locator('[data-testid="metric-value"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert(size >= 48, `metric font is ${size}px`);
    assert(size >= 72, `expected the 72px design size, got ${size}px`);
  });

  await check("mobile: every button, link, input and select is at least 48px tall (we aim for 56px)", async () => {
    const list = await controls(m);
    assert(list.length >= 3, `found only ${list.length} controls`);
    const small = list.filter((c) => c.h < 48);
    assert(small.length === 0, `too small: ${JSON.stringify(small)}`);
    const under56 = list.filter((c) => c.h < 56).map((c) => `${c.tag}:${c.label}=${c.h}`);
    console.log(`      smallest control: ${Math.min(...list.map((c) => c.h))}px (${list.length} controls); under 56px: ${under56.length ? under56.join(", ") : "none"}`);
  });

  await check("mobile: every piece of text has at least 7:1 contrast against its real background, and nothing is smaller than 16px", async () => {
    const report = await contrastReport(m);
    assert(report.length > 10, "found too little text");
    const weak = report.filter((r) => r.ratio < 7).map((r) => `"${r.text}" ${r.ratio.toFixed(2)}:1`);
    assert(weak.length === 0, `low contrast: ${weak.join("; ")}`);
    const tiny = report.filter((r) => r.size < 16).map((r) => `"${r.text}" ${r.size}px`);
    assert(tiny.length === 0, `text under 16px: ${tiny.join("; ")}`);
    console.log(`      lowest contrast: ${Math.min(...report.map((r) => r.ratio)).toFixed(1)}:1 over ${report.length} text runs`);
  });

  await check("status is never colour alone: every status badge has an icon AND a word, and the four icons are four different shapes", async () => {
    await m.locator('[data-testid="timeline-disclosure"] summary').click();
    const badges = await m.evaluate(() =>
      [...document.querySelectorAll("[data-status]")]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => ({ level: el.getAttribute("data-status"), hasSvg: !!el.querySelector("svg"), word: el.textContent.trim(), shape: el.querySelector("svg")?.innerHTML ?? "" })),
    );
    assert(badges.length >= 4, `only ${badges.length} badges visible`);
    for (const b of badges) {
      assert(b.hasSvg, `${b.level} badge has no icon`);
      assert(b.word.length >= 3, `${b.level} badge has no word`);
    }
    const shapes = new Map();
    for (const b of badges) shapes.set(b.level, b.shape);
    assert(shapes.size === 4, `only saw statuses: ${[...shapes.keys()].join(", ")}`);
    assert(new Set(shapes.values()).size === 4, "two statuses share the same icon shape");
    const words = new Set(badges.map((b) => b.word));
    assert(["Critical", "Low", "Normal", "High"].every((w) => words.has(w)), `words seen: ${[...words].join(", ")}`);
    await m.locator('[data-testid="timeline-disclosure"]').screenshot({ path: path.join(SHOTS, "02-mobile-history-open.png") });
    await m.addStyleTag({ content: "html{filter:grayscale(1)}" });
    await m.locator('[data-testid="timeline-disclosure"]').screenshot({ path: path.join(SHOTS, "03-mobile-history-grayscale.png") }); // what a colour-blind user (or sunlight washing out colour) sees
    await m.evaluate(() => document.querySelectorAll("style").forEach((s) => s.textContent?.includes("grayscale") && s.remove()));
  });

  await check("mobile: the history is one tap away and the pending state is described in words", async () => {
    const points = await m.locator('[data-testid="timeline-point"]:visible').count();
    assert(points >= 4, `only ${points} timeline points`);
  });
  await m.close();
  await phone.close();

  // ======================================================== logging an allocation (Ben: CRITICAL -> LOW)
  const benCtx = await newContext(main.base, "mobile", "ben");
  const b = await benCtx.newPage();
  await b.goto("/");
  await b.waitForSelector('[data-testid="metric-value"]');

  await check("log an allocation on a phone: the number updates at once, with a Syncing row in words, and never flickers or double counts", async () => {
    assert((await metricText(b)) === "5", "expected Ben to start at 5");
    assert((await statusWord(b)).includes("Critical"), "expected CRITICAL to start");
    // watch every value the metric ever shows
    await b.evaluate(() => {
      window.__seen = [document.querySelector('[data-testid="metric-value"]').textContent];
      new MutationObserver(() => {
        const t = document.querySelector('[data-testid="metric-value"]').textContent;
        if (window.__seen.at(-1) !== t) window.__seen.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    // hold the request open so the pending state can be inspected
    let release;
    const gate = new Promise((r) => (release = r));
    await b.route("**/api/entries", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await gate;
      await route.continue();
    });

    await b.locator('[data-testid="open-log-sheet"]').tap();
    await b.waitForSelector('[data-testid="log-sheet"][open]');
    await shot(b, "04-mobile-sheet");
    const sheetControls = await controls(b);
    const smallInSheet = sheetControls.filter((c) => c.h < 48);
    assert(smallInSheet.length === 0, `sheet controls too small: ${JSON.stringify(smallInSheet)}`);
    await b.locator('[data-testid="log-sheet"] [data-testid="units-input"]').fill("20");
    await b.locator('[data-testid="log-sheet"] [data-testid="submit-allocation"]').tap();
    await b.waitForSelector('[data-testid="pending-row"]');

    assert((await metricText(b)) === "25", `optimistic number should be 25, got ${await metricText(b)}`);
    assert((await statusWord(b)).includes("Low"), "status should already read Low");
    const pending = await b.locator('[data-testid="pending-row"]').first();
    assert((await pending.innerText()).includes("Syncing"), "pending row should say Syncing…");
    assert((await pending.evaluate((el) => getComputedStyle(el).borderStyle)) === "dashed", "pending row should have a dashed border");
    assert((await b.locator('[data-testid="metric-pending"]').innerText()).includes("still syncing"), "metric should say it includes units still syncing");
    await shot(b, "05-mobile-pending");

    release();
    await b.waitForSelector('[data-testid="pending-row"]', { state: "detached" });
    await b.waitForFunction(() => document.querySelectorAll('[data-testid="activity-row"]').length >= 2);
    await sleep(500);
    assert((await metricText(b)) === "25", `final number should be 25, got ${await metricText(b)}`);
    const seen = await b.evaluate(() => window.__seen);
    assert(JSON.stringify(seen) === JSON.stringify(["5", "25"]), `the metric showed ${JSON.stringify(seen)} (expected exactly 5 then 25)`);
    assert((await b.locator('[data-testid="activity-row"]').first().innerText()).includes("+20"), "the confirmed row should be at the top");
    const rows = await pool_query(`SELECT count(*)::int AS n, coalesce(sum(units),0)::int AS s FROM ledger_entry WHERE operator_id = $1`, [id("ben")]);
    assert(rows.n === 2 && rows.s === 25, `database holds ${JSON.stringify(rows)}`);
    await b.unroute("**/api/entries");
  });

  await check("a failed send shows Not sent + Retry, and Retry re-sends with the SAME Idempotency-Key (one row, counted once)", async () => {
    const keys = [];
    let failures = 3; // the first three attempts (1 + 2 automatic retries) die; the manual Retry succeeds
    await b.route("**/api/entries", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue();
      keys.push(req.headers()["idempotency-key"]);
      if (failures > 0) {
        failures -= 1;
        return route.abort("connectionfailed");
      }
      return route.continue();
    });
    await b.locator('[data-testid="open-log-sheet"]').tap();
    await b.locator('[data-testid="log-sheet"] [data-testid="units-input"]').fill("7");
    await b.locator('[data-testid="log-sheet"] [data-testid="submit-allocation"]').tap();
    await b.waitForSelector('[data-testid="pending-row"][data-state="failed"]', { timeout: 15_000 });
    const failed = b.locator('[data-testid="pending-row"][data-state="failed"]');
    assert((await failed.innerText()).includes("Not sent"), "failed row should say Not sent");
    assert((await metricText(b)) === "25", `a failed send must not count: expected 25, got ${await metricText(b)}`);
    await shot(b, "06-mobile-failed");
    const h = await failed.locator('[data-testid="retry-button"]').boundingBox();
    assert(h && h.height >= 48, `Retry button is ${h?.height}px tall`);
    await failed.locator('[data-testid="retry-button"]').tap();
    await b.waitForSelector('[data-testid="pending-row"]', { state: "detached" });
    assert(keys.length === 4, `expected 4 attempts, saw ${keys.length}`);
    assert(new Set(keys).size === 1 && keys[0], `the key changed between attempts: ${JSON.stringify(keys)}`);
    await sleep(400);
    assert((await metricText(b)) === "32", `expected 32 after the retry, got ${await metricText(b)}`);
    const rows = await pool_query(`SELECT count(*)::int AS n, coalesce(sum(units),0)::int AS s FROM ledger_entry WHERE operator_id = $1`, [id("ben")]);
    assert(rows.n === 3 && rows.s === 32, `database holds ${JSON.stringify(rows)} (a duplicate would show 4 rows / 39 units)`);
    await b.unroute("**/api/entries");
  });

  await check("a REJECTED allocation rolls back: the row and the number go away and an error says why (no retry offered)", async () => {
    assert((await metricText(b)) === "32", `expected Ben at 32, got ${await metricText(b)}`);
    const rowsBefore = await b.locator('[data-testid="activity-row"]').count();
    let release;
    const gate = new Promise((r) => (release = r));
    await b.route("**/api/entries", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await gate; // hold it so the optimistic state can be seen, then let the REAL server answer (it will refuse: pool capacity is 500)
      await route.continue();
    });
    await b.locator('[data-testid="open-log-sheet"]').tap();
    await b.locator('[data-testid="log-sheet"] [data-testid="units-input"]').fill("600");
    await b.locator('[data-testid="log-sheet"] [data-testid="submit-allocation"]').tap();

    await b.waitForSelector('[data-testid="pending-row"]');
    assert((await b.locator('[data-testid="pending-row"]').first().innerText()).includes("Syncing"), "should say Syncing while waiting");
    assert((await metricText(b)) === "632", `optimistic number should be 632, got ${await metricText(b)}`);
    assert((await statusWord(b)).includes("High"), "optimistic status should be High");

    release();
    await b.waitForSelector('[data-testid="pending-row"]', { state: "detached" });
    await b.waitForSelector('[data-testid="notice"]');
    assert((await metricText(b)) === "32", `the number must roll back to 32, got ${await metricText(b)}`);
    assert((await statusWord(b)).includes("Low"), "the status must roll back to Low");
    const notice = await b.locator('[data-testid="notice"]').first().innerText();
    assert(notice.includes("600") && /full|capacity|room/i.test(notice), `the error should say what happened, got: ${notice}`);
    assert((await b.locator('[data-testid="notice"] [data-testid="retry-button"]').count()) === 0, "a rejection must not offer Retry");
    assert((await b.locator('[data-testid="activity-row"]').count()) === rowsBefore, "no new row should remain in the log");
    assert((await b.locator('[data-testid="metric-pending"]').count()) === 0, "the 'still syncing' note should be gone");
    const dbRows = await pool_query(`SELECT count(*)::int AS n, coalesce(sum(units),0)::int AS s FROM ledger_entry WHERE operator_id = $1`, [id("ben")]);
    assert(dbRows.n === 3 && dbRows.s === 32, `the database must be unchanged, got ${JSON.stringify(dbRows)}`);
    await b.screenshot({ path: path.join(SHOTS, "13-mobile-rolled-back.png") });
    const dismiss = b.locator('[data-testid="notice"] [data-testid="dismiss-notice"]').first();
    const box = await dismiss.boundingBox();
    assert(box && box.height >= 48, `Dismiss button is ${box?.height}px tall`);
    await dismiss.tap();
    await b.waitForSelector('[data-testid="notice"]', { state: "detached" });
    await b.unroute("**/api/entries");
  });
  await benCtx.close();

  // ======================================================== desktop, operator
  const adaDesk = await newContext(main.base, "desktop", "ada");
  const d = await adaDesk.newPage();
  await d.goto("/");
  await d.waitForSelector('[data-testid="metric-value"]');
  await shot(d, "07-desktop-operator");

  await check("desktop: three columns left to right: form, metric with its history, activity log", async () => {
    const form = await d.locator('[data-testid="desktop-form"]').boundingBox();
    const metric = await d.locator('[data-testid="metric-card"]').boundingBox();
    const timeline = await d.locator('[data-testid="status-timeline"]:visible').boundingBox();
    const log = await d.locator('[data-testid="activity-log"]').boundingBox();
    assert(form && metric && timeline && log, "missing a section");
    assert(form.x < metric.x && metric.x < log.x, `columns out of order: form ${form.x}, metric ${metric.x}, log ${log.x}`);
    assert(Math.abs(timeline.x - metric.x) < 4, "the history should sit in the metric's column");
    assert(timeline.y > metric.y, "the history should be below the metric");
    assert(Math.abs(form.y - metric.y) < 8 && Math.abs(metric.y - log.y) < 8, "the three columns should start on the same row");
    assert(!(await d.locator('[data-testid="action-bar"]').isVisible()), "the mobile action bar should be hidden on desktop");
  });
  await check("desktop: nothing spills out of its card", async () => {
    const out = await spills(d);
    assert(out.length === 0, `${out.length} element(s) poke out of their card: ${JSON.stringify(out.slice(0, 4))}`);
  });
  await check("desktop: controls are at least 48px tall and all text has 7:1 contrast", async () => {
    const small = (await controls(d)).filter((c) => c.h < 48);
    assert(small.length === 0, `too small: ${JSON.stringify(small)}`);
    const weak = (await contrastReport(d)).filter((r) => r.ratio < 7).map((r) => `"${r.text}" ${r.ratio.toFixed(2)}:1`);
    assert(weak.length === 0, `low contrast: ${weak.join("; ")}`);
  });
  await adaDesk.close();

  // ======================================================== supervisor on desktop: adjust, see it recalculate
  const supCtx = await newContext(main.base, "desktop", "eli");
  const s = await supCtx.newPage();
  await s.goto("/");
  await s.waitForSelector('[data-testid="operator-picker"]');
  await shot(s, "08-desktop-supervisor");

  await check("supervisor: the picker, and a log of ONLY the selected operator (Ada) with an Adjust button on every allocation, and no other site's data", async () => {
    const options = await s.locator('[data-testid="operator-picker"] option').allInnerTexts();
    assert(options.some((o) => o.includes("Ada")) && options.some((o) => o.includes("Ben")), `picker shows ${options.join(", ")}`);
    assert(!options.some((o) => o.includes("Far Away")), "the other site's operator is in the picker");
    const rows = s.locator('[data-testid="activity-row"]');
    const allocations = await rows.evaluateAll((els) => els.filter((e) => e.getAttribute("data-kind") === "ALLOCATION").length);
    const adjustButtons = await s.locator('[data-testid="adjust-button"]').count();
    assert(allocations === adjustButtons && adjustButtons > 0, `${allocations} allocation rows but ${adjustButtons} Adjust buttons`);
    const people = await rows.evaluateAll((els) => els.map((e) => e.textContent));
    assert(people.length > 0 && people.every((t) => t.includes("Ada")), "every row should be Ada's");
    assert(!people.some((t) => t.includes("Ben") || t.includes("Cy")), "another operator's row is in the filtered log");
    assert(await s.locator('[data-testid="log-scope-operator"]').getAttribute("aria-pressed") === "true", "the operator filter should be on");
    assert(await s.locator('[data-testid="log-scope-all"]').getAttribute("aria-pressed") === "false", "Everyone should be off");
    assert(!(await s.locator('[data-testid="load-more"]').isVisible()), "Ada's own log fits one page: nothing to page through");
    const html = await s.content();
    assert(!leaksFar(html), "the other site's numbers are on the page");
  });

  await check("supervisor: a hand-edited URL naming another site's operator falls back to the default and leaks nothing", async () => {
    const page = await supCtx.newPage();
    await page.goto(`/?operator=${id("far")}`);
    await page.waitForSelector('[data-testid="metric-value"]');
    assert(!(await page.content()).includes("Far Away") && !leaksFar(await page.content()), "the other site leaked");
    await page.close();
  });

  await check("supervisor: the 'Everyone' toggle widens the log to the whole pool, is kept in the URL, and survives changing operator", async () => {
    await s.locator('[data-testid="log-scope-all"]').click();
    await s.waitForFunction(() => new URL(location.href).searchParams.get("log") === "all");
    await s.waitForFunction(() => document.querySelector('[data-testid="log-scope-text"]')?.textContent?.startsWith("Everyone in"));
    assert(await s.locator('[data-testid="log-scope-all"]').getAttribute("aria-pressed") === "true", "Everyone should be on");
    assert((await s.locator('[data-testid="load-more"]').isVisible()), "the pool log has more than one page");
    const names = await s.locator('[data-testid="activity-row"]').evaluateAll((els) => els.map((e) => e.textContent));
    assert(names.some((t) => t.includes("Cy")), "Cy's entries should be in the pool log");
    assert(!leaksFar(await s.content()), "the other site leaked into the pool log");
    // changing operator keeps "Everyone", and the metric still follows the picker
    await s.locator('[data-testid="operator-picker"]').selectOption({ label: "Ben Lindqvist" });
    await s.waitForFunction(() => document.querySelector('[data-testid="metric-card"]')?.textContent?.includes("Ben Lindqvist"));
    const url = new URL(s.url());
    assert(url.searchParams.get("log") === "all" && url.searchParams.get("operator") === id("ben"), `URL lost a choice: ${url.search}`);
    assert(await s.locator('[data-testid="log-scope-all"]').getAttribute("aria-pressed") === "true", "Everyone should still be on");
    assert((await s.locator('[data-testid="log-scope-text"]').innerText()).startsWith("Everyone in"), "the pool log should still be shown");
  });

  await check("the log pages (Everyone): Load older entries brings more, with no duplicates", async () => {
    const seqs = () => s.locator('[data-testid="activity-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-seq")));
    const first = await seqs();
    await s.locator('[data-testid="load-more"]').scrollIntoViewIfNeeded();
    await s.locator('[data-testid="load-more"]').click();
    await s.waitForFunction((n) => document.querySelectorAll('[data-testid="activity-row"]').length > n, first.length);
    const all = await seqs();
    assert(new Set(all).size === all.length, "duplicate rows after loading more");
    assert(all.length > first.length, "no more rows loaded");
    const sorted = [...all].sort((x, y) => Number(y) - Number(x));
    assert(JSON.stringify(sorted) === JSON.stringify(all), "rows are not newest-first");
  });

  await check("supervisor: toggling back to one operator drops the paged-in rows (nothing from the pool view lingers)", async () => {
    await s.locator('[data-testid="operator-picker"]').selectOption({ label: "Ada Okafor" });
    await s.waitForFunction(() => document.querySelector('[data-testid="metric-card"]')?.textContent?.includes("Ada Okafor"));
    await s.locator('[data-testid="log-scope-operator"]').click();
    await s.waitForFunction(() => !new URL(location.href).searchParams.has("log"));
    await s.waitForFunction(() => document.querySelector('[data-testid="log-scope-all"]')?.getAttribute("aria-pressed") === "false");
    const rows = await s.locator('[data-testid="activity-row"]').evaluateAll((els) => els.map((e) => e.textContent));
    assert(rows.length > 0 && rows.every((t) => t.includes("Ada")), `rows from other operators lingered: ${rows.length}`);
    assert(!(await s.locator('[data-testid="load-more"]').isVisible()), "load-more should be gone for Ada's short log");
  });

  const fullTimeline = () =>
    s.evaluate(() => [...document.querySelectorAll('[data-testid="timeline-point"]')].filter((e) => e.getClientRects().length > 0).map((e) => ({ at: e.getAttribute("data-at"), balance: Number(e.querySelector('[data-testid="timeline-balance"]').textContent), changed: e.getAttribute("data-changed") === "true" })));

  await check("supervisor: adjusting a past entry recalculates the history from that moment on, marks exactly the changed points, and leaves earlier ones alone", async () => {
    const before = await fullTimeline();
    assert(before.length >= 6, `only ${before.length} history points`);
    assert(before.every((p) => !p.changed), "nothing should be marked before an adjustment");
    const target = await revealRow(s, "+60");
    await target.locator('[data-testid="adjust-button"]').click();
    await s.waitForSelector('[data-testid="adjust-dialog"][open]');
    await s.locator('[data-testid="adjust-dialog"]').screenshot({ path: path.join(SHOTS, "09-desktop-adjust-dialog.png") });
    const small = (await controls(s)).filter((c) => c.h < 48);
    assert(small.length === 0, `dialog controls too small: ${JSON.stringify(small)}`);

    // over-correction is refused with a clear message, and nothing changes
    await s.locator('[data-testid="adjust-remove"]').click();
    await s.locator('[data-testid="adjust-amount"]').fill("61");
    await s.locator('[data-testid="adjust-reason"]').fill("Too much");
    await s.locator('[data-testid="adjust-save"]').click();
    await s.waitForSelector('[data-testid="adjust-error"]');
    assert((await s.locator('[data-testid="adjust-error"]').innerText()).includes("below zero"), "expected the below-zero message");
    assert(await s.locator('[data-testid="adjust-dialog"]').evaluate((el) => el.open), "the dialog should stay open after an error");

    // a valid one
    await s.locator('[data-testid="adjust-amount"]').fill("20");
    await s.locator('[data-testid="adjust-reason"]').fill("Miscount at pickup");
    await s.locator('[data-testid="adjust-save"]').click();
    await s.waitForSelector('[data-testid="adjust-dialog"]', { state: "detached" });
    await s.locator('[data-testid="recalculated-tag"]:visible').first().waitFor();
    const after = await fullTimeline();

    // the adjusted entry's real window, from the database (an adjustment is dated at the entry's time and expires with it)
    const win = await pool_query(
      `SELECT extract(epoch from effective_at) * 1000 AS eff, extract(epoch from expires_at) * 1000 AS exp FROM ledger_entry WHERE operator_id = $1 AND units = 60 AND kind = 'ALLOCATION'`,
      [id("ada")],
    );
    const effective = Number(win.eff);
    const expiry = Number(win.exp);
    let changedCount = 0;
    for (const p of before) {
      const q = after.find((x) => x.at === p.at);
      assert(q, `point ${p.at} disappeared`);
      const t = Date.parse(p.at);
      const inWindow = t >= effective && t < expiry;
      if (inWindow) {
        assert(q.balance === p.balance - 20, `point ${p.at}: ${p.balance} -> ${q.balance}, expected -20`);
        changedCount += 1;
      } else {
        assert(q.balance === p.balance, `point ${p.at} (outside the adjusted window) changed: ${p.balance} -> ${q.balance}`);
      }
      assert(q.changed === (q.balance !== p.balance), `point ${p.at}: marked=${q.changed} but changed=${q.balance !== p.balance}`);
    }
    assert(changedCount >= 2, `only ${changedCount} points were recalculated`);
    assert((await metricText(s)) === "105", `Ada's metric should now be 105, got ${await metricText(s)}`); // 125 - 20
    const adjustmentRow = s.locator('[data-testid="activity-row"][data-kind="ADJUSTMENT"]').first();
    assert((await adjustmentRow.innerText()).includes("Miscount at pickup"), "the adjustment row should show its reason");
    assert((await s.locator('[data-testid="announcer"]').innerText()).includes("recalculated"), "screen readers should be told");
    await s.locator('[data-testid="status-timeline"]:visible').screenshot({ path: path.join(SHOTS, "10-desktop-history-after-adjust.png") });
  });

  await check("the recalculated marks fade away by themselves", async () => {
    await s.locator('[data-testid="recalculated-tag"]:visible').first().waitFor({ state: "hidden", timeout: 15_000 });
  });

  await check("adjust: a retry after a failure re-sends the SAME Idempotency-Key, and a changed request gets a NEW one", async () => {
    const keys = [];
    let failOnce = true;
    await s.route("**/api/adjustments", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (failOnce) {
        failOnce = false;
        return route.abort("connectionfailed");
      }
      return route.continue();
    });
    const target = await revealRow(s, "+30");
    await target.locator('[data-testid="adjust-button"]').click();
    await s.locator('[data-testid="adjust-remove"]').click();
    await s.locator('[data-testid="adjust-amount"]').fill("5");
    await s.locator('[data-testid="adjust-reason"]').fill("Retry test");
    await s.locator('[data-testid="adjust-save"]').click();
    await s.waitForSelector('[data-testid="adjust-error"]');
    assert((await s.locator('[data-testid="adjust-save"]').innerText()).includes("Try again"), "the button should offer Try again");
    await s.locator('[data-testid="adjust-save"]').click();
    await s.waitForSelector('[data-testid="adjust-dialog"]', { state: "detached" });
    assert(keys.length === 2 && keys[0] === keys[1], `keys: ${JSON.stringify(keys)}`);
    const rows = await pool_query(`SELECT count(*)::int AS n FROM ledger_entry WHERE reason = 'Retry test' AND operator_id = $1`, [id("ada")]);
    assert(rows.n === 1, `the adjustment was saved ${rows.n} times`);
    await s.unroute("**/api/adjustments");
  });

  await check("other people's writes show up on their own within a few seconds (the 3 s poll), and only in the log they belong to", async () => {
    const before = await s.locator('[data-testid="activity-row"]').count(); // Ada's log
    const write = (who, units, key) =>
      fetch(`${main.base}/api/entries`, {
        method: "POST",
        headers: { cookie: `uid=${id(who)}`, "content-type": "application/json", "Idempotency-Key": `${key}-${RUN}` },
        body: JSON.stringify({ units }),
      });
    assert((await write("cy", 3, "poll-cy")).status === 201, "setup write (Cy) failed");
    assert((await write("ada", 4, "poll-ada")).status === 201, "setup write (Ada) failed");
    const started = Date.now();
    await s.waitForFunction((n) => document.querySelectorAll('[data-testid="activity-row"]').length > n, before, { timeout: 8_000 });
    console.log(`      appeared after ${Date.now() - started} ms`);
    await sleep(3_500); // a whole extra poll: Cy's entry must still not show up in Ada's log
    const after = await s.locator('[data-testid="activity-row"]').evaluateAll((els) => els.map((e) => e.textContent));
    assert(after.length === before + 1, `Ada's log should grow by exactly 1 (Ada's write), went ${before} -> ${after.length}`);
    assert(after.every((t) => t.includes("Ada")), "Cy's entry leaked into Ada's filtered log");
  });
  await supCtx.close();

  // ======================================================== supervisor on a phone: the filter, and the adjust dialog as a bottom sheet
  const supPhone = await newContext(main.base, "mobile", "eli");
  const sm = await supPhone.newPage();
  await sm.goto(`/?operator=${id("ada")}`);
  await sm.waitForSelector('[data-testid="log-scope"]');
  await shot(sm, "14-mobile-supervisor");

  await check("supervisor on a phone: the filter and the log fit the screen (no sideways scroll, nothing spills, controls >= 48px, 7:1 contrast)", async () => {
    const overflow = await sm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `page is ${overflow}px wider than the screen`);
    const out = await spills(sm);
    assert(out.length === 0, `${out.length} element(s) poke out of their card: ${JSON.stringify(out.slice(0, 4))}`);
    const small = (await controls(sm)).filter((c) => c.h < 48);
    assert(small.length === 0, `too small: ${JSON.stringify(small)}`);
    const weak = (await contrastReport(sm)).filter((r) => r.ratio < 7).map((r) => `"${r.text}" ${r.ratio.toFixed(2)}:1`);
    assert(weak.length === 0, `low contrast: ${weak.join("; ")}`);
    const both = await sm.locator('[data-testid="log-scope"] button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
    assert(both.length === 2 && both.every(([l, r]) => l >= 0 && r <= 390), `filter buttons are cut off: ${JSON.stringify(both)}`);
    const state = await sm.locator('[data-testid="log-scope"] button').evaluateAll((els) => els.map((e) => e.textContent.trim()));
    assert(state[0].startsWith("✓") && !state[1].startsWith("✓"), `which filter is on must be readable without colour: ${JSON.stringify(state)}`);
  });

  await check("supervisor on a phone: the filter toggle works with a tap, and Everyone also fits the screen", async () => {
    await sm.locator('[data-testid="log-scope-all"]').tap();
    await sm.waitForFunction(() => new URL(location.href).searchParams.get("log") === "all");
    await sm.waitForFunction(() => document.querySelector('[data-testid="log-scope-text"]')?.textContent?.startsWith("Everyone in"));
    const overflow = await sm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `page is ${overflow}px wider than the screen`);
    const out = await spills(sm);
    assert(out.length === 0, `${out.length} element(s) poke out of their card: ${JSON.stringify(out.slice(0, 4))}`);
    await sm.locator('[data-testid="log-scope-operator"]').tap();
    await sm.waitForFunction(() => !new URL(location.href).searchParams.has("log"));
    await sm.waitForFunction(() => document.querySelector('[data-testid="log-scope-text"]')?.textContent?.includes("allocations and corrections"));
  });

  await check("supervisor on a phone: Adjust opens a bottom sheet (full width, flush with the bottom edge) whose buttons are within thumb reach and inside the sheet", async () => {
    const row = await revealRow(sm, "+60");
    await row.locator('[data-testid="adjust-button"]').tap();
    await sm.waitForSelector('[data-testid="adjust-dialog"][open]');
    await sm.waitForTimeout(300);
    const dlg = await sm.locator('[data-testid="adjust-dialog"]').boundingBox();
    const view = sm.viewportSize();
    assert(dlg, "no dialog box");
    assert(Math.abs(dlg.x) <= 1 && Math.abs(dlg.width - view.width) <= 1, `the sheet should span the screen width: x=${dlg.x} w=${dlg.width}`);
    assert(Math.abs(dlg.y + dlg.height - view.height) <= 1, `the sheet should sit on the bottom edge: bottom=${dlg.y + dlg.height}, screen=${view.height}`);
    assert(dlg.y > 0, "the sheet should leave a strip of the page visible above it");
    for (const testid of ["adjust-save", "adjust-cancel"]) {
      const b = await sm.locator(`[data-testid="${testid}"]`).boundingBox();
      assert(b && b.y + b.height <= dlg.y + dlg.height + 0.5 && b.y >= dlg.y, `${testid} is not inside the sheet`);
      const centre = b.y + b.height / 2;
      assert(centre >= view.height * 0.6, `${testid} is at ${Math.round(centre)}px of ${view.height}: out of thumb reach (needs the lower 40%)`);
      assert(b.height >= 56, `${testid} is only ${b.height}px tall`);
    }
    const out = await spills(sm);
    assert(out.length === 0, `${out.length} element(s) poke out of the sheet: ${JSON.stringify(out.slice(0, 4))}`);
    const small = (await controls(sm)).filter((c) => c.h < 48);
    assert(small.length === 0, `sheet controls too small: ${JSON.stringify(small)}`);
    await shot(sm, "15-mobile-adjust-sheet");
    await sm.locator('[data-testid="adjust-cancel"]').tap();
    await sm.waitForSelector('[data-testid="adjust-dialog"]', { state: "detached" });
  });
  await supPhone.close();

  // ======================================================== expiry at the exact moment (poll interval 60 s, so only the scheduled refetch can do it)
  await check("expiry: the number and status change at the exact moment an entry expires, not at the next poll (poll is 60 s here)", async () => {
    const insert = async (units, expiresSql) =>
      (await db.query(
        `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, idempotency_key)
         VALUES ('ALLOCATION', $1, $2, $1, $3, now() - interval '1 minute', ${expiresSql}, $4) RETURNING extract(epoch from expires_at) * 1000 AS ms`,
        [id("zed"), id("pool_zed"), units, `zed-${RUN}-${units}`],
      )).rows[0].ms;
    await insert(40, "NULL"); //                      never expires: 40 stays
    const expiresMs = Number(await insert(20, "now() + interval '9 seconds'")); // 20 more, gone in 9 s
    await db.query(`UPDATE pool SET balance = balance + 60 WHERE id = $1`, [id("pool_zed")]);

    const ctx = await newContext(slow.base, "mobile", "zed");
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForSelector('[data-testid="metric-value"]');
    assert((await metricText(page)) === "60", `expected 60 at the start, got ${await metricText(page)}`);
    assert((await statusWord(page)).includes("Normal"), "expected Normal at 60");
    assert((await page.locator('[data-testid="next-expiry"]').innerText()).includes("Next expiry"), "should show the next expiry");

    await page.waitForFunction(() => document.querySelector('[data-testid="metric-value"]').textContent === "40", null, { timeout: 25_000, polling: 25 });
    const delay = Date.now() - expiresMs;
    console.log(`      changed ${delay} ms after the expiry instant`);
    assert(delay >= -100, `it changed ${-delay} ms BEFORE the entry expired`);
    assert(delay < 2_500, `it changed ${delay} ms after the expiry (a 60 s poll would be far later)`);
    assert((await statusWord(page)).includes("Low"), "status should have dropped to Low");
    assert((await page.locator('[data-testid="next-expiry"]').innerText()).includes("No upcoming expiry"), "no further expiry is pending");
    await shot(page, "11-mobile-after-expiry");
    await ctx.close();
  });

  // ======================================================== the temporary user switcher
  await check("user switcher: shown when ENABLE_USER_SWITCHER=true; picking a user signs them in", async () => {
    const ctx = await browser.newContext({ baseURL: main.base, viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForSelector('[data-testid="user-switcher"]');
    const options = await page.locator('[data-testid="switch-user-option"]').count();
    assert(options >= 6, `only ${options} users listed`);
    const small = (await controls(page)).filter((c) => c.h < 48);
    assert(small.length === 0, `switcher buttons too small: ${JSON.stringify(small)}`);
    await page.screenshot({ path: path.join(SHOTS, "12-mobile-switcher.png") });
    await page.locator(`[data-user-id="${id("ben")}"]`).click();
    await page.waitForSelector('[data-testid="metric-value"]');
    assert((await page.locator('[data-testid="current-user"]').innerText()).includes("Ben Lindqvist"), "should be signed in as Ben");
    await ctx.close();
  });

  await check("user switcher OFF (the default): the page says sign-in isn't available, and POST /api/switch-user does not exist", async () => {
    const ctx = await browser.newContext({ baseURL: off.base });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.waitForSelector('[data-testid="signed-out"]');
    assert((await page.locator('[data-testid="switch-user-option"]').count()) === 0, "the switcher is showing");
    const res = await fetch(`${off.base}/api/switch-user`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: id("ada") }) });
    assert(res.status === 404, `endpoint answered ${res.status}, expected 404`);
    assert(!res.headers.get("set-cookie"), "it set a cookie");
    await ctx.close();
  });
} finally {
  await browser.close();
  stopServers();
  await db.end();
  await poolEnd();
}

// ---------------------------------------------------------------- shared little query helper
async function pool_query(sql, params) {
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows[0];
  } finally {
    await c.end();
  }
}
async function poolEnd() {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length === 0 ? 0 : 1);
