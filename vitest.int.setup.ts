import { execFileSync } from "node:child_process";

/** Migrates the TEST database (never the dev one) before the integration tests run. */
export default function setup() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the real environment.
  }
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  if (url === process.env["DATABASE_URL"]) {
    throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL: integration tests insert rows that can never be deleted");
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
