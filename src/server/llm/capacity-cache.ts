// 容量探测的短缓存（用户 2026-09-25）：QQ 一条回复会连着问好几次"这个模型现在多大容量"——
// 判断、写回复、选图、复核各问一次。对本地 LM Studio 来说每次问都是一条 HTTP（`/api/v1/models`），
// 一轮下来就是好几次白跑的往返；对云端模型它是本地读（用户手填的窗口），本来就不花时间。
//
// 只包住 QQ 那两条链：网页那侧每轮自己就只探一次（`ContextBuilder` 的 per-turn 冻结），把它一起改了
// 反而会让"换模型后立刻对话"用上过期容量。缓存的是**成功的数字**，探不到（null）不缓存——"不知道"
// 必须每次重新问，否则一次网络抖动会让后面几分钟的调用都按"未知容量"被拒。
//
// TTL 取秒级而不是分钟级：容量会随"用户在 LM Studio 里换了模型"而变，而这个值只用来算预算，
// 过期一点顶多让一次调用被服务端自己拒绝（有明确报错），不会静默按错误的预算跑。

import type { ModelGateway } from "./model-gateway";

export interface CapacityCacheOptions {
  /** 一次探测的有效期（毫秒）。默认 10 秒：够覆盖一轮里的几次询问，又不至于跨过换模型。 */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const CAPACITY_CACHE_TTL_MS = 10_000;

export function withCapacityCache(
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  options: CapacityCacheOptions = {},
): Pick<ModelGateway, "complete" | "loadedContextCapacity"> {
  const ttlMs = options.ttlMs ?? CAPACITY_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { value: number; at: number }>();
  return {
    complete: (input) => gateway.complete(input),
    async loadedContextCapacity(model, probeOptions) {
      const cached = entries.get(model);
      if (cached !== undefined && now() - cached.at < ttlMs) return cached.value;
      const value = await gateway.loadedContextCapacity(model, probeOptions);
      if (typeof value === "number") entries.set(model, { value, at: now() });
      return value;
    },
  };
}
