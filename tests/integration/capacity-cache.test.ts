// 容量探测的短缓存（用户 2026-09-25）。
//
// QQ 一条回复会连着问好几次"这个模型现在多大容量"（判断、写回复、选图、复核各一次）。对本地
// LM Studio 每次问都是一条 HTTP；缓存把它压到一轮一次。这里用注入的时钟钉住三件事：TTL 内只探一次、
// 过期后再探、**探不到（null）不缓存**——"不知道"必须每次重新问，否则一次网络抖动会让后面几分钟的
// 调用都按"未知容量"被拒。

import { describe, expect, it } from "bun:test";
import { withCapacityCache } from "../../src/server/llm/capacity-cache";

function countingGateway(values: Array<number | null>) {
  const probes: string[] = [];
  let index = 0;
  return {
    probes,
    gateway: {
      complete: async () => "text",
      loadedContextCapacity: async (model: string) => {
        probes.push(model);
        const value = values[Math.min(index, values.length - 1)];
        index += 1;
        return value ?? null;
      },
    },
  };
}

describe("capacity probe cache", () => {
  it("probes once inside the TTL and again after it expires", async () => {
    let now = 1_000;
    const { gateway, probes } = countingGateway([65536]);
    const cached = withCapacityCache(gateway, { ttlMs: 10_000, now: () => now });
    expect(await cached.loadedContextCapacity("m")).toBe(65536);
    expect(await cached.loadedContextCapacity("m")).toBe(65536);
    now += 9_999;
    expect(await cached.loadedContextCapacity("m")).toBe(65536);
    expect(probes).toHaveLength(1);
    now += 2;
    expect(await cached.loadedContextCapacity("m")).toBe(65536);
    expect(probes).toHaveLength(2);
  });

  it("keeps models apart and never caches an unknown capacity", async () => {
    const { gateway, probes } = countingGateway([null, 32768]);
    const cached = withCapacityCache(gateway, { ttlMs: 10_000, now: () => 1_000 });
    // 第一次探不到：不缓存，下一次仍然真的去问。
    expect(await cached.loadedContextCapacity("m")).toBeNull();
    expect(await cached.loadedContextCapacity("m")).toBe(32768);
    // 另一个模型是自己的条目，不会被 m 的缓存顶掉。
    expect(await cached.loadedContextCapacity("other")).toBe(32768);
    expect(probes).toEqual(["m", "m", "other"]);
  });
});
