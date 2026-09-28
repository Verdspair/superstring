// 0.4.0 P5：记忆读取的两个阶段分开测试。
//
//   * 检索（`retrieveMemoryCandidates`）：只读**已授权**目录、按问题关键词取有界一批——
//     没有模型调用，同一输入同一顺序；
//   * 重排（`select` / `selectRecallIds`）：模型调用，只能在检索出的候选集内挑选；
//     越界、重复或超量的 id 由共享解析器整次拒绝，不会被"猜着凑出来"。

import { describe, expect, it } from "bun:test";
import type { MemoryItem } from "../../src/server/db/context-repository";
import {
  contextKeywords,
  recallMemoryItems,
  retrieveMemoryCandidates,
  selectRecallIds,
} from "../../src/server/modules/memory-query";
import { type RuntimeConfig, RuntimeConfigSchema } from "../../src/shared/contracts";

const item = (id: string, body: string, createdAt = "2026-01-01T00:00:00.000Z"): MemoryItem => ({
  id,
  source_type: "memory",
  content_origin: "derived",
  name: body,
  summary: body,
  tags: [],
  revision: "rev-1",
  validity: "valid",
  createdAt,
  sources: [],
  body,
});

const runtime: RuntimeConfig = RuntimeConfigSchema.parse({
  agent_id: "agent",
  name: "agent",
  system_prompt: "",
  additional_instructions: "",
  model_name: "chat",
  temperature: 0,
  memory_consolidation_model_name: "chat",
  memory_consolidation_prompt: "整理记忆",
  memory_consolidation_additional_instructions: "",
  memory_retrieval_model_name: "selector",
  memory_retrieval_prompt: "挑选相关记忆",
  context_compression_model_name: "chat",
  p5_config: {},
  config_version: 1,
});

type CatalogOptions = {
  keywords?: string[];
  limit: number;
  afterId?: string | null;
  allEntries?: boolean;
};

describe("记忆检索阶段（0.4.0 P5）", () => {
  it("按关键词取候选：无模型调用、有界且确定", () => {
    const calls: CatalogOptions[] = [];
    const catalog = (options: CatalogOptions): MemoryItem[] => {
      calls.push(options);
      return [item("a", "苹果价格"), item("b", "苹果库存")];
    };
    const first = retrieveMemoryCandidates({ question: "苹果 价格怎么样", limit: 5, catalog });
    const second = retrieveMemoryCandidates({ question: "苹果 价格怎么样", limit: 5, catalog });
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
    expect(calls[0]).toEqual({ keywords: contextKeywords("苹果 价格怎么样"), limit: 5 });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("重排只拿到检索结果本身，并且只能裁剪、不能扩充", async () => {
    const candidates = [item("a", "苹果价格"), item("b", "苹果库存"), item("c", "梨的价格")];
    const seen: string[][] = [];
    const fetched: string[][] = [];
    const kept = await recallMemoryItems({
      runtime,
      question: "苹果 价格",
      available: 4096,
      catalog: () => candidates,
      fingerprint: () => "fp",
      bodies: (ids) => {
        fetched.push(ids);
        return ids.map((id) => {
          const found = candidates.find((candidate) => candidate.id === id);
          if (!found) throw new Error(`unexpected body request: ${id}`);
          return found;
        });
      },
      select: async (batch) => {
        seen.push(batch.map((entry) => String(entry.id)));
        // 重排的作用是排序与裁剪：这里只留 b、a，且换了顺序。
        return ["b", "a"];
      },
      cost: () => 1,
    });
    expect(seen).toEqual([["a", "b", "c"]]);
    expect(fetched).toEqual([["b", "a"]]);
    expect(kept.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("重排给出候选之外的 id 时整次拒绝，而不是猜着继续", async () => {
    const candidates = [{ id: "a" }, { id: "b" }];
    await expect(
      selectRecallIds(runtime, "问题", candidates, 5, "指令", async () => '{"ids":["outside"]}'),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    await expect(
      selectRecallIds(runtime, "问题", candidates, 5, "指令", async () => '{"ids":["a","a"]}'),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    await expect(
      selectRecallIds(runtime, "问题", candidates, 1, "指令", async () => '{"ids":["a","b"]}'),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(
      await selectRecallIds(runtime, "问题", candidates, 5, "指令", async () => '{"ids":["b"]}'),
    ).toEqual(["b"]);
  });
});
