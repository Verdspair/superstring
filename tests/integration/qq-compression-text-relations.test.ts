// 压缩输入的文字关系接线验收（T06 接力2）：水位压缩的 CompressionRecord 文字来自
// 统一事实投影（projectQqTextRelations 同 scope/now），id/seq/说话人与旧规则逐字相等，
// 水位计数/CAS 不动；存在但已过期的事实不回旧正文（整条不给正文/名字/关系）；只有真
// 缺 facts 行且原 body 仍有效的消息沿原 text 标 legacy_partial，不编双名；image category
// 在压缩输入统一 unknown 存在标记，不消费模型分类/视觉笔记。测试走真实
// BotContextSource.read 与背景压缩 job（group-summary 夹具同构），捕获 completeLeaf 的
// 真实模型输入，不用 private 方法当生产入口。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { CompressionRecord } from "../../src/server/agent/conversation-compression";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { rememberQqMemberNames } from "../../src/server/db/qq-member-repository";
import {
  recordQqMessageFact,
  recordQqOutboundMessageFact,
} from "../../src/server/db/qq-message-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  readQqConversationSummary,
  saveQqConversationSummary,
} from "../../src/server/db/qq-summary-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  evidenceHash,
  inTimeline,
  loadConversationEvidence,
  storedPackages,
} from "../../src/server/modules/conversation-evidence-store";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { QqContextMessage } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { uniqueSources } from "../../src/server/services/source-refs";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import { QQ_COMPRESSION_DEFAULT } from "../../src/shared/contracts/qq";
import type { QqMessagePart } from "../../src/shared/contracts/qq-message";
import { closeHarnesses } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});

interface CapturedEvent {
  id: string;
  seq: number | null;
  speaker: string;
  text: string;
}

/** 与 bot-context-source / group-summary 同构的精简夹具：回复档 + 水位压缩。 */
function setup(input: { watermarkTrigger?: number; singleFactCompression?: boolean } = {}) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "compression-text-relations",
    compression: { ...QQ_COMPRESSION_DEFAULT, watermark_trigger: input.watermarkTrigger ?? 1 },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const capturedEvents: CapturedEvent[][] = [];
  /** 压缩调用是否带 question 字段（body-only 诊断专用；其余调用不采集）。 */
  const capturedQuestions: boolean[] = [];
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete(request) {
      // 网关契约的 wire messages 自 preparedFrom 起可选（钩子路径不传它）。本夹具是无钩子
      // 的纯文字调用：wire 消息必到，缺了就当场失败，不静默跳过断言。
      const messages = request.messages;
      if (messages === undefined) throw new Error("wire messages expected in text fixture");
      const firstRaw = messages[1].content;
      if (typeof firstRaw !== "string") throw new Error("text content expected");
      const data = JSON.parse(firstRaw);
      if (data.events) {
        capturedEvents.push(data.events as CapturedEvent[]);
        capturedQuestions.push(Object.hasOwn(data, "question"));
        const first = data.events[0];
        if (input.singleFactCompression === true)
          return JSON.stringify({
            facts: [
              {
                kind: "fact",
                speaker: first.speaker,
                text: "old fact",
                source_ids: [first.id],
              },
            ],
          });
        return JSON.stringify({
          facts: data.events.map((event: { id: string; speaker: string }) => ({
            kind: "fact",
            speaker: event.speaker,
            text: "old fact",
            source_ids: [event.id],
          })),
        });
      }
      return JSON.stringify({ ids: [] });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const runs = new AgentRunRepository(h.db),
    agentRuntime = createAgentRuntime({ gateway, repository: runs });
  const spec: AgentSpec = {
    id: "test.bot",
    model: "reply-model",
    context: "conversation",
    instructions: "respond concisely",
    availableActions: [],
    limits: { steps: 16 },
  };
  const diagnostics: unknown[] = [];
  const buildSource = () =>
    new BotContextSource({
      ...h,
      gateway,
      agentRuntime,
      journal,
      outbox,
      conversationId: conversation.id,
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: "reply",
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
      onDiagnostic: (event) => diagnostics.push(event),
    });
  /**
   * 种一条真实入站观察 +（缺省）同键 facts 行。factParts 定制片段；noFact 跳过事实行；
   * bodyExpiresInSeconds/factExpiresInSeconds 可把正文/事实各自的到期分开拨快。
   */
  const seed = (
    text: string,
    age = 0,
    options: {
      speakerId?: string;
      messageId?: string;
      factParts?: QqMessagePart[];
      replyToMessageId?: string;
      noFact?: boolean;
      bodyExpiresInSeconds?: number;
      factExpiresInSeconds?: number;
    } = {},
  ) => {
    const id = crypto.randomUUID();
    const occurredAt = seconds - age;
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: options.messageId ?? id,
        occurredAtSeconds: occurredAt,
        speakerKind: "member",
        speakerId: options.speakerId ?? "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds: occurredAt,
        expiresAt: new Date((options.bodyExpiresInSeconds ?? seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    if (!options.noFact) {
      // 发送时快照按说话人给名字：20002=阿林/林某，30003=小周/周同学（与真实 intake 同构）。
      const named =
        (options.speakerId ?? "20002") === "20002"
          ? { groupCard: "阿林", personalNickname: "林某" }
          : { groupCard: "小周", personalNickname: "周同学" };
      recordQqMessageFact(
        h.orm,
        {
          eventKey: id,
          groupCard: named.groupCard,
          groupCardSource: "wire",
          personalNickname: named.personalNickname,
          personalNicknameSource: "wire",
          legacyDisplayName: null,
          nameState: "known",
          parts: options.factParts ?? [{ kind: "text", text }],
          replyToMessageId: options.replyToMessageId ?? null,
          occurredAtSeconds: occurredAt,
        },
        // 事实行默认与正文同窗；测试用 occurredAtSeconds 推到期，和真实 intake 一致。
      );
      if (options.factExpiresInSeconds !== undefined) {
        h.db
          .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
          .run(new Date(options.factExpiresInSeconds * 1000).toISOString(), id);
      }
    }
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return {
    ...h,
    runs,
    source: buildSource(),
    binding,
    conversation,
    journal,
    outbox,
    diagnostics,
    seed,
    newSource: buildSource,
    capturedEvents,
    capturedQuestions,
    runtime,
    gateway,
    seconds,
    now,
  };
}

const readInput = () => ({ signal: new AbortController().signal, observations: [] });
async function compress(source: BotContextSource): Promise<void> {
  const job = source.takeCompressionJob();
  if (!job) return;
  try {
    await job.run(readInput().signal);
  } catch (error) {
    job.failed(error);
  }
}
const compressionRuns = (h: ReturnType<typeof setup>) =>
  h.runs
    .listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })
    .filter((run) => run.specId === "context.compress.events");
/** 旧规则下 record 的 id：原 sources tuple 的 contextDumps（与源码逐字同一算式）。 */
const legacyIdOf = (sources: readonly { kind: string; id: string; revision?: string }[]) =>
  contextDumps(sources.map((source) => [source.kind, source.id, source.revision]));
const bodySha = (body: string) => createHash("sha256").update(body).digest("hex");

const compressionRecordsOf = (source: BotContextSource, messages: readonly QqContextMessage[]) =>
  (
    source as unknown as {
      compressionRecords(messages: readonly QqContextMessage[]): CompressionRecord[];
    }
  ).compressionRecords(messages);

const assistantMessage = (sources: SourceRef[] = []): QqContextMessage => ({
  speaker: "assistant",
  speakerId: null,
  text: "assistant history",
  occurredAtSeconds: 1,
  mediaNotes: [],
  mediaUnread: 0,
  sources,
});

describe("压缩输入的文字关系（T06 接力2）", () => {
  it.each([
    ["legacy inbound control", false, null],
    ["fully confirmed speech", true, null],
    ["wrong target peer", true, "peer"],
    ["wrong target epoch", true, "epoch"],
    ["wrong target authority", true, "authority"],
    ["duplicate legacy link", true, "duplicate"],
    ["missing delivery journal", true, "journal"],
    ["mismatched receipt", true, "receipt"],
    ["speech body drift", true, "body"],
    ["unconfirmed intent", true, "status"],
    ["malformed target array", true, "target_array"],
    ["missing target authority revision", true, "missing_authority"],
    ["expired intent", true, "expired_intent"],
    ["expired send log", true, "expired_send"],
    ["expired speech log", true, "expired_speech"],
    ["expired speech body", true, "expired_body"],
  ] as const)(
    "recognizes only scoped confirmed speech provenance: %s",
    async (_scenario, withSpeech, mutation) => {
      const h = setup({ watermarkTrigger: 2 });
      const firstBody = "old producer first";
      const secondBody = "old producer second";
      const first = h.seed(firstBody, 30001, { noFact: true });
      const second = h.seed(secondBody, 30000, { noFact: true });
      const scope = {
        channel: "onebot11" as const,
        conversationId: h.conversation.id,
        accountId: h.binding.accountId,
        conversationKind: h.binding.kind,
        peerId: h.binding.peerId,
        agentId: h.binding.agentId,
        bindingId: h.binding.id,
        bindingEpoch: h.conversation.bindingEpoch,
        authorityRevision: h.binding.authorityRevision,
      };
      let speechId: string | undefined;
      let intentId: string | undefined;
      let portCalls = 0;
      if (withSpeech) {
        const runId = crypto.randomUUID();
        const sentAt = new Date((h.seconds - 60) * 1000).toISOString();
        const expiresAt = new Date((h.seconds + 3600) * 1000).toISOString();
        const assistantBody = "confirmed recent producer speech";
        h.runs.createRun({
          runId,
          specId: "synthetic-producer-delivery",
          specVersion: "1",
          at: sentAt,
          owner: {
            kind: "conversation",
            id: h.conversation.id,
            userId: DEFAULT_USER_ID,
            agentId: h.binding.agentId,
          },
        });
        const intent = h.outbox.commit({
          id: crypto.randomUUID(),
          runId,
          conversationId: h.conversation.id,
          ordinal: 0,
          target: {
            accountId: scope.accountId,
            conversationKind: scope.conversationKind,
            peerId: scope.peerId,
            agentId: scope.agentId,
            bindingId: scope.bindingId,
            bindingEpoch: scope.bindingEpoch,
            authorityRevision: scope.authorityRevision,
          },
          speechKind: "direct_reply",
          sourceThroughSeq: 2,
          deliverBy: expiresAt,
          createdAt: sentAt,
          expiresAt,
          parts: [{ kind: "text", text: assistantBody }],
        });
        intentId = intent.id;
        h.journal.append({
          conversationId: h.conversation.id,
          eventKey: `output:${intent.id}`,
          kind: "delivery",
          source: { kind: "outbound_intent", id: intent.id, revision: "planned", expiresAt },
          occurredAt: sentAt,
          runId,
          outputId: intent.id,
        });
        recordQqOutboundMessageFact(h.orm, {
          intentId: intent.id,
          accountId: scope.accountId,
          agentId: scope.agentId,
          identity: {
            qq: scope.accountId,
            groupCard: "合成助手",
            personalNickname: null,
            legacyDisplayName: null,
            nameState: "known",
          },
          occurredAtSeconds: h.seconds - 60,
        });
        const delivery = new OutboundDelivery({
          orm: h.orm,
          repository: h.outbox,
          journal: h.journal,
          stickerFile: () => null,
          authorize: () => true,
          now: () => sentAt,
          port: {
            async send() {
              portCalls++;
              return { kind: "confirmed" as const, messageId: "-99101" };
            },
          },
        });
        await delivery.deliver(intent.id);
        const part = h.outbox.parts(intent.id)[0];
        expect(portCalls).toBe(1);
        expect(part?.status).toBe("confirmed");
        expect(part?.platform_message_id).toBe("-99101");
        expect(part?.finished_at).toBe(sentAt);
        speechId = h.outbox.row(intent.id)?.legacy_send_id ?? undefined;
        if (!speechId) throw new Error("fixture: confirmed legacy send identity missing");
        const speech = h.db
          .query(`SELECT s.account_id,s.conversation_kind,s.peer_id,s.agent_id,
          s.expires_at AS logExpiry,t.expires_at AS bodyExpiry,t.body
          FROM qq_speech_log s JOIN qq_speech_text t ON t.speech_id=s.id WHERE s.id=?`)
          .get(speechId) as {
          account_id: string;
          conversation_kind: string;
          peer_id: string;
          agent_id: string;
          logExpiry: string;
          bodyExpiry: string;
          body: string;
        };
        expect(speech.body).toBe(assistantBody);
        expect([
          speech.account_id,
          speech.conversation_kind,
          speech.peer_id,
          speech.agent_id,
        ]).toEqual([scope.accountId, scope.conversationKind, scope.peerId, scope.agentId]);
        expect(Date.parse(speech.logExpiry)).toBeGreaterThan(Date.parse(h.now));
        expect(Date.parse(speech.bodyExpiry)).toBeGreaterThan(Date.parse(h.now));
      }
      const expectedSpeechIds: string[] = [];
      if (withSpeech) {
        if (!speechId) throw new Error("fixture: confirmed speech identity missing");
        expectedSpeechIds.push(speechId);
      }
      const trigger = h.seed("current producer trigger", 0, { noFact: true });
      const source = h.newSource();
      const material = await source.read(readInput());
      expect(
        material.sources?.some((ref) => ref.kind === "qq_observation" && ref.id === trigger),
      ).toBe(true);
      const materialSpeech = material.sources?.filter((ref) => ref.kind === "qq_speech") ?? [];
      expect(materialSpeech.map((ref) => ref.id)).toEqual(expectedSpeechIds);
      if (withSpeech) {
        const speechSource = materialSpeech[0];
        if (!speechSource || speechSource.expiresAt === undefined)
          throw new Error("fixture: selected speech source or expiry missing");
        expect(speechSource.revision).toBe(bodySha("confirmed recent producer speech"));
        expect(Date.parse(speechSource.expiresAt)).toBeGreaterThan(Date.parse(h.now));
      }
      const job = source.takeCompressionJob();
      if (!job) throw new Error("fixture: original compression job missing");
      await job.run(readInput().signal);
      expect(h.capturedEvents).toHaveLength(1);
      const events = h.capturedEvents[0];
      if (!events) throw new Error("fixture: original captured compression events missing");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      const rawIds = [
        legacyIdOf([{ kind: "qq_observation", id: first, revision: bodySha(firstBody) }]),
        legacyIdOf([{ kind: "qq_observation", id: second, revision: bodySha(secondBody) }]),
      ];
      const labels = new Map(
        [...new Set(rawIds)].sort().map((id, index) => [id, `s${index.toString(36)}`]),
      );
      expect(events.map((event) => event.id)).toEqual(rawIds.map((id) => labels.get(id)!));
      const row = h.orm.select().from(schema.qqConversationSummaries).get();
      if (!row) throw new Error("fixture: original job did not publish a package");
      const pkg = (
        JSON.parse(row.content) as {
          packages: {
            facts: { source_ids: string[] }[];
            sources: SourceRef[];
            provenance: Record<string, string>;
          }[];
        }
      ).packages[0];
      if (!pkg) throw new Error("fixture: original published package missing");
      expect(pkg.sources.length).toBeLessThanOrEqual(100);
      expect(pkg.sources.filter((ref) => ref.kind === "qq_speech")).toEqual([]);
      expect(pkg.facts.map((fact) => fact.source_ids.map((id) => pkg.provenance[id]))).toEqual(
        rawIds.map((id) => [id]),
      );
      expect(row.throughSeq).toBe(2);
      expect(row.coveredSeq).toBe(2);
      const currentSummary = readQqConversationSummary(h.orm, h.conversation.id, h.binding.agentId);
      if (!currentSummary) throw new Error("fixture: current summary missing");
      const currentPackage = currentSummary.packages[0];
      if (!currentPackage) throw new Error("fixture: current package missing");
      const legacyPackage = {
        ...currentPackage,
        sources: uniqueSources([...(currentPackage.sources ?? []), ...(material.sources ?? [])]),
      };
      const saved = saveQqConversationSummary(h.orm, {
        conversationId: h.conversation.id,
        agentId: h.binding.agentId,
        throughSeq: currentSummary.throughSeq,
        coveredSeq: currentSummary.coveredSeq,
        packages: [legacyPackage],
        modelName: currentSummary.modelName,
        configSnapshot: h.runtime.p5_config,
        estimatedTokens: currentSummary.estimatedTokens,
        at: h.now,
        expected: currentSummary,
        assertCurrent() {},
      });
      expect(saved).toBe(true);
      const persistedLegacySummary = readQqConversationSummary(
        h.orm,
        h.conversation.id,
        h.binding.agentId,
      );
      const legacyPkg = persistedLegacySummary?.packages[0];
      if (!legacyPkg) throw new Error("fixture: persisted legacy package missing");
      expect(legacyPkg.sources?.length).toBeLessThanOrEqual(100);
      expect(
        (legacyPkg.sources ?? []).filter((ref) => ref.kind === "qq_speech").map((ref) => ref.id),
      ).toEqual(expectedSpeechIds);
      expect(
        legacyPkg.facts.map((fact) => fact.source_ids.map((id) => legacyPkg.provenance?.[id])),
      ).toEqual(rawIds.map((id) => [id]));
      if (mutation) {
        if (!intentId || !speechId)
          throw new Error("fixture: confirmed provenance identity missing");
        if (mutation === "peer") {
          h.db
            .query("UPDATE outbound_intents SET target=json_set(target,'$.peerId',?) WHERE id=?")
            .run("39999", intentId);
        } else if (mutation === "epoch") {
          h.db
            .query(
              "UPDATE outbound_intents SET target=json_set(target,'$.bindingEpoch',?) WHERE id=?",
            )
            .run(scope.bindingEpoch + 1, intentId);
        } else if (mutation === "authority") {
          h.db
            .query(
              "UPDATE outbound_intents SET target=json_set(target,'$.authorityRevision',?) WHERE id=?",
            )
            .run(scope.authorityRevision + 1, intentId);
        } else if (mutation === "duplicate") {
          h.db
            .query(`INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,
            source_through_seq,deliver_by,status,created_at,expires_at,legacy_send_id)
            SELECT ?,run_id,conversation_id,99,target,speech_kind,source_through_seq,deliver_by,status,
              created_at,expires_at,legacy_send_id FROM outbound_intents WHERE id=?`)
            .run(crypto.randomUUID(), intentId);
        } else if (mutation === "journal") {
          h.db
            .query(
              "DELETE FROM conversation_events WHERE conversation_id=? AND kind='delivery' AND source_kind='outbound_intent' AND source_id=?",
            )
            .run(h.conversation.id, intentId);
        } else if (mutation === "receipt") {
          h.db
            .query("UPDATE outbound_parts SET platform_message_id=? WHERE intent_id=?")
            .run("-99102", intentId);
        } else if (mutation === "body") {
          h.db
            .query("UPDATE qq_speech_text SET body=? WHERE speech_id=?")
            .run("synthetic changed speech body", speechId);
        } else if (mutation === "status") {
          h.db.query("UPDATE outbound_intents SET status='unknown' WHERE id=?").run(intentId);
        } else if (mutation === "target_array") {
          h.db.query("UPDATE outbound_intents SET target='[]' WHERE id=?").run(intentId);
        } else if (mutation === "missing_authority") {
          h.db
            .query(
              "UPDATE outbound_intents SET target=json_remove(target,'$.authorityRevision') WHERE id=?",
            )
            .run(intentId);
        } else if (mutation === "expired_intent") {
          const expiredStamp = new Date((h.seconds - 10) * 1000).toISOString();
          h.db
            .query("UPDATE outbound_intents SET expires_at=? WHERE id=?")
            .run(expiredStamp, intentId);
        } else if (mutation === "expired_send") {
          const expiredStamp = new Date((h.seconds - 10) * 1000).toISOString();
          h.db.query("UPDATE qq_send_log SET expires_at=? WHERE id=?").run(expiredStamp, speechId);
        } else if (mutation === "expired_speech") {
          const expiredStamp = new Date((h.seconds - 10) * 1000).toISOString();
          h.db
            .query("UPDATE qq_speech_log SET expires_at=? WHERE id=?")
            .run(expiredStamp, speechId);
        } else if (mutation === "expired_body") {
          const expiredStamp = new Date((h.seconds - 10) * 1000).toISOString();
          h.db
            .query("UPDATE qq_speech_text SET expires_at=? WHERE speech_id=?")
            .run(expiredStamp, speechId);
        }
      }
      const sourceKindCounts: Record<string, number> = Object.create(null);
      const absentTimelineByKind: Record<string, number> = Object.create(null);
      let expiredSourceCount = 0;
      for (const ref of legacyPkg.sources ?? []) {
        sourceKindCounts[ref.kind] = (sourceKindCounts[ref.kind] ?? 0) + 1;
        if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= Date.parse(h.now))
          expiredSourceCount++;
        if (!inTimeline(h.db, scope, ref.kind, ref.id))
          absentTimelineByKind[ref.kind] = (absentTimelineByKind[ref.kind] ?? 0) + 1;
      }
      const stored = storedPackages(h, scope);
      const canonicalPackage = stored?.packages[0];
      console.log(
        JSON.stringify({
          withSpeech,
          sourceKindCounts,
          expiredSourceCount,
          absentTimelineByKind,
          factsCount: legacyPkg.facts.length,
          provenanceCount: Object.keys(legacyPkg.provenance ?? {}).length,
          fullSourceCount: legacyPkg.sources?.length ?? 0,
          storedPackagesAvailable: stored !== null,
        }),
      );
      if (!canonicalPackage) throw new Error("fixture: original stored package address missing");
      const loaded = loadConversationEvidence(
        h,
        scope,
        "summary",
        evidenceHash(canonicalPackage),
        h.now,
      );
      if (withSpeech) {
        if (!speechId) throw new Error("fixture: confirmed speech membership identity missing");
        expect(inTimeline(h.db, scope, "qq_speech", speechId)).toBe(mutation === null);
      } else {
        expect(portCalls).toBe(0);
      }
      if (mutation) {
        expect(loaded).toBeNull();
      } else {
        expect(loaded).not.toBeNull();
        if (!loaded) throw new Error("fixture: approved scoped summary was unreadable");
        const presented = JSON.parse(loaded.text) as { source_ids: string[] }[];
        expect(presented).toEqual(legacyPkg.facts);
        expect(
          presented.map((fact) => fact.source_ids.map((id) => legacyPkg.provenance?.[id])),
        ).toEqual(rawIds.map((id) => [id]));
      }
    },
  );

  it("publishes a target-2048 QQ summary with reversible compact references while retaining original raw records", async () => {
    const h = setup({ watermarkTrigger: 50 });
    h.runtime.p5_config.summary_target_tokens = 2048;
    h.runtime.p5_config.summary_read_max_tokens = 2048;
    const keys = Array.from({ length: 50 }, (_, index) =>
      h.seed(`old source ${index}`, 30000 + index),
    );
    h.seed("current question");
    const rawRecords = compressionRecordsOf(
      h.newSource(),
      keys.map((id, index) => ({
        speaker: "member",
        speakerId: "20002",
        text: `old source ${index}`,
        occurredAtSeconds: h.seconds - 30000 - index,
        mediaNotes: [],
        mediaUnread: 0,
        sources: [{ kind: "qq_observation", id, revision: bodySha(`old source ${index}`) }],
      })),
    );
    expect(rawRecords.map((record) => record.id)).toEqual(
      keys.map((id, index) =>
        legacyIdOf([{ kind: "qq_observation", id, revision: bodySha(`old source ${index}`) }]),
      ),
    );
    let returnedFacts: { kind: string; speaker: string; text: string; source_ids: string[] }[] = [];
    h.gateway.complete = async (request) => {
      const wire = request.messages?.[1]?.content;
      if (typeof wire !== "string") throw new Error("fixture: summary wire missing");
      const data = JSON.parse(wire) as { events: CapturedEvent[] };
      expect(data.events).toHaveLength(50);
      returnedFacts = Array.from({ length: 5 }, (_, index) => ({
        kind: "fact",
        speaker: data.events[index * 3]!.speaker,
        text: `fact ${index}`,
        source_ids: data.events.slice(index * 3, index * 3 + 3).map((event) => event.id),
      }));
      return JSON.stringify({ facts: returnedFacts });
    };
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("fixture: compression job missing");
    await job.run(readInput().signal);
    const stored = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!stored) throw new Error("fixture: accepted summary not stored");
    const packages = JSON.parse(stored.content) as {
      packages: {
        facts: typeof returnedFacts;
        sources: SourceRef[];
        provenance?: Record<string, string>;
      }[];
    };
    const pkg = packages.packages[0]!;
    expect(pkg.facts).toEqual(returnedFacts);
    expect(Buffer.byteLength(contextDumps({ facts: pkg.facts }))).toBeLessThanOrEqual(2048);
    const referenced = [...new Set(pkg.facts.flatMap((fact) => fact.source_ids))];
    expect(referenced).toHaveLength(15);
    expect(Object.keys(pkg.provenance ?? {}).sort()).toEqual([...referenced].sort());
    for (const id of referenced) {
      const original = pkg.provenance?.[id];
      expect(rawRecords.some((record) => record.id === original)).toBe(true);
      const orderedRaw = [...new Set(rawRecords.map((record) => record.id))].sort();
      expect(id).toBe(`s${orderedRaw.indexOf(original!).toString(36)}`);
    }
    expect(
      pkg.sources.some(
        (ref) =>
          ref.kind === "qq_observation" &&
          ref.id === keys[0] &&
          ref.revision === bodySha("old source 0"),
      ),
    ).toBe(true);
    expect(stored.throughSeq).toBe(50);
    expect(stored.coveredSeq).toBe(50);
  });

  it("compression record sequence association reads history once for twenty source references", () => {
    const h = setup();
    const sources: SourceRef[] = Array.from({ length: 20 }, (_, index) => ({
      kind: "qq_speech",
      id: `speech-${index}`,
      revision: "original",
    }));
    const journal = new ConversationEventRepository(h.db);
    for (const [index, source] of sources.entries()) {
      journal.append({
        conversationId: h.conversation.id,
        eventKey: `history-${index}`,
        kind: "outbound",
        source,
        occurredAt: h.now,
      });
    }
    for (let index = 0; index < 60; index++) {
      journal.append({
        conversationId: h.conversation.id,
        eventKey: `unrelated-${index}`,
        kind: "outbound",
        source: { kind: "qq_speech", id: `unrelated-${index}`, revision: "original" },
        occurredAt: h.now,
      });
    }
    const source = h.newSource();
    const query = h.db.query.bind(h.db);
    const originalQuery = h.db.query;
    let historyReads = 0;
    let associationRows = 0;
    // No inbound refs: this phase cannot enter fact projection. Count native all() reads
    // bound to this conversation, without depending on a SQL string or elapsed time.
    h.db.query = ((...arguments_: Parameters<typeof h.db.query>) => {
      const statement = query(...arguments_);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") {
            return (...bindings: unknown[]) => {
              const rows: unknown[] = Reflect.apply(target.all, target, bindings);
              if (bindings[0] === h.conversation.id) {
                historyReads += 1;
                associationRows += rows.filter((row) => {
                  if (row === null || typeof row !== "object") return false;
                  const value = row as Record<string, unknown>;
                  return "kind" in value && "id" in value && typeof value.seq === "number";
                }).length;
              }
              return rows;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof h.db.query;
    let records: CompressionRecord[];
    try {
      records = compressionRecordsOf(
        source,
        sources.map((ref) => assistantMessage([ref, ref])),
      );
    } finally {
      h.db.query = originalQuery;
    }
    expect(records.map((record) => record.seq)).toEqual(sources.map((_, index) => index + 1));
    expect(records.map((record) => record.id)).toEqual(
      sources.map((ref) => legacyIdOf([ref, ref])),
    );
    expect(records.map((record) => record.text)).toEqual(
      sources.map(() => contextDumps({ text: "assistant history" })),
    );
    expect(historyReads).toBeGreaterThan(0);
    expect(historyReads).toBeLessThanOrEqual(1);
    expect(associationRows).toBeGreaterThan(0);
    expect(associationRows).toBeLessThanOrEqual(sources.length);
  });

  it("sequence association keeps secondary refs, all-history minimum and kind/conversation boundaries", () => {
    const h = setup();
    const other = setup();
    const journal = new ConversationEventRepository(h.db);
    const ref = (kind: string, id: string, revision = "current"): SourceRef => ({
      kind,
      id,
      revision,
    });
    const secondary = ref("qq_speech", "secondary");
    const alternate = ref("qq_send", "secondary");
    const missing = ref("qq_speech", "missing");
    const append = (kind: "inbound" | "outbound" | "delivery", sources: SourceRef[]) =>
      journal.append({
        conversationId: h.conversation.id,
        eventKey: crypto.randomUUID(),
        kind,
        source: ref("unrelated", crypto.randomUUID()),
        sources,
        occurredAt: h.now,
      });
    append("delivery", [secondary, missing]);
    append("inbound", [
      ref("unrelated", "primary"),
      {
        ...secondary,
        revision: "old",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ]);
    append("outbound", [secondary]);
    append("outbound", [alternate]);
    h.db
      .query(`INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
      VALUES(?,5,'numeric-json','outbound','qq_speech','numeric-carrier','original',?,'{"reasons":[],"mentionIds":[]}',?,?)`)
      .run(
        h.conversation.id,
        JSON.stringify([{ kind: "qq_speech", id: 123, revision: "original" }]),
        h.now,
        h.now,
      );
    // Another conversation in the same database must not supply a smaller sequence.
    h.db
      .query(
        "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,next_seq,consumed_seq,created_at,updated_at,closed_at,source_watermark) SELECT ?,channel,topology,?,agent_id,user_id,binding_epoch,1,0,created_at,updated_at,closed_at,source_watermark FROM conversations WHERE id=?",
      )
      .run(other.conversation.id, other.binding.id, h.conversation.id);
    journal.append({
      conversationId: other.conversation.id,
      eventKey: "outside",
      kind: "inbound",
      source: secondary,
      sources: [secondary, missing],
      occurredAt: h.now,
    });
    const messages = [
      assistantMessage([secondary]),
      assistantMessage([alternate]),
      assistantMessage([secondary, alternate, secondary]),
      assistantMessage([missing]),
      assistantMessage(),
    ];
    const source = h.newSource();
    const records = compressionRecordsOf(source, messages);
    expect(records.map((record) => record.seq)).toEqual([2, 4, 2, null, null]);
    expect(records.map((record) => record.id)).toEqual(
      messages.map((message, index) =>
        message.sources?.length ? legacyIdOf(message.sources ?? []) : `anonymous:1:${index}`,
      ),
    );
    expect(records.map((record) => record.sources)).toEqual(
      messages.map((message) => message.sources ?? []),
    );
    expect(records.map((record) => record.text)).toEqual(
      messages.map(() => contextDumps({ text: "assistant history" })),
    );
    // Each invocation derives its map from current journal rows, not an instance cache.
    h.db
      .query("UPDATE conversation_events SET sources=? WHERE conversation_id=? AND seq=1")
      .run(JSON.stringify([secondary]), h.conversation.id);
    h.db
      .query("UPDATE conversation_events SET kind='inbound' WHERE conversation_id=? AND seq=1")
      .run(h.conversation.id);
    expect(compressionRecordsOf(source, messages).map((record) => record.seq)).toEqual([
      1,
      4,
      1,
      null,
      null,
    ]);
    expect(
      compressionRecordsOf(source, [assistantMessage([ref("qq_speech", "123")])])[0]?.seq,
    ).toBeNull();
  });

  it("原压缩记录 id/seq/count 保持旧规则，模型使用可逆短 ID；水位推进位置不变", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const first = h.seed("旧事实一", 30001);
    const second = h.seed("旧事实二", 30000);
    h.seed("recent question");
    const source = h.newSource();
    const rawIds = [
      legacyIdOf([{ kind: "qq_observation", id: first, revision: bodySha("旧事实一") }]),
      legacyIdOf([{ kind: "qq_observation", id: second, revision: bodySha("旧事实二") }]),
    ];
    const rawRecords = compressionRecordsOf(source, [
      {
        speaker: "member",
        speakerId: "20002",
        text: "旧事实一",
        occurredAtSeconds: h.seconds - 30001,
        mediaNotes: [],
        mediaUnread: 0,
        sources: [{ kind: "qq_observation", id: first, revision: bodySha("旧事实一") }],
      },
      {
        speaker: "member",
        speakerId: "20002",
        text: "旧事实二",
        occurredAtSeconds: h.seconds - 30000,
        mediaNotes: [],
        mediaUnread: 0,
        sources: [{ kind: "qq_observation", id: second, revision: bodySha("旧事实二") }],
      },
    ]);
    expect(rawRecords).toHaveLength(2);
    expect(rawRecords.map((record) => record.seq)).toEqual([1, 2]);
    expect(rawRecords.map((record) => record.id)).toEqual(rawIds);
    const material = await source.read(readInput());
    expect(JSON.stringify(material.pending)).not.toContain("旧事实");
    const job = source.takeCompressionJob();
    expect(job).toBeDefined();
    if (!job) throw new Error("expected the queued compression job");
    try {
      await job.run(readInput().signal);
    } catch (error) {
      job.failed(error);
    }
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected summary row");
    expect(row.throughSeq).toBe(2);
    expect(row.coveredSeq).toBe(2);
    expect(h.capturedEvents).toHaveLength(1);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    const labels = new Map(
      [...new Set(rawIds)].sort().map((id, index) => [id, `s${index.toString(36)}`]),
    );
    expect(events.map((event) => event.id)).toEqual(rawIds.map((id) => labels.get(id)!));
    const pkg = (JSON.parse(row.content) as { packages: { provenance: Record<string, string> }[] })
      .packages[0]!;
    expect(events.map((event) => pkg.provenance[event.id])).toEqual(rawIds);
  });

  it("发送时双名快照与 @/reply 关系进同一次压缩调用；当前目录名不进", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const first = h.seed("先说一句", 30001, { messageId: "PLAT-101" });
    const second = h.seed("回复你", 30000, {
      speakerId: "30003",
      messageId: "PLAT-102",
      factParts: [
        { kind: "mention", qq: "20002" },
        { kind: "text", text: "回复你" },
      ],
      replyToMessageId: "PLAT-101",
    });
    void first;
    void second;
    // 当前目录另有其名：投影会给出 currentName，压缩输入必须只消费发送时快照。
    rememberQqMemberNames(h.orm, {
      scope: { accountId: "10001", conversationKind: "group", peerId: "30003" },
      userId: "20002",
      names: { groupCard: "当前目录名" },
      seenAtSeconds: h.seconds - 1,
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    expect(h.capturedEvents).toHaveLength(1);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    // 发送时双名快照进文字；当前目录名（currentName）不进。
    expect(all).toContain("阿林");
    expect(all).toContain("林某");
    expect(all).toContain("小周");
    expect(all).toContain("周同学");
    expect(all).not.toContain("当前目录名");
    // @ 对象与 reply 关系（平台消息 ID）进文字。
    expect(all).toContain("20002");
    expect(all).toContain("PLAT-101");
    expect(all).toContain("PLAT-102");
  });

  it("存在但已过期的事实整跳：不回旧正文、不给名字，只留最少状态", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const key = h.seed("到期旧文 SECRET-BODY-991", 30000, {
      factExpiresInSeconds: h.seconds - 1,
    });
    void key;
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw Error("expected captured call");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error("expected one event");
    // 说话人身份按原规则保留（水位计数与说话人逐字不变），但文字里没有旧正文与名字。
    expect(event.speaker).toBe("20002");
    expect(event.text).toBe(contextDumps({ completeness: "unavailable" }));
    expect(event.text).not.toContain("SECRET-BODY-991");
    expect(event.text).not.toContain("阿林");
  });

  it("正文被改写而片段对不上：unavailable 不供任何私有正文", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("改写后的正文 REWRITTEN-BODY-77", 30000, {
      factParts: [{ kind: "text", text: "原始片段 ORIGINAL-PARTS-77" }],
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).not.toContain("REWRITTEN-BODY-77");
    expect(all).not.toContain("ORIGINAL-PARTS-77");
    expect(all).not.toContain("阿林");
    expect(all).toContain("unavailable");
  });

  it("真缺 facts 行且原 body 有效的旧消息沿原 text 标 legacy_partial，不编双名", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("无事实行的旧话 LEGACY-PLAIN-BODY", 30000, { noFact: true });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).toContain("LEGACY-PLAIN-BODY");
    expect(all).toContain("legacy_partial");
    expect(all).not.toContain("阿林");
    expect(all).not.toContain("林某");
  });

  it("facts 行在 call 期间到期：压缩 job 按来源复验拒绝，不落包", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed("旧事实一", 30001);
    h.seed("旧事实二", 30000);
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("expected the queued compression job");
    // 两条事实行都在读取之后、任务开跑之前到期：合并进 sources 的 fact 引用必须被复验拦下。
    // job.run 的失败走 failed()（真实队列同路径），诊断带码。
    h.db
      .query("UPDATE qq_message_facts SET expires_at=? WHERE 1")
      .run(new Date((h.seconds - 1) * 1000).toISOString());
    try {
      await job.run(readInput().signal);
    } catch (error) {
      job.failed(error);
    }
    expect(compressionRuns(h)).toHaveLength(0);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "CONTEXT_SOURCE_INVALID" },
    ]);
  });

  it("ownerScope 定位失败（scope=null）的入站消息 fail closed：不回退 legacy 正文", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("定位失败的正文 SCOPE-BROKEN-42", 30000);
    // 最小破坏（等效使 ownerScope 对该 conversation 判 null，复审 §4 的"宿主对已关闭
    // 会话跑轮次"）：把本会话行拨成已关闭。ownerScope 只接受 closed_at IS NULL 的活会话
    // （qq-media-sources.ts），于是 compressionRecords 判 scope=null；而绑定行、journal
    // 时间线、facts 行、qq_observation 复验与摘要读写都不依赖 closed_at，宿主
    // assertCurrent 在本夹具是空实现——不会更早拦下，破坏点只剩这一条分类分支。
    // 时序必须在 read 之前：压缩记录在 read 内冻结；若在 read 后、run 前破坏，冻结记录里
    // 的 qq_message_fact 引用会被 job 的来源复验以 CONTEXT_SOURCE_INVALID 整单拒绝
    // （那种时序已由来源复验收紧覆盖，本条负测的是 read 时的分支分类）。
    h.db
      .query("UPDATE conversations SET closed_at=? WHERE id=?")
      .run(new Date().toISOString(), h.conversation.id);
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(events).toHaveLength(1);
    // 无法定位 scope 与"事实行存在但投影整跳"同判 unavailable：不回退正文、不给名字。
    expect(events[0]?.text).toBe(contextDumps({ completeness: "unavailable" }));
    expect(all).not.toContain("SCOPE-BROKEN-42");
    expect(all).not.toContain("阿林");
    expect(all).not.toContain("林某");
  });

  it("image category 在压缩输入统一 unknown 存在标记；模型分类/视觉笔记不进", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("看图说话 IMAGE-BODY-51", 30000, {
      // 合成塞入非 unknown 分类（真实 intake 恒为 unknown）：压缩输入必须归一成 unknown，
      // 证明它只做存在标记、不 join 任何分类来源。
      factParts: [
        { kind: "image", mediaId: "img-cat-1", category: "expression" },
        { kind: "text", text: "看图说话 IMAGE-BODY-51" },
      ],
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).toContain("img-cat-1");
    expect(all).toContain("IMAGE-BODY-51");
    expect(all).toContain("unknown");
    expect(all).not.toContain("expression");
    expect(all).not.toContain("mediaNotes");
  });
  /**
   * QQ 长期语义「摘要只压正文」（body-only）：模型输入的用户消息里不该有当前问题；
   * 包是中性可复用历史事件段，与本次提问无关；网页共享问题引导契约不在本文件。
   */
  it("QQ compression is body-only: the model user message carries no current question", async () => {
    const h = setup({ watermarkTrigger: 1 });
    for (let index = 0; index < 5; index += 1) h.seed(`old body ${index}`, 30000 + index);
    h.seed("今天群里讨论了什么问题？");
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("fixture: compression job missing");
    await job.run(readInput().signal);
    // 先证包正产出：事实为正、模型确实被调用过。
    const stored = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!stored) throw new Error("fixture: body-only case produced no package");
    const packages = JSON.parse(stored.content) as { packages: { facts: unknown[] }[] };
    expect(packages.packages.length).toBeGreaterThan(0);
    expect(packages.packages.at(-1)?.facts.length).toBeGreaterThan(0);
    // 意图契约：QQ body-only → 用户消息不得携带 question 字段（字段缺席，不是空串）。
    expect(h.capturedQuestions).toHaveLength(1);
    expect(h.capturedQuestions[0]).toBe(false);
  });

  /**
   * 来源上限（消费者 LINKS=100）：仅本批记录自身的不同来源自然并集就超过 100 时，
   * 发布的整包 sources 仍必须 <= 100 且出处完整。不丢引用、不靠测试专用拟合，
   * 也不改水位/包上限。
   */
  it("splits a natural >100 full tail into multiple packages: every package <=100 refs and the union keeps all 101 observation refs", async () => {
    const h = setup({ watermarkTrigger: 101, singleFactCompression: true });
    const keys = Array.from({ length: 101 }, (_, index) =>
      h.seed(`old source ${index}`, 30000 + index),
    );
    h.seed("current window question");
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("fixture: compression job missing");
    await job.run(readInput().signal);
    const stored = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!stored) throw new Error("fixture: finite-partition case produced no package");
    const packages = JSON.parse(stored.content) as {
      packages: {
        facts: { source_ids: string[] }[];
        sources: SourceRef[];
        provenance?: Record<string, string>;
      }[];
    };
    // 同一 job 内产出多个包：整段 101 条各带自身来源，自然并集 >100。
    expect(packages.packages.length).toBeGreaterThan(1);
    for (const pkg of packages.packages) {
      expect(pkg.sources.length).toBeLessThanOrEqual(100);
      expect(pkg.facts.length).toBeGreaterThan(0);
      const referenced = [...new Set(pkg.facts.flatMap((fact) => fact.source_ids))];
      for (const id of referenced) expect(pkg.provenance?.[id]).toBeDefined();
    }
    // 分区覆盖：每个 observation 引用恰好被一个包带上（不丢、不重）。
    const counts = new Map<string, number>();
    for (const pkg of packages.packages)
      for (const ref of pkg.sources)
        if (ref.kind === "qq_observation") counts.set(ref.id, (counts.get(ref.id) ?? 0) + 1);
    for (const key of keys) expect(counts.get(key)).toBe(1);
  });

  /**
   * 原子性（失败不落盘）：多包任务在中途失败时，不写任何行、水位不动。
   * 第二段模型结果无效 → 整个 job 失败；既有行与两个水位保持原样。
   */
  it("keeps the row and watermarks untouched when a mid-chunk summary fails", async () => {
    const h = setup({ watermarkTrigger: 101, singleFactCompression: true });
    for (let index = 0; index < 101; index += 1) h.seed(`old part ${index}`, 30000 + index);
    h.seed("current window question");
    let calls = 0;
    h.gateway.complete = async (request) => {
      const wire = request.messages?.[1]?.content;
      if (typeof wire !== "string") throw new Error("fixture: summary wire missing");
      const data = JSON.parse(wire) as { events: { id: string; speaker: string }[] };
      calls += 1;
      if (calls === 1)
        return JSON.stringify({
          facts: [
            {
              kind: "fact",
              speaker: data.events[0]!.speaker,
              text: "f",
              source_ids: [data.events[0]!.id],
            },
          ],
        });
      throw new Error("synthetic mid-chunk failure");
    };
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("fixture: compression job missing");
    await expect(job.run(readInput().signal)).rejects.toThrow("synthetic mid-chunk failure");
    expect(calls).toBeGreaterThan(1);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });

  /**
   * 调用前拒绝：分包数超过原总预算时，先拒（typed），一个模型调用都不发、不落盘。
   */
  it("refuses before any model call when the chunk count exceeds the original total target", async () => {
    const h = setup({ watermarkTrigger: 101, singleFactCompression: true });
    h.runtime.p5_config.summary_target_tokens = 1;
    for (let index = 0; index < 101; index += 1) h.seed(`old slice ${index}`, 30000 + index);
    h.seed("current window question");
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("fixture: compression job missing");
    await expect(job.run(readInput().signal)).rejects.toMatchObject({
      code: "CONTEXT_SUMMARY_BUDGET",
    });
    expect(h.capturedEvents).toHaveLength(0);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });
});
