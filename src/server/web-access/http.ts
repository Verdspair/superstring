// 抓取与搜索共用的小件：总超时与调用方 signal 的组合、带上限的响应体读取。

import { webError } from "./errors";

export interface Deadline {
  /** 传给 fetchImpl 的组合 signal：调用方取消或总超时任一先到都会中止。 */
  readonly signal: AbortSignal;
  /** 超时（而非调用方取消）是否已触发。 */
  readonly expired: () => boolean;
}

export function deadline(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    expired: () => timeout.aborted,
  };
}

export interface CappedBody {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

/** 读取响应体，最多 limit 字节；超出即中止读取并标记 truncated。 */
export async function readBodyCapped(response: Response, limit: number): Promise<CappedBody> {
  const body = response.body;
  if (body === null) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > limit
      ? { bytes: whole.subarray(0, limit), truncated: true }
      : { bytes: whole, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { bytes: concatChunks(chunks), truncated: false };
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      await reader.cancel().catch(() => {});
      return { bytes: concatChunks(chunks), truncated: true };
    }
    chunks.push(value);
    size += value.byteLength;
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * fetch 抛错 → 带码失败：调用方取消优先原样抛出（取消不是故障），其次总超时，
 * 最后归为调用方给的失败码。`label` 如 "网页请求"/"SearXNG 请求"。
 */
export function throwFetchFailure(
  error: unknown,
  caller: AbortSignal | undefined,
  target: Deadline,
  code: string,
  label: string,
): never {
  if (caller?.aborted === true) throw caller.reason ?? error;
  if (target.expired()) throw webError("WEB_TIMEOUT", `${label}超时`);
  const detail = error instanceof Error ? error.message : String(error);
  throw webError(code, `${label}失败：${detail}`, { cause: error });
}
