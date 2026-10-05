import { describe, expect, it } from "vitest";
import {
  createCachedLoader,
  PRELOAD_REGISTRY,
  WORKSPACE_LOADERS,
} from "../../src/web/state/preload-registry";
import { ENVIRONMENT, SPACES } from "../../src/web/workspace/navigation";

const navigationSpaces = [...SPACES, ...ENVIRONMENT].map((space) => space.id);

describe("preload registry (chunk single source)", () => {
  it("registers exactly one chunk entry per navigation workspace", () => {
    const spaces = PRELOAD_REGISTRY.map((entry) => entry.space);
    expect(new Set(spaces).size).toBe(spaces.length);
    expect([...spaces].sort()).toEqual([...navigationSpaces].sort());
    for (const entry of PRELOAD_REGISTRY) {
      expect(typeof entry.loadChunk).toBe("function");
    }
  });

  it("exposes every workspace loader through WORKSPACE_LOADERS keyed by space id", () => {
    for (const id of navigationSpaces) {
      expect(typeof (WORKSPACE_LOADERS as Record<string, unknown>)[id]).toBe("function");
    }
  });

  it("evaluates each workspace chunk via its loader and shares the resulting module", async () => {
    const settled = await Promise.allSettled(PRELOAD_REGISTRY.map((entry) => entry.loadChunk()));
    for (const result of settled) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        expect(result.value).toBeTypeOf("object");
        expect(result.value).not.toBeNull();
      }
    }
    const shared = PRELOAD_REGISTRY[0];
    const [first, second] = await Promise.all([shared.loadChunk(), shared.loadChunk()]);
    expect(first).toBe(second);
  });
});

describe("preload registry (data phase status)", () => {
  it("gives every entry a known dataStatus and a non-empty reason when excluded", () => {
    for (const entry of PRELOAD_REGISTRY) {
      expect(["eligible", "excluded"]).toContain(entry.dataStatus);
      if (entry.dataStatus === "excluded") {
        expect(entry.excludedReason?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("createCachedLoader (in-flight chunk promise sharing)", () => {
  it("returns the same in-flight promise to concurrent callers", async () => {
    let calls = 0;
    const gate = { resolve: (_: unknown) => {} };
    const loader = createCachedLoader(
      () =>
        new Promise((resolve) => {
          calls += 1;
          gate.resolve = resolve;
        }),
    );
    const first = loader();
    const second = loader();
    expect(second).toBe(first);
    gate.resolve({ default: () => null });
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("clears the in-flight cache on failure so a later call retries the underlying load", async () => {
    let calls = 0;
    const loader = createCachedLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error("chunk failed");
      return { recovered: true };
    });
    await expect(loader()).rejects.toThrow("chunk failed");
    await expect(loader()).resolves.toEqual({ recovered: true });
    expect(calls).toBe(2);
  });
});
