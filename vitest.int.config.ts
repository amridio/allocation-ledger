import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against real Postgres (TEST_DATABASE_URL). Run: npm run test:int
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    globalSetup: ["./vitest.int.setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
