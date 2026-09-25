// 判断调用能看到的东西（用户 2026-09-25）：长期记忆与知识库，权重排在人物与上下文之后。
//
// 为什么是一个新模块：网页那两条链各自绑在 web 会话（`catalog`/`memoryBodies` 走 `ownedSession`）
// 与 web 轮次（`KnowledgeContext.owner` 要 `turns JOIN sessions`）上，QQ 既没有会话也没有轮次，
// 直接复用会连带把"网页会话归属"当成 QQ 的权限。这里只用同一套**规则**——记忆的有效性与打分、
// 知识库的授权 join/分段/草稿映射——换掉的是"谁有资格读"那一层：QQ 的资格来自绑定的读范围
// （`resolveQqMemoryAccess`）与助手自己的知识库授权。
//
// 两条都失败即不注入（并写一行服务端日志），不阻断判断：判断是"要不要开口"，背景资料取不到不该
// 让她永久闭嘴——这与 §7.2 的媒体失败（她要说的对象没看懂）是不同性质的两件事。
//
// material 永远走 user 段（`buildQqPrompt` 强制），§6.1 的"资料不提升为系统权限"因此是结构性的。

import type { Database } from "bun:sqlite";
import type { ContentItem } from "../../shared/contracts/content";
import type { SourceRef } from "../../shared/contracts/evidence";
import { catalogByScopeKeys, type MemoryItem } from "../db/context-repository";
import { readQqOwnerIdentity } from "../db/qq-owner-repository";
import type { Orm } from "../db/repositories";
import { selectionSources } from "../modules/provenance";
import { contextKeywords } from "./context-builder";
import { knowledgeCost, knowledgeMessages, qqKnowledgeItems } from "./knowledge-context";
import { qqMemoryScopeKeyset } from "./memory-scope";
import { type QqBinding, resolveQqMemoryAccess } from "./qq-binding-contract";
import type { QqPromptMaterial } from "./qq-prompt-contract";
import { estimateTokens } from "./token-estimate";

/**
 * 记忆与资料各留多少（估算 token）。用户 2026-09-25 选定"用固定上限"：像冷却、门槛那样的可编辑
 * 参数要多一次迁移与两个方案字段，这一版不做。真正的硬上限仍是模型容量预检（它看的是完整消息）。
 */
export const QQ_JUDGEMENT_MEMORY_TOKENS = 400;
export const QQ_JUDGEMENT_KNOWLEDGE_TOKENS = 600;

/** 检索与打分用的"这一段在说什么"：最近这批群友消息的正文，最多十条。 */
export function qqJudgementQuestion(texts: readonly (string | null)[]): string {
  return texts
    .filter((text): text is string => text !== null && text.trim().length > 0)
    .slice(-10)
    .join("\n");
}

/**
 * 判断调用的两个可选资料段，按权重顺序：记忆在前、资料在后（与打分口径的四层一致）。
 * 取不到就少一段，绝不因此不判断。
 */
export function qqJudgementMaterial(
  orm: Orm,
  input: {
    readonly binding: QqBinding;
    readonly question: string;
    onSources?: (sources: SourceRef[]) => void;
  },
): readonly QqPromptMaterial[] {
  return qqPromptMaterial(orm, {
    binding: input.binding,
    onSources: input.onSources,
    question: input.question,
    memoryTokens: QQ_JUDGEMENT_MEMORY_TOKENS,
    knowledgeTokens: QQ_JUDGEMENT_KNOWLEDGE_TOKENS,
  });
}

/**
 * 同一套资料装配，但预算由调用方给（2026-09-25：回复档复用这一份，不再自己叫模型挑记忆）。
 *
 * 装配本身**不调模型**：记忆是关键词打分 + 预算裁剪，资料是既有的授权取段。所以判断读一次、回复
 * 再读一次都不花调用——真正花钱的是"让模型挑"那一步，而那一步已经从 QQ 回复档去掉了。
 */
export function qqPromptMaterial(
  orm: Orm,
  input: {
    readonly binding: QqBinding;
    readonly question: string;
    readonly memoryTokens: number;
    readonly knowledgeTokens: number;
    onSources?: (sources: SourceRef[]) => void;
  },
): readonly QqPromptMaterial[] {
  const material: QqPromptMaterial[] = [];
  const memory = memoryMaterial(
    orm,
    input.binding,
    input.question,
    input.memoryTokens,
    input.onSources,
  );
  if (memory !== null) material.push(memory);
  const knowledge = knowledgeMaterial(
    orm,
    input.binding.agentId,
    input.question,
    input.knowledgeTokens,
    input.onSources,
  );
  if (knowledge !== null) material.push(knowledge);
  return Object.freeze(material);
}

/**
 * 知识库读取器要的是原生连接（`KnowledgeContext` 收 `bun:sqlite` 的 `Database`），而 QQ 侧只拿到
 * drizzle 句柄。Bun 驱动把连接放在 `$client`（运行时就是 `openBusinessDb()` 的那个 db，已实测同一个
 * 对象），但 drizzle 0.45 的类型没为 Bun 驱动声明它，所以这里做一次带说明的取用，而不是把
 * `KnowledgeContext` 改成收 drizzle（那会牵动网页那整条链）。
 */
function rawDatabase(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 长期记忆：读范围来自绑定的 `readScopes`（群 scope；只有绑定了共享才加 web scope），
 * 打分与排序与网页目录同源，预算内按相关度取前几条。
 */
function memoryMaterial(
  orm: Orm,
  binding: QqBinding,
  question: string,
  budgetTokens: number,
  onSources?: (sources: SourceRef[]) => void,
): QqPromptMaterial | null {
  try {
    const access = resolveQqMemoryAccess(binding, readQqOwnerIdentity(orm));
    if (access.kind !== "resolved") {
      console.warn(`[qq-memory] 判断不读记忆：读范围未解析（${access.reason}）`);
      return null;
    }
    const keys = qqMemoryScopeKeyset(access.access).read;
    const rows = catalogByScopeKeys(orm, binding.agentId, keys, {
      keywords: contextKeywords(question),
      limit: 8,
    });
    const lines: string[] = [];
    let cost = 0;
    for (const item of rows) {
      const line = memoryLine(item);
      if (line === null) continue;
      const next = cost + estimateTokens(line);
      if (next > budgetTokens) break;
      lines.push(line);
      onSources?.([{ kind: "memory", id: item.id, revision: item.revision }]);
      cost = next;
    }
    if (lines.length === 0) return null;
    return Object.freeze({ title: "你记得的事", body: lines.join("\n") });
  } catch (error) {
    console.warn(`[qq-memory] 判断不读记忆：${reason(error)}`);
    return null;
  }
}

/** 一行记忆：名字＋正文（正文缺了就退回摘要）；两者皆空的行不占预算。 */
function memoryLine(item: MemoryItem): string | null {
  const body = (item.body ?? "").trim() || item.summary.trim();
  if (body.length === 0) return null;
  const name = item.name.trim();
  return name.length === 0 ? `- ${body}` : `- ${name}：${body}`;
}

/**
 * 知识库：按**助手授权**读，与网页同源（用户 2026-09-25 选定）。切段、草稿映射、来源有效性与
 * 打分规则由 `qqKnowledgeItems` 复用网页那一份；这里只按预算裁剪并交给提示词。
 */
function knowledgeMaterial(
  orm: Orm,
  agentId: string,
  question: string,
  budgetTokens: number,
  onSources?: (sources: SourceRef[]) => void,
): QqPromptMaterial | null {
  try {
    const items = qqKnowledgeItems(rawDatabase(orm), agentId, question);
    if (items.length === 0) return null;
    const kept: ContentItem[] = [];
    let cost = 0;
    for (const item of items) {
      const next = cost + knowledgeCost([item]);
      if (next > budgetTokens) break;
      kept.push(item);
      cost = next;
    }
    const message = knowledgeMessages(kept)[0];
    if (message === undefined) return null;
    onSources?.(selectionSources(orm, [{ sources: kept }], agentId));
    return Object.freeze({ title: "参考资料", body: message.content });
  } catch (error) {
    console.warn(`[qq-knowledge] 判断不读资料：${reason(error)}`);
    return null;
  }
}
