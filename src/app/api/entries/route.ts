import { apiContext } from "@/server/api/default-context";
import { createEntry, listEntries } from "@/server/api/entries";

export const GET = (request: Request) => listEntries(request, apiContext());
export const POST = (request: Request) => createEntry(request, apiContext());
