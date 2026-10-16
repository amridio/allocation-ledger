// One command to a running demo: npm run demo
//
//   1. creates .env from .env.example if there is none
//   2. starts Postgres in Docker (waits for its healthcheck)
//   3. applies the migrations
//   4. seeds the demo people and past entries, with T1 expiry = 2 MINUTES so expiry can be watched
//   5. starts the app on http://localhost:3000
//
// Safe to run again: the seed is idempotent. Demo data only: never point DATABASE_URL at real data.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

function fail(message) {
  console.error(`\ndemo: ${message}`);
  process.exit(1);
}
const run = (cmd, args, env = {}) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.error?.code === "ENOENT") fail(`"${cmd}" was not found. Install it first (Docker for Postgres, Node 22+ for npm).`);
  if (result.status !== 0) fail(`"${cmd} ${args.join(" ")}" failed (exit ${result.status}).`);
};

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("demo: created .env from .env.example");
}
try {
  process.loadEnvFile(); // variables already set in the shell win over .env
} catch {
  /* no .env: rely on the real environment */
}

console.log("\n== Postgres (Docker)");
run("docker", ["compose", "up", "-d", "--wait"]);
console.log("\n== Migrations");
run("npx", ["prisma", "migrate", "deploy"]);
console.log("\n== Demo data (T1 expiry = 2 minutes)");
run("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "prisma/seed.mjs", "--demo"], { SEED_SHORT_EXPIRY: "true" });

const port = process.env.PORT ?? "3000";
console.log(`
== Ready: http://localhost:${port}
   Open it, press "Switch user" and pick someone:
     Ada Okafor      demo_ada   operator, tier T1 (entries expire after 2 min in this demo)
     Ben Lindqvist   demo_ben   operator, tier T1
     Chidi Mensah    demo_cho   operator, tier T2 (72 h)
     Dee Navarro     demo_dee   operator, tier T3 (never)
     Eli Park        demo_sup   supervisor
   Walkthrough: README, "Try it in 10 minutes". Stop with Ctrl+C.
`);
const app = spawn("npx", ["next", "dev", "-p", port], { stdio: "inherit" });
app.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => app.kill("SIGINT"));
process.on("SIGTERM", () => app.kill("SIGTERM"));
