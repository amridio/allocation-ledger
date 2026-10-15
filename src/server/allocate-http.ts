import { allocateInputSchema, type AllocateInput } from "@/domain/allocation";
import type { AllocateFailure, AllocateResult } from "./allocate-types";

const FAILURES: Record<AllocateFailure, { status: number; message: string }> = {
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: "This idempotency key was already used with a different request." },
  CAPACITY_EXCEEDED: { status: 422, message: "The pool does not have enough capacity for this allocation." },
  OPERATOR_NOT_FOUND: { status: 404, message: "Operator not found." },
  BUSY: { status: 503, message: "The pool is busy. Retry with the same idempotency key." },
};

/** Thin HTTP layer: parse, call the service, map the result. No business rules here. */
export async function handleAllocate(
  request: Request,
  allocate: (input: AllocateInput) => Promise<AllocateResult>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "INVALID_JSON", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = allocateInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, { status: 400 });
  }

  let result: AllocateResult;
  try {
    result = await allocate(parsed.data);
  } catch (err) {
    console.error("allocate failed", err);
    return Response.json({ error: "INTERNAL", message: "Something went wrong." }, { status: 500 });
  }

  if (result.ok) {
    return Response.json({ replay: result.replay, entry: result.entry }, { status: result.replay ? 200 : 201 });
  }
  const { status, message } = FAILURES[result.reason];
  return Response.json(
    { error: result.reason, message },
    { status, headers: result.reason === "BUSY" ? { "Retry-After": "1" } : undefined },
  );
}
