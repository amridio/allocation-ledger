import { defineConfig } from "prisma/config";

// The Prisma CLI does not load .env itself; use Node's built-in loader (no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  // No .env file (e.g. CI): rely on the real environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON prisma/seed.mjs",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
