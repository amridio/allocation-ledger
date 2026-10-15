import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { requireAccessibleOperator } from "./access";
import type { SessionUser } from "./auth";

const operator: SessionUser = { id: "op_1", name: "Ada", role: "OPERATOR", poolId: "pool_A" };
const supervisor: SessionUser = { id: "sup_1", name: "Eli", role: "SUPERVISOR", poolId: "pool_A" };

function stubDb(rows: Record<string, { id: string; name: string; poolId: string }>) {
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
  return { db: { operator: { findUnique } } as unknown as PrismaClient, findUnique };
}
const people = {
  op_1: { id: "op_1", name: "Ada", poolId: "pool_A" },
  op_2: { id: "op_2", name: "Ben", poolId: "pool_A" },
  op_far: { id: "op_far", name: "Far", poolId: "pool_B" },
};

describe("requireAccessibleOperator: the one read-access rule", () => {
  it("an operator may read themselves, without a database lookup", async () => {
    const { db, findUnique } = stubDb(people);
    expect(await requireAccessibleOperator(db, operator, "op_1")).toEqual({ id: "op_1", name: "Ada", poolId: "pool_A" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(["op_2", "op_far", "ghost"])("an operator can't read %s (colleague, other pool, unknown): 403, no lookup", async (id) => {
    const { db, findUnique } = stubDb(people);
    await expect(requireAccessibleOperator(db, operator, id)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(findUnique).not.toHaveBeenCalled(); // so 403 can't be used to probe which ids exist
  });

  it("a supervisor may read any operator in their own pool, themselves included", async () => {
    const { db } = stubDb({ ...people, sup_1: { id: "sup_1", name: "Eli", poolId: "pool_A" } });
    expect(await requireAccessibleOperator(db, supervisor, "op_2")).toMatchObject({ id: "op_2", poolId: "pool_A" });
    expect(await requireAccessibleOperator(db, supervisor, "sup_1")).toMatchObject({ id: "sup_1" });
  });

  it("a supervisor can't read an operator in another pool: 403", async () => {
    const { db } = stubDb(people);
    await expect(requireAccessibleOperator(db, supervisor, "op_far")).rejects.toMatchObject({ status: 403 });
  });

  it("a supervisor asking for an id that doesn't exist also gets 403, identical to another pool's, so existence can't be probed", async () => {
    const { db } = stubDb(people);
    const other = await requireAccessibleOperator(db, supervisor, "op_far").catch((e) => e);
    const unknown = await requireAccessibleOperator(db, supervisor, "ghost").catch((e) => e);
    expect(unknown).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(unknown.message).toBe(other.message);
  });
});
