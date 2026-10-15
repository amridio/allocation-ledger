import { execFileSync } from "node:child_process";
import { assertSafeTestDatabase } from "./src/server/testing/test-db-guard";

/** Migrates the TEST database (never the dev one) before the integration tests run. */
export default function setup() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment.
  }
  const url = process.env["TEST_DATABASE_URL"];
  assertSafeTestDatabase(url, process.env["DATABASE_URL"]);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url as string },
    stdio: "inherit",
  });
}
