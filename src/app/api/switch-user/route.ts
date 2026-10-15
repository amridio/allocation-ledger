import { apiContext } from "@/server/api/default-context";
import { switchUser } from "@/server/api/session";

export const POST = (request: Request) => switchUser(request, apiContext());
