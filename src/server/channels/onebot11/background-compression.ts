import type { RuntimeConfig } from "../../../shared/contracts";
import type { RunOwner } from "../../../shared/contracts/agent-run";
import type { SourceRef } from "../../../shared/contracts/evidence";
import type { LeafAgentRuntime, RunBudget, RunUsage } from "../../agent/agent-runtime";
import { uniqueSources } from "../../agent/context-engine";
import {
  type CompressionRecord,
  ConversationCompressor,
} from "../../agent/conversation-compression";
import { contextDumps } from "../../db/json-text";
import { readOrganizationSettings } from "../../db/organization-repository";
import {
  type QqConversationSummary,
  readQqConversationSummary,
  saveQqConversationSummary,
} from "../../db/qq-summary-repository";
import type { Orm } from "../../db/repositories";
import type { ModelGateway } from "../../llm/model-gateway";
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
import { estimateTokens } from "../../services/token-estimate";
import { failureCode } from "./failure-code";

export interface BotCompressionJob {
  key: string;
  run(signal: AbortSignal): Promise<void>;
  failed(error: unknown): void;
}

export function createBotCompressionJob(options: {
  orm: Orm;
  gateway: Pick<ModelGateway, "loadedContextCapacity">;
  agentRuntime: LeafAgentRuntime;
  runtime: RuntimeConfig;
  owner: RunOwner;
  conversationId: string;
  agentId: string;
  expected: QqConversationSummary | null;
  records: readonly CompressionRecord[];
  throughSeq: number;
  coveredSeq: number;
  fromSeconds: number;
  throughSeconds: number;
  question: string;
  sources: readonly SourceRef[];
  target: number;
  packageLimit: number;
  task: string;
  usage?: RunUsage;
  budget?: RunBudget;
  /**
   * 仅在任务**尚未开始**时判定的启动闸门（ADR0019 §13.1 B）：暂停与普通配置变化
   * 拒绝排队中的任务，但不得在已经跑起来之后杀它。缺省＝不拒绝（测试与只读调用方）。
   */
  assertStartable?(): void;
  assertCurrent(): void;
  assertSources(sources: readonly SourceRef[]): void;
  now(): string;
  onFailure(code: string): void;
}): BotCompressionJob {
  const model =
    readOrganizationSettings(options.orm).model_name?.trim() ||
    options.runtime.context_compression_model_name;
  const sources = uniqueSources([
    ...options.sources,
    ...options.records.flatMap((record) => record.sources),
  ]);
  return {
    key: options.conversationId,
    async run(signal) {
      // 先过启动闸门：暂停中的群不再有新的模型任务，排队任务在这里被拒；
      // 已开始的任务只用下面的背景边界判定（暂停不杀在跑的任务）。
      options.assertStartable?.();
      // 飞行前冻结本群「历史摘要」纪元：停用后（哪怕随后恢复）这次压缩不得再写入。
      // 中央叶子边界可能被省（standalone 装配），这里按捕获的纪元自足复验。
      const capCheckpoint = new QqGroupCapabilityGuard(options.orm).assertLeaf(
        options.owner,
        "context.compress.events",
      );
      const check = (refs: readonly SourceRef[]) => {
        signal.throwIfAborted();
        options.assertCurrent();
        options.assertSources(refs);
        if (typeof capCheckpoint === "function") capCheckpoint();
      };
      check(sources);
      if (
        JSON.stringify(
          readQqConversationSummary(options.orm, options.conversationId, options.agentId),
        ) !== JSON.stringify(options.expected)
      ) {
        options.onFailure("CONTEXT_SUMMARY_STALE");
        return;
      }
      const compressor = new ConversationCompressor({
        runtime: { ...options.runtime, context_compression_model_name: model },
        gateway: options.gateway,
        agentRuntime: options.agentRuntime,
        owner: options.owner,
        assertSources: check,
        usage: options.usage,
        budget: options.budget,
      });
      let facts:
        | Parameters<typeof saveQqConversationSummary>[1]["packages"][number]["facts"]
        | undefined;
      try {
        await compressor.summarize({
          records: options.records,
          task: options.task,
          target: options.target,
          question: options.question,
          sources: options.sources,
          signal,
          requireFacts: true,
          onSummary: (value) => {
            facts = value;
          },
        });
      } catch (error) {
        check(sources);
        throw error;
      }
      check(sources);
      if (!facts) return;
      const seqs = options.records.flatMap((record) => (record.seq === null ? [] : [record.seq]));
      const packages = [
        ...(options.expected?.packages ?? []),
        {
          facts,
          fromSeq: seqs.length ? Math.min(...seqs) : -1,
          throughSeq: seqs.length ? Math.max(...seqs) : -1,
          fromSeconds: options.fromSeconds,
          throughSeconds: options.throughSeconds,
          at: options.now(),
          sources,
        },
      ].slice(-options.packageLimit);
      const saved = saveQqConversationSummary(options.orm, {
        conversationId: options.conversationId,
        agentId: options.agentId,
        throughSeq: options.throughSeq,
        coveredSeq: options.coveredSeq,
        packages,
        modelName: model,
        configSnapshot: options.runtime.p5_config,
        estimatedTokens: estimateTokens(contextDumps(packages.map((item) => item.facts))),
        at: options.now(),
        expected: options.expected,
        assertCurrent: () => check(sources),
      });
      if (!saved) options.onFailure("CONTEXT_SUMMARY_STALE");
    },
    failed(error) {
      const code = failureCode(error, { pattern: /^[A-Z][A-Z_]+$/, allowErrorCode: true });
      options.onFailure(code);
    },
  };
}

export class BotCompressionQueue {
  private readonly pending = new Map<string, BotCompressionJob>();
  private readonly controller = new AbortController();
  private active?: Promise<void>;
  private activeKey?: string;
  enqueue(job: BotCompressionJob): void {
    if (!this.controller.signal.aborted && this.activeKey !== job.key)
      this.pending.set(job.key, job);
  }
  runOnce(): Promise<void> {
    if (this.active) return this.active;
    const job = this.pending.values().next().value;
    if (!job || this.controller.signal.aborted) return Promise.resolve();
    this.pending.delete(job.key);
    this.activeKey = job.key;
    this.active = Promise.resolve()
      .then(() => job.run(this.controller.signal))
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) {
          try {
            job.failed(error);
          } catch {
            /* Diagnostics cannot leave an unhandled background rejection. */
          }
        }
      })
      .finally(() => {
        this.active = undefined;
        this.activeKey = undefined;
      });
    return this.active;
  }
  async stop(): Promise<void> {
    this.controller.abort(new Error("COMPRESSION_STOPPED"));
    this.pending.clear();
    await this.active;
  }
}
