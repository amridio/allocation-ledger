import type { ZodType } from "zod";
import { idempotencyKeySchema } from "@/domain/idempotency";
import { badRequest } from "./errors";

/** The Idempotency-Key header every POST must send. Resend the same key to retry safely. */
export function readIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key");
  if (value === null || value.trim() === "") {
    throw badRequest(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send an Idempotency-Key header (any unique string) so a retry can't be counted twice.",
    );
  }
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be between 1 and 200 characters.");
  }
  return parsed.data;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest("INVALID_JSON", "Request body must be valid JSON.");
  }
}

/** Parses the query string with a Zod schema; a ZodError is turned into a 400 by the shared handler. */
export function readQuery<T>(request: Request, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}
