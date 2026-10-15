import { z } from "zod";

/** Client-generated, unique per user. Sent in the `Idempotency-Key` header; resend the same key to retry safely. */
export const idempotencyKeySchema = z.string().min(1).max(200);
