import type { ModelResponseMetadata, ModelResponseUsage } from "../../shared/contracts/agent-run";

/** 一个 provider 原样写出的 finish_reason：原始字符串或显式 null。 */
export type RawFinishReason = string | null;

/**
 * 组装一次尝试的元数据。`httpStatus`/`doneMarker`/`usage` 按契约可选：没有见到响应 → 无
 * 状态码；没观察到 `[DONE]` → 无标记；本次尝试没有可记录的 usage → 整个字段缺席。
 * 100..599 之外的状态码按"没有响应"处理，不造元数据。
 */
export function attemptMetadata(
  transport: ModelResponseMetadata["transport"],
  httpStatus: number | undefined,
  finishReasons: readonly RawFinishReason[],
  doneMarker?: boolean,
  usage?: ModelResponseUsage,
): ModelResponseMetadata {
  return {
    transport,
    ...(typeof httpStatus === "number" && httpStatus >= 100 && httpStatus <= 599
      ? { httpStatus }
      : {}),
    finishReasons: [...finishReasons],
    ...(doneMarker === undefined ? {} : { doneMarker }),
    ...(usage === undefined ? {} : { usage }),
  };
}

const isUsageCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const openAiUsageCount = (raw: Record<string, unknown>, key: string): number | undefined => {
  const value = raw[key];
  return isUsageCount(value) ? value : undefined;
};

/**
 * OpenAI chat completions usage 的唯一生产解析（D1/D2/D3，source of truth）：
 * - prompt_tokens→inputTokens、completion_tokens→outputTokens、total_tokens→totalTokens，
 *   prompt_tokens_details.cached_tokens→cacheReadInputTokens；
 * - 每个有效计数独立保留，畸形/缺席只省略自身，绝不推导（totalTokens 不求和）；
 * - cacheState 只随 cache 维度：显式有效 cached（含 0）=reported，坏 cache=invalid，
 *   有计数而无 cache 字段=unreported；
 * - 全部字段缺席/畸形 → 返回 undefined（缺席不是 0，也不造部分对象）。
 * 只认 OpenAI chat 别名：DeepSeek 字段须官方证实后另行加入，不读未证实的
 * Anthropic 形状；未知多余键忽略。
 */
export function parseProviderUsage(raw: unknown): ModelResponseUsage | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const usage = raw as Record<string, unknown>;
  const counters: Pick<ModelResponseUsage, "inputTokens" | "outputTokens" | "totalTokens"> = {};
  const inputTokens = openAiUsageCount(usage, "prompt_tokens");
  if (inputTokens !== undefined) counters.inputTokens = inputTokens;
  const outputTokens = openAiUsageCount(usage, "completion_tokens");
  if (outputTokens !== undefined) counters.outputTokens = outputTokens;
  const totalTokens = openAiUsageCount(usage, "total_tokens");
  if (totalTokens !== undefined) counters.totalTokens = totalTokens;
  const details = usage.prompt_tokens_details;
  const cacheReadInputTokens =
    details !== null && typeof details === "object" && !Array.isArray(details)
      ? openAiUsageCount(details as Record<string, unknown>, "cached_tokens")
      : undefined;
  const cachePresent =
    details !== undefined &&
    details !== null &&
    (typeof details !== "object" ||
      Array.isArray(details) ||
      (details as Record<string, unknown>).cached_tokens !== undefined);
  const cacheState: ModelResponseUsage["cacheState"] = !cachePresent
    ? "unreported"
    : cacheReadInputTokens === undefined
      ? "invalid"
      : "reported";
  if (Object.keys(counters).length === 0 && cacheState === "unreported") return undefined;
  return {
    ...counters,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    cacheState,
  };
}

/** 观察者只做诊断：抛错只记一行固定警告（不携带任何正文），绝不改变推理结果。 */
export function reportModelResponse(
  observer: ((metadata: ModelResponseMetadata) => void) | undefined,
  metadata: ModelResponseMetadata,
): void {
  if (observer === undefined) return;
  try {
    observer(metadata);
  } catch {
    console.warn("model response observer failed");
  }
}

/**
 * 非流式/视觉的一次解析：choice0 的 finish_reason 原样读取——原始字符串或显式 null；
 * 字段缺席（或不是这两类值）返回 undefined。不归一化大小写，不从 JSON 解析结果推断。
 */
export function observedFinishReason(payload: unknown): RawFinishReason | undefined {
  const choice = (payload as { choices?: Array<Record<string, unknown>> } | null | undefined)
    ?.choices?.[0];
  if (choice === null || typeof choice !== "object" || !("finish_reason" in choice))
    return undefined;
  const reason = choice.finish_reason;
  return typeof reason === "string" || reason === null ? reason : undefined;
}

/** 非流式/视觉的 finishReasons：字段缺席 = []，出现 = [原样值]（含显式 null）。 */
export function finishReasonsFromPayload(payload: unknown): RawFinishReason[] {
  const reason = observedFinishReason(payload);
  return reason === undefined ? [] : [reason];
}

/**
 * 流式的到达顺序收集：只收原始字符串与显式 null（undefined = 字段缺席，忽略）；
 * 同一值只记一次，顺序保留。
 */
export function observeStreamFinishReason(collected: RawFinishReason[], reason: unknown): void {
  if (typeof reason !== "string" && reason !== null) return;
  if (!collected.includes(reason)) collected.push(reason);
}
