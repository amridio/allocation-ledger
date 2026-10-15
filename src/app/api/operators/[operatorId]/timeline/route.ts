import { apiContext } from "@/server/api/default-context";
import { getTimeline } from "@/server/api/timeline";

export async function GET(request: Request, context: RouteContext<"/api/operators/[operatorId]/timeline">) {
  const { operatorId } = await context.params;
  return getTimeline(request, apiContext(), operatorId);
}
