import { describe, expect, it } from "vitest";
import { dashboardHref, entriesKeyFor, scopeKeysFor } from "./entries-scope";

/*
 * The activity log exists in up to three scopes, each with its own cached list:
 *   self      an operator's own entries
 *   op:<id>   a supervisor looking at ONE operator (the default once an operator is selected)
 *   pool      a supervisor looking at everyone in the pool
 * A new entry must land in every list it belongs to, and only those.
 */
describe("entriesKeyFor", () => {
  it("names the cached list for each scope", () => {
    expect(entriesKeyFor("self", "op_1")).toBe("self");
    expect(entriesKeyFor("operator", "op_1")).toBe("op:op_1");
    expect(entriesKeyFor("pool", "op_1")).toBe("pool");
  });

  it("an operator-scoped list is per operator: switching operator is a different list", () => {
    expect(entriesKeyFor("operator", "op_1")).not.toBe(entriesKeyFor("operator", "op_2"));
  });

  it("the pool list doesn't depend on which operator is selected", () => {
    expect(entriesKeyFor("pool", "op_1")).toBe(entriesKeyFor("pool", "op_2"));
  });
});

describe("scopeKeysFor: which cached lists a new entry belongs in", () => {
  it("the pool list, that operator's own list, and the operator's self list", () => {
    expect(scopeKeysFor({ operatorId: "op_7" })).toEqual(["pool", "op:op_7", "self"]);
  });

  it("never another operator's filtered list (an entry for Ada must not appear under Ben)", () => {
    const keys = scopeKeysFor({ operatorId: "ada" });
    expect(keys).not.toContain("op:ben");
    expect(keys).toContain("op:ada");
  });
});

describe("dashboardHref: the screen's URL keeps both choices", () => {
  it("names the operator, and adds log=all only for the everyone view", () => {
    expect(dashboardHref({ operatorId: "op_1", logAll: false })).toBe("/?operator=op_1");
    expect(dashboardHref({ operatorId: "op_1", logAll: true })).toBe("/?operator=op_1&log=all");
  });

  it("encodes the id", () => {
    expect(dashboardHref({ operatorId: "a b&c", logAll: false })).toBe("/?operator=a%20b%26c");
  });
});
