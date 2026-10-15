import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Structural guard: every route must either read its subject operator through
 * requireAccessibleOperator() (src/server/api/access.ts) or be listed here with the reason it
 * doesn't need to. A new route that does neither fails this test, so the read rule can't be
 * forgotten by omission.
 */
const EXEMPT: Record<string, string> = {
  session: "POST /api/switch-user: login, returns no ledger data (temporary cookie auth)",
  adjustments: "write endpoint: the own-pool and supervisor-only rules are enforced inside adjust() and tested there",
  // entries.ts is NOT exempt: it has a read handler (listEntries) and a write handler (createEntry).
};

const API_ROUTES = path.join(process.cwd(), "src/app/api");
const HANDLERS = path.join(process.cwd(), "src/server/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === "route.ts" ? [full] : [];
  });
}
const handlerModulesUsedBy = (routeFile: string) =>
  [...readFileSync(routeFile, "utf8").matchAll(/from "@\/server\/api\/([a-z-]+)"/g)]
    .map((m) => m[1] as string)
    .filter((m) => m !== "default-context");

describe("every API route applies the shared read-access rule (or is explicitly exempt)", () => {
  const routes = routeFiles(API_ROUTES);

  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(routes.map((r) => [path.relative(process.cwd(), r), r]))("%s", (_name, routeFile) => {
    const modules = handlerModulesUsedBy(routeFile as string);
    expect(modules.length, "a route must delegate to a module in src/server/api").toBeGreaterThan(0);

    for (const mod of modules) {
      if (EXEMPT[mod]) continue; // reason recorded above
      const source = readFileSync(path.join(HANDLERS, `${mod}.ts`), "utf8");
      expect(
        /requireAccessibleOperator\(/.test(source) && /from "\.\/access"/.test(source),
        `${mod}.ts serves operator data but does not call requireAccessibleOperator(). ` +
          `Use it to get the subject operator, or add ${mod} to EXEMPT in access-coverage.test.ts with a reason.`,
      ).toBe(true);
    }
  });

  it("the exemptions are real modules and each has a reason", () => {
    for (const [mod, reason] of Object.entries(EXEMPT)) {
      expect(() => readFileSync(path.join(HANDLERS, `${mod}.ts`), "utf8"), `${mod}.ts exists`).not.toThrow();
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
