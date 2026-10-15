import { notFound as nextNotFound, redirect } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { ApiError, failureError, forbidden, jsonResponse, notFound, route, toErrorResponse, unauthenticated } from "./errors";

afterEach(() => vi.restoreAllMocks());

describe("failureError: every service failure maps to exactly one HTTP error", () => {
  it.each([
    ["IDEMPOTENCY_KEY_REUSED", 409],
    ["CAPACITY_EXCEEDED", 422],
    ["TARGET_NOT_ALLOCATION", 422],
    ["OPERATOR_NOT_FOUND", 404],
    ["SUPERVISOR_NOT_FOUND", 404],
    ["TARGET_NOT_FOUND", 404],
    ["NOT_SUPERVISOR", 403],
    ["BUSY", 503],
  ] as const)("%s -> %i with a matching error code", async (reason, status) => {
    const res = toErrorResponse(failureError(reason));
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: reason });
  });

  it("BUSY tells the client to retry in 1 second", () => {
    expect(toErrorResponse(failureError("BUSY")).headers.get("Retry-After")).toBe("1");
    expect(toErrorResponse(failureError("CAPACITY_EXCEEDED")).headers.get("Retry-After")).toBeNull();
  });
});

describe("toErrorResponse: the one shared error handler", () => {
  it.each([
    [unauthenticated(), 401, "UNAUTHENTICATED"],
    [forbidden("Supervisors only."), 403, "FORBIDDEN"],
    [notFound("No such operator."), 404, "NOT_FOUND"],
  ] as const)("ApiError %# keeps its status and code", async (err, status, code) => {
    const res = toErrorResponse(err);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code });
  });

  it("includes the message the ApiError was given", async () => {
    expect(await toErrorResponse(forbidden("Supervisors only.")).json()).toMatchObject({ message: "Supervisors only." });
  });

  it("a Zod validation error becomes 400 INVALID_REQUEST with the field issues", async () => {
    const parsed = z.object({ units: z.number().positive() }).safeParse({ units: -1 });
    const err: ZodError = parsed.error as ZodError;
    const res = toErrorResponse(err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_REQUEST");
    expect(JSON.stringify(body.issues)).toContain("units");
  });

  it("an unexpected error becomes 500 INTERNAL with NO message, stack or details from the original", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("password=hunter2 at postgres://user:pw@host/db");
    const res = toErrorResponse(original);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "INTERNAL", message: "Something went wrong." });
    for (const leak of ["hunter2", "postgres://", "pw@host", "Error:", " at ", ".ts:", "stack"]) {
      expect(text).not.toContain(leak);
    }
    // ...but the real error is still logged server-side
    expect(log).toHaveBeenCalledWith(expect.anything(), original);
  });

  it("anything thrown that isn't an Error is also a plain 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of ["a string", 42, null, undefined, { weird: true }]) {
      const res = toErrorResponse(thrown);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "INTERNAL", message: "Something went wrong." });
    }
  });

  it("error responses are JSON and never cacheable", () => {
    const res = toErrorResponse(notFound("x"));
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("jsonResponse", () => {
  it("is JSON, honors status and headers, and is never cacheable (the data is per-user)", async () => {
    const res = jsonResponse({ a: 1 }, { status: 201, headers: { "X-Test": "1" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("serializes Dates as ISO strings", async () => {
    expect(await jsonResponse({ at: new Date("2026-01-01T00:00:00Z") }).json()).toEqual({ at: "2026-01-01T00:00:00.000Z" });
  });
});

describe("route(): wraps a handler so any throw goes through the shared error handler", () => {
  it("passes a normal Response through untouched", async () => {
    const ok = jsonResponse({ fine: true });
    const wrapped = route(async () => ok);
    expect(await wrapped()).toBe(ok);
  });

  it("forwards the handler's arguments", async () => {
    const wrapped = route(async (a: number, b: number) => jsonResponse({ sum: a + b }));
    expect(await (await wrapped(2, 3)).json()).toEqual({ sum: 5 });
  });

  it("turns a thrown ApiError into its response", async () => {
    const wrapped = route(async () => {
      throw new ApiError(404, "NOT_FOUND", "gone");
    });
    expect((await wrapped()).status).toBe(404);
  });

  it("turns a thrown unexpected error into a safe 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapped = route(async () => {
      throw new Error("boom");
    });
    const res = await wrapped();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
});

describe("Next.js framework errors are never swallowed by the shared handler", () => {
  // notFound() / redirect() and (at build time) the "this route is dynamic" prerender signal are
  // implemented by throwing. Turning them into a 500 would break routing and rendering.
  it("route() rethrows Next control-flow errors instead of answering them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const notFoundHandler = route(async () => nextNotFound());
    const redirectHandler = route(async () => redirect("/elsewhere"));

    await expect(notFoundHandler()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(redirectHandler()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(log).not.toHaveBeenCalled(); // not logged as an "unhandled API error" either
  });

  it("toErrorResponse rethrows them too", () => {
    expect(() => toErrorResponse(captured(() => nextNotFound()))).toThrow();
  });

  it("application errors are still handled as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await route(async () => {
      throw new Error("ordinary failure");
    })();
    expect(res.status).toBe(500);
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the function to throw");
}
