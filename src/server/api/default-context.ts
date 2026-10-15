import { db } from "../db";
import type { ApiContext } from "./context";

/** The real context for the Next route files. The only place the real clock is created. */
export function apiContext(): ApiContext {
  return { db, clock: () => new Date() };
}
