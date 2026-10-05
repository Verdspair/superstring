import { describe, expect, test } from "bun:test";
import { uniqueSources } from "../../src/server/services/source-refs";

function ref(kind: string, id: string, revision: string, expiresAt?: string) {
  return expiresAt === undefined ? { kind, id, revision } : { kind, id, revision, expiresAt };
}

describe("uniqueSources", () => {
  test("same kind/id/revision with mixed precision keeps earlier real instant", () => {
    const [kept] = uniqueSources([
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00.500Z"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
    ]);
    expect(kept?.expiresAt).toBe("2026-10-02T00:00:00Z");
  });

  test("timestamps with millisecond precision keep the earlier instant", () => {
    const [kept] = uniqueSources([
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:01.000Z"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00.500Z"),
    ]);
    expect(kept?.expiresAt).toBe("2026-10-02T00:00:00.500Z");
  });

  test("reverse order still keeps earliest real instant", () => {
    const first = uniqueSources([
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00.250Z"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
    ]);
    expect(first[0]?.expiresAt).toBe("2026-10-02T00:00:00Z");
    const second = uniqueSources([
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00.250Z"),
    ]);
    expect(second[0]?.expiresAt).toBe("2026-10-02T00:00:00Z");
  });

  test("old bounded cap survives later no-expiry entry (intersection, not union)", () => {
    const [kept] = uniqueSources([
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
      ref("memory", "m1", "rev-1"),
    ]);
    expect(kept?.expiresAt).toBe("2026-10-02T00:00:00Z");
  });

  test("a later bounded cap narrows an earlier no-expiry entry", () => {
    const [kept] = uniqueSources([
      ref("memory", "m1", "rev-1"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
    ]);
    expect(kept?.expiresAt).toBe("2026-10-02T00:00:00Z");
  });

  test("different keys stay independent and stable in first-seen order", () => {
    const sources = [
      ref("memory", "a", "r1", "2026-10-02T00:00:00Z"),
      ref("memory", "b", "r1", "2026-10-02T00:00:00Z"),
      ref("knowledge", "a", "r1", "2026-10-02T00:00:00Z"),
      ref("memory", "a", "r2", "2026-10-02T00:00:00Z"),
      ref("memory", "a", "r1", "2026-10-03T00:00:00Z"),
    ];
    expect(uniqueSources(sources)).toEqual([
      ref("memory", "a", "r1", "2026-10-02T00:00:00Z"),
      ref("memory", "b", "r1", "2026-10-02T00:00:00Z"),
      ref("knowledge", "a", "r1", "2026-10-02T00:00:00Z"),
      ref("memory", "a", "r2", "2026-10-02T00:00:00Z"),
    ]);
  });

  test("does not mutate the input array or its entries", () => {
    const sources = [
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00.500Z"),
      ref("memory", "m1", "rev-1", "2026-10-02T00:00:00Z"),
    ];
    const snapshot = JSON.parse(JSON.stringify(sources));
    const result = uniqueSources(sources);
    expect(result).not.toBe(sources);
    expect(sources).toEqual(snapshot);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sources[1]);
  });
});
