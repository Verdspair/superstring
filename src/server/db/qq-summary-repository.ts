// QQ 会话的滚动摘要存取（0045 建表、0046 改语义，）。
//
// 一次会话一行，但内容是**一个压缩包列表 + 两个书签**（0046 第二版机制）：
//   * packages     → 每次水位攒够 `watermark_trigger` 条压出来的那一份事实，包与包不合并，
//                    超过方案的 `package_limit` 就把最早的整包丢掉；
//   * throughSeq   → 历史水位：窗口外的老消息压到哪（只由窗口外那一批推进，保持连续不跳空）；
//   * coveredSeq   → 已覆盖水位：连"窗口内被条数/预算裁掉"的那段也算进去，避免同一批反复触发。
// 两个水位都只增不减；事务内复验授权与旧快照，拒绝并发或迟到覆盖。

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type SourceRef, SourceRefSchema } from "../../shared/contracts/evidence";
import type { ConversationSummaryFacts } from "../agent/conversation-compression";
import { uniqueSources } from "../services/source-refs";
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
  readonly sources?: readonly SourceRef[];
  readonly provenance?: Readonly<Record<string, string>>;
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

const RecordTuplesSchema = z
  .array(z.tuple([z.string().min(1), z.string().min(1), z.string()]))
  .min(1);

export function compactQqSummaryRecordId(rawId: string): string {
  return `qq-record:${createHash("sha256").update(rawId).digest("base64url")}`;
}

/** Resolve exact record groups without treating their compact labels as authority. */
export function resolveQqSummaryProvenance(
  pkg: Pick<QqSummaryPackage, "facts" | "sources" | "provenance">,
  sources: readonly SourceRef[] = pkg.sources ?? [],
): ConversationSummaryFacts {
  const identities = new Set(
    sources.map((source) => JSON.stringify([source.kind, source.id, source.revision])),
  );
  const provenance =
    pkg.provenance === undefined
      ? undefined
      : z.record(z.string(), z.string()).parse(pkg.provenance);
  z.array(
    z.object({
      text: z.string(),
      source_ids: z.array(z.string()).min(1),
    }),
  ).parse(pkg.facts);
  const resolved = new Map<string, string>();
  const referenced = new Set<string>();
  const facts = pkg.facts.map((fact) => {
    const ids = z.array(z.string()).min(1).parse(fact.source_ids);
    z.string().parse(fact.text);
    return {
      ...fact,
      source_ids: ids.map((id) => {
        const cached = resolved.get(id);
        if (cached !== undefined) return cached;
        let raw = id;
        if (provenance !== undefined && id.startsWith("qq-record:")) {
          raw = z.string().parse(Object.hasOwn(provenance, id) ? provenance[id] : undefined);
          z.literal(id).parse(compactQqSummaryRecordId(raw));
          referenced.add(id);
        }
        const tuples = RecordTuplesSchema.parse(JSON.parse(raw));
        for (const tuple of tuples) z.literal(true).parse(identities.has(JSON.stringify(tuple)));
        resolved.set(id, raw);
        return raw;
      }),
    };
  });
  if (provenance !== undefined) {
    for (const id of Object.keys(provenance)) z.literal(true).parse(referenced.has(id));
  }
  return facts;
}

/**
 * `content` 的两种形态：0046 起是包数组；同一天的 0045 初版写过"一行一份纯事实数组"。
 * 后者读出来当作一个覆盖范围未知的包（from/through 记 -1、时刻记 0），这样升级后不丢历史。
 */
function packageSources(
  facts: ConversationSummaryFacts,
  sources?: readonly SourceRef[],
): SourceRef[] {
  if (sources !== undefined) return z.array(SourceRefSchema).min(1).parse(sources);
  return uniqueSources(
    facts.flatMap((fact) =>
      fact.source_ids.flatMap((id) =>
        z
          .array(z.tuple([z.string().min(1), z.string().min(1), z.string()]))
          .min(1)
          .parse(JSON.parse(id))
          .map(([kind, id, revision]) => ({ kind, id, revision })),
      ),
    ),
  );
}

function parsePackages(content: string, throughSeq: number, updatedAt: string): QqSummaryPackage[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed))
    return [
      {
        facts: parsed as ConversationSummaryFacts,
        sources: packageSources(parsed as ConversationSummaryFacts),
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
    const pkg: QqSummaryPackage = {
      facts: (entry.facts ?? []) as ConversationSummaryFacts,
      fromSeq: entry.fromSeq ?? -1,
      throughSeq: entry.throughSeq ?? -1,
      fromSeconds: entry.fromSeconds ?? 0,
      throughSeconds: entry.throughSeconds ?? 0,
      at: entry.at ?? updatedAt,
      sources: packageSources(entry.facts ?? [], entry.sources),
      ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    };
    if (pkg.provenance !== undefined) resolveQqSummaryProvenance(pkg);
    return Object.freeze(pkg);
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
    expected: QqConversationSummary | null;
    assertCurrent(): void;
  },
): boolean {
  return orm.transaction(
    () => {
      input.assertCurrent();
      const current = readQqConversationSummary(orm, input.conversationId, input.agentId);
      if (JSON.stringify(current) !== JSON.stringify(input.expected)) return false;
      for (const pkg of input.packages) {
        if (pkg.provenance !== undefined) resolveQqSummaryProvenance(pkg);
      }
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
      return true;
    },
    { behavior: "immediate" },
  );
}
