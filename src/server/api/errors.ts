import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import type { AdjustFailure, AllocateFailure } from "../ledger-types";

/** An error that already knows how it should look over HTTP. Throw it from anywhere in a handler. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthenticated = () => new ApiError(401, "UNAUTHENTICATED", "Not logged in.");
export const forbidden = (message = "You are not allowed to do that.") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new ApiError(404, "NOT_FOUND", message);

type Failure = AllocateFailure | AdjustFailure;

const FAILURES: Record<Failure, { status: number; message: string; headers?: Record<string, string> }> = {
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: "This Idempotency-Key was already used with a different request." },
  CAPACITY_EXCEEDED: { status: 422, message: "The pool does not have enough capacity for this." },
  TARGET_NOT_ALLOCATION: { status: 422, message: "Only allocations can be adjusted. Adjust the original entry instead." },
  OPERATOR_NOT_FOUND: { status: 404, message: "Operator not found." },
  SUPERVISOR_NOT_FOUND: { status: 404, message: "Supervisor not found." },
  TARGET_NOT_FOUND: { status: 404, message: "Entry not found." },
  NOT_SUPERVISOR: { status: 403, message: "Only supervisors can do that." },
  TARGET_OTHER_POOL: { status: 403, message: "You can only adjust entries in your own pool." },
  ADJUSTMENT_BELOW_ZERO: {
    status: 422,
    message: "That would take the entry below zero units once all its adjustments are counted.",
  },
  BUSY: {
    status: 503,
    message: "The pool is busy. Retry with the same Idempotency-Key.",
    headers: { "Retry-After": "1" },
  },
};

/** A service failure reason as an HTTP error. */
export function failureError(reason: Failure): ApiError {
  const { status, message, headers } = FAILURES[reason];
  return new ApiError(status, reason, message, headers);
}

/** JSON responses are per-user, so they must never be cached. */
export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: { "Cache-Control": "no-store", ...init.headers },
  });
}

/**
 * THE shared error handler. Every handler's failures end up here:
 *   ApiError  -> its own status / code / message (401, 403, 404, 409, 422, 503, ...)
 *   ZodError  -> 400 INVALID_REQUEST with the field issues
 *   anything else -> 500 INTERNAL with a fixed message. The real error is logged server-side
 *                    only: no message, stack or detail ever reaches the client.
 *   Next.js framework errors (notFound, redirect, prerender interrupts) are rethrown untouched.
 */
export function toErrorResponse(err: unknown): Response {
  // Next.js implements notFound(), redirect() and its "this route is dynamic" prerender signal by
  // throwing. Those must reach the framework, never become a 500. (Documented usage: first line of the catch.)
  unstable_rethrow(err);
  if (err instanceof ApiError) {
    return jsonResponse({ error: err.code, message: err.message }, { status: err.status, headers: err.headers });
  }
  if (err instanceof ZodError) {
    return jsonResponse(
      { error: "INVALID_REQUEST", message: "Request validation failed.", issues: err.issues },
      { status: 400 },
    );
  }
  console.error("Unhandled API error", err);
  return jsonResponse({ error: "INTERNAL", message: "Something went wrong." }, { status: 500 });
}

/** Wraps a handler so anything it throws (or rejects with) goes through toErrorResponse. */
export function route<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
