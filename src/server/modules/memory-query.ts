import { z } from "zod";
import type { RuntimeConfig } from "../../shared/contracts";
import { readJsonBody } from "../../shared/contracts/agent-output";
import type { ContextMessage, MemoryItem } from "../db/context-repository";
import { contextDumps } from "../db/json-text";
import { fail } from "../errors";
import { contentCandidate } from "../services/content-format";
import { fullCasefold } from "../services/text";
import { estimateTokens } from "../services/token-estimate";

const SelectionSchema = z.strictObject({ ids: z.array(z.string()) });
export const SELECTION_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    ids: { items: { type: "string" }, title: "Ids", type: "array" },
  },
  required: ["ids"],
  title: "Selection",
  type: "object",
} as const;

export function estimateMessages(messages: ContextMessage[]): number {
  return (
    3 +
    messages.reduce(
      (sum, message) => sum + 12 + estimateTokens(message.role) + estimateTokens(message.content),
      0,
    )
  );
}

export function contextKeywords(text: string): string[] {
  const words = fullCasefold(text).match(/[a-zA-Z0-9_]{2,}|[\u3400-\u9fff]+/g) ?? [];
  const pieces: string[] = [];
  for (const word of words) {
    const isAscii = [...word].every((char) => (char.codePointAt(0) ?? 128) <= 0x7f);
    if (word.length <= 4 || isAscii) {
      pieces.push(word);
    } else {
      for (let index = 0; index < word.length - 1; index += 1) {
        pieces.push(word.slice(index, index + 2));
      }
    }
  }
  return [...new Set(pieces)].slice(0, 24);
}

export function validateContextIds(ids: string[], allowed: string[], limit?: number): string[] {
  const permitted = new Set(allowed);
  if (ids.length !== new Set(ids).size || ids.some((id) => !permitted.has(id))) {
    fail("CONTEXT_INVALID_SELECTION", "辅助模型返回重复、未授权或候选之外的来源ID");
  }
  if (limit !== undefined && ids.length > limit) {
    fail("CONTEXT_INVALID_SELECTION", "辅助模型选择条数超过配置限制");
  }
  return ids;
}

export function parseRecallIds(text: string, allowed: string[], limit: number): string[] {
  const result = SelectionSchema.parse(JSON.parse(readJsonBody(text)));
  return validateContextIds(result.ids, allowed, limit);
}

export async function selectRecallIds(
  runtime: RuntimeConfig,
  question: string,
  candidates: Array<Record<string, unknown>>,
  limit: number,
  instruction: string,
  call: (input: {
    instruction: string;
    data: unknown;
    responseSchema: Record<string, unknown>;
    outputTokens: number;
  }) => Promise<string>,
): Promise<string[]> {
  if (candidates.length === 0 || limit < 1) return [];
  const allowed = candidates.map((candidate) => String(candidate.id));
  const responseSchema = structuredClone(SELECTION_JSON_SCHEMA) as Record<string, unknown> & {
    properties: { ids: Record<string, unknown> };
  };
  responseSchema.properties.ids = {
    ...responseSchema.properties.ids,
    items: { type: "string", enum: allowed },
    maxItems: Math.min(limit, candidates.length),
    uniqueItems: true,
  };
  const text = await call({
    instruction:
      `${runtime.memory_retrieval_prompt}\n${instruction}` +
      `\n仅选择相关候选id，最多${limit}条；没有相关内容时ids为空。不要复述正文。` +
      // 只输出 JSON——外部模型爱先写一段说明，撞上输出上限就成了 MODEL_OUTPUT_LIMIT
      // （叶子失败被容忍，代价是这一轮没有记忆）。
      `\n只输出符合schema的JSON，不要任何解释、前言或后续内容。`,
    data: { question, candidates },
    responseSchema,
    // 上限抬了个下限（128 → 384）：给"忍不住写一句"的模型留出余量，别把 JSON 挤掉。
    outputTokens: Math.min(runtime.p5_config.max_output_tokens, Math.max(384, limit * 48 + 32)),
  });
  return parseRecallIds(text, allowed, limit);
}

export async function boundedRecallIds(
  candidates: Array<Record<string, unknown>>,
  budget: number,
  select: (batch: Array<Record<string, unknown>>) => Promise<string[]>,
): Promise<string[]> {
  let selected: Array<Record<string, unknown>> = [];
  let batch: Array<Record<string, unknown>> = [];
  for (const item of candidates) {
    if (batch.length > 0 && estimateTokens(contextDumps([...selected, ...batch, item])) > budget) {
      const chosen = await select([...selected, ...batch]);
      selected = [...selected, ...batch].filter((candidate) =>
        chosen.includes(String(candidate.id)),
      );
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length > 0) {
    const chosen = await select([...selected, ...batch]);
    selected = [...selected, ...batch].filter((candidate) => chosen.includes(String(candidate.id)));
  }
  return selected.map((candidate) => String(candidate.id));
}

/**
 * 检索阶段（0.4.0 P5）：从**已授权**目录里按问题关键词取一批有界候选。
 *
 * 它与重排阶段是分开的两件事，分开是刻意的：
 *   * 检索**没有模型调用**、同一输入同一顺序——候选集是确定且可复用的；
 *   * 重排（`select`）是模型调用、有成本、可能失败，而且**只能在候选集里选**（越界由选择器实现拒绝）。
 * 两段各自有预算与直接测试，不再混在一个函数里靠调用方猜。
 *
 * 全目录/全部正文两档是有意的例外：全目录按批扫描、每批立即重排（否则选择器提示词会超出模型容量），
 * 这段"边扫边排"留在 `recallMemoryItems` 里，不套用本函数。
 */
export function retrieveMemoryCandidates(input: {
  question: string;
  limit: number;
  catalog: (options: {
    keywords?: string[];
    limit: number;
    afterId?: string | null;
    allEntries?: boolean;
  }) => MemoryItem[];
}): MemoryItem[] {
  return input.catalog({ keywords: contextKeywords(input.question), limit: input.limit });
}

export async function recallMemoryItems(input: {
  runtime: RuntimeConfig;
  question: string;
  available: number;
  catalog: (options: {
    keywords?: string[];
    limit: number;
    afterId?: string | null;
    allEntries?: boolean;
  }) => MemoryItem[];
  fingerprint: () => string;
  bodies: (ids: string[]) => MemoryItem[];
  select: (
    candidates: Array<Record<string, unknown>>,
    limit: number,
    instruction: string,
    bounded: boolean,
  ) => Promise<string[]>;
  cost: (items: MemoryItem[]) => number;
}): Promise<MemoryItem[]> {
  const cfg = input.runtime.p5_config;
  const mode = cfg.retrieval_mode;
  if (mode === "off") return [];
  let selected: string[] = [];
  let retainedCatalog: Array<Record<string, unknown>> = [];
  const preset =
    cfg.retrieval_presets[
      mode === "conservative" || mode === "standard" || mode === "broad" ? mode : "broad"
    ];
  if (mode === "full_catalog" || mode === "full_body") {
    const fingerprint = input.fingerprint();
    let cursor: string | null = null;
    let completed = false;
    for (let batchNo = 0; batchNo < cfg.max_catalog_batches; batchNo += 1) {
      const batch = input.catalog({
        limit: cfg.catalog_batch_size,
        afterId: cursor,
        allEntries: true,
      });
      const last = batch.at(-1);
      if (!last) {
        completed = true;
        break;
      }
      cursor = last.id;
      if (mode === "full_body") {
        selected.push(...batch.map((item) => item.id));
      } else {
        const candidates = [
          ...retainedCatalog,
          ...batch.map((item) => ({ ...contentCandidate(item), created_at: item.createdAt })),
        ];
        selected = await input.select(
          candidates,
          preset.max_entries,
          preset.relevance_instruction,
          true,
        );
        retainedCatalog = candidates.filter((item) => selected.includes(String(item.id)));
      }
      if (batch.length < cfg.catalog_batch_size) {
        completed = true;
        break;
      }
    }
    if (!completed && input.catalog({ limit: 1, afterId: cursor, allEntries: true }).length > 0)
      fail("CONTEXT_CATALOG_LIMIT", "全目录扫描超过批次数限制，扫描未完成");
    if (input.fingerprint() !== fingerprint)
      fail("CONTEXT_SOURCE_INVALID", "全量读取期间授权目录发生变化，扫描结果不可使用");
  } else {
    const batch = retrieveMemoryCandidates({
      question: input.question,
      limit: preset.candidate_limit,
      catalog: input.catalog,
    });
    if (batch.length > 0)
      selected = await input.select(
        batch.map((item) => ({ ...contentCandidate(item), created_at: item.createdAt })),
        preset.max_entries,
        preset.relevance_instruction,
        false,
      );
  }
  if (selected.length === 0) return [];
  const items = input.bodies(selected);
  const budget =
    mode === "full_body" ? input.available : Math.min(input.available, preset.max_tokens);
  const unique: MemoryItem[] = [];
  const seen = new Set<string | undefined>();
  for (const item of items) {
    if (mode === "full_body" || !seen.has(item.body)) {
      unique.push(item);
      seen.add(item.body);
    }
  }
  if (input.cost(unique) > budget)
    fail("CONTEXT_MEMORY_BUDGET", "已选记忆正文超过可用预算，未静默注入部分正文");
  return unique;
}
