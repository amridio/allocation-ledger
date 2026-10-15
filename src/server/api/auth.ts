import type { PrismaClient } from "@/generated/prisma/client";
import { forbidden, unauthenticated } from "./errors";

/*
 * TEMPORARY AUTH. The "session" is a cookie holding a user id, set by POST /api/switch-user.
 * Anyone can set that cookie to any id, so this identifies users but does NOT authenticate them.
 * Replace with real login before this holds real data. Everything that needs "who is calling"
 * goes through requireUser(), so that is the one place to change.
 */

export const SESSION_COOKIE = "uid";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type Role = "OPERATOR" | "SUPERVISOR";
export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  poolId: string;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined; // malformed percent-escape: treat as absent
    }
  }
  return undefined;
}

export function sessionCookie(userId: string, options: { secure?: boolean } = {}): string {
  const secure = options.secure ?? process.env.NODE_ENV === "production";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(userId)}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The logged-in user, or a 401. */
export async function requireUser(request: Request, db: PrismaClient): Promise<SessionUser> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) throw unauthenticated();
  const user = await db.operator.findUnique({ where: { id } });
  if (!user) throw unauthenticated();
  return { id: user.id, name: user.name, role: user.role, poolId: user.poolId };
}

export function requireRole(user: SessionUser, role: Role): void {
  if (user.role !== role) {
    throw forbidden(role === "SUPERVISOR" ? "Only supervisors can do that." : "Only operators can do that.");
  }
}
