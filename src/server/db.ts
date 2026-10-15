import type { PrismaClient } from "@/generated/prisma/client";
import { createDb } from "./db-client";

// One client per process; cached on globalThis so Next dev HMR doesn't open a new pool per reload.
const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

function createDefaultClient(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return createDb(connectionString);
}

export const db = globalForDb.prisma ?? createDefaultClient();
if (process.env.NODE_ENV !== "production") globalForDb.prisma = db;
