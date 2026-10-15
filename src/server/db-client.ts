import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/** Side-effect free: builds a client for the given connection string (used by tests and by db.ts). */
export function createDb(connectionString: string, options: { max?: number } = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: options.max }) });
}
