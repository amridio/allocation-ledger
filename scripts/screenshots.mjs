// README screenshots: npm run docs:screenshots   (run `npm run build` first)
//
// Starts the production server against the ops_test database (never the dev one), builds a fresh,
// realistic pool for each screen size, drives the real UI, and saves docs/screenshots/*.png:
//   operator view, after a submit, the capacity-exceeded error, the supervisor's adjust sheet,
//   and the status history after an adjustment; each at 360px (phone) and 1280px (desktop).
import { spawn } from "node:child_process";
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

const OUT = path.resolve("docs/screenshots");
mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const PORT = 3130;
const HOUR = 3_600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server
const NEXT_BIN = path.resolve("node_modules/next/dist/bin/next");
const isUp = () => fetch(`http://localhost:${PORT}/`).then(() => true, () => false);
if (await isUp()) throw new Error(`port ${PORT} is already in use (a leftover server?). Stop it and run again.`);
const server = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(PORT)], {
  env: { ...process.env, DATABASE_URL: TEST_URL, APP_TIMEZONE: "UTC", UI_POLL_MS: "60000", ENABLE_USER_SWITCHER: "true" },
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* gone */
  }
};
process.on("exit", stop);
for (let i = 0; i < 60 && !(await isUp()); i++) await sleep(500);
if (!(await isUp())) throw new Error("the server did not start");

// ---------------------------------------------------------------- fixtures
const db = new pg.Client({ connectionString: TEST_URL });
await db.connect();

/** A fresh pool: Ada's history walks through all four statuses; the pool is nearly full so a big allocation is refused. */
async function seedPool(tag) {
  const id = (n) => `${n}_${tag}_${RUN}`;
  await db.query(`INSERT INTO tier (id, name, expiry_minutes) VALUES ($1, $1, 1440)`, [id("tier")]);
  // Pool names are unique and the ledger can't be cleaned up: retire the pool of an earlier size / run (the pool row may be renamed, only the ledger is append-only).
  await db.query(`UPDATE pool SET name = name || ' (retired ' || id || ')' WHERE name = 'Warehouse North'`);
  await db.query(`INSERT INTO pool (id, name, capacity, updated_at) VALUES ($1, 'Warehouse North', 500, now())`, [id("pool")]);
  const person = (key, name, role) =>
    db.query(`INSERT INTO operator (id, name, role, tier_id, pool_id) VALUES ($1, $2, $3::"Role", $4, $5)`, [id(key), name, role, id("tier"), id("pool")]);
  await person("ada", "Ada Okafor", "OPERATOR");
  await person("ben", "Ben Lindqvist", "OPERATOR");
  await person("cy", "Cy Navarro", "OPERATOR");
  await person("eli", "Eli Park", "SUPERVISOR");
  let n = 0;
  const entry = async (op, units, ageMs, expiresInMs) => {
    n += 1;
    await db.query(
      `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, idempotency_key)
       VALUES ('ALLOCATION', $1, $2, $1, $3, $4, $5, $6)`,
      [id(op), id("pool"), units, new Date(Date.now() - ageMs), expiresInMs === null ? null : new Date(Date.now() + expiresInMs), `shot-${tag}-${RUN}-${n}`],
    );
    await db.query(`UPDATE pool SET balance = balance + $1 WHERE id = $2`, [units, id("pool")]);
  };
  await entry("ada", 10, 30 * HOUR, null); //                      10   Critical
  await entry("ada", 20, 26 * HOUR, -2 * HOUR); //                  expired
  await entry("ada", 15, 20 * HOUR, null); //                      25   Low
  await entry("ada", 30, 10 * HOUR, 3 * HOUR); //                  55   Normal
  await entry("ada", 60, 5 * HOUR, 10 * HOUR); //                  115  High
  await entry("ada", 10, 1 * HOUR, null); //                       125
  await entry("ben", 32, 3 * HOUR, null);
  await entry("cy", 330, 2 * HOUR, null); //                       pool at 487 of 500: only 13 units of room
  return id;
}

// ---------------------------------------------------------------- browser
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
    const exe = path.join(root, dir, "chrome-linux", "chrome");
    if (existsSync(exe)) return exe;
  }
  throw new Error(`no Chromium under ${root}`);
}
const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const SIZES = {
  phone: { name: "360", viewport: { width: 360, height: 900 }, mobile: true },
  desktop: { name: "1280", viewport: { width: 1280, height: 900 }, mobile: false },
};
const context = (size, uid) =>
  browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    viewport: size.viewport,
    deviceScaleFactor: 2,
    isMobile: size.mobile,
    hasTouch: size.mobile,
    storageState: { cookies: [{ name: "uid", value: uid, domain: "localhost", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] },
  });
const tap = (page, size, selector) => (size.mobile ? page.locator(selector).tap() : page.locator(selector).click());
const save = async (page, size, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}-${size.name}.png`) });
  console.log(`saved docs/screenshots/${name}-${size.name}.png`);
};
const openLogForm = async (page, size) => {
  if (!size.mobile) return page.locator('[data-testid="desktop-form"]');
  await tap(page, size, '[data-testid="open-log-sheet"]');
  await page.waitForSelector('[data-testid="log-sheet"][open]');
  return page.locator('[data-testid="log-sheet"]');
};

try {
  for (const size of Object.values(SIZES)) {
    const id = await seedPool(size.name);

    // ------------------------------------------------ 1. operator view, 2. after a submit, 3. error
    const ada = await context(size, id("ada"));
    const page = await ada.newPage();
    await page.goto("/");
    await page.waitForSelector('[data-testid="metric-value"]');
    await save(page, size, "01-operator");

    const form = await openLogForm(page, size);
    await form.locator('[data-testid="units-input"]').fill("10");
    await form.locator('[data-testid="submit-allocation"]').click();
    await page.waitForSelector('[data-testid="pending-row"]', { state: "detached" });
    await page.waitForFunction(() => document.querySelector('[data-testid="metric-value"]')?.textContent === "135");
    // a phone is too short to show the number AND the new row: take this one on a taller (1500px) screen (same 360px width)
    if (size.mobile) await page.setViewportSize({ width: size.viewport.width, height: 1500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);
    await save(page, size, "02-after-submit");
    if (size.mobile) await page.setViewportSize(size.viewport);

    const form2 = await openLogForm(page, size);
    await form2.locator('[data-testid="units-input"]').fill("50"); // 13 units of room left
    await form2.locator('[data-testid="submit-allocation"]').click();
    await page.waitForSelector('[data-testid="notice"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);
    await save(page, size, "03-error-capacity");
    await ada.close();

    // ------------------------------------------------ 4. supervisor adjust sheet, 5. history after an adjustment
    const eli = await context(size, id("eli"));
    const sup = await eli.newPage();
    await sup.goto(`/?operator=${id("ada")}`);
    await sup.waitForSelector('[data-testid="log-scope"]');
    const row = sup.locator('[data-testid="activity-row"][data-kind="ALLOCATION"]', { hasText: "+60" }).first();
    await row.scrollIntoViewIfNeeded();
    await (size.mobile ? row.locator('[data-testid="adjust-button"]').tap() : row.locator('[data-testid="adjust-button"]').click());
    await sup.waitForSelector('[data-testid="adjust-dialog"][open]');
    await sup.locator('[data-testid="adjust-remove"]').click();
    await sup.locator('[data-testid="adjust-amount"]').fill("20");
    await sup.locator('[data-testid="adjust-reason"]').fill("Miscount at pickup");
    await sleep(400);
    await save(sup, size, "04-adjust-sheet");

    await sup.locator('[data-testid="adjust-save"]').click();
    await sup.waitForSelector('[data-testid="adjust-dialog"]', { state: "detached" });
    if (size.mobile) await sup.locator('[data-testid="timeline-disclosure"] summary').tap(); // the phone keeps the history behind a tap
    await sup.locator('[data-testid="recalculated-tag"]:visible').first().waitFor();
    if (size.mobile) {
      await sup.evaluate(() => document.querySelector('[data-testid="timeline-disclosure"]').scrollIntoView({ block: "start" }));
    } else {
      // the history is a tall column: a taller window shows the number, the history and the log together
      await sup.setViewportSize({ width: size.viewport.width, height: 1500 });
      await sup.evaluate(() => window.scrollTo(0, 0));
    }
    await sleep(500);
    await save(sup, size, "05-history-after-adjustment");
    await eli.close();
  }
} finally {
  await browser.close();
  await db.end();
  stop();
}
