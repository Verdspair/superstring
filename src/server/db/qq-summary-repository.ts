// QQ 会话的滚动摘要存取（0045 建表、0046 改语义，）。
//
// 一次会话一行，但内容是**一个压缩包列表 + 两个书签**（0046 第二版机制）：
//   * packages     → 每次水位攒够 `watermark_trigger` 条压出来的那一份事实，包与包不合并，
//                    超过方案的 `package_limit` 就把最早的整包丢掉；
//   * throughSeq   → 历史水位：窗口外的老消息压到哪（只由窗口外那一批推进，保持连续不跳空）；
//   * coveredSeq   → 已覆盖水位：连"窗口内被条数/预算裁掉"的那段也算进去，避免同一批反复触发。
// 两个水位都只增不减：并发或迟到的写入不得把它们退回去，否则会重复压缩或重新计数。
//
// 这里不做授权判断：调用方已经拿到的是一次**受权会话**的摘要（来源可见性与其它读取一致）。

import { and, eq } from "drizzle-orm";
import type { ConversationSummaryFacts } from "../agent/conversation-compression";
import type { Orm } from "./repositories";
import * as schema from "./schema";

/** 一个压缩包：一份事实 + 它覆盖的范围（按事件序号与时刻，供装配排序与诊断）。 */
export interface QqSummaryPackage {
  readonly facts: ConversationSummaryFacts;
  readonly fromSeq: number;
  readonly throughSeq: number;
  readonly fromSeconds: number;
  readonly throughSeconds: number;
  readonly at: string;
}

export interface QqConversationSummary {
  readonly conversationId: string;
  readonly agentId: string;
  /** 历史水位（窗口外那批压到哪；判断档不读它）。 */
  readonly throughSeq: number;
  /** 已覆盖水位（含窗口内被裁掉的那段）。 */
  readonly coveredSeq: number;
  /** 最早的包在前；装配时按这个顺序带上，装不下就丢最早的。 */
  readonly packages: readonly QqSummaryPackage[];
  readonly modelName: string;
  readonly estimatedTokens: number;
  readonly updatedAt: string;
}

/**
 * `content` 的两种形态：0046 起是包数组；同一天的 0045 初版写过"一行一份纯事实数组"。
 * 后者读出来当作一个覆盖范围未知的包（from/through 记 -1、时刻记 0），这样升级后不丢历史。
 */
function parsePackages(content: string, throughSeq: number, updatedAt: string): QqSummaryPackage[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed))
    return [
      {
        facts: parsed as ConversationSummaryFacts,
        fromSeq: -1,
        throughSeq,
        fromSeconds: 0,
        throughSeconds: 0,
        at: updatedAt,
      },
    ];
  const packages = (parsed as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];
  return packages.map((item) => {
    const entry = item as Partial<QqSummaryPackage>;
    return Object.freeze({
      facts: (entry.facts ?? []) as ConversationSummaryFacts,
      fromSeq: entry.fromSeq ?? -1,
      throughSeq: entry.throughSeq ?? -1,
      fromSeconds: entry.fromSeconds ?? 0,
      throughSeconds: entry.throughSeconds ?? 0,
      at: entry.at ?? updatedAt,
    });
  });
}

/** 这条会话当下的水位与包；没有压过就是 null（正常状态，不是错误）。 */
export function readQqConversationSummary(
  orm: Orm,
  conversationId: string,
  agentId: string,
): QqConversationSummary | null {
  const row = orm
    .select()
    .from(schema.qqConversationSummaries)
    .where(eq(schema.qqConversationSummaries.conversationId, conversationId))
    .get();
  if (!row || row.agentId !== agentId) return null;
  return Object.freeze({
    conversationId: row.conversationId,
    agentId: row.agentId,
    throughSeq: row.throughSeq,
    coveredSeq: row.coveredSeq,
    packages: Object.freeze(parsePackages(row.content, row.throughSeq, row.updatedAt)),
    modelName: row.modelName,
    estimatedTokens: row.estimatedTokens,
    updatedAt: row.updatedAt,
  });
}

/**
 * 历史水位对应的时刻——水位缓冲的下界：只取比它更晚、又早于窗口起点的老消息。
 * 事件已被清理或 seq 对不上时返回 null，调用方按"从头补"处理。
 */
export function qqSummaryCoveredSeconds(
  orm: Orm,
  conversationId: string,
  seq: number,
): number | null {
  const row = orm
    .select({ occurredAt: schema.conversationEvents.occurredAt })
    .from(schema.conversationEvents)
    .where(
      and(
        eq(schema.conversationEvents.conversationId, conversationId),
        eq(schema.conversationEvents.seq, seq),
      ),
    )
    .get();
  if (!row) return null;
  const seconds = Math.floor(Date.parse(row.occurredAt) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * 写回这一行。两个水位都只允许往前推（并发或迟到的写入不得把它们退回去）；
 * 包列表由调用方负责（它读过旧行、按上限丢过最早的包）。
 */
export function saveQqConversationSummary(
  orm: Orm,
  input: {
    conversationId: string;
    agentId: string;
    throughSeq: number;
    coveredSeq: number;
    packages: readonly QqSummaryPackage[];
    modelName: string;
    configSnapshot: unknown;
    estimatedTokens: number;
    at: string;
  },
): void {
  const current = readQqConversationSummary(orm, input.conversationId, input.agentId);
  const throughSeq = Math.max(current?.throughSeq ?? -1, input.throughSeq);
  const coveredSeq = Math.max(current?.coveredSeq ?? -1, input.coveredSeq);
  const content = JSON.stringify({ packages: input.packages });
  orm
    .insert(schema.qqConversationSummaries)
    .values({
      conversationId: input.conversationId,
      agentId: input.agentId,
      throughSeq,
      coveredSeq,
      content,
      modelName: input.modelName,
      configSnapshot: JSON.stringify(input.configSnapshot),
      estimatedTokens: input.estimatedTokens,
      createdAt: current?.updatedAt ?? input.at,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: schema.qqConversationSummaries.conversationId,
      set: {
        agentId: input.agentId,
        throughSeq,
        coveredSeq,
        content,
        modelName: input.modelName,
        configSnapshot: JSON.stringify(input.configSnapshot),
        estimatedTokens: input.estimatedTokens,
        updatedAt: input.at,
      },
    })
    .run();
}
