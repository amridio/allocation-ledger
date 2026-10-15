import { allocate } from "@/server/allocate";
import { handleAllocate } from "@/server/allocate-http";
import { db } from "@/server/db";

export async function POST(request: Request) {
  // The edge of the system is where the real clock is injected.
  return handleAllocate(request, (input) => allocate({ db, clock: () => new Date() }, input));
}
