import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../../../shared/contracts";
import type { WakeSignal } from "../../../shared/contracts/conversation";
import type { Evidence, SourceRef } from "../../../shared/contracts/evidence";
import { qqReplyTaskPrompt } from "../../../shared/contracts/qq";
import type { AgentRuntime, PreparedOutput } from "../../agent/agent-runtime";
import type { AgentSpec } from "../../agent/agent-specs";
import { createBuiltInActions } from "../../agent/built-in-actions";
import { sourceAccess } from "../../agent/context-access";
import {
  type ActionObservation,
  ContextEngine,
  type ContextMaterial,
  inputUnits,
  textMessage,
  uniqueSources,
} from "../../agent/context-engine";
import { ConversationHost } from "../../agent/conversation-host";
import { AgentRunRepository } from "../../db/agent-run-repository";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { KnowledgeReadRepository } from "../../db/knowledge-read-repository";
import type { OutboundIntentRepository } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { recordQqIdleJudgement } from "../../db/qq-dispatch-repository";
import { qqMemberLabels } from "../../db/qq-member-repository";
import {
  conversationMessagesSince,
  type QqConversationScope,
} from "../../db/qq-observation-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import {
  effectiveQqTriggers,
  readQqScheme,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
  schemeRhythm,
} from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { newestMemberMessageSeconds, ownSpeechSince } from "../../db/qq-speech-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import type { WakeRepository } from "../../db/wake-repository";
import type { ModelGateway } from "../../llm/model-gateway";
import { SqliteKnowledgeModule } from "../../modules/knowledge-module";
import { SqliteMemoryModule } from "../../modules/memory-module";
import { qqMemoryScopeKeyset } from "../../services/memory-scope";
import { captureQqTask, checkQqTask, qqConversationKey } from "../../services/qq-binding-contract";
import { checkQqModelCapacity } from "../../services/qq-capacity-preflight";
import {
  type QqContextSelection,
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "../../services/qq-context-contract";
import {
  attentionTriggerFilter,
  QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS,
} from "../../services/qq-dispatch";
import { qqJudgementQuestion } from "../../services/qq-judgement-material";
import { prepareQqJudgement } from "../../services/qq-judgement-preparation";
import {
  type QqMemoryReadSnapshot,
  qqMemoryReadIsCurrent,
  recallQqReplyMemory,
} from "../../services/qq-memory-recall";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_MEDIA_RULE,
  type QqPromptInput,
  qqJudgeAllowsSpeech,
  qqJudgeOutcome,
  qqPromptMessages,
  qqSpeakerLabel,
} from "../../services/qq-prompt-contract";
import type { QqPendingReview } from "../../services/qq-reply-runner";
import { speechExpiresAt } from "../../services/qq-retention";
import {
  checkQqSpeechSend,
  disabledKindsFromTriggers,
  type QqSpeechKind,
} from "../../services/qq-speaking-contract";
import {
  planQqPreparedReply,
  type QqStickerStage,
  selectQqSticker,
} from "../../services/qq-sticker-runner";
import { compileSystemPrompt, runtimeFromAgent } from "../../services/runtime-config";

export interface OneBotPrivatePolicy {
  maxSteps: number;
  deliveryTtlSeconds: number;
  retentionDays: number;
}
export interface OneBotPrivateHostOptions {
  orm: Orm;
  agentRuntime: AgentRuntime;
  host?: ConversationHost;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  journal: ConversationEventRepository;
  wakes: WakeRepository;
  outbox: OutboundIntentRepository;
  stickers: QqStickerStage;
  policy: () => OneBotPrivatePolicy;
  now?: () => string;
}
/** Channel-owned input/auth/effects around the same model-controlled Agent loop as Web. */
export class OneBotPrivateHost {
  private readonly host: ConversationHost;
  constructor(private readonly options: OneBotPrivateHostOptions) {
    this.host = options.host ?? new ConversationHost({ runtime: options.agentRuntime });
  }
  async activate(wake: WakeSignal, signal: AbortSignal) {
    const o = this.options;
    const db = (o.orm as Orm & { $client: Database }).$client;
    const now = () => o.now?.() ?? new Date().toISOString();
    const conversation = o.journal.get(wake.conversationId);
    if (!conversation || conversation.channel !== "onebot11" || conversation.topology !== "direct")
      throw new Error("BOT_DIRECT_CONVERSATION_REQUIRED");
    const binding = readQqBinding(o.orm, conversation.sourceId);
    if (!binding || binding.agentId !== conversation.agentId || binding.kind !== "private")
      throw new Error("BINDING_CHANGED");
    const scheme = readQqScheme(o.orm, binding.schemeId);
    const agent = getAgentRow(o.orm, binding.agentId);
    if (!scheme || !agent) throw new Error("BOT_CONFIGURATION_MISSING");
    const captured = captureQqTask(binding, "reply", readQqOwnerIdentity(o.orm));
    if (captured.kind !== "captured") throw new Error(captured.reason);
    const snapshot = captured.snapshot;
    const runtime: RuntimeConfig = {
      ...runtimeFromAgent(agent),
      knowledge_read: new KnowledgeReadRepository(db).freeze(agent.id),
    };
    const path: QqSpeechKind = wake.cause === "idle_topic" ? "idle_topic" : "direct_reply";
    const scope: QqConversationScope = {
      kind: "qq",
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    };
    if (path === "direct_reply") {
      const newest = newestMemberMessageSeconds(o.orm, scope, {
        attentionMembers: attentionTriggerFilter(binding) ?? undefined,
      });
      if (
        newest === null ||
        Math.floor(Date.parse(now()) / 1000) - newest > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS
      ) {
        db.transaction(() => {
          o.wakes.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, now());
          o.journal.acknowledge(conversation.id, wake.throughSeq);
        }).immediate();
        return { status: "expired" as const };
      }
    }
    const policy = o.policy();
    const reserve = schemeOutputReserve(scheme).reply_output_reserved;
    const capacity = await o.gateway.loadedContextCapacity(runtime.model_name, { signal });
    if (capacity === null) throw new Error("CONTEXT_CAPACITY_UNKNOWN");
    const available = capacity - reserve;
    let observedSeq = 0;
    let selection: QqContextSelection;
    let read: QqMemoryReadSnapshot | undefined;
    let material: ContextMaterial | undefined;
    let materialSources: SourceRef[] = [];
    let memoryAvailable = 0;
    let runId: string | undefined;
    let idleAllowed: boolean | undefined;
    let observations: readonly ActionObservation[] = [];
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!wake.leaseToken || !o.wakes.owns(wake.id, wake.leaseToken, now()))
        throw new Error("WAKE_LEASE_LOST");
      const current = readQqBinding(o.orm, binding.id);
      const check = checkQqTask(snapshot, current, "send", readQqOwnerIdentity(o.orm));
      if (check.kind === "blocked") throw new Error(check.reason);
      if (
        readQqScheme(o.orm, binding.schemeId)?.revision !== scheme.revision ||
        getAgentRow(o.orm, binding.agentId)?.configVersion !== agent.configVersion
      )
        throw new Error("BOT_CONFIGURATION_CHANGED");
      const settings = readQqSettings(o.orm);
      if (
        settings.accountId !== binding.accountId ||
        getAgentRow(o.orm, binding.agentId)?.isActive !== 1
      )
        throw new Error("BOT_ACCOUNT_CHANGED");
      const gate = checkQqSpeechSend({
        kind: path,
        featureEnabled: settings.enabled === 1,
        conversationPaused: current?.paused ?? true,
        disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(current!, scheme)),
      });
      if (gate.kind === "blocked") throw new Error(gate.reason);
      if (o.journal.row(conversation.id)?.closed_at) throw new Error("BINDING_EPOCH_CHANGED");
      if (read && !qqMemoryReadIsCurrent(o.orm, binding.agentId, read))
        throw new Error("CONTEXT_SOURCE_INVALID");
      for (const source of [...materialSources, ...observations.flatMap((o) => o.sources)]) {
        if (
          sourceAccess(
            db,
            source,
            {
              kind: "qq_binding",
              id: binding.id,
              userId: DEFAULT_USER_ID,
              agentId: binding.agentId,
            },
            { userId: DEFAULT_USER_ID },
            now(),
          ) !== "available"
        )
          throw new Error("CONTEXT_SOURCE_INVALID");
      }
    };
    const promptInput = (
      messages: QqContextSelection["messages"],
      nowSeconds: number,
    ): QqPromptInput => ({
      tier: "reply",
      path,
      persona: compileSystemPrompt(runtime),
      prompts: {
        ...schemePrompts(scheme),
        reply: qqReplyTaskPrompt(schemeReply(scheme).split_by_speaker),
      },
      timeline: messages,
      nowSeconds,
      labels: qqMemberLabels(
        o.orm,
        { accountId: binding.accountId, conversationKind: binding.kind, peerId: binding.peerId },
        now(),
      ),
      attentionMembers: binding.attention.members,
      ...(path === "idle_topic"
        ? {}
        : {
            replyingTo: {
              speakerId: binding.peerId,
              label: qqSpeakerLabel(
                binding.peerId,
                qqMemberLabels(
                  o.orm,
                  {
                    accountId: binding.accountId,
                    conversationKind: binding.kind,
                    peerId: binding.peerId,
                  },
                  now(),
                ),
              ),
            },
          }),
    });
    const initialSystem = qqPromptMessages(
      buildQqPrompt(promptInput([], Math.floor(Date.parse(now()) / 1000))),
    ).find((m) => m.role === "system")!.content;
    const spec: AgentSpec = {
      id: "onebot.private.main",
      version: "2",
      model: runtime.model_name,
      context: "conversation",
      instructions: [
        compileSystemPrompt(runtime),
        schemePrompts(scheme).scene,
        QQ_MEDIA_RULE,
        `这是已授权的 OneBot 私聊；可回复目标只有 ${binding.peerId}。`,
        path === "idle_topic"
          ? `现在是冷场唤醒。若想发起话题，先 invoke speech.evaluate 使用配置的判断模型和评分门槛，只有 allowed=true 才能 final。根据场景决定是否发起话题：\n${schemePrompts(scheme).judge}`
          : "对方在私聊中直接向你发言。决定需要查询资料、生成回答、直接给出文本或保持沉默。没有群聊兴趣评分门槛。",
        "一次 final 只提交一份面向当前私聊的逻辑回复；这份回复仍可按换行拆成多个传输片段。",
        `新消息到来后，重新审视尚未投递的计划。复核要求：\n${schemePrompts(scheme).review}`,
      ].join("\n\n"),
      availableActions: [],
      generation: {
        model: runtime.model_name,
        inputUnits: available,
        allowEmpty: true,
        instructions: initialSystem,
      },
      limits: { steps: policy.maxSteps, inputUnits: available },
    };
    const context = {
      read: async ({
        signal: readSignal,
        observations: currentObservations,
      }: {
        signal: AbortSignal;
        observations: readonly ActionObservation[];
      }) => {
        observations = currentObservations;
        assertCurrent();
        readSignal.throwIfAborted();
        if (material) return material;
        const nowSeconds = Math.floor(Date.parse(now()) / 1000);
        const limits = qqContextLimits(schemeContext(scheme), "reply");
        const sinceSeconds = Math.max(0, nowSeconds - limits.windowMinutes * 60 - 1);
        // Capture the upper sequence before reading; every later inbound seq is reconsidered.
        observedSeq = o.journal.get(conversation.id)!.lastSeq;
        selection = qqSelectContext({
          timeline: qqBuildTimeline({
            messages: conversationMessagesSince(o.orm, scope, {
              sinceSeconds,
              limit: limits.messageLimit,
              includeSources: true,
            }).map(({ eventKey: _key, ...m }) => m),
            ownSpeech: [
              ...ownSpeechSince(o.orm, scope, {
                sinceSeconds,
                limit: limits.messageLimit,
                includeSources: true,
              }),
              ...o.outbox.partialSpeechSince(conversation.id, {
                sinceSeconds,
                limit: limits.messageLimit,
                at: now(),
              }),
            ],
          }),
          limits,
          nowSeconds,
        });
        const input = promptInput(selection.messages, nowSeconds);
        const base = qqPromptMessages(buildQqPrompt(input));
        const system = base.find((m) => m.role === "system")!.content;
        Object.assign(spec.generation!, { instructions: system });
        const pending = base
          .filter((m) => m.role === "user")
          .map((m) => textMessage("user", m.content));
        const sources = selection.messages.flatMap((m) => m.sources ?? []);
        const engine = new ContextEngine();
        const fixed = engine.render(spec, { pending, sources }, [], [binding.peerId]);
        const outputFixed = inputUnits(
          engine.renderOutput(spec, fixed, {
            kind: "generate",
            targetId: binding.peerId,
            instructions: "",
          }),
        );
        memoryAvailable = Math.max(0, available - Math.max(fixed.units, outputFixed));
        const memory = await recallQqReplyMemory(o.orm, o.gateway, {
          runtime,
          snapshot,
          question: qqJudgementQuestion(selection.messages.map((m) => m.text)),
          available: memoryAvailable,
          agentRuntime: o.agentRuntime,
          sources,
          signal: readSignal,
        });
        read = memory.read;
        const messages = qqPromptMessages(buildQqPrompt({ ...input, material: memory.material }));
        materialSources = [...sources, ...(memory.sources ?? [])];
        material = {
          pending: messages
            .filter((m) => m.role === "user")
            .map((m) => textMessage("user", m.content)),
          sources: materialSources,
        };
        if (runId) o.journal.linkRun(runId, conversation.id, observedSeq, wake.id);
        assertCurrent();
        return material;
      },
    };
    const actionOwner = {
      kind: "qq_binding",
      id: binding.id,
      userId: DEFAULT_USER_ID,
      agentId: binding.agentId,
    };
    const engine = new ContextEngine();
    const actionRemaining = () =>
      Math.max(
        0,
        available - engine.render(spec, material ?? {}, observations, [binding.peerId]).units,
      );
    // Knowledge allocation includes every retained nonempty result's rendered envelope.
    // Empty-result protocol feedback still consumes the model budget, but carries no knowledge.
    const knowledgeCost = (items: readonly ActionObservation[]) =>
      engine.render(spec, {}, items, []).units - engine.render(spec, {}, [], []).units;
    const knowledgeRemaining = () =>
      Math.max(
        0,
        (runtime.knowledge_read?.budget ?? 0) -
          knowledgeCost(
            observations.filter(
              (observation) =>
                observation.name === "knowledge.query" &&
                Array.isArray(observation.value) &&
                observation.value.length > 0,
            ),
          ),
      );
    const fitEvidence = (name: string, found: readonly Evidence[]) => {
      if (
        name === "memory.query" &&
        ["full_catalog", "full_body"].includes(runtime.p5_config.retrieval_mode)
      ) {
        const obs = {
          id: "00000000-0000-0000-0000-000000000000",
          name,
          value: found,
          sources: found.flatMap((e) => e.sources),
        };
        if (
          engine.render(spec, material ?? {}, [...observations, obs], [binding.peerId]).units >
          available
        )
          throw new Error("CONTEXT_BUDGET_EXCEEDED");
        return [...found];
      }
      const groups = new Map<string, Evidence[]>();
      for (const item of found) {
        const key =
          name === "knowledge.query"
            ? (item.sources.find((s) => s.kind === "knowledge_document")?.id ?? item.id)
            : item.id;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      let kept: Evidence[] = [];
      for (const group of groups.values()) {
        const candidate = [...kept, ...group];
        const obs = {
          id: "00000000-0000-0000-0000-000000000000",
          name,
          value: candidate,
          sources: candidate.flatMap((e) => e.sources),
        };
        if (
          engine.render(spec, material ?? {}, [...observations, obs], [binding.peerId]).units <=
            available &&
          (name !== "knowledge.query" || knowledgeCost([obs]) <= knowledgeRemaining())
        )
          kept = candidate;
      }
      return kept;
    };
    const memoryModule = new SqliteMemoryModule({
      orm: o.orm,
      gateway: o.gateway,
      agentRuntime: o.agentRuntime,
      runtime: () => runtime,
      assertCurrent,
    });
    const knowledgeModule = new SqliteKnowledgeModule({
      db,
      gateway: o.gateway,
      agentRuntime: o.agentRuntime,
      runtime: () => runtime,
    });
    const actions = createBuiltInActions({
      memory: {
        query: async (input, action) => {
          assertCurrent();
          const evidence = await memoryModule.query({
            agentId: binding.agentId,
            mode: runtime.p5_config.retrieval_mode,
            scopes: qqMemoryScopeKeyset(snapshot.access).read,
            query: input.query,
            budget: actionRemaining(),
            owner: actionOwner,
            sources: materialSources,
            signal: action.signal,
          });
          assertCurrent();
          return fitEvidence("memory.query", evidence);
        },
      },
      ...(runtime.knowledge_read?.config.enabled
        ? {
            knowledge: {
              query: async (input: { query: string }, action: { signal: AbortSignal }) => {
                assertCurrent();
                const evidence = await knowledgeModule.query({
                  agentId: binding.agentId,
                  query: input.query,
                  budget: Math.min(actionRemaining(), knowledgeRemaining()),
                  owner: actionOwner,
                  sources: materialSources,
                  signal: action.signal,
                });
                assertCurrent();
                return fitEvidence("knowledge.query", evidence);
              },
            },
          }
        : {}),
    });
    if (path === "idle_topic")
      actions.push({
        description: {
          name: "speech.evaluate",
          description: "Evaluate the configured initiative score and current idle eligibility",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          capability: "speech.evaluate",
        },
        async execute(_args, action) {
          assertCurrent();
          const sources: SourceRef[] = [];
          const prepared = prepareQqJudgement(
            o.orm,
            { bindingId: binding.id, path, nowSeconds: Math.floor(Date.parse(now()) / 1000) },
            { onSources: (refs) => sources.push(...refs) },
          );
          if (prepared.kind !== "prepared") {
            idleAllowed = false;
            return { value: { allowed: false, reason: prepared.reason }, sources: [] };
          }
          const verdicts = [];
          for (const prompt of prepared.judgementPrompts) {
            const messages = [...prompt.messages];
            const capacity = await checkQqModelCapacity(o.gateway, {
              model: prepared.modelName,
              messages,
              outputReserved: schemeOutputReserve(scheme).judgement_output_reserved,
            });
            if (capacity.kind !== "allowed") throw new Error(`JUDGEMENT_CAPACITY_${capacity.kind}`);
            const raw = await o.agentRuntime.completeLeaf(
              {
                id: "onebot.initiative.evaluate",
                model: prepared.modelName,
                responseSchema: QQ_JUDGEMENT_RESPONSE_SCHEMA,
              },
              {
                messages,
                signal: action.signal,
                owner: {
                  kind: "qq_binding",
                  id: binding.id,
                  agentId: binding.agentId,
                  userId: DEFAULT_USER_ID,
                },
                sources,
                validate: (raw) => {
                  const parsed = qqJudgeOutcome(raw);
                  if (parsed.kind === "unreadable") throw new Error("JUDGEMENT_UNREADABLE");
                  return parsed;
                },
              },
            );
            verdicts.push(qqJudgeOutcome(raw));
          }
          assertCurrent();
          idleAllowed = verdicts.some((v) =>
            qqJudgeAllowsSpeech(v, schemeRhythm(scheme).initiative_min_score),
          );
          return {
            value: {
              allowed: idleAllowed,
              threshold: schemeRhythm(scheme).initiative_min_score,
              verdicts,
            },
            sources,
          };
        },
      });
    spec.availableActions = actions.map((a) => a.description);
    const reconsider = async () => {
      assertCurrent();
      const latest = o.journal.get(conversation.id)!.lastSeq;
      if (latest <= observedSeq) return false;
      const updates = o.journal.eventsAfter(
        conversation.id,
        observedSeq,
        Number.MAX_SAFE_INTEGER,
      ).items;
      const relevant = updates.some(
        (e) =>
          (e.kind === "inbound" || e.kind === "media_revision") &&
          (!attentionTriggerFilter(binding) ||
            (e.participant?.id && attentionTriggerFilter(binding)!.includes(e.participant.id))),
      );
      if (relevant) {
        material = undefined;
        read = undefined;
        idleAllowed = undefined;
        materialSources = [];
        return true;
      }
      observedSeq = latest;
      return false;
    };
    const staged = new Map<string, QqPendingReview>();
    return this.host.activate({
      conversation,
      spec,
      owner: {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: binding.agentId,
      },
      context,
      authorizedTargets: [binding.peerId],
      actions,
      outputMode: "buffered",
      signal,
      onEvent(event) {
        if (event.type === "started") {
          runId = event.runId;
          o.journal.linkRun(runId, conversation.id, observedSeq, wake.id);
        }
      },
      prepareOutput: async (draft, ordinal) =>
        ordinal > 0
          ? { blocked: true, code: "ONE_OUTPUT_PER_CONVERSATION" }
          : draft.kind === "inline" && draft.stickerIds.length > 1
            ? { blocked: true, code: "STICKER_COUNT_EXCEEDED" }
            : path === "idle_topic" && idleAllowed !== true
              ? { blocked: true, code: "INITIATIVE_NOT_ELIGIBLE" }
              : { outputId: crypto.randomUUID() },
      beforeFinal: reconsider,
      reconsider: async (outputs) => {
        if (await reconsider()) return true;
        // Leaf selection happens before the commit transaction and sees the generated draft.
        for (const output of outputs) {
          if (output.status !== "prepared") continue;
          const raw = output.text ?? "";
          const text = schemeReply(scheme).split_by_speaker
            ? raw.replace(/\s*\r?\n+\s*/g, " ").trim()
            : raw;
          const pick =
            output.stickerIds !== undefined
              ? { kind: "chosen" as const, stickerId: output.stickerIds[0] ?? null }
              : await selectQqSticker(
                  o.orm,
                  o.gateway,
                  {
                    bindingId: binding.id,
                    schemeId: scheme.id,
                    schemeRevision: scheme.revision,
                    agentId: agent.id,
                    agentConfigVersion: agent.configVersion,
                    path,
                    text: text || null,
                    messages: selection.messages,
                    nowSeconds: Math.floor(Date.parse(now()) / 1000),
                  },
                  o.stickers,
                  {
                    agentRuntime: o.agentRuntime,
                    signal,
                    sources: uniqueSources([
                      ...materialSources,
                      ...observations.flatMap((obs) => obs.sources),
                    ]),
                  },
                );
          if (pick.kind === "blocked") throw new Error(pick.reason);
          staged.set(output.outputId, {
            text: text || null,
            snapshot,
            schemeRevision: scheme.revision,
            agentConfigVersion: agent.configVersion,
            path,
            nowSeconds: Math.floor(Date.parse(now()) / 1000),
            memberEventCount: 0,
            recomputesUsed: 0,
            selection,
            stickerId: pick.kind === "chosen" ? pick.stickerId : null,
            targetSpeakerId: path === "idle_topic" ? null : binding.peerId,
            memoryRead: read,
          });
        }
        if (await reconsider()) return true;
        for (const output of outputs) {
          if (output.status !== "prepared") continue;
          const draft = staged.get(output.outputId)!;
          if (planQqPreparedReply(o.orm, draft, o.stickers).kind !== "planned") {
            output.status = "blocked";
            output.code = "EMPTY_OUTPUT";
          }
        }
        if (outputs.some((output) => output.status === "prepared" || output.status === "failed"))
          return false;
        return outputs.some((output) => output.code === "EMPTY_OUTPUT") ? "no_output" : false;
      },
      commitOutputs: async (outputs: readonly PreparedOutput[], currentRunId, terminal) =>
        db
          .transaction(() => {
            assertCurrent();
            const updates = o.journal.eventsAfter(
              conversation.id,
              observedSeq,
              Number.MAX_SAFE_INTEGER,
            ).items;
            if (updates.some((e) => e.kind === "inbound" || e.kind === "media_revision"))
              throw new Error("CONVERSATION_CHANGED_AT_COMMIT");
            for (const [ordinal, output] of outputs.entries()) {
              if (output.status !== "prepared") continue;
              const draft = staged.get(output.outputId);
              if (!draft) throw new Error("OUTPUT_PREPARATION_MISSING");
              const plan = planQqPreparedReply(o.orm, draft, o.stickers);
              if (plan.kind !== "planned") throw new Error("OUTPUT_CHANGED_AT_COMMIT");
              const intent = o.outbox.commit({
                id: output.outputId,
                runId: currentRunId,
                conversationId: conversation.id,
                ordinal,
                target: {
                  accountId: binding.accountId,
                  conversationKind: "private",
                  peerId: binding.peerId,
                  agentId: binding.agentId,
                  bindingId: binding.id,
                  bindingEpoch: conversation.bindingEpoch,
                  bindingRevision: binding.revision,
                  authorityRevision: binding.authorityRevision,
                  ownerIdentityRevision: readQqOwnerIdentity(o.orm)?.revision ?? null,
                  schemeId: scheme.id,
                  schemeRevision: scheme.revision,
                  agentConfigVersion: agent.configVersion,
                  sources: uniqueSources([
                    ...materialSources,
                    ...observations.flatMap((obs) => obs.sources),
                  ]),
                },
                speechKind: path,
                sourceThroughSeq: observedSeq,
                deliverBy: new Date(
                  Date.parse(terminal.at) + policy.deliveryTtlSeconds * 1000,
                ).toISOString(),
                createdAt: terminal.at,
                expiresAt: speechExpiresAt(
                  Math.floor(Date.parse(terminal.at) / 1000),
                  policy.retentionDays,
                ),
                parts: [...plan.parts],
              });
              o.journal.append({
                conversationId: conversation.id,
                eventKey: `output:${intent.id}`,
                kind: "delivery",
                source: {
                  kind: "outbound_intent",
                  id: intent.id,
                  revision: "planned",
                  expiresAt: speechExpiresAt(
                    Math.floor(Date.parse(terminal.at) / 1000),
                    policy.retentionDays,
                  ),
                },
                occurredAt: terminal.at,
                runId: currentRunId,
                outputId: intent.id,
              });
            }
            if (path === "idle_topic") {
              const newest = newestMemberMessageSeconds(o.orm, scope, {
                attentionMembers: attentionTriggerFilter(binding) ?? undefined,
              });
              if (newest !== null)
                recordQqIdleJudgement(o.orm, {
                  conversationKey: qqConversationKey({
                    accountId: binding.accountId,
                    kind: binding.kind,
                    peerId: binding.peerId,
                  }),
                  basisSeconds: newest,
                  nowSeconds: Math.floor(Date.parse(terminal.at) / 1000),
                });
            }
            o.journal.acknowledge(conversation.id, observedSeq);
            o.wakes.complete(wake.id, wake.leaseToken!, terminal.status, observedSeq, now());
            o.journal.linkRun(currentRunId, conversation.id, observedSeq, wake.id);
            return new AgentRunRepository(db).finishRun(
              currentRunId,
              terminal.status,
              terminal.event,
              terminal.at,
            );
          })
          .immediate(),
    });
  }
}
