// 短生命周期图片字节解析器（规格 §10/§12）。
//
// 字节只在发送边界出现：host（可信宿主）把本 run/owner 的 image part 与已验证字节登记进来，
// gateway/port 在组装 wire 时按同一 run/owner+part 句柄解析。resolver 只接受登记句柄——
// 模型传来的任何 URL/ID 都不能借它反向读取文件或下载（没有第二入口）。run 结束时 release
// 只清指定 owner 的登记，同 run 的其他 owner 不受影响。

import type { ModelContent, RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { VisionImage } from "../llm/vision-client";

export interface ImageByteResolver {
  register(input: {
    runId: string;
    owner: RunOwner;
    part: ModelContent;
    bytes: Uint8Array;
    sources: readonly SourceRef[];
    assertCurrent: () => void;
  }): void;
  resolve(input: {
    runId: string;
    owner: RunOwner;
    part: ModelContent;
    signal: AbortSignal;
  }): Promise<VisionImage>;
  release(runId: string, owner: RunOwner): void;
}

/** 同一 run/owner 下一个 image part 的身份：按元数据元组精确匹配，不吃模型自造的别名。 */
function partKey(part: ModelContent): string {
  if (part.kind !== "image") throw new Error("ImageByteResolver only accepts image parts");
  return [
    part.sourceId,
    part.revision,
    part.mimeType,
    part.sha256,
    part.width ?? "",
    part.height ?? "",
    part.frameIndex ?? "",
  ].join("\u0000");
}

/**
 * Owner 的完整已知身份：kind/id 之外 userId/agentId 也参与区分。同一个 kind/id 在
 * userId 或 agentId 变化时是不同的 owner——旧身份登记的字节对新身份不可见。
 */
function ownerKey(owner: RunOwner): string {
  return [owner.kind, owner.id, owner.userId ?? "", owner.agentId ?? ""].join("\u0000");
}

export function createImageByteResolver(): ImageByteResolver {
  // runId -> ownerKey -> partKey -> entry。短生命周期：host 在 run 结束时按 owner release。
  const runs = new Map<
    string,
    Map<string, Map<string, { bytes: Uint8Array; mimeType: string; assertCurrent: () => void }>>
  >();

  return {
    register(input) {
      if (input.part.kind !== "image")
        throw new Error("ImageByteResolver only accepts image parts");
      // 登记时就要求来源当前有效：失效来源从一开始就不该进 resolver。
      input.assertCurrent();
      let owners = runs.get(input.runId);
      if (!owners) {
        owners = new Map();
        runs.set(input.runId, owners);
      }
      const key = ownerKey(input.owner);
      let parts = owners.get(key);
      if (!parts) {
        parts = new Map();
        owners.set(key, parts);
      }
      parts.set(partKey(input.part), {
        bytes: input.bytes,
        mimeType: input.part.mimeType,
        assertCurrent: input.assertCurrent,
      });
    },

    async resolve(input) {
      input.signal.throwIfAborted();
      const entry = runs.get(input.runId)?.get(ownerKey(input.owner))?.get(partKey(input.part));
      if (!entry) throw new Error("图片字节句柄未登记或已释放");
      entry.assertCurrent();
      input.signal.throwIfAborted();
      return { mimeType: entry.mimeType, bytes: entry.bytes };
    },

    release(runId, owner) {
      const owners = runs.get(runId);
      if (!owners) return;
      owners.delete(ownerKey(owner));
      if (owners.size === 0) runs.delete(runId);
    },
  };
}
