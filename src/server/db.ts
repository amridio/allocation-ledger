import type { PrismaClient } from "@/generated/prisma/client";
import { createDb } from "./db-client";
import { parsePoolSize } from "./pool-size";

// One client per process; cached on globalThis so Next dev HMR doesn't open a new pool per reload.
const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

function createDefaultClient(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return createDb(connectionString, { max: parsePoolSize(process.env["DATABASE_POOL_SIZE"]) });
}

export const db = globalForDb.prisma ?? createDefaultClient();
if (process.env.NODE_ENV !== "production") globalForDb.prisma = db;
