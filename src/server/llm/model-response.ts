import type { ModelResponseMetadata } from "../../shared/contracts/agent-run";

/** 一个 provider 原样写出的 finish_reason：原始字符串或显式 null。 */
export type RawFinishReason = string | null;

/**
 * 组装一次尝试的元数据。`httpStatus`/`doneMarker` 按契约可选：没有见到响应 → 无状态码；
 * 没观察到 `[DONE]` → 无标记。100..599 之外的状态码按"没有响应"处理，不造元数据。
 */
export function attemptMetadata(
  transport: ModelResponseMetadata["transport"],
  httpStatus: number | undefined,
  finishReasons: readonly RawFinishReason[],
  doneMarker?: boolean,
): ModelResponseMetadata {
  return {
    transport,
    ...(typeof httpStatus === "number" && httpStatus >= 100 && httpStatus <= 599
      ? { httpStatus }
      : {}),
    finishReasons: [...finishReasons],
    ...(doneMarker === undefined ? {} : { doneMarker }),
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
