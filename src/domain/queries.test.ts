import { describe, expect, it } from "vitest";
import { entriesQuerySchema, metricQuerySchema, timelineQuerySchema } from "./queries";

const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, query: string) =>
  schema.safeParse(Object.fromEntries(new URLSearchParams(query)));

describe("entriesQuerySchema", () => {
  it("defaults to 20 per page with no cursor", () => {
    expect(entriesQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it("coerces string query params", () => {
    expect(parse(entriesQuerySchema, "cursor=42&limit=5&operatorId=op_1").data).toEqual({
      cursor: 42,
      limit: 5,
      operatorId: "op_1",
    });
  });

  it.each(["cursor=0", "cursor=-3", "cursor=1.5", "cursor=abc", "cursor=", "limit=0", "limit=101", "limit=2.5", "limit=x", "operatorId=", "foo=bar"])(
    "rejects %s",
    (query) => {
      expect(parse(entriesQuerySchema, query).success).toBe(false);
    },
  );

  it("accepts the limits themselves: 1 and 100", () => {
    expect(parse(entriesQuerySchema, "limit=1").success).toBe(true);
    expect(parse(entriesQuerySchema, "limit=100").success).toBe(true);
  });
});

describe("timelineQuerySchema", () => {
  it("view is optional and must be 'transitions' or 'full'", () => {
    expect(timelineQuerySchema.parse({})).toEqual({});
    expect(parse(timelineQuerySchema, "view=full").data).toEqual({ view: "full" });
    expect(parse(timelineQuerySchema, "view=transitions").data).toEqual({ view: "transitions" });
    expect(parse(timelineQuerySchema, "view=all").success).toBe(false);
    expect(parse(timelineQuerySchema, "x=1").success).toBe(false);
  });
});

describe("metricQuerySchema", () => {
  it("operatorId is optional", () => {
    expect(metricQuerySchema.parse({})).toEqual({});
    expect(parse(metricQuerySchema, "operatorId=op_1").data).toEqual({ operatorId: "op_1" });
    expect(parse(metricQuerySchema, "operatorId=").success).toBe(false);
    expect(parse(metricQuerySchema, "x=1").success).toBe(false);
  });
});
