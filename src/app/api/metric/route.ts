import { apiContext } from "@/server/api/default-context";
import { getMetric } from "@/server/api/metric";

export const GET = (request: Request) => getMetric(request, apiContext());
