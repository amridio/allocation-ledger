import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "./errors";
import { readCookie, requireRole, requireUser, sessionCookie, SESSION_COOKIE } from "./auth";

const withCookie = (cookie?: string) =>
  new Request("http://localhost/api/x", { headers: cookie === undefined ? {} : { cookie } });

describe("readCookie", () => {
  it("finds a cookie among several", () => {
    expect(readCookie(withCookie("a=1; uid=op_7; b=2"), "uid")).toBe("op_7");
  });

  it("is undefined when there is no Cookie header or no such cookie", () => {
    expect(readCookie(withCookie(), "uid")).toBeUndefined();
    expect(readCookie(withCookie("a=1"), "uid")).toBeUndefined();
  });

  it("does not confuse cookies that merely end with the name", () => {
    expect(readCookie(withCookie("xuid=evil; myuid=evil2"), "uid")).toBeUndefined();
  });

  it("decodes percent-encoding and tolerates malformed input", () => {
    expect(readCookie(withCookie("uid=op%20one"), "uid")).toBe("op one");
    expect(readCookie(withCookie("uid=%E0%A4%A"), "uid")).toBeUndefined(); // bad escape: ignored, not a crash
    expect(readCookie(withCookie(";;=;uid"), "uid")).toBeUndefined();
  });

  it("uses the first occurrence if the cookie is repeated", () => {
    expect(readCookie(withCookie("uid=first; uid=second"), "uid")).toBe("first");
  });
});

describe("sessionCookie", () => {
  it("is HttpOnly, SameSite=Lax, site-wide, and lasts 30 days", () => {
    const cookie = sessionCookie("op_7");
    expect(cookie).toContain(`${SESSION_COOKIE}=op_7`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("is Secure only when asked to be (production)", () => {
    expect(sessionCookie("op_7", { secure: false })).not.toContain("Secure");
    expect(sessionCookie("op_7", { secure: true })).toContain("Secure");
  });

  it("encodes the id so it can't inject extra cookie attributes", () => {
    const cookie = sessionCookie("x; Path=/evil");
    expect(cookie.startsWith(`${SESSION_COOKIE}=x%3B%20Path%3D%2Fevil`)).toBe(true);
  });
});

describe("requireUser / requireRole", () => {
  const user = (role: "OPERATOR" | "SUPERVISOR") => ({ id: "u", name: "U", role, poolId: "p" });

  it("401 without a cookie, and never touches the database", async () => {
    const findUnique = vi.fn();
    const db = { operator: { findUnique } } as unknown as PrismaClient;
    await expect(requireUser(withCookie(), db)).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("401 when the cookie names a user that doesn't exist", async () => {
    const db = { operator: { findUnique: async () => null } } as unknown as PrismaClient;
    await expect(requireUser(withCookie("uid=ghost"), db)).rejects.toBeInstanceOf(ApiError);
    await expect(requireUser(withCookie("uid=ghost"), db)).rejects.toMatchObject({ status: 401 });
  });

  it("returns the user the cookie names", async () => {
    const row = { id: "op_7", name: "Ada", role: "OPERATOR", poolId: "pool_1", tierId: "t" };
    const db = { operator: { findUnique: async () => row } } as unknown as PrismaClient;
    expect(await requireUser(withCookie("uid=op_7"), db)).toEqual({ id: "op_7", name: "Ada", role: "OPERATOR", poolId: "pool_1" });
  });

  it("requireRole: passes for the right role, 403 for the wrong one", () => {
    expect(() => requireRole(user("SUPERVISOR"), "SUPERVISOR")).not.toThrow();
    expect(() => requireRole(user("OPERATOR"), "SUPERVISOR")).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => requireRole(user("SUPERVISOR"), "OPERATOR")).toThrowError(expect.objectContaining({ status: 403 }));
  });
});
