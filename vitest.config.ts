import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Fast unit tests only. Integration tests (*.int.test.ts) need Postgres: see vitest.int.config.ts.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
  },
});
