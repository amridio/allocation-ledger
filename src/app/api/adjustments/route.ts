import { createAdjustment } from "@/server/api/adjustments";
import { apiContext } from "@/server/api/default-context";

export const POST = (request: Request) => createAdjustment(request, apiContext());
