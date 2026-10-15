import { db } from "../db";
import type { ApiContext } from "./context";

/** ENABLE_USER_SWITCHER=true turns on the temporary user switcher (UI and endpoint). Anything else = off. */
export function isUserSwitcherEnabled(): boolean {
  return process.env["ENABLE_USER_SWITCHER"] === "true";
}

/** The real context for the Next route files. The only place the real clock is created. */
export function apiContext(): ApiContext {
  return { db, clock: () => new Date(), userSwitcherEnabled: isUserSwitcherEnabled() };
}
