import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./test-db-guard";

const DEV = "postgresql://postgres:postgres@localhost:5432/allocation_ledger";

describe("assertSafeTestDatabase: integration tests insert rows that can never be deleted, so they must not touch dev data", () => {
  it("accepts a database whose name ends in _test", () => {
    expect(() => assertSafeTestDatabase("postgresql://postgres:postgres@localhost:5432/ops_test", DEV)).not.toThrow();
    expect(() => assertSafeTestDatabase("postgresql://u:p@db:5432/ops_test?schema=public", DEV)).not.toThrow();
  });

  it("refuses the dev database", () => {
    expect(() => assertSafeTestDatabase(DEV, DEV)).toThrowError(/DATABASE_URL/);
  });

  it("refuses a name that doesn't end in _test, even if it differs from DATABASE_URL", () => {
    for (const name of ["ops", "allocation_ledger", "ops_test_old", "test", "production"]) {
      expect(() => assertSafeTestDatabase(`postgresql://u:p@h:5432/${name}`, DEV), name).toThrowError(/_test/);
    }
  });

  it("refuses a missing or unparseable URL", () => {
    expect(() => assertSafeTestDatabase(undefined, DEV)).toThrowError(/TEST_DATABASE_URL/);
    expect(() => assertSafeTestDatabase("", DEV)).toThrowError(/TEST_DATABASE_URL/);
    expect(() => assertSafeTestDatabase("not a url", DEV)).toThrowError(/TEST_DATABASE_URL/);
  });

  it("works when DATABASE_URL isn't set at all", () => {
    expect(() => assertSafeTestDatabase("postgresql://u:p@h:5432/ops_test", undefined)).not.toThrow();
  });
});
