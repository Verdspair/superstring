import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { writeQqGroupAgentConfigRow } from "../../src/server/db/qq-binding-repository";
import {
  createQqScheme,
  schemeStickers,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqStorageSettings,
} from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import {
  createQqConversationTask,
  type QqConversationTaskSourceGuard,
} from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { PermissionService } from "../../src/server/permissions/service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { speechExpiresAt } from "../../src/server/services/qq-retention";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import {
  createWebActions,
  WEB_PERMISSION_RESOURCE,
  WEB_PERMISSION_REVISION,
} from "../../src/server/web-access/actions";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { QQ_ALLOCATION_DEFAULT } from "../../src/shared/contracts/context-allocation";
import { QQ_MODEL_OUTPUT_RESERVE_DEFAULT } from "../../src/shared/contracts/qq";
import {
  QqTaskExecutionSnapshotSchema,
  qqConversationTaskKey,
} from "../../src/shared/contracts/qq-task";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  time = 2_000_000_000;
function addSticker(h: ReturnType<typeof setup>) {
  const collection = createQqStickerCollection(h.orm, { name: "test" });
  const id = crypto.randomUUID();
  importQqSticker(h.orm, {
    id,
    copy: { fileName: `${id}.png`, byteSize: 64, mediaType: "image" },
    name: "wave",
    width: 64,
    height: 64,
    collectionIds: [collection.id],
  });
  setQqStickerEnabled(h.orm, id, true);
  updateQqScheme(h.orm, h.scheme.id, {
    name: h.scheme.name,
    stickerCollections: [collection.id],
    expectedRevision: h.scheme.revision,
  });
  return id;
}
function setup(
  model: Partial<ModelPort> = {},
  options: {
    split?: boolean;
    recomputes?: number;
    mergeSeconds?: number;
    follow?: boolean;
    stickerCollections?: readonly string[];
    stickersEnabled?: () => boolean;
    stickersAvailable?: boolean;
    researchEnabled?: () => boolean;
    mediaAdapter?: ConstructorParameters<typeof OneBotHost>[0]["mediaAdapter"];
    onCompression?: (job: unknown) => void;
    onCapacity?: () => void;
    taskSourceState?: ConstructorParameters<typeof OneBotHost>[0]["taskSourceState"];
    externalActions?: ConstructorParameters<typeof OneBotHost>[0]["externalActions"];
    resolveSource?: ConstructorParameters<typeof OneBotHost>[0]["resolveSource"];
    actionExecutor?:
      | ConstructorParameters<typeof AgentRuntime>[0]["actionExecutor"]
      | ((
          orm: ConstructorParameters<typeof OneBotHost>[0]["orm"],
        ) => NonNullable<ConstructorParameters<typeof AgentRuntime>[0]["actionExecutor"]>);
  } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    judgementModelName: "judge-model",
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "group",
    outputReserve: { ...QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    allocation: structuredClone(QQ_ALLOCATION_DEFAULT),
    reply: { split_by_speaker: options.split ?? true },
    ...(options.stickerCollections ? { stickerCollections: [...options.stickerCollections] } : {}),
    // 连续与自主互斥（保存边界拒绝双 true）：默认只开自主，需要连续交谈的用例传 follow:true。
    triggers: {
      direct_reply: true,
      follow_up: options.follow ?? false,
      chiming_in: !(options.follow ?? false),
      idle_topic: true,
    },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      // 本文件不是批次门槛的验证面：把批量下界设为 1（X1/Y0，合法可配置，queue ON 保持），
      // 让 1 条合格成员事件即可进入既有 host 行为。真实批次门槛（X15/Y5）由 D1 专测。
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: options.mergeSeconds ?? 2,
      max_recompute_count: options.recomputes ?? 1,
      judgement_interval_turns: 1,
    },
  });
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(time * 1000).toISOString(),
      new Date(time * 1000).toISOString(),
    );
  const clock = { seconds: time };
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    researchEnabled: options.researchEnabled,
    now,
    model: {
      complete: async (req) => {
        requests.push(req);
        return '{"kind":"none"}';
      },
      async *streamText(req) {
        requests.push(req);
        yield "reply\nfor target";
      },
      completeMultimodal: async () => "",
      ...model,
    },
    ...(options.actionExecutor
      ? {
          actionExecutor:
            typeof options.actionExecutor === "function"
              ? options.actionExecutor(h.orm)
              : options.actionExecutor,
        }
      : {}),
  });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => {
      options.onCapacity?.();
      return 65536;
    },
  };
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const host = new OneBotHost({
    orm: h.orm,
    journal,
    wakes,
    outbox,
    agentRuntime: runtime,
    gateway,
    stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
    stickersEnabled: options.stickersEnabled,
    ...(options.mediaAdapter ? { mediaAdapter: options.mediaAdapter } : {}),
    policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
    now,
    ...(options.taskSourceState ? { taskSourceState: options.taskSourceState } : {}),
    ...(options.onCompression ? { enqueueCompression: options.onCompression } : {}),
    ...(options.externalActions ? { externalActions: options.externalActions } : {}),
    ...(options.resolveSource ? { resolveSource: options.resolveSource } : {}),
  });
  const receive = (
    id: string,
    speaker = "20002",
    addressed = false,
    text = "hello",
    reply?: string,
  ) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: Number(speaker),
          group_id: 30003,
          message_id: id,
          message: [
            ...(reply ? [{ type: "reply", data: { id: reply } }] : []),
            ...(addressed ? [{ type: "at", data: { qq: "10001" } }] : []),
            { type: "text", data: { text } },
          ],
          sender: { nickname: speaker },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  const activate = async (cause?: string) => {
    const wake = wakes.claim({ at: now(), leaseMs: 120000, cause })!;
    expect(wake).not.toBeNull();
    return host.activate(wake, new AbortController().signal);
  };
  return {
    ...h,
    journal,
    wakes,
    outbox,
    runs,
    requests,
    runtime,
    adapter,
    host,
    clock,
    now,
    receive,
    activate,
    scheme,
  };
}
const authorizedTargetIds = (request: ModelRequest): string[] => {
  const matches = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter(
      (part): part is Extract<ModelMessage["content"][number], { kind: "text" }> =>
        part.kind === "text",
    )
    .flatMap((part) => [...part.text.matchAll(/"authorizedTargets"\s*:\s*(\[[^\]]*\])/g)]);
  const targets = matches.at(-1)?.[1];
  if (!targets) throw new Error("request has no authorizedTargets fixture envelope");
  return JSON.parse(targets) as string[];
};
const generate = (ids: string[]) =>
  JSON.stringify({
    kind: "invoke",
    calls: [
      {
        name: "reply.text",
        arguments: {
          outputs: ids.map((targetId) => ({ kind: "generate", targetId, instructions: "respond" })),
        },
      },
    ],
  });
const generateForRequest = (request: ModelRequest) => generate(authorizedTargetIds(request));
const replyText = (outputs: { targetId: string; text: string; mentionIds?: readonly string[] }[]) =>
  JSON.stringify({
    kind: "invoke",
    calls: [
      {
        name: "reply.text",
        arguments: {
          outputs: outputs.map(({ targetId, text, mentionIds }) => ({
            targetId,
            kind: "inline",
            text,
            ...(mentionIds ? { mentionIds } : {}),
          })),
        },
      },
    ],
  });
const replyTextForRequest = (request: ModelRequest, textForTarget: (targetId: string) => string) =>
  replyText(
    authorizedTargetIds(request).map((targetId) => ({ targetId, text: textForTarget(targetId) })),
  );
const stickerFrequencyGuides = {
  low: "表情发送倾向（low）：以文字为主，也要自然使用贴切的表情；情绪回应、轻松互动时主动用 sticker.search 找候选，有合适的就用 reply.sticker，不必等到表情比文字更好。没有合适的就不用，不硬凑。",
  medium:
    "表情发送倾向（medium）：自然、积极地使用表情；情绪回应、玩笑、赞同或安慰时先用 sticker.search 找候选，有合适的就用 reply.sticker，可只发表情或配文字，不必每次都选纯文字。没有合适的就不用，不硬凑。",
  high: "表情发送倾向（high）：主动且优先使用贴切的表情或图文组合；除非本轮明显不适合表情，先用 sticker.search 查看候选，有合适的就用 reply.sticker；文字与表情同样合适时优先表情或图文。没有合适的就不用，不强加。",
} as const;
const systemRequestText = (request: ModelRequest) =>
  request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
const frequencyGuideLines = (request: ModelRequest) => {
  const lines = new Set<string>(Object.values(stickerFrequencyGuides));
  return systemRequestText(request)
    .split("\n")
    .filter((line) => lines.has(line));
};
const setGroupFrequency = (h: ReturnType<typeof setup>, frequency: "low" | "medium" | "high") => {
  const row = h.db
    .query(
      "SELECT revision,scheme_overrides,disabled_capabilities FROM qq_group_agent_configs WHERE binding_id=? AND agent_id=?",
    )
    .get(bindingId, DEFAULT_AGENT_ID) as {
    revision: number;
    scheme_overrides: string;
    disabled_capabilities: string;
  } | null;
  const overrides = row ? JSON.parse(row.scheme_overrides) : {};
  overrides.stickers = { ...(overrides.stickers ?? {}), frequency };
  writeQqGroupAgentConfigRow(h.orm, {
    bindingId,
    agentId: DEFAULT_AGENT_ID,
    overrides,
    disabledCapabilities: row ? JSON.parse(row.disabled_capabilities) : [],
    expectedRevision: row?.revision ?? 0,
  });
};

/** 从批量评分请求里取出本批候选 target id（data_only 的 qq_batch_targets 块）。 */
const batchTargetIds = (request: { messages?: readonly { content?: unknown }[] }): string[] => {
  for (const message of request.messages ?? []) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts as { kind?: string; text?: string }[]) {
      if (part.kind !== "text" || typeof part.text !== "string") continue;
      try {
        const data = JSON.parse(part.text) as { kind?: string; targets?: { targetId: string }[] };
        if (data.kind === "qq_batch_targets" && data.targets)
          return data.targets.map((entry) => entry.targetId);
      } catch {}
    }
  }
  return [];
};

/** 阶段一批量评分的响应：对给定 target 集合逐人给分（D1 的批 schema）。 */
const batchScores = (ids: string[], score = 9) =>
  JSON.stringify({
    evaluations: ids.map((targetId) => ({ targetId, score, intent: "respond", sourceSeqs: [] })),
  });

/**
 * 本文件里的评分桩：批量评分请求的 responseSchema 带 `evaluations`（区别于单判的 `score`）。
 * 返回该批候选的逐人结论。
 */
const isBatchScore = (request: { responseSchema?: { properties?: Record<string, unknown> } }) =>
  request.responseSchema?.properties?.evaluations !== undefined;

/** 轮询等待条件成立（用于观察在飞 run 的中间状态）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

/**
 * 可中止等待：外部 gate 未放行时若 signal 中止，立即以中止原因 reject 并移除监听；
 * 否则崩溃用例里挂起的生成器会永久卡住整批结算（无法 allSettle）。
 */
const abortableWait = (gate: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (signal === undefined) return gate;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};
const taskSourceState: QqConversationTaskSourceGuard = (transaction, identity) => {
  const db = (
    transaction as typeof transaction & { $client: ReturnType<typeof openBusinessDb>["db"] }
  ).$client;
  const source = db
    .query("SELECT 1 AS ok FROM conversation_events WHERE conversation_id=? AND seq=?")
    .get(identity.conversationId, identity.sourceThroughSeq);
  return source ? "valid" : "revoked";
};

async function claimFrequencyTask(
  h: ReturnType<typeof setup>,
  frequency?: "low" | "medium" | "high",
) {
  const ingress = h.receive(
    String(9_000_000 + Math.floor(h.clock.seconds % 100_000)),
    "20002",
    true,
    "task frequency",
  );
  if (ingress.kind !== "recorded")
    throw new Error(`frequency ingress failed: ${JSON.stringify(ingress)}`);
  const conversation = h.journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("missing conversation");
  const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" });
  if (!wake?.leaseToken) throw new Error("missing leased direct_reply wake");
  const binding = h.db
    .query("SELECT revision,authority_revision FROM qq_bindings WHERE id=?")
    .get(bindingId) as {
    revision: number;
    authority_revision: number;
  };
  const scheme = h.db.query("SELECT revision FROM qq_schemes WHERE id=?").get(h.scheme.id) as {
    revision: number;
  };
  const agent = h.db
    .query("SELECT config_version FROM agents WHERE id=?")
    .get(DEFAULT_AGENT_ID) as { config_version: number };
  const created = createQqConversationTask(
    h.orm,
    {
      taskKey: qqConversationTaskKey.ordinary({
        conversationId: conversation.id,
        bindingEpoch: conversation.bindingEpoch,
        agentId: DEFAULT_AGENT_ID,
        wakeId: wake.id,
      }),
      conversationId: conversation.id,
      bindingEpoch: conversation.bindingEpoch,
      agentId: DEFAULT_AGENT_ID,
      taskClass: "ordinary",
      cause: "direct_reply",
      sourceFromSeq: h.wakes.getSourceFromSeq(wake.id) ?? wake.throughSeq,
      sourceThroughSeq: wake.throughSeq,
      originWakeId: wake.id,
      wakeLeaseToken: wake.leaseToken,
      at: h.now(),
    },
    { validateSource: taskSourceState },
  );
  const snapshot = QqTaskExecutionSnapshotSchema.parse({
    accountId: "10001",
    conversationId: conversation.id,
    bindingId,
    bindingEpoch: conversation.bindingEpoch,
    agentId: DEFAULT_AGENT_ID,
    schemeId: h.scheme.id,
    bindingRevision: binding.revision,
    authorityRevision: binding.authority_revision,
    schemeRevision: scheme.revision,
    agentConfigVersion: agent.config_version,
    taskClass: "ordinary",
    cause: "direct_reply",
    ...(frequency === undefined ? {} : { stickerFrequency: frequency }),
    sourceFromSeq: created.task.sourceFromSeq,
    sourceThroughSeq: created.task.sourceThroughSeq,
    sourceExpiresAt: created.task.sourceExpiresAt,
    authorizedTargets: ["20002"],
    targetParticipants: [{ targetId: "20002", speakerId: "20002" }],
    maxSteps: 20,
    deliveryTtlSeconds: 600,
    mentionTaskLimit: 4,
    ordinaryTaskLimit: 1,
    taskKey: created.task.taskKey,
  });
  const leaseToken = "frequency-test-lease";
  const leaseExpiresAt = new Date(Date.parse(h.now()) + 120000).toISOString();
  h.db
    .query(
      "UPDATE qq_conversation_tasks SET status='running',lease_token=?,lease_expires_at=?,execution_snapshot=?,claimed_at=?,updated_at=? WHERE id=?",
    )
    .run(leaseToken, leaseExpiresAt, JSON.stringify(snapshot), h.now(), h.now(), created.task.id);
  const task = {
    ...created.task,
    status: "running" as const,
    leaseToken,
    leaseExpiresAt,
    executionSnapshot: JSON.stringify(snapshot),
    claimedAt: h.now(),
  };
  return { task, snapshot, leaseToken };
}

describe("shared Bot model-controlled conversation", () => {
  it("captures the sticker switch per reply and preserves the text path while paused", async () => {
    let enabled = true;
    let offered: string[][] = [];
    const f = setup(
      {
        complete: async (request) => {
          offered.push(request.tools?.map((tool) => tool.name) ?? []);
          enabled = false;
          return generate(["20002"]);
        },
      },
      { stickersEnabled: () => enabled },
    );
    f.receive("9901", "20002", true);
    expect((await f.activate("direct_reply")).status).toBe("completed");
    expect(offered[0]).toContain("sticker.search");
    f.clock.seconds += 2;
    f.receive("9902", "20002", true);
    offered = [];
    expect((await f.activate("direct_reply")).status).toBe("completed");
    expect(offered[0]).not.toContain("sticker.search");
    expect(f.outbox.list({})).toHaveLength(2);
  });

  it("keeps a text contribution after a successful sticker search is group-disabled", async () => {
    let calls = 0;
    const h = setup({
      complete: async () => {
        calls++;
        if (calls === 1)
          return JSON.stringify({
            kind: "invoke",
            name: "sticker.search",
            arguments: { query: "wave" },
          });
        if (calls === 2) {
          const row = h.db
            .query("SELECT revision FROM qq_group_agent_configs WHERE binding_id=? AND agent_id=?")
            .get(bindingId, DEFAULT_AGENT_ID) as { revision: number } | null;
          writeQqGroupAgentConfigRow(h.orm, {
            bindingId,
            agentId: DEFAULT_AGENT_ID,
            overrides: {},
            disabledCapabilities: ["stickers"],
            expectedRevision: row?.revision ?? 0,
          });
          return JSON.stringify({
            kind: "invoke",
            calls: [
              {
                name: "reply.text",
                arguments: { outputs: [{ targetId: "20002", kind: "inline", text: "只发文字" }] },
              },
            ],
          });
        }
        throw new Error("NO_CORRECTION_OR_EXTRA_MODEL_STEP_EXPECTED");
      },
    });
    h.receive("9901", "20002", true, "回个招呼");
    expect((await h.activate("direct_reply")).status).toBe("completed");
    expect(calls).toBe(2);
    expect(h.outbox.list({})).toHaveLength(1);
    const intent = h.outbox.list({})[0]!;
    expect(h.outbox.parts(intent.id).map((part) => part.kind)).toEqual(["text"]);
    expect(
      h.db.query("SELECT status FROM outbound_parts WHERE intent_id=?").all(intent.id),
    ).toEqual([{ status: "planned" }]);
  });
  it("settles a sticker-only contribution as no_output when group stickers close after search", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "wave" },
            });
          if (calls === 2) {
            const row = h.db
              .query(
                "SELECT revision FROM qq_group_agent_configs WHERE binding_id=? AND agent_id=?",
              )
              .get(bindingId, DEFAULT_AGENT_ID) as { revision: number } | null;
            writeQqGroupAgentConfigRow(h.orm, {
              bindingId,
              agentId: DEFAULT_AGENT_ID,
              overrides: {},
              disabledCapabilities: ["stickers"],
              expectedRevision: row?.revision ?? 0,
            });
            const obs = request.messages
              .flatMap((message) => message.content)
              .flatMap((part) => {
                if (part.kind !== "text") return [];
                try {
                  const parsed = JSON.parse(part.text);
                  return parsed.kind === "action_observation" &&
                    parsed.value?.name === "sticker.search"
                    ? [parsed.value]
                    : [];
                } catch {
                  return [];
                }
              })
              .at(-1);
            const id = obs?.value?.items?.[0]?.id;
            if (!id) throw new Error("missing disclosed sticker");
            return JSON.stringify({
              kind: "invoke",
              calls: [
                {
                  name: "reply.sticker",
                  arguments: { outputs: [{ targetId: "20002", stickerId: id }] },
                },
              ],
            });
          }
          throw new Error("no extra model call expected after group sticker hard-off");
        },
      },
      { stickersAvailable: true },
    );
    const stickerId = addSticker(h);
    expect(stickerId).toBeTruthy();
    h.receive("9910", "20002", true, "只发表情");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(calls).toBe(2);
    expect(h.outbox.list({})).toEqual([]);
  });
  it("把输出预留下发为 max_tokens：direct/continuous 决策与生成都用回复预留，方案改值后新轮生效", async () => {
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (request) => {
        seen.push(request);
        return generate(["20002"]);
      },
      async *streamText(request) {
        seen.push(request);
        yield "answer";
      },
    });
    const textOf = (request: ModelRequest) =>
      request.messages
        .flatMap((message) =>
          message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
        )
        .join("\n");
    const find = (marker: string) => seen.find((request) => textOf(request).includes(marker));
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    // 群聊 direct 走**回复档**（规格 §3.3）：决策与生成/重算都按回复预留（默认 2048）下发。
    expect(find("Return exactly one JSON decision")?.maxTokens).toBe(2048);
    expect(find("Write only the response body")?.maxTokens).toBe(2048);
    seen.length = 0;
    updateQqScheme(h.orm, h.scheme.id, {
      name: h.scheme.name,
      outputReserve: { judgement_output_reserved: 640, reply_output_reserved: 896 },
      expectedRevision: h.scheme.revision,
    });
    h.clock.seconds += 2;
    h.receive("2", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    expect(find("Return exactly one JSON decision")?.maxTokens).toBe(896);
    expect(find("Write only the response body")?.maxTokens).toBe(896);
  });

  it("group direct replies on the first call via reply.text and advertises independent sticker contribution", async () => {
    let calls = 0;
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (request) => {
        calls++;
        seen.push(request);
        return JSON.stringify({
          kind: "invoke",
          calls: [
            {
              name: "reply.text",
              arguments: { outputs: [{ kind: "inline", targetId: "20002", text: "hi" }] },
            },
          ],
        });
      },
      async *streamText() {
        yield "should-not-stream";
      },
    });
    h.receive("1", "20002", true);
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    // 首 call 直接回，不前置意图/生成。
    expect(calls).toBe(1);
    // 终结能力进同一次原生工具目录（系统声明与 tools 都能看到它）。
    expect(seen[0].tools?.map((tool) => tool.name)).toContain("reply.text");
    expect(seen[0].tools?.map((tool) => tool.name)).toContain("reply.sticker");
    expect(JSON.stringify(seen[0].messages)).toContain("reply.text");
    // 首 call 就是**回复正文任务**：带 qqEffectiveReplyPrompt 的正文任务提示词（custom/sentinel）。
    expect(JSON.stringify(seen[0].messages)).toContain("写这一轮要发的话");
    // 群 direct 用回复档预留。
    expect(seen[0].maxTokens).toBe(2048);
    expect(h.outbox.list({})[0]!.target?.participantId).toBe("20002");
  });

  it("quotes a mention-only whitespace message after earlier content without invalidating its source", async () => {
    const h = setup({
      complete: async () =>
        JSON.stringify({
          kind: "invoke",
          calls: [
            {
              name: "reply.text",
              arguments: {
                outputs: [
                  {
                    kind: "inline",
                    targetId: "20002",
                    text: "synthetic reply",
                    replyToMessageId: "-702",
                  },
                ],
              },
            },
          ],
        }),
    });
    h.receive("-701", "20002", false, "earlier content");
    h.receive("-702", "20002", true, " ");
    expect(
      h.db
        .query("SELECT 1 FROM qq_observation_text WHERE event_key=?")
        .get('["qq","10001","group","30003","-702"]'),
    ).toBeNull();
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    expect(h.outbox.list({})).toHaveLength(1);
    const intent = h.outbox.list({})[0];
    if (!intent) throw new Error("Expected a committed reply intent");
    const part = h.outbox.parts(intent.id)[0];
    if (!part?.payload) throw new Error("Expected a committed reply part");
    expect(JSON.parse(part.payload).replyToMessageId).toBe("-702");
  });

  it("carries structured mentionIds into the committed outbox part", async () => {
    const h = setup({
      complete: async () => replyText([{ targetId: "20002", text: "ping", mentionIds: ["20002"] }]),
    });
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    const intent = h.outbox.list({})[0]!;
    const part = h.outbox.parts(intent.id)[0]!;
    // 结构化 mention 进入 outbox part 的 payload.mentions；正文 CQ 不再被解释为编码来源。
    expect(JSON.parse(part.payload!)).toEqual({ text: "ping", mentions: ["20002"] });
  });

  it("continuous with scheme split off still replies per person, one target each, no none", async () => {
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return replyTextForRequest(request, (targetId) =>
            targetId === "20002" ? "to A" : "to B",
          );
        },
        async *streamText() {
          yield "should-not-stream";
        },
      },
      { split: false, follow: true },
    );
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002", false);
    h.receive("2", "20003", false);
    h.clock.seconds += 5;
    // 连续交谈按人滚动：每个人各有一次唤醒，各自回他自己的那条。
    const first = await h.activate("follow_up");
    const second = await h.activate("follow_up");
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    // 首 call 即回复档正文任务（回复提示词与终结能力出现在首条 wire），非判断档。
    expect(JSON.stringify(seen[0].messages)).toContain("reply.text");
    expect(seen[0].maxTokens).toBe(2048);
    // 连续交谈强制按人：两位各一条，按 speaker 目标（scheme split 关了也如此）。
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });

  it("continuous (follow_up) settles a pure sticker contribution as no_output after group hard-off", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "wave" },
            });
          const row = h.db
            .query("SELECT revision FROM qq_group_agent_configs WHERE binding_id=? AND agent_id=?")
            .get(bindingId, DEFAULT_AGENT_ID) as { revision: number } | null;
          writeQqGroupAgentConfigRow(h.orm, {
            bindingId,
            agentId: DEFAULT_AGENT_ID,
            overrides: {},
            disabledCapabilities: ["stickers"],
            expectedRevision: row?.revision ?? 0,
          });
          const observation = request.messages
            .flatMap((message) => message.content)
            .flatMap((part) => {
              if (part.kind !== "text") return [];
              try {
                const parsed = JSON.parse(part.text);
                return parsed.kind === "action_observation" &&
                  parsed.value?.name === "sticker.search"
                  ? [parsed.value]
                  : [];
              } catch {
                return [];
              }
            })
            .at(-1);
          const id = observation?.value?.items?.[0]?.id;
          if (!id) throw new Error("missing disclosed sticker");
          return JSON.stringify({
            kind: "invoke",
            calls: [
              {
                name: "reply.sticker",
                arguments: { outputs: [{ targetId: "20002", stickerId: id }] },
              },
            ],
          });
        },
      },
      { follow: true, stickersAvailable: true },
    );
    const stickerId = addSticker(h);
    expect(stickerId).toBeTruthy();
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002", false, "只发表情");
    h.clock.seconds += 5;
    expect((await h.activate("follow_up")).status).toBe("no_output");
    expect(calls).toBe(2);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("continuous (follow_up) refuses a silent none instead of dropping a required reply", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async () => {
          calls++;
          return '{"kind":"none"}';
        },
      },
      { follow: true },
    );
    // 先有一次她自己的发言，随后的成员消息才归 continuous。
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002", false);
    h.clock.seconds += 5;
    // continuous 是"必回"：模型返回 none 时宿主明确拒绝，不静默当无输出。
    await expect(h.activate("follow_up")).rejects.toThrow("CONTINUOUS_REPLY_REQUIRED");
    expect(calls).toBeGreaterThan(0);
  });

  it("keeps addressed target even when another speaker is newer; unrelated later events do not block delivery", async () => {
    let h: ReturnType<typeof setup>;
    let generated = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText(req) {
        expect(req.model).toBe("reply-model");
        generated++;
        h.receive("3", "20004", false, "unrelated during output");
        yield "answer\nline";
      },
    });
    h.receive("1", "20002", true);
    h.receive("2", "20003", false);
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    expect(generated).toBe(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: "20002" });
    const sends: unknown[] = [];
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send(request) {
          sends.push(request);
          return { kind: "confirmed", messageId: "sent" };
        },
      },
    });
    await delivery.deliver(intent.id);
    // 新协议：结构化 mention 是 @ 的唯一来源；本轮没有 mentionIds，所以正文按字面文本发送
    // （不再由程序自动 @ 收件人）。收件人仍由 target.participantId 决定投递去向。
    expect(sends).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [{ type: "text", data: { text: "answer line" } }],
      },
    ]);
  });
  it("ordinary group activity keeps participant opportunities and one Agent run evaluates and replies to the mature batch", async () => {
    let decisions = 0;
    const scoreModels: string[] = [];
    const generated: string[] = [];
    const h = setup({
      complete: async (req) => {
        // 阶段一批量评分：一次调用对整批候选逐人给分（D1 的 QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA）。
        const schema = req.responseSchema as { properties?: Record<string, unknown> } | undefined;
        if (schema?.properties?.evaluations) {
          scoreModels.push(req.model!);
          return JSON.stringify({
            evaluations: [
              { targetId: "20002", score: 9, intent: "a", sourceSeqs: [] },
              { targetId: "20003", score: 9, intent: "b", sourceSeqs: [] },
            ],
          });
        }
        decisions++;
        return generateForRequest(req);
      },
      async *streamText(req) {
        generated.push(JSON.stringify(req.messages[0]));
        yield "separate\nmessage";
      },
    });
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20003");
    // 自主批次是**一个**会话级合并机会（D1 批次边界），不是每人一个 wake。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    h.clock.seconds += 2;
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("completed");
    // 整批**一次**评分调用（而非逐人两次）。
    expect(scoreModels).toEqual(["judge-model"]);
    expect(generated).toHaveLength(2);
    expect(generated[0]).toContain("20002");
    expect(generated[1]).toContain("20003");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
    expect(h.outbox.list({}).map((d) => h.outbox.parts(d.id).length)).toEqual([1, 1]);
  });
  it("keeps shared replies unsplit with no forced recipient when the scheme switch is off", async () => {
    const h = setup(
      {
        complete: async (request) => generateForRequest(request),
        async *streamText() {
          yield "first\nsecond";
        },
      },
      { split: false },
    );
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    expect(h.outbox.list({})).toHaveLength(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.outbox.parts(intent.id)).toHaveLength(2);
  });
  it("verified reply to an assistant receipt is addressed without fabricating a mention", () => {
    const h = setup();
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1", "20002", false, "reply", "100");
    const c = h.journal.ensureOneBot(bindingId)!;
    const message = h.journal.eventsAfter(c.id).items.find((e) => e.kind === "inbound")!;
    expect(message.addressing.reasons).toEqual(["reply_to_agent"]);
    expect(message.addressing.mentionIds).toEqual([]);
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("direct_reply");
  });
  it("a new unaddressed partner message after own speech becomes follow_up", async () => {
    const h = setup({ complete: async () => generate(["20002"]) }, { follow: true });
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1");
    // 连续交谈现按人滚动：merge 窗口过后才成熟，等过一个窗口再取。
    h.clock.seconds += 5;
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("follow_up");
    expect((await h.activate("follow_up")).status).toBe("completed");
  });
  for (const count of [0, 2])
    it(`bounds independent generation calls with configured recompute budget ${count}`, async () => {
      let h: ReturnType<typeof setup>;
      let generations = 0;
      h = setup(
        {
          complete: async (request) =>
            JSON.stringify(request.messages).includes("generation_budget_exhausted")
              ? '{"kind":"none"}'
              : generate(["20002"]),
          async *streamText() {
            generations++;
            if (generations <= 2) h.receive(String(generations + 1), "20002", true);
            yield "draft";
          },
        },
        { recomputes: count },
      );
      h.receive("1", "20002", true);
      if (count === 0) {
        expect((await h.activate()).status).toBe("no_output");
        expect(generations).toBe(1);
        expect(h.outbox.list({})).toEqual([]);
        expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBeGreaterThan(0);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(generations).toBe(3);
        expect(h.outbox.list({})).toHaveLength(1);
      }
    });
  it("migrates a pending legacy candidate once without changing its ready time", () => {
    const h = setup();
    h.receive("1");
    const event = h.db.query("SELECT event_key FROM qq_events WHERE message_id='1'").get() as {
      event_key: string;
    };
    h.db.exec("DELETE FROM wake_signals");
    h.db
      .query(
        "INSERT INTO qq_dispatch_candidates(conversation_key,binding_id,event_key,path,ready_at_seconds,observed_at_seconds,generation) VALUES('legacy',?,?,'chiming_in',?,?,4)",
      )
      .run(bindingId, event.event_key, time + 10, time);
    expect(h.adapter.migrateLegacyCandidates()).toBe(1);
    expect(h.adapter.migrateLegacyCandidates()).toBe(0);
    expect(h.db.query("SELECT ready_at,through_seq FROM wake_signals").get()).toMatchObject({
      ready_at: new Date((time + 10) * 1000).toISOString(),
      through_seq: 1,
    });
    expect(h.db.query("SELECT * FROM qq_dispatch_candidates").all()).toEqual([]);
  });
});
describe("shared configuration and races", () => {
  for (const mode of ["hard", "soft"])
    it(`preserves ${mode} attention semantics on the actual new ingress`, async () => {
      const h = setup({ complete: async () => generate(["20003"]) });
      h.db
        .query("UPDATE qq_bindings SET attention_mode=?,attention_members='[\"20002\"]' WHERE id=?")
        .run(mode, bindingId);
      h.receive("1", "20003", true);
      if (mode === "hard") {
        expect(h.wakes.peek({ at: h.now() })).toBeNull();
        expect(
          h.journal
            .eventsAfter(h.journal.ensureOneBot(bindingId)!.id)
            .items.filter((e) => e.kind === "inbound"),
        ).toHaveLength(1);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(h.outbox.list({})[0]!.target?.participantId).toBe("20003");
      }
    });
  it("continues another recipient after one generation fails and preserves both output statuses", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generateForRequest(req),
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes('authorizedTarget\\":\\"20002'))
          throw new Error("MODEL_FAILED");
        yield "second recipient survives";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    expect("outputs" in result ? result.outputs.map((o) => o.status) : []).toEqual([
      "failed",
      "prepared",
    ]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
  });
  it("commits a fast target's outbox while a slow sibling is still generating, parent not terminal", async () => {
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generateForRequest(req),
      async *streamText(req) {
        // 慢目标挂起等待外部放行；快目标立刻产出正文，验证早提交不等整批。
        if (JSON.stringify(req.messages[0]).includes("20002")) {
          yield "fast recipient";
          return;
        }
        await abortableWait(slowGate, req.signal);
        yield "slow recipient";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const pending = h.activate();
    try {
      // 快目标生成完成即写自己的 outbox 行——此时慢目标仍在生成、父 run 仍非终态。
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
      const parentRuns = h.db
        .query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'")
        .all() as { status: string }[];
      expect(parentRuns).toHaveLength(1);
      expect(["completed", "failed", "cancelled"]).not.toContain(parentRuns[0]!.status);
    } finally {
      releaseSlow();
    }
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("forks a per-target session source so children keep their own intent and run id", async () => {
    const generationPrompts: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req))
          return JSON.stringify({
            evaluations: batchTargetIds(req).map((targetId) => ({
              targetId,
              score: 9,
              intent: targetId === "20002" ? "announce-alpha" : "announce-beta",
              sourceSeqs: [],
            })),
          });
        return generateForRequest(req);
      },
      async *streamText(req) {
        generationPrompts.push(JSON.stringify(req.messages));
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    expect(generationPrompts).toHaveLength(2);
    const forAlpha = generationPrompts.find((prompt) => prompt.includes("announce-alpha"))!;
    const forBeta = generationPrompts.find((prompt) => prompt.includes("announce-beta"))!;
    expect(forAlpha).toBeDefined();
    expect(forBeta).toBeDefined();
    // 每个子 run 只带本人的 intent（独立 source）：alpha 材料里没有 beta 的意图，反之亦然。
    expect(forAlpha).not.toContain("announce-beta");
    expect(forBeta).not.toContain("announce-alpha");
    // 两个子 run 各有独立 run row（bindRun 的 runId 不互相覆写）。
    const replyRuns = h.db
      .query("SELECT run_id FROM agent_runs WHERE spec_id='onebot.main'")
      .all() as { run_id: string }[];
    expect(replyRuns).toHaveLength(2);
    expect(new Set(replyRuns.map((run) => run.run_id)).size).toBe(2);
  });
  it("prepares the reply view once so forked children do not re-compress the watermark", async () => {
    let capacityProbes = 0;
    const h = setup(
      {
        complete: async (req) =>
          isBatchScore(req) ? batchScores(batchTargetIds(req)) : generateForRequest(req),
        async *streamText() {
          yield "ok";
        },
      },
      { onCapacity: () => (capacityProbes += 1) },
    );
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    // 父先建 reply 档视图一次：容量探针恰 2 次＝判断档（1）＋父的 reply 档（1）；
    // 两个子 run 复制该视图与容量缓存，不各自重建（否则两 child 各建一次＝3，已实测）。
    expect(capacityProbes).toBe(2);
  });
  it("resumes a fully committed opportunity without re-judging or replaying (0 model calls)", async () => {
    let judgeCalls = 0;
    const generations: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText(req) {
        generations.push(JSON.stringify(req.messages));
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const first = await h.host.activate(wake, new AbortController().signal);
    expect(first.status).toBe("completed");
    expect(judgeCalls).toBe(1);
    expect(generations).toHaveLength(2);
    // 崩溃恢复：committed 已落（outbox 行），但 wake 未结算——重新租约同一行再跑一次
    //（模拟进程中断后重取同一冻结机会）。
    const crashToken = "lease-crash-resume";
    h.db
      .query(
        "UPDATE wake_signals SET status='leased', lease_token=?, lease_expires_at=?, attempts=attempts+1 WHERE id=?",
      )
      .run(crashToken, new Date((h.clock.seconds + 600) * 1000).toISOString(), wake.id);
    const resumed = await h.host.activate(
      { ...wake, leaseToken: crashToken, status: "leased" },
      new AbortController().signal,
    );
    expect(resumed.status).toBe("no_output");
    expect(judgeCalls).toBe(1); // 0 次新判断调用（全已提交，判定前查 outbox）
    expect(generations).toHaveLength(2); // 不重生成已提交目标
    expect(h.outbox.list({})).toHaveLength(2);
  });
  it("resumes a partially committed opportunity by reusing the persisted stage-1 judgement", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const generations: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText(req) {
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
        generations.push(isFast ? "20002" : "20003");
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const frozenLower = h.wakes.getSourceFromSeq(wake.id);
    const frozenThrough = wake.throughSeq;
    expect(frozenLower).toBe(h.journal.chimingInObservedSeq(h.journal.ensureOneBot(bindingId)!.id));
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    // 快目标早提交后中断（模拟崩溃）：20002 已 committed，20003 未完成。
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      const conversationId = h.journal.ensureOneBot(bindingId)!.id;
      expect(h.journal.chimingInObservedSeq(conversationId)).toBe(frozenThrough);
      const judgedAt = h.journal.chimingInJudgedAt(conversationId);
      expect(judgedAt).toBe(h.now());
      h.receive("3", "20004", false, "next batch input");
      const nextPending = h.db
        .query(
          "SELECT id,through_seq FROM wake_signals WHERE conversation_id=? AND cause='chiming_in' AND status='pending'",
        )
        .all(conversationId) as { id: string; through_seq: number }[];
      expect(nextPending).toHaveLength(1);
      expect(nextPending[0]!.id).not.toBe(wake.id);
      expect(nextPending[0]!.through_seq).toBeGreaterThan(frozenThrough);
      expect(h.wakes.get(wake.id)?.throughSeq).toBe(frozenThrough);
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 恢复走真实重启语义：租约到期后 WakeRepository.recover 把该 wake 退回 pending，再 claim
    // 同一行（不是手工 SQL 伪造租约）。判断步 raw 经 exact wake 链接持久复用，不重判；只补缺目标。
    hangSlow = false;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    expect(resumedWake.id).toBe(wake.id);
    expect(resumedWake.throughSeq).toBe(frozenThrough);
    expect(h.wakes.getSourceFromSeq(resumedWake.id)).toBe(frozenLower);
    const resumed = await h.host.activate(resumedWake, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(judgeCalls).toBe(1); // 复用持久判断：0 次新判断调用
    expect(generations.filter((target) => target === "20002")).toHaveLength(1); // 不重放已提交
    expect(generations.filter((target) => target === "20003")).toHaveLength(1); // 只补缺目标
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("re-judges instead of consuming a redacted stage-1 judgement context after recovery", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const generationPrompts: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          const intent = judgeCalls === 1 ? "stale-intent" : "fresh-intent";
          return JSON.stringify({
            evaluations: batchTargetIds(req).map((targetId) => ({
              targetId,
              score: 9,
              intent,
              sourceSeqs: [],
            })),
          });
        }
        return generateForRequest(req);
      },
      async *streamText(req) {
        generationPrompts.push(JSON.stringify(req.messages));
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 只清掉旧判断步 ctx 的正文与状态（redactSource，真实 API + 真实 source_refs）；当前 QQ 来源
    // 授权仍然合法——所以"旧正文不可复用"不等于"当前来源不可用"，不得就此判成未授权。
    const snapshot = h.db
      .query(
        `SELECT c.source_refs AS source_refs FROM context_snapshots c
         JOIN agent_steps s ON s.step_id=c.step_id
         JOIN agent_runs r ON r.run_id=s.run_id
         WHERE r.spec_id='onebot.initiative.evaluate_batch' AND r.wake_id=? AND c.status='exact'
         ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(wake.id) as { source_refs: string } | null;
    expect(snapshot).not.toBeNull();
    const refs = JSON.parse(snapshot!.source_refs) as { kind: string; id: string }[];
    expect(refs.length).toBeGreaterThan(0);
    let redacted = 0;
    for (const ref of refs) redacted += h.runs.redactSource(ref.kind, ref.id, "revoked");
    expect(redacted).toBeGreaterThan(0);
    // 恢复：真实租约到期→recover→claim 同一 wake。旧正文不得被消费：当前来源仍合法，允许按新判断
    // 补缺目标回复（SPEC 只要求不重放旧缓存，不禁止合法重判）。
    hangSlow = false;
    const beforeResume = generationPrompts.length;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    expect(resumedWake.id).toBe(wake.id);
    const resumed = await h.host.activate(resumedWake, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(judgeCalls).toBe(2); // 旧 raw 未被消费：按当前合法来源重新判断
    // 恢复只补缺目标 20003，且其材料是新判断的 fresh-intent，不是旧保护正文的 stale-intent。
    const resumedPrompts = generationPrompts.slice(beforeResume);
    expect(resumedPrompts).toHaveLength(1);
    expect(resumedPrompts[0]).toContain("20003");
    expect(resumedPrompts[0]).toContain("fresh-intent");
    expect(resumedPrompts[0]).not.toContain("stale-intent");
    // 已提交目标不重生成；缺目标在当前来源合法下正常补回复。
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("refuses to reuse a stage-1 judgement after its observation sources expire", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText(req) {
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 真实来源失效：把承载本批成员证据的观察正文置为已过期（真实 store 语义；不是 redact 旧 ctx，也不造假权限表）。
    h.db.exec("UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z'");
    hangSlow = false;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    // 恢复必须经 current guard 拒绝：旧判断 ctx 的来源已过期，不得复用旧 raw 产出缺目标未授权回复。
    await expect(h.host.activate(resumedWake, new AbortController().signal)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
  });
  it("a related message buried under an unrelated latest message still causes a new decision", async () => {
    let h: ReturnType<typeof setup>;
    let generations = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        generations++;
        if (generations === 1) {
          h.receive("2", "20002", false, "related");
          h.receive("3", "20004", false, "unrelated latest");
        }
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    expect((await h.activate()).status).toBe("completed");
    expect(generations).toBe(2);
  });
  it("new addressed participant becomes an authorized target when re-deciding", async () => {
    let h: ReturnType<typeof setup>;
    let calls = 0;
    h = setup({
      complete: async (req) => {
        calls++;
        if (calls === 2) expect(JSON.stringify(req.messages[0])).toContain("20003");
        return generate(calls === 1 ? ["20002"] : ["20002", "20003"]);
      },
      async *streamText() {
        if (calls === 1) h.receive("2", "20003", true);
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    await h.activate();
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
  });
  it("new addressed message after final but before network marks the committed plan stale", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    h.receive("1", "20002", true);
    await h.activate();
    const intent = h.outbox.list({})[0]!;
    h.receive("2", "20003", true);
    h.receive("3", "20004", false);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: "unexpected" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(0);
    expect(h.outbox.get(intent.id)!.status).toBe("stale");
  });
  it("idle initiative threshold and unanswered rule remain active under the same host", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req)
          ? batchScores(batchTargetIds(req), 0)
          : '{"kind":"final","outputs":[{"kind":"generate","targetId":"30003","instructions":"开个话题"}]}',
    });
    h.receive("1");
    h.db.exec("UPDATE wake_signals SET status='no_output'");
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect((await h.activate("idle_topic")).status).toBe("no_output");
    expect(h.outbox.list({})).toEqual([]);
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "idle_topic",
      parts: [{ kind: "text", result: "confirmed", messageId: "200", stickerId: null }],
      text: "opener",
      sentAtSeconds: h.clock.seconds,
    });
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect(h.wakes.peek({ at: h.now(), cause: "idle_topic" })).toBeNull();
  });
});
describe("failed generation and observation epochs", () => {
  it("all failed generations fail the run and leave wake/source unacknowledged", async () => {
    const h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        yield await Promise.reject<string>(new Error("MODEL_FAILURE"));
      },
    });
    h.receive("1", "20002", true);
    await expect(h.activate()).rejects.toThrow("No output could be prepared");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").get()).toEqual({
      status: "failed",
    });
  });
  it("new related input during generation defers to the next frozen batch without reusing the unscored source", async () => {
    let h: ReturnType<typeof setup>;
    let scores = 0,
      generations = 0;
    const genPrompts: string[] = [];
    h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scores++;
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002"]);
      },
      async *streamText(req) {
        generations++;
        genPrompts.push(JSON.stringify(req.messages));
        if (generations === 1) {
          h.receive("2", "20002", false, "new material");
          h.clock.seconds += 2;
        }
        yield "answer";
      },
    });
    h.receive("1");
    h.clock.seconds += 2;
    expect((await h.activate()).status).toBe("completed");
    // 同一冻结批次只评分一次；运行中新到的相关输入属于下一冻结批次（留 pending），不回喂当前回复。
    expect(scores).toBe(1);
    expect(generations).toBe(1);
    expect(genPrompts[0]).not.toContain("new material"); // 回复未消费未评分的新来源
    expect(h.outbox.list({})).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("immediate opportunity coverage", () => {
  function previousSpeech(h: ReturnType<typeof setup>) {
    recordQqSend(
      h.orm,
      {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
        text: "previous",
        sentAtSeconds: time - 10,
      },
      undefined,
      h.db,
    );
  }
  function transport(h: ReturnType<typeof setup>, status: "confirmed" | "failed" | "unknown") {
    return new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      now: h.now,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          return status === "confirmed"
            ? { kind: "confirmed", messageId: "receipt" }
            : status === "unknown"
              ? { kind: "unknown", reason: "timeout" }
              : { kind: "failed", retcode: 500 };
        },
      },
    });
  }
  it.each(["confirmed", "failed", "unknown"] as const)(
    "does not repeat covered same-person input after a %s direct attempt",
    async (status) => {
      const h = setup({ complete: async () => generate(["20002"]) }, { follow: true });
      previousSpeech(h);
      h.receive("1", "20002", false);
      h.clock.seconds++;
      h.receive("2", "20002", true);
      await h.activate("direct_reply");
      await transport(h, status).runOnce();
      // 连续交谈按人滚动：下一个窗口成熟后才可领取。
      h.clock.seconds += 5;
      const c = h.journal.ensureOneBot(bindingId)!;
      const idle = h.wakes.enqueue({
        conversationId: c.id,
        cause: "idle_topic",
        throughSeq: h.journal.sourceThroughSeq(c.id),
        dedupeKey: "unrelated-idle",
        readyAt: h.now(),
        at: h.now(),
        priority: 0,
      });
      expect(await h.activate("follow_up")).toMatchObject({
        status: "no_output",
        reason: status === "confirmed" ? "already_replied" : "already_attempted",
      });
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
      ).toEqual({ n: 1 });
      expect(h.wakes.get(idle.id)?.status).toBe("pending");
      h.clock.seconds += 5;
      h.receive("3", "20002", false, "a genuinely new input");
      h.clock.seconds += 5;
      expect((await h.activate("follow_up")).status).toBe("completed");
      expect(h.outbox.list({})).toHaveLength(2);
    },
  );
  it("does not consume another participant merely because the first reply observed their input", async () => {
    let decisions = 0;
    const h = setup(
      { complete: async () => generate([++decisions === 1 ? "20003" : "20002"]) },
      { follow: true },
    );
    previousSpeech(h);
    h.receive("1", "20002", false);
    h.clock.seconds++;
    h.receive("2", "20003", true);
    await h.activate("direct_reply");
    await transport(h, "confirmed").runOnce();
    h.clock.seconds += 5;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003", "20002"]);
  });
  it("does not treat a planned sticker-only reply as coverage after group stickers close", async () => {
    let replyDecisions = 0;
    const h = setup(
      {
        complete: async (request) => {
          if (isBatchScore(request)) return batchScores(batchTargetIds(request));
          replyDecisions++;
          if (replyDecisions === 1)
            return JSON.stringify({
              kind: "invoke",
              name: "sticker.search",
              arguments: { query: "wave" },
            });
          if (replyDecisions === 2) {
            const observation = request.messages
              .flatMap((message) => message.content)
              .flatMap((part) => {
                if (part.kind !== "text") return [];
                try {
                  const parsed = JSON.parse(part.text);
                  return parsed.kind === "action_observation" &&
                    parsed.value?.name === "sticker.search"
                    ? [parsed.value]
                    : [];
                } catch {
                  return [];
                }
              })
              .at(-1);
            const id = observation?.value?.items?.[0]?.id;
            if (!id) throw new Error("missing disclosed sticker");
            return JSON.stringify({
              kind: "invoke",
              calls: [
                {
                  name: "reply.sticker",
                  arguments: { outputs: [{ targetId: "20002", stickerId: id }] },
                },
              ],
            });
          }
          return JSON.stringify({
            kind: "invoke",
            calls: [
              {
                name: "reply.text",
                arguments: {
                  outputs: [{ targetId: "20002", kind: "inline", text: "text survives hard-off" }],
                },
              },
            ],
          });
        },
      },
      { stickersAvailable: true },
    );
    const stickerId = addSticker(h);
    h.receive("99001", "20002", false);
    const conversation = h.journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error("missing conversation");
    const inputEvent = h.journal
      .eventsAfter(conversation.id, 0, Number.MAX_SAFE_INTEGER)
      .items.find((event) => event.kind === "inbound");
    if (!inputEvent) throw new Error("missing input event");
    const initial = h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "chiming_in",
      throughSeq: inputEvent.seq,
      dedupeKey: "planned-sticker-hardoff-initial-chiming",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const initialWake = h.wakes.claim({
      at: h.now(),
      leaseMs: 120000,
      cause: "chiming_in",
      wakeId: initial.id,
    });
    if (!initialWake) throw new Error("missing initial chiming wake");
    expect((await h.host.activate(initialWake, new AbortController().signal)).status).toBe(
      "completed",
    );
    const original = h.outbox.list({})[0]!;
    expect(original.target?.participantId).toBe("20002");
    expect(h.outbox.parts(original.id).map((part) => part.status)).toEqual(["planned"]);
    expect(JSON.parse(h.outbox.parts(original.id)[0]!.payload!).stickerId).toBe(stickerId);
    expect(h.outbox.row(original.id)?.run_id).toBeTruthy();

    const config = h.db
      .query("SELECT revision FROM qq_group_agent_configs WHERE binding_id=? AND agent_id=?")
      .get(bindingId, DEFAULT_AGENT_ID) as { revision: number } | null;
    writeQqGroupAgentConfigRow(h.orm, {
      bindingId,
      agentId: DEFAULT_AGENT_ID,
      overrides: {},
      disabledCapabilities: ["stickers"],
      expectedRevision: config?.revision ?? 0,
    });
    const direct = h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: inputEvent.seq,
      dedupeKey: "planned-sticker-hardoff-second-direct",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const priorReplyDecisions = replyDecisions;
    const wake = h.wakes.claim({
      at: h.now(),
      leaseMs: 120000,
      cause: "direct_reply",
      wakeId: direct.id,
    });
    if (!wake) throw new Error("missing hard-off direct wake");
    const coverageResult = await h.host.activate(wake, new AbortController().signal);
    expect(coverageResult).toMatchObject({ status: "completed" });
    expect(replyDecisions).toBeGreaterThan(priorReplyDecisions);
    expect(h.outbox.list({}).map((intent) => intent.target?.participantId)).toEqual([
      "20002",
      "20002",
    ]);
    expect(h.outbox.parts(h.outbox.list({})[1]!.id).map((part) => part.kind)).toEqual(["text"]);
    expect(JSON.parse(h.outbox.parts(h.outbox.list({})[1]!.id)[0]!.payload!).text).toBe(
      "text survives hard-off",
    );
    expect(h.outbox.parts(original.id).map((part) => part.status)).toEqual(["planned"]);
  });

  it("does not regenerate an answer already durably owned by a planned in-flight reply", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    h.clock.seconds++;
    // 追问并入同一 pending 窗口：第一轮 direct run 的观察窗吞掉它，已提交 intent 的
    // sourceThroughSeq 因此覆盖追问 seq（与本轮覆盖形态一致）。
    h.receive("2", "20002", true);
    const first = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(await h.host.activate(first, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    const [intent] = h.outbox.list({});
    // 第二个 direct wake 的上界＝被在途回复覆盖的追问：与既有 wake 生成时机一致。
    const conversation = h.journal.ensureOneBot(bindingId)!;
    const second = h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: intent.sourceThroughSeq,
      dedupeKey: "repeat-second-direct",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    // 部件经真实 claimPart 已在发（sending）、未确认。
    expect(h.outbox.claimPart(intent.id, h.now())).not.toBeNull();
    const modelCalls = h.requests.length;
    const leased = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(leased.id).toBe(second.id);
    expect(await h.host.activate(leased, new AbortController().signal)).toMatchObject({
      status: "no_output",
      reason: "already_replying",
    });
    expect(h.requests.length).toBe(modelCalls);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 1 });
    expect(h.outbox.list({})).toHaveLength(1);
  });
  it("in-flight coverage stays per speaker: another participant's wake still generates", async () => {
    let calls = 0;
    const h = setup({ complete: async () => generate([++calls === 1 ? "20002" : "20003"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    h.clock.seconds++;
    h.receive("2", "20003", true);
    const oldestPending = () =>
      h.db
        .query(
          "SELECT id FROM wake_signals WHERE status='pending' ORDER BY created_at,through_seq LIMIT 1",
        )
        .get() as { id: string };
    const first = h.wakes.claim({
      at: h.now(),
      leaseMs: 120000,
      cause: "direct_reply",
      wakeId: oldestPending().id,
    })!;
    expect(await h.host.activate(first, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    const [intent] = h.outbox.list({});
    expect(intent.target?.participantId).toBe("20002");
    expect(h.outbox.claimPart(intent.id, h.now())).not.toBeNull();
    expect(
      await h.host.activate(
        h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!,
        new AbortController().signal,
      ),
    ).toMatchObject({
      status: "completed",
    });
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
    expect(h.requests.length).toBe(2);
  });
  it("an expired planned intent is not active coverage", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    // 来源过期的行由既有 expiry keeper（purgeExpired）判 stale；keeper 运行前的窗口里，
    // 门禁同样不得把它当在飞覆盖吞掉新一轮回答。
    const [intent] = h.outbox.list({});
    h.db
      .query("UPDATE outbound_intents SET expires_at=? WHERE id=?")
      .run(new Date((time - 60) * 1000).toISOString(), intent.id);
    h.clock.seconds += 5;
    h.receive("2", "20002", true, "a genuinely new input");
    h.clock.seconds += 5;
    expect(await h.activate("direct_reply")).toMatchObject({ status: "completed" });
    expect(h.outbox.list({})).toHaveLength(2);
    expect(h.requests.length).toBe(2);
  });
  it("does not treat a delivery-TTL-expired planned intent as coverage", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    h.clock.seconds++;
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    const [intent] = h.outbox.list({});
    h.db
      .query("UPDATE outbound_intents SET deliver_by=? WHERE id=?")
      .run(new Date((time - 60) * 1000).toISOString(), intent.id);
    const conversation = h.journal.ensureOneBot(bindingId)!;
    h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: intent.sourceThroughSeq,
      dedupeKey: "ttl-second-direct",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const modelCalls = h.requests.length;
    const leased = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(await h.host.activate(leased, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    expect(h.requests.length).toBe(modelCalls + 1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
  });
  it("does not treat an intent whose authority changed as coverage", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    h.clock.seconds++;
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    const [intent] = h.outbox.list({});
    h.db
      .query(
        "UPDATE qq_bindings SET revision=revision+1, authority_revision=authority_revision+1 WHERE id=?",
      )
      .run(bindingId);
    const conversation = h.journal.ensureOneBot(bindingId)!;
    h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: intent.sourceThroughSeq,
      dedupeKey: "authority-second-direct",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const modelCalls = h.requests.length;
    const leased = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(await h.host.activate(leased, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    expect(h.requests.length).toBe(modelCalls + 1);
  });
  it("confirmed direct coverage excludes the same member's old input when another member raises the batch boundary", async () => {
    // An independent member's new message must not revive an already answered input.
    // History remains shared; a genuinely newer input from this member is tested separately.
    const scored: string[][] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scored.push(batchTargetIds(req));
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText() {
        yield "reply\nfor target";
      },
    });
    previousSpeech(h);
    h.receive("1", "20002", false);
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    await transport(h, "confirmed").runOnce();
    expect(h.outbox.list({}).find((d) => d.target?.participantId === "20002")?.status).toBe(
      "confirmed",
    );
    h.clock.seconds += 1;
    h.receive("4", "20004", false, "newer member input releases the batch");
    h.clock.seconds += 11;
    const chiming = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "chiming_in" })!;
    await h.host.activate(chiming, new AbortController().signal);
    expect(scored.at(-1)).toEqual(["20004"]);
  });

  it("[v3] a member's newer input after a confirmed reply stays a candidate under both checks", async () => {
    // S<E<=T：confirmed（T 口径）与 pending（最新事件口径）都保留成员——新输入永不被旧回复吞。
    const scored: string[][] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scored.push(batchTargetIds(req));
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002"]);
      },
      async *streamText() {
        yield "reply\nfor target";
      },
    });
    previousSpeech(h);
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    const directIntent = h.outbox.list({}).find((d) => d.target?.participantId === "20002")!;
    expect(h.outbox.claimPart(directIntent.id, h.now())).not.toBeNull();
    await transport(h, "confirmed").runOnce();
    h.receive("2", "20002", false);
    h.receive("3", "20003", false);
    h.clock.seconds += 5;
    const chiming = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "chiming_in" })!;
    await h.host.activate(chiming, new AbortController().signal);
    expect(scored.at(-1)).toEqual(["20002", "20003"]);
  });
  it("[v3] a member whose latest eligible input is covered by a current valid pending reply is omitted", async () => {
    // 最新合格事件被当前有效 pending 覆盖 → 成员整员省略（不是靠更旧未覆盖事件复活候选）；
    // 无覆盖成员照常进批。
    const scored: string[][] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scored.push(batchTargetIds(req));
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText() {
        yield "reply\nfor target";
      },
    });
    previousSpeech(h);
    h.receive("1", "20002", false);
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    const directIntent = h.outbox.list({}).find((d) => d.target?.participantId === "20002")!;
    expect(h.outbox.claimPart(directIntent.id, h.now())).not.toBeNull();
    h.receive("3", "20003", false);
    h.clock.seconds += 5;
    const chiming = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "chiming_in" })!;
    await h.host.activate(chiming, new AbortController().signal);
    expect(scored.at(-1)).toEqual(["20003"]);
  });

  it("chiming keeps a member covered by a valid pending reply out of the batch but keeps new members", async () => {
    const scored: string[][] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scored.push(batchTargetIds(req));
          return batchScores(batchTargetIds(req));
        }
        return generateForRequest(req);
      },
      async *streamText() {
        yield "reply\nfor target";
      },
    });
    previousSpeech(h);
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.receive("3", "20002", true);
    await h.activate("direct_reply");
    const directIntent = h.outbox.list({}).find((d) => d.target?.participantId === "20002")!;
    expect(h.outbox.claimPart(directIntent.id, h.now())).not.toBeNull();
    h.clock.seconds += 5;
    const leased = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "chiming_in" })!;
    await h.host.activate(leased, new AbortController().signal);
    expect(scored.at(-1)).toEqual(["20003"]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
  });

  it("[SO-A] a same-original planned reply is replaced on the opportunity rerun", async () => {
    // 同原始机会（重跑 wake throughSeq=原 wake throughSeq，origin run/wake 归属一致）上的
    // planned 且全部部件未尝试：合法计划替换——重跑重新生成并按幂等替换部件，仍只投递一条。
    let round = 0;
    const bodies = ["第一版正文", "第二版正文"];
    const h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        yield bodies[Math.min(round++, bodies.length - 1)];
      },
    });
    previousSpeech(h);
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    const conversation = h.journal.ensureOneBot(bindingId)!;
    const firstIntent = h.outbox.list({}).find((d) => d.target?.participantId === "20002")!;
    expect(firstIntent.status).toBe("planned");
    h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: firstIntent.sourceThroughSeq,
      dedupeKey: "so-same-origin-rerun",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const rerun = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(await h.host.activate(rerun, new AbortController().signal)).toMatchObject({
      status: "completed",
    });
    expect(h.outbox.list({})).toHaveLength(1);
    const replaced = h.outbox.parts(firstIntent.id)[0];
    expect(JSON.parse(replaced.payload as string).text).toBe("第二版正文");
  });
  it("[SO-B] a second wake at an absorbed newer seq stays covered after a real mid-run refresh", async () => {
    // 事故形态真链：第一轮 decision 挂起期间同参与者追问到达（second wake pending），放行后
    // reconsider refresh 重观察并把 commit 抬到追问 seq（origin wake=第一 wake）；第二 wake
    // 在该 seq 上仍被覆盖——不因 origin 不同而重生成，零额外模型调用与出站增长。
    let decisionCalls = 0;
    let releaseDecision: () => void = () => {};
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const h = setup({
      complete: async () => {
        decisionCalls += 1;
        if (decisionCalls === 1) await decisionGate;
        return generate(["20002"]);
      },
      async *streamText() {
        yield "回复正文";
      },
    });
    previousSpeech(h);
    h.receive("1", "20002", true);
    const running = h.activate("direct_reply");
    await waitFor(() => decisionCalls === 1);
    h.receive("2", "20002", true);
    releaseDecision();
    await running;
    expect(h.outbox.list({}).map((d) => d.sourceThroughSeq)).toEqual([3]);
    h.clock.seconds += 5;
    expect(await h.activate("direct_reply")).toMatchObject({ status: "no_output" });
    expect(h.outbox.list({})).toHaveLength(1);
    expect(decisionCalls).toBe(2);
  });
  it("[SO-C] a same-original intent already sending is not replaced on the opportunity rerun", async () => {
    // 同原始机会但部件真实在发：不替换不重放（coverage 生效），目标实际发送计数保持一次，
    // 放行后原部件照常收口。
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sends: string[] = [];
    const h = setup({ complete: async () => generate(["20002"]) });
    previousSpeech(h);
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    const intent = h.outbox.list({}).find((d) => d.target?.participantId === "20002")!;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          sends.push("20002");
          await sendGate;
          return { kind: "confirmed", messageId: "receipt" };
        },
      },
    });
    const pumping = delivery.runOnce();
    await waitFor(() => h.outbox.parts(intent.id)[0]?.status === "sending");
    const conversation = h.journal.ensureOneBot(bindingId)!;
    h.wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: intent.sourceThroughSeq,
      dedupeKey: "so-sending-rerun",
      readyAt: h.now(),
      at: h.now(),
      priority: 100,
    });
    const rerun = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    expect(await h.host.activate(rerun, new AbortController().signal)).toMatchObject({
      status: "no_output",
    });
    expect(h.outbox.list({})).toHaveLength(1);
    expect(sends).toEqual(["20002"]);
    releaseSend();
    await pumping;
    expect(h.outbox.list({})[0]?.status).toBe("confirmed");
  });
});

function pendingPlan(
  request: ModelRequest,
):
  | { outputs: { text?: string; targetId: string }[]; generationBudget: { remaining: number }[] }
  | undefined {
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text);
        if (data.kind === "pending_plan") return data.value;
      } catch {}
    }
}
describe("Agent-directed recovery", () => {
  it.each(["malformed", "model_error"])(
    "fails the whole initiative batch when its single batch score is %s",
    async (failure) => {
      let scores = 0,
        replies = 0;
      const h = setup({
        complete: async (request) => {
          if (isBatchScore(request)) {
            scores++;
            if (failure === "model_error") throw new Error("MODEL_FAILED");
            return "invalid";
          }
          replies++;
          return generateForRequest(request);
        },
      });
      h.receive("1", "20002");
      h.receive("2", "20003");
      h.clock.seconds += 2;
      // 新协议：阶段一只有一次批量评分；协议错误/模型失败整批结算为失败，不逐 target 重试或部分回复。
      if (failure === "model_error") await expect(h.activate()).rejects.toThrow("MODEL_FAILED");
      else await expect(h.activate()).rejects.toMatchObject({ code: "JUDGEMENT_UNREADABLE" });
      expect(scores).toBe(1);
      expect(replies).toBe(0);
      expect(h.outbox.list({})).toHaveLength(0);
      expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0); // 游标未消费
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
      ).toEqual({ n: 0 }); // wake 未消费
    },
  );
  it.each(["keep", "revise", "defer"])(
    "Agent can %s a pending draft after new input even with zero regeneration budget",
    async (choice) => {
      let h: ReturnType<typeof setup>;
      let decisions = 0,
        generations = 0;
      h = setup(
        {
          complete: async (request) => {
            if (++decisions === 1) return generate(["20002"]);
            const plan = pendingPlan(request);
            expect(plan?.outputs[0]?.text).toBe("original draft");
            expect(plan?.generationBudget[0]?.remaining).toBe(0);
            expect(JSON.stringify(request.messages)).toContain("additional detail");
            if (choice === "defer") return '{"kind":"none"}';
            if (choice === "keep") {
              const pendingText = plan?.outputs[0]?.text;
              if (pendingText === undefined) throw new Error("pending draft text is missing");
              return replyText([{ targetId: "20002", text: pendingText }]);
            }
            return replyText([{ targetId: "20002", text: "revised draft" }]);
          },
          async *streamText() {
            generations++;
            h.receive("2", "20002", true, "additional detail");
            yield "original draft";
          },
        },
        { recomputes: 0 },
      );
      h.receive("1", "20002", true);
      const result = await h.activate();
      expect(result.status).toBe(choice === "defer" ? "no_output" : "completed");
      expect(generations).toBe(1);
      expect(decisions).toBe(2);
      const intents = h.outbox.list({});
      expect(intents).toHaveLength(choice === "defer" ? 0 : 1);
      if (choice !== "defer")
        expect(JSON.parse(h.outbox.parts(intents[0]!.id)[0]!.payload!).text).toBe(
          choice === "keep" ? "original draft" : "revised draft",
        );
    },
  );
  it("cannot reuse a pending draft after its source leaves the raw window and is deleted", async () => {
    let h: ReturnType<typeof setup>,
      decisions = 0;
    h = setup(
      {
        complete: async (request) => {
          if (++decisions === 1) return generate(["20002"]);
          expect(pendingPlan(request)?.outputs[0]?.text).toBe("original secret");
          h.db.exec(
            "DELETE FROM qq_observation_text WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='1')",
          );
          return replyText([{ targetId: "20002", text: "original secret" }]);
        },
        async *streamText() {
          h.clock.seconds++;
          h.receive("2", "20002", true, "new input");
          yield "original secret";
        },
      },
      { recomputes: 0 },
    );
    h.db.exec("UPDATE qq_schemes SET judgement_message_limit=1, reply_message_limit=1");
    h.receive("1", "20002", true, "sensitive old source");
    await expect(h.activate()).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });
  it("stamps the retention window saved at commit time into the planned intent", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    // 30 days, saved before the commit: the commit point reads the setting when it runs, and
    // the intent's expiry (the row every later read is bounded by) must carry that window.
    updateQqStorageSettings(h.orm, {
      retentionDays: 30,
      expectedRevision: readQqSettings(h.orm).revision,
    });
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    const intent = h.outbox.row(h.outbox.list({})[0]!.id)!;
    expect(intent.expires_at).toBe(speechExpiresAt(time, 30));
  });
});

it.each(["revoked", "cancelled"])(
  "does not turn %s authority loss into an unauthorized reply",
  async (failure) => {
    const controller = new AbortController();
    let h: ReturnType<typeof setup>;
    let scores = 0;
    h = setup({
      complete: async (request) => {
        if (isBatchScore(request)) {
          scores++;
          return batchScores(batchTargetIds(request));
        }
        return generateForRequest(request);
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    // 撤权：删掉承载成员证据的会话事件（真实让来源不可用）；取消：直接 abort。
    // 注：当前 QQ 评分相没有可 assert 的"来源授权"入口（评分叶子非能力门控、删 observation text 不影响来源），
    // 真实"扣授权"面见 knowledge grant（父已批准范围），故本用例只证"撤权/取消不产未授权回复、不进评分"。
    if (failure === "revoked") h.db.exec("DELETE FROM conversation_events");
    else controller.abort();
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const settled = await h.host.activate(wake, controller.signal).then(
      (value) => ({ ok: true as const, status: value.status }),
      () => ({ ok: false as const }),
    );
    expect(h.outbox.list({})).toHaveLength(0); // 不产未授权回复
    expect(scores).toBe(0); // 来源不可用/已取消时不进入评分（非普通评分失败）
    if (failure === "cancelled") expect(settled.ok).toBe(false);
  },
);
describe("durable participant windows across actual Host and delivery", () => {
  it("A at 0 is answered at 15; B at 14 remains pending and is answered at 29 after A's confirmed delivery", async () => {
    let h: ReturnType<typeof setup>;
    h = setup(
      {
        // 15/29 的按人滚动成熟属于连续交谈（follow_up），不是自主接话。
        complete: async (request) =>
          replyTextForRequest(request, (targetId) => (targetId === "20002" ? "to A" : "to B")),
        async *streamText() {
          yield "should-not-stream";
        },
      },
      { mergeSeconds: 15, follow: true },
    );
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002");
    h.clock.seconds = time + 14;
    h.receive("2", "20003");
    h.clock.seconds = time + 15;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: { send: async () => ({ kind: "confirmed", messageId: "receipt-a" }) },
    });
    await delivery.deliver(h.outbox.list({})[0]!.id);
    expect(h.outbox.list({})[0]!.status).toBe("confirmed");
    h.adapter.sweep();
    h.clock.seconds = time + 29;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
  });
  it("an unpaired legacy or room-wide initiative still preserves the unanswered gate", async () => {
    const h = setup({}, { mergeSeconds: 15 });
    h.receive("1", "20002");
    h.clock.seconds = time + 15;
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "chiming_in",
      parts: [{ kind: "text", result: "confirmed", messageId: "legacy", stickerId: null }],
      sentAtSeconds: time + 1,
      text: "room topic",
    });
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("no_output");
    expect(result).toHaveProperty("reason", "awaiting_reply");
    expect(h.requests).toHaveLength(0);
  });
  it("initiative low score freezes the batch and consumes its frozen members once without leaving pending", async () => {
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (req) => {
        seen.push(req);
        // 主动批次：一次批量评分；低于门槛＝本批无达标目标，整批冻结成员一次性消费（非按人 15/29 成熟）。
        return isBatchScore(req) ? batchScores(batchTargetIds(req), 0) : '{"kind":"none"}';
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("no_output");
    const conversation = h.journal.ensureOneBot(bindingId)!;
    expect(h.journal.chimingInJudgedAt(conversation.id)).toBe(h.now());
    expect(h.journal.chimingInObservedSeq(conversation.id)).toBeGreaterThan(0);
    expect(seen).toHaveLength(1); // 只一次批量评分
    expect(h.outbox.list({})).toHaveLength(0);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 }); // 冻结成员一次消费完毕，无残留 pending
  });
  it("split off keeps one logical room reply covering both qualified intents", async () => {
    const generationPrompts: string[] = [];
    const h = setup(
      {
        complete: async (req) => {
          if (isBatchScore(req))
            return JSON.stringify({
              evaluations: [
                { targetId: "20002", score: 9, intent: "intent-a", sourceSeqs: [] },
                { targetId: "20003", score: 9, intent: "intent-b", sourceSeqs: [] },
              ],
            });
          return generate(["30003"]);
        },
        async *streamText(req) {
          generationPrompts.push(JSON.stringify(req.messages));
          yield "room reply";
        },
      },
      { split: false },
    );
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    // 自主批次：一个会话 wake，只结算 1 个 completed（不是每个机会各一个）。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 1 });
    expect(h.outbox.list({})).toHaveLength(1);
    expect(h.outbox.list({})[0]!.target).toEqual({ peerId: "30003", participantId: null });
    // intent 完整性：room 回复材料覆盖两个达标 intent，而不是只计 part 数。
    expect(generationPrompts).toHaveLength(1);
    expect(generationPrompts[0]).toContain("intent-a");
    expect(generationPrompts[0]).toContain("intent-b");
  });
  it("keeps one room wake while a failed target child does not fail the parent or its sibling", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generateForRequest(req),
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes("20002")) throw new Error("MODEL_A_FAILED");
        yield "B reply";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    // 分层：A 的 target 子 run 失败、B 的子 run 完成；父 run 仍 completed，同一会话 wake 只结算一次。
    const childStates = (
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").all() as {
        status: string;
      }[]
    ).map((row) => row.status);
    expect(childStates.sort()).toEqual(["completed", "failed"]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
    expect(
      h.db
        .query(
          "SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.initiative.batch' AND status='completed'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("confirmed reply coverage across opportunity paths", () => {
  function coverageFixture() {
    let initiativeTarget = "20002",
      initiative = false,
      decisions = 0,
      evaluations = 0;
    const h = setup(
      {
        complete: async (req) => {
          if (isBatchScore(req)) {
            evaluations++;
            return batchScores(batchTargetIds(req));
          }
          if (!initiative) return generate(["20002"]);
          decisions++;
          return generate([initiativeTarget]);
        },
      },
      { mergeSeconds: 15, follow: false },
    );
    return {
      ...h,
      startInitiative(target = "20002") {
        initiative = true;
        initiativeTarget = target;
      },
      get evaluations() {
        return evaluations;
      },
      async deliverDirect(outcome: "confirmed" | "failed" | "unknown") {
        const delivery = new OutboundDelivery({
          orm: h.orm,
          repository: h.outbox,
          journal: h.journal,
          authorize: () => true,
          stickerFile: () => null,
          now: h.now,
          port: {
            send: async () =>
              outcome === "confirmed"
                ? { kind: "confirmed", messageId: "direct-receipt" }
                : outcome === "unknown"
                  ? { kind: "unknown", reason: "timeout" }
                  : { kind: "failed", retcode: 500 },
          },
        });
        await delivery.deliver(h.outbox.list({})[0]!.id);
        expect(h.outbox.list({})[0]!.status).toBe(outcome);
      },
    };
  }

  it("skips an older ordinary opportunity already covered by the same recipient's confirmed direct reply", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    await h.deliverDirect("confirmed");
    h.startInitiative();
    h.clock.seconds = time + 15;
    expect(await h.activate("chiming_in")).toEqual({
      status: "no_output",
      reason: "already_replied",
    });
    expect(h.evaluations).toBe(0);
    expect(h.outbox.list({})).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 1 });
  });

  it("filters covered A from a mature batch while preserving and evaluating unconfirmed B", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20003");
    h.clock.seconds++;
    h.receive("3", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    await h.deliverDirect("confirmed");
    h.startInitiative("20003");
    h.clock.seconds = time + 17;
    // B 是更新的普通机会并拥有这次激活；A 必须从同批其它成熟目标里被过滤（不是只在 claim 时检查）。
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.evaluations).toBe(1); // 一次批量评分，不重复模型调用
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]); // 保留 A 的 direct 已发事实
    // 一次自主批过滤 covered A、回复 B 后不应再有第二个 wake。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
  });

  it.each(["failed", "unknown"] as const)(
    "does not treat %s direct delivery as confirmed coverage",
    async (outcome) => {
      const h = coverageFixture();
      h.receive("1", "20002");
      h.clock.seconds++;
      h.receive("2", "20002", true);
      await h.activate("direct_reply");
      await h.deliverDirect(outcome);
      h.startInitiative();
      h.clock.seconds = time + 15;
      expect((await h.activate("chiming_in")).status).toBe("completed");
      expect(h.evaluations).toBe(1);
      expect(h.outbox.list({}).map((d) => d.status)).toEqual([outcome, "planned"]);
    },
  );

  it("does not cover a participant's newer source with an earlier confirmed reply", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    await h.deliverDirect("confirmed");
    h.clock.seconds = time + 5;
    h.receive("3", "20002");
    h.startInitiative();
    h.clock.seconds = time + 20;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.evaluations).toBe(1);
    expect(h.outbox.list({})).toHaveLength(2);
  });
});

interface EvidenceEnvelope {
  status: "ok" | "unavailable";
  code?: string;
  items: {
    id: string;
    title?: string;
    summary?: string;
    bodyRef: string;
    text?: string;
    offset?: number;
    nextOffset?: number | null;
  }[];
  nextCursor?: string | null;
}

/** The latest rendered `action_observation` envelope with this action name, if any. */
function evidencePage(request: ModelRequest, name: string): EvidenceEnvelope | undefined {
  let found: EvidenceEnvelope | undefined;
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text) as {
          kind?: string;
          value?: { name?: string; value?: EvidenceEnvelope };
        };
        if (data.kind === "action_observation" && data.value?.name === name)
          found = data.value.value;
      } catch {}
    }
  return found;
}

interface CommittedObservation {
  id: string;
  name: string;
  arguments: unknown;
  value: unknown;
  sources: unknown;
}

/** Every distinct evidence observation the run ever produced, deduped by observation id. */
function committedObservations(
  requests: readonly ModelRequest[],
  prefix: string,
): CommittedObservation[] {
  const observations = new Map<string, CommittedObservation>();
  for (const request of requests)
    for (const message of request.messages)
      for (const part of message.content) {
        if (part.kind !== "text") continue;
        try {
          const data = JSON.parse(part.text) as {
            kind?: string;
            value?: CommittedObservation;
          };
          const observation = data.value;
          if (
            data.kind !== "action_observation" ||
            typeof observation?.name !== "string" ||
            !observation.name.startsWith(prefix) ||
            typeof observation.id !== "string"
          )
            continue;
          observations.set(observation.id, observation);
        } catch {}
      }
  return [...observations.values()];
}

/**
 * Mirrors the production charge for one published observation (`observationUnits` in
 * built-in-actions): the rendered action_observation envelope measured by `inputUnits`.
 * The id placeholder is the same length as a real observation id, so the charge matches.
 */
function observationCharge(observation: CommittedObservation): number {
  const message: ModelMessage = {
    role: "user",
    content: [
      {
        kind: "text",
        text: JSON.stringify({
          kind: "action_observation",
          trust: "data_only",
          value: {
            id: "00000000-0000-0000-0000-000000000000",
            name: observation.name,
            arguments: observation.arguments,
            value: observation.value,
            sources: observation.sources,
          },
        }),
      },
    ],
  };
  return inputUnits([message]) - inputUnits([]);
}

describe("sticker frequency in actual QQ model requests", () => {
  it.each(["low", "medium", "high"] as const)(
    "sends exactly the %s system guidance from the durable task snapshot",
    async (frequency) => {
      const seen: ModelRequest[] = [];
      const h = setup(
        {
          complete: async (request) => {
            seen.push(request);
            return replyTextForRequest(request, () => "frequency reply");
          },
        },
        { taskSourceState },
      );
      updateQqScheme(h.orm, h.scheme.id, {
        name: h.scheme.name,
        stickers: { ...schemeStickers(h.scheme), frequency },
        expectedRevision: h.scheme.revision,
      });
      const descriptor = await claimFrequencyTask(h, frequency);
      expect(descriptor.snapshot.stickerFrequency).toBe(frequency);
      expect((await h.host.activateTask(descriptor, new AbortController().signal)).status).toBe(
        "completed",
      );
      expect(frequencyGuideLines(seen[0]!)).toEqual([stickerFrequencyGuides[frequency]]);
      expect(h.outbox.list({}).map((intent) => intent.target?.participantId)).toEqual(["20002"]);
    },
  );

  it("keeps the claimed low guidance for this run after the group override changes to high", async () => {
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return replyTextForRequest(request, () => "frozen reply");
        },
      },
      { taskSourceState },
    );
    const descriptor = await claimFrequencyTask(h, "low");
    setGroupFrequency(h, "high");
    expect((await h.host.activateTask(descriptor, new AbortController().signal)).status).toBe(
      "completed",
    );
    expect(frequencyGuideLines(seen[0]!)).toEqual([stickerFrequencyGuides.low]);
  });

  it("does not add any new frequency guidance for a legacy task snapshot without the field", async () => {
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return replyTextForRequest(request, () => "legacy reply");
        },
      },
      { taskSourceState },
    );
    updateQqScheme(h.orm, h.scheme.id, {
      name: h.scheme.name,
      stickers: { ...schemeStickers(h.scheme), frequency: "high" },
      expectedRevision: h.scheme.revision,
    });
    const descriptor = await claimFrequencyTask(h);
    expect(Object.hasOwn(descriptor.snapshot, "stickerFrequency")).toBe(false);
    expect((await h.host.activateTask(descriptor, new AbortController().signal)).status).toBe(
      "completed",
    );
    expect(frequencyGuideLines(seen[0]!)).toEqual([]);
  });
});

describe("Bot tool-first knowledge reading in the shared host", () => {
  function seedKnowledge(h: ReturnType<typeof setup>, name: string, text: string) {
    const library = new KnowledgeRepository(h.db);
    const doc = library.importDocument({ name, category_id: "default", original_text: text });
    library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    return doc;
  }
  function setKnowledgeBudget(h: ReturnType<typeof setup>, budget: number) {
    h.db
      .query("UPDATE agent_knowledge_read_settings SET context_budget=? WHERE agent_id=?")
      .run(budget, DEFAULT_AGENT_ID);
  }

  it("keeps knowledge raw until the Agent explicitly queries and reads it", async () => {
    const seen: ModelRequest[] = [];
    let decisions = 0;
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        decisions++;
        if (decisions === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        if (decisions === 2) {
          const catalog = evidencePage(request, "knowledge.query");
          expect(catalog?.status).toBe("ok");
          expect(catalog?.items).toHaveLength(1);
          expect(catalog?.items[0]?.title).toBe("apples manual");
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: catalog!.items[0]!.bodyRef },
          });
        }
        return '{"kind":"none"}';
      },
    });
    // 正文标记特意放在 160 字摘要之外：目录信封即使带摘要也不得泄漏正文。
    seedKnowledge(h, "apples manual", "apples " + "Q".repeat(200) + " SECRET_BODY");
    h.receive("1", "20002", true, "apples question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(decisions).toBe(3);
    // 预取已移除：第一条决策里没有正文、没有证据信封、没有检索失败状态。
    const first = JSON.stringify(seen[0]!.messages);
    expect(first).not.toContain("SECRET_BODY");
    expect(first).not.toContain("retrieval_status");
    expect(evidencePage(seen[0]!, "knowledge.query")).toBeUndefined();
    // 工具可用 ≠ 内容注入；独立 selector 已移除（任何请求都不再出现 ids 选择 schema）。
    expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["knowledge.query", "knowledge.read"]),
    );
    for (const request of seen)
      expect(
        (request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids,
      ).toBeUndefined();
    // 显式 query 只给目录信封（标题/摘要/bodyRef）：正文标记落在 160 字摘要之外，仍不进入模型输入。
    const second = JSON.stringify(seen[1]!.messages);
    expect(second).toContain("apples manual");
    expect(second).not.toContain("SECRET_BODY");
    // 只有 knowledge.read 之后正文才进入，并带着资料文档与授权的来源。
    const read = evidencePage(seen[2]!, "knowledge.read");
    expect(read?.items[0]?.text).toContain("SECRET_BODY");
    expect(JSON.stringify(seen[2]!.messages)).toContain("knowledge_grant");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("bounds explicit query and paged reads by the frozen knowledge budget", async () => {
    const seen: ModelRequest[] = [];
    const body = "apples " + "Q".repeat(4000);
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        const read = evidencePage(request, "knowledge.read");
        if (read) {
          if (read.status !== "ok") return '{"kind":"none"}';
          const page = read.items[0]!;
          if (page.nextOffset == null) return '{"kind":"none"}';
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: page.bodyRef, offset: page.nextOffset, limit: 4096 },
          });
        }
        const catalog = evidencePage(request, "knowledge.query");
        if (!catalog)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        if (catalog.status !== "ok") return '{"kind":"none"}';
        return JSON.stringify({
          kind: "invoke",
          name: "knowledge.read",
          arguments: { bodyRef: catalog.items[0]!.bodyRef },
        });
      },
    });
    seedKnowledge(h, "apples", body);
    setKnowledgeBudget(h, 3000);
    h.receive("1", "20002", true, "apples question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");

    const pages = seen
      .map((request) => evidencePage(request, "knowledge.read"))
      .filter((page): page is EvidenceEnvelope => page !== undefined);
    const text = pages
      .filter((page) => page.status === "ok")
      .map((page) => page.items[0]!.text)
      .join("");
    // 预算是逐页截断而不是放行：读到的正文是原文前缀，且在读完之前就被截住。
    expect(text.length).toBeGreaterThan(0);
    expect(body.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(body.length);
    expect(
      pages.some(
        (page) => page.status === "unavailable" && page.code === "CONTEXT_BUDGET_EXCEEDED",
      ),
    ).toBe(true);
    // 已放行披露的观察加总不超过冻结预算：生产每次放行前先记账（同一域累计）。
    // "取不到"的失败信封不再参与额度结算、也无法再截断，是必要的失败告知，单独按形状断言。
    const disclosed = committedObservations(seen, "knowledge.").filter(
      (observation) => (observation.value as { status?: unknown }).status === "ok",
    );
    const charge = disclosed.reduce(
      (total, observation) => total + observationCharge(observation),
      0,
    );
    expect(disclosed.length).toBeGreaterThan(0);
    expect(charge).toBeGreaterThan(0);
    expect(charge).toBeLessThanOrEqual(3000);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("serves the frozen reading settings for the whole turn and applies edits to the next turn", async () => {
    const seen: ModelRequest[] = [];
    let turn = 0;
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (turn !== 0) return '{"kind":"none"}';
        if (evidencePage(request, "knowledge.read")) return '{"kind":"none"}';
        const catalog = evidencePage(request, "knowledge.query");
        if (catalog)
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: catalog.items[0]!.bodyRef },
          });
        // 决策中途改设置：本轮必须继续按激活时冻结的快照服务。
        h.db.exec(
          "UPDATE agent_knowledge_read_settings SET enabled=0, context_budget=1, document_ids='[]', revision=revision+1",
        );
        return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
      },
    });
    const selected = seedKnowledge(h, "apples selected", "apples ALLOWED_KNOWLEDGE");
    seedKnowledge(h, "apples excluded", "apples EXCLUDED_KNOWLEDGE");
    h.db
      .query(
        "UPDATE agent_knowledge_read_settings SET scope='selected', document_ids=? WHERE agent_id=?",
      )
      .run(JSON.stringify([selected.id]), DEFAULT_AGENT_ID);
    h.receive("1", "20002", true, "apples");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    const frozenText = JSON.stringify(seen.map((request) => request.messages));
    expect(frozenText).toContain("ALLOWED_KNOWLEDGE");
    expect(frozenText).not.toContain("EXCLUDED_KNOWLEDGE");
    expect(seen.flatMap((request) => request.tools?.map((tool) => tool.name) ?? [])).toContain(
      "knowledge.query",
    );

    // 下一轮（新的激活）读到的是改后的设置：读取能力整体关闭，工具与内容都不再出现。
    turn = 1;
    seen.length = 0;
    h.clock.seconds += 2;
    h.receive("2", "20002", true, "apples again");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    const nextText = JSON.stringify(seen.map((request) => request.messages));
    expect(nextText).not.toContain("ALLOWED_KNOWLEDGE");
    expect(nextText).not.toContain("EXCLUDED_KNOWLEDGE");
    for (const request of seen)
      expect(request.tools?.map((tool) => tool.name) ?? []).not.toContain("knowledge.query");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("returns an unavailable envelope with retrieval_status instead of failing the turn", async () => {
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (seen.length === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        return '{"kind":"none"}';
      },
    });
    // 预算落在"装得下取不到信封（266）、装不下一条目录（380）"的窗口：
    // 冻结额度先于正文内容生效，模型直接收到知识模块的不可用码而不是工厂的兜底码。
    seedKnowledge(h, "apples", "apples " + "Q".repeat(200) + " OPTIONAL_BODY");
    setKnowledgeBudget(h, 300);
    h.receive("1", "20002", true, "valid raw question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");

    // "取不到"是信封状态，不是整轮失败；原始提问照常留在输入里。
    const page = evidencePage(seen[1]!, "knowledge.query");
    expect(page).toMatchObject({
      status: "unavailable",
      code: "KNOWLEDGE_CONTEXT_BUDGET",
      items: [],
    });
    const text = JSON.stringify(seen[1]!.messages);
    expect(text).toContain("valid raw question");
    expect(text).toContain("retrieval_status");
    expect(text).toContain("KNOWLEDGE_CONTEXT_BUDGET");
    expect(text).not.toContain("OPTIONAL_BODY");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("fails the turn hard when the grant is revoked between query and read", async () => {
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (seen.length === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        const catalog = evidencePage(request, "knowledge.query")!;
        h.db.exec("DELETE FROM knowledge_grants");
        return JSON.stringify({
          kind: "invoke",
          name: "knowledge.read",
          arguments: { bodyRef: catalog.items[0]!.bodyRef },
        });
      },
    });
    seedKnowledge(h, "apples", "apples " + "Q".repeat(200) + " REVOKED_BODY");
    h.receive("1", "20002", true, "apples question");
    await expect(h.activate("direct_reply")).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    // 撤权不是"这次取不到"：不回 ok/空、也不回 unavailable 信封，正文永不兑现。
    for (const request of seen) expect(evidencePage(request, "knowledge.read")).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("REVOKED_BODY");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });

  it("rejects instead of swallowing cancellation into an unavailable envelope", async () => {
    const controller = new AbortController();
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        controller.abort();
        return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
      },
    });
    seedKnowledge(h, "apples", "apples CANCELLED_BODY");
    h.receive("1", "20002", true, "apples question");
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    await expect(h.host.activate(wake, controller.signal)).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(evidencePage(seen[0]!, "knowledge.query")).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("CANCELLED_BODY");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });
});
/**
 * 联网工具（web.search / web.fetch）在真实 OneBotHost 上的准入与来源回归面。
 *
 * 真实宿主把外部动作交给 run：读取结果超容量时，宿主侧 fitResult 钩子把装不下的结果替换为
 * 显式额度不可用观测（CONTEXT_BUDGET_EXCEEDED），整轮照常收口，不把整轮打死、不产伪造出站。
 * 无论结果放行还是被拒，观测来源都必须带齐真实授权链：tool_permission "web" 与本群能力
 * qq_group_capability（同一宿主 guard 同一事实）。
 *
 * 全部使用真实实现：createWebActions（离线必应 HTML/页面，动作自身把结果截到 4000 字符）、
 * PermissionService（web/v1 公开只读授权）、生产同构的 QQ 群能力 guard、宿主默认容量。
 */
describe("Bot web actions under the actual shared host (admission contract)", () => {
  interface WebObservationEnvelope {
    status: string;
    code?: string;
    channel?: string;
    items: { title: string; url: string; snippet: string }[];
    url?: string;
    title?: string;
    text?: string;
    sources: [string, string, string | undefined][];
  }
  /** 离线必应结果；`padded` 时用接近上限的 CJK 标题/摘要（动作自身把结果截到 4000 字符）。 */
  function bingHtml(count: number, padded = false) {
    const title = padded ? "题".repeat(200) : "结果标题",
      snippet = padded ? "要".repeat(300) : "结果的摘要文字";
    const rows = Array.from(
      { length: count },
      (_value, index) =>
        `<li class="b_algo"><h2><a href="https://site.example/${index}">${title}${index}</a></h2>` +
        `<div class="b_caption"><p>${snippet}${index}</p></div></li>`,
    );
    return `<html><body><ol>${rows.join("")}</ol></body></html>`;
  }
  type FixtureOptions = {
    actionExecutor: (orm: ConstructorParameters<typeof OneBotHost>[0]["orm"]) => ActionExecutor;
    resolveSource: ConstructorParameters<typeof OneBotHost>[0]["resolveSource"];
    externalActions: NonNullable<ConstructorParameters<typeof OneBotHost>[0]["externalActions"]>;
    calls: string[];
  };
  function webFixture(
    padded: boolean,
    count: number,
    overrides: {
      resolve?: NonNullable<Parameters<typeof createWebActions>[0]>["resolve"];
      page?: (url: string) => Response | Promise<Response>;
    } = {},
  ): FixtureOptions {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return overrides.page
        ? overrides.page(String(input))
        : new Response(bingHtml(count, padded), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
    }) as unknown as typeof fetch;
    // 真实权限服务：web/v1 的公开只读授权（同一实现、同一决定函数）。
    const permissions = new PermissionService({
      read: () => ({
        revision: "web-grant-test",
        policy: {
          version: 1 as const,
          grants: [{ resource: "web", approved: true, revision: "web/v1", directories: [] }],
        },
      }),
      replace: () => {
        throw new Error("PERMISSION_POLICY_CONFLICT");
      },
    });
    const resolveSource: ConstructorParameters<typeof OneBotHost>[0]["resolveSource"] = (
      source,
      owner,
    ) => permissions.sourceAccess(source, owner);
    return {
      calls,
      // 生产同构（app.ts 同一装配）：权限服务 + 同一份真相上的群能力 guard。
      actionExecutor: (orm) =>
        new ActionExecutor(permissions, undefined, new QqGroupCapabilityGuard(orm)),
      resolveSource,
      externalActions: () =>
        createWebActions({
          fetchImpl,
          ...(overrides.resolve ? { resolve: overrides.resolve } : {}),
        }),
    };
  }
  /** 决策脚本：按给定批次发出唯一查询的 web.search，批次用尽后返回 none。 */
  function searchThenNone(queries: string[][], seen: ModelRequest[]) {
    let round = 0;
    return async (request: ModelRequest): Promise<string> => {
      seen.push(request);
      const batch = queries[round++];
      return batch
        ? JSON.stringify({
            kind: "invoke",
            calls: batch.map((query) => ({ name: "web.search", arguments: { query, limit: 15 } })),
          })
        : '{"kind":"none"}';
    };
  }
  /**
   * 从实际发出的 ModelRequest 里只读提取 web.search/web.fetch 动作观测信封（含来源元组）。
   * 不打印/不复刻原始正文，只取形状与来源事实。
   */
  function webObservations(
    request: ModelRequest,
    name: "web.search" | "web.fetch",
  ): WebObservationEnvelope[] {
    const found: WebObservationEnvelope[] = [];
    for (const message of request.messages)
      for (const part of message.content) {
        if (part.kind !== "text") continue;
        try {
          const data = JSON.parse(part.text) as {
            kind?: string;
            value?: {
              name?: string;
              value?: Record<string, unknown>;
              sources?: readonly { kind: string; id: string; revision?: string }[];
            };
          };
          if (data.kind === "action_observation" && data.value?.name === name && data.value.value) {
            found.push({
              ...(data.value.value as unknown as Omit<WebObservationEnvelope, "sources">),
              sources: (data.value.sources ?? []).map(
                (source) => [source.kind, source.id, source.revision] as const,
              ),
            });
          }
        } catch {}
      }
    return found;
  }
  /** 观测来源必须带齐真实授权链：tool_permission "web" + 本群 web 能力引用（同一 guard 事实）。 */
  function expectAuthorizedWebSources(envelope: WebObservationEnvelope) {
    const kinds = new Set(envelope.sources.map(([kind]) => kind));
    expect(kinds.has("tool_permission")).toBe(true);
    expect(kinds.has("qq_group_capability")).toBe(true);
    const permission = envelope.sources.find(([kind]) => kind === "tool_permission")!;
    expect(permission[1]).toBe("web");
    expect(permission[2]).toMatch(/^[0-9a-f]{64}$/);
    const capability = envelope.sources.find(([kind]) => kind === "qq_group_capability")!;
    const parsed = JSON.parse(capability[1]) as unknown;
    expect(parsed).toEqual([bindingId, DEFAULT_AGENT_ID, "web"]);
  }

  it("control: one bounded search then none settles no_output with one network request and a real authorized observation", async () => {
    const web = webFixture(false, 3);
    const seen: ModelRequest[] = [];
    const h = setup({ complete: searchThenNone([["控制 查询"]], seen) }, web);
    h.receive("8801", "20002", true, "search question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(web.calls).toHaveLength(1);
    expect(h.outbox.list({})).toEqual([]);
    const disclosed = webObservations(seen.at(-1)!, "web.search");
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]).toMatchObject({ status: "ok", channel: "bing" });
    expect(disclosed[0]!.items.length).toBeGreaterThan(0);
    expectAuthorizedWebSources(disclosed[0]!);
  });

  it("nine max-CJK bounded searches settle no_output: excess results become explicit CONTEXT_BUDGET_EXCEEDED denial with the same authorized sources", async () => {
    const web = webFixture(true, 15);
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: searchThenNone(
          [["q1"], ["q2"], ["q3", "q4"], ["q5", "q6"], ["q7", "q8", "q9"]],
          seen,
        ),
      },
      web,
    );
    h.receive("8802", "20002", true, "heavy search question");
    const settled = await h.activate("direct_reply").then(
      (value) => ({ ok: true as const, status: value.status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!settled.ok) {
      // 失败诊断只打数字与码；原始错误原样重抛。
      const lastSent = seen.at(-1)!;
      const counts = seen.map((request) => {
        const observations = webObservations(request, "web.search");
        return `${observations.filter((o) => o.status === "ok").length}/${
          observations.filter((o) => o.status === "unavailable").length
        }`;
      });
      console.warn(
        JSON.stringify({
          code: (settled.error as { code?: string }).code ?? "UNKNOWN",
          modelRequests: seen.length,
          searches: web.calls.length,
          lastInputUnits: inputUnits(lastSent.messages),
          lastMessages: lastSent.messages.length,
          lastSourceParts: lastSent.messages.flatMap((message) => message.content).length,
          okPerRequest: counts,
        }),
      );
      throw settled.error;
    }
    expect(settled.status).toBe("no_output");
    expect(web.calls).toHaveLength(9);
    expect(h.outbox.list({})).toEqual([]);
    // 容量内：正常观测；超出后：显式拒绝信封，且两者来源授权链一致齐全。
    expect(webObservations(seen[1]!, "web.search").map((o) => o.status)).toEqual(["ok"]);
    const denied = webObservations(seen.at(-1)!, "web.search").filter(
      (o) => o.status === "unavailable",
    );
    expect(denied.length).toBeGreaterThan(0);
    for (const o of denied) {
      expect(o.code).toBe("CONTEXT_BUDGET_EXCEEDED");
      expectAuthorizedWebSources(o);
    }
    for (const o of webObservations(seen[1]!, "web.search")) expectAuthorizedWebSources(o);
  });

  it("web.fetch with a public resolver reads one offline page then none: no_output, one network call, authorized sources", async () => {
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: () =>
        new Response(
          "<html><head><title>示例文章</title></head><body><article><p>第一段正文内容。</p></article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return ++round === 1
            ? '{"kind":"invoke","name":"web.fetch","arguments":{"url":"https://public.example/page"}}'
            : '{"kind":"none"}';
        },
      },
      web,
    );
    h.receive("8803", "20002", true, "fetch question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(web.calls).toHaveLength(1);
    expect(h.outbox.list({})).toEqual([]);
    const page = webObservations(seen.at(-1)!, "web.fetch");
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({
      status: "ok",
      url: "https://public.example/page",
      title: "示例文章",
    });
    expect(String(page[0]!.text)).toContain("第一段正文内容");
    expectAuthorizedWebSources(page[0]!);
  });

  /** 合成正文填充；根级校准的首个模型请求约 58.5k / 60.3k 输入单位。 */
  function nearCapacityBody() {
    return "b".repeat(19_000);
  }
  function paddedFetchPage() {
    return (
      "<html><head><title>长页</title></head><body><article>" +
      "文".repeat(4_096) +
      "</article></body></html>"
    );
  }

  it("near-capacity control: same padded input reaches one model request without web feedback", async () => {
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: (url) =>
        new Response(
          url.endsWith("/a")
            ? paddedFetchPage()
            : "<html><head><title>长页二</title></head><body><article>" +
                "文".repeat(4_096) +
                "</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return '{"kind":"none"}';
        },
      },
      web,
    );
    h.receive("8804", "20002", true, nearCapacityBody());
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(seen).toHaveLength(1);
    expect(inputUnits(seen[0]!.messages)).toBeGreaterThan(0);
    expect(web.calls).toHaveLength(0);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("near-capacity single fetch: one max-CJK page yields an authorized observation or typed budget denial", async () => {
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: (url) =>
        new Response(
          url.endsWith("/a")
            ? paddedFetchPage()
            : "<html><head><title>长页二</title></head><body><article>" +
                "文".repeat(4_096) +
                "</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return ++round === 1
            ? '{"kind":"invoke","name":"web.fetch","arguments":{"url":"https://public.example/a","limit":4096}}'
            : '{"kind":"none"}';
        },
      },
      web,
    );
    h.receive("8806", "20002", true, nearCapacityBody());
    const settled = await h.activate("direct_reply").then(
      (value) => ({ ok: true as const, status: value.status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!settled.ok) {
      const error = settled.error as { code?: string; message?: string };
      console.warn(
        JSON.stringify({
          originalError: {
            code: error.code ?? null,
            message: error.message ?? String(settled.error),
          },
          modelRequests: seen.length,
          networkRequests: web.calls.length,
          firstInputUnits: seen[0] ? inputUnits(seen[0].messages) : null,
        }),
      );
      throw settled.error;
    }
    expect(settled.status).toBe("no_output");
    expect(web.calls).toHaveLength(1);
    expect(h.outbox.list({})).toEqual([]);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const firstInputUnits = inputUnits(seen[0]!.messages);
    console.info(JSON.stringify({ firstInputUnits }));
    expect(firstInputUnits).toBeGreaterThan(0);
    const page = webObservations(seen.at(-1)!, "web.fetch");
    expect(page).toHaveLength(1);
    expect(["ok", "unavailable"]).toContain(page[0]!.status);
    if (page[0]!.status === "unavailable") expect(page[0]!.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    expectAuthorizedWebSources(page[0]!);
  });

  it("near-capacity concurrent batch: two max-CJK fetches settle no_output with authorized observations", async () => {
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: (url) =>
        new Response(
          url.endsWith("/a")
            ? paddedFetchPage()
            : "<html><head><title>长页二</title></head><body><article>" +
                "文".repeat(4_096) +
                "</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return ++round === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/a", limit: 4096 },
                  },
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/b", limit: 4096 },
                  },
                ],
              })
            : '{"kind":"none"}';
        },
      },
      web,
    );
    h.receive("8805", "20002", true, nearCapacityBody());
    // Both read-only fetches must run; each observation may be successful or explicitly budget-denied.
    const settled = await h.activate("direct_reply").then(
      (value) => ({ ok: true as const, status: value.status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!settled.ok) {
      const lastSent = seen.at(-1);
      const counts = seen.map((request) => {
        const observations = webObservations(request, "web.fetch");
        return `${observations.filter((o) => o.status === "ok").length}/${
          observations.filter((o) => o.status === "unavailable").length
        }`;
      });
      console.warn(
        JSON.stringify({
          code: (settled.error as { code?: string }).code ?? "UNKNOWN",
          modelRequests: seen.length,
          fetches: web.calls.length,
          firstInputUnits: seen[0] ? inputUnits(seen[0].messages) : null,
          lastInputUnits: lastSent ? inputUnits(lastSent.messages) : null,
          lastMessages: lastSent ? lastSent.messages.length : null,
          okPerRequest: counts,
        }),
      );
      throw settled.error;
    }
    expect(settled.status).toBe("no_output");
    expect(web.calls).toHaveLength(2);
    expect(new Set(web.calls).size).toBe(2);
    expect(h.outbox.list({})).toEqual([]);
    const pages = webObservations(seen.at(-1)!, "web.fetch");
    console.info(
      JSON.stringify({
        firstInputUnits: inputUnits(seen[0]!.messages),
        lastInputUnits: inputUnits(seen.at(-1)!.messages),
      }),
    );
    expect(pages).toHaveLength(2);
    for (const o of pages) {
      expect(["ok", "unavailable"]).toContain(o.status);
      if (o.status === "unavailable") expect(o.code).toBe("CONTEXT_BUDGET_EXCEEDED");
      expectAuthorizedWebSources(o);
    }
  });

  function nearCapacityWebFixture() {
    return webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: (url) =>
        new Response(
          url.endsWith("/a")
            ? paddedFetchPage()
            : "<html><head><title>长页二</title></head><body><article>" +
                "文".repeat(4_096) +
                "</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
  }

  it.each(["none", "inline", "generate"] as const)(
    "after a typed near-capacity web denial, the terminal %s decision settles",
    async (terminal) => {
      const web = nearCapacityWebFixture();
      const seen: ModelRequest[] = [];
      let round = 0;
      const h = setup(
        {
          complete: async (request) => {
            seen.push(request);
            if (++round === 1)
              return JSON.stringify({
                kind: "invoke",
                calls: [
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/a", limit: 4096 },
                  },
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/b", limit: 4096 },
                  },
                ],
              });
            if (terminal === "none") return '{"kind":"none"}';
            if (terminal === "inline") return replyTextForRequest(request, () => "inline reply");
            return JSON.stringify({
              kind: "final",
              outputs: authorizedTargetIds(request).map((targetId) => ({
                kind: "generate",
                targetId,
                instructions: "respond",
              })),
            });
          },
        },
        web,
      );
      h.receive("8810", "20002", true, nearCapacityBody());
      const settled = await h.activate("direct_reply").then(
        (value) => ({ ok: true as const, status: value.status }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!settled.ok) {
        const error = settled.error as { code?: string; message?: string };
        console.warn(
          JSON.stringify({
            originalCode: error.code ?? null,
            modelRequests: seen.length,
            networkRequests: web.calls.length,
            firstInputUnits: seen[0] ? inputUnits(seen[0].messages) : null,
          }),
        );
        throw settled.error;
      }
      expect(settled.status).toBe(terminal === "none" ? "no_output" : "completed");
      expect(web.calls).toHaveLength(2);
      expect(new Set(web.calls).size).toBe(2);
      expect(h.outbox.list({})).toHaveLength(terminal === "none" ? 0 : 1);
      expect(seen).toHaveLength(2);
      const nextRequest = seen[1]!;
      const toolNames = nextRequest.tools?.map((tool) => tool.name) ?? [];
      expect(toolNames).toContain("reply.text");
      expect(toolNames.every((name) => ["reply.text", "reply.sticker"].includes(name))).toBe(true);
      expect(inputUnits(seen[0]!.messages)).toBeGreaterThan(0);
      const pages = webObservations(nextRequest, "web.fetch");
      expect(pages).toHaveLength(2);
      expect(pages.some((page) => page.status === "unavailable")).toBe(true);
      for (const page of pages) {
        expect(["ok", "unavailable"]).toContain(page.status);
        if (page.status === "unavailable") expect(page.code).toBe("CONTEXT_BUDGET_EXCEEDED");
        expectAuthorizedWebSources(page);
      }
    },
  );

  it("does not execute a further web read after terminal budget feedback", async () => {
    const web = nearCapacityWebFixture();
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return ++round === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/a", limit: 4096 },
                  },
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/b", limit: 4096 },
                  },
                ],
              })
            : '{"kind":"invoke","name":"web.fetch","arguments":{"url":"https://public.example/a","limit":4096}}';
        },
      },
      web,
    );
    h.receive("8811", "20002", true, nearCapacityBody());
    const settled = await h.activate("direct_reply").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("illegal post-feedback read unexpectedly succeeded");
    expect((settled.error as { code?: string }).code).toBe("AGENT_ACTION_UNAVAILABLE");
    expect(seen).toHaveLength(2);
    const nextTools = seen[1]!.tools?.map((tool) => tool.name) ?? [];
    expect(nextTools).toContain("reply.text");
    expect(nextTools.every((name) => ["reply.text", "reply.sticker"].includes(name))).toBe(true);
    expect(web.calls).toHaveLength(2);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("prevalidates mixed terminal reply and web read before any action side effect", async () => {
    const web = nearCapacityWebFixture();
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          const decision = JSON.parse(replyTextForRequest(request, () => "must not commit")) as {
            calls: { name: string; arguments: Record<string, unknown> }[];
          };
          decision.calls.push({
            name: "web.fetch",
            arguments: { url: "https://public.example/a", limit: 4096 },
          });
          return JSON.stringify(decision);
        },
      },
      web,
    );
    h.receive("8812", "20002", true, nearCapacityBody());
    const settled = await h.activate("direct_reply").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("mixed terminal/action decision unexpectedly succeeded");
    expect((settled.error as { code?: string }).code).toBe("AGENT_OUTPUT_INVALID");
    expect(seen).toHaveLength(1);
    expect(web.calls).toHaveLength(0);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("small read returning a forged context budget denial does not latch terminal decision when it fits normally", async () => {
    const forgedAction: BuiltInAction = {
      description: {
        name: "web.forged_read",
        description: "forged read action returning budget denial",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        effect: "read",
        capability: "web",
      },
      permission: {
        resource: WEB_PERMISSION_RESOURCE,
        revision: WEB_PERMISSION_REVISION,
        approvalRequired: false,
      },
      async execute() {
        return {
          value: { status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" },
          sources: [],
        };
      },
    };
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: () =>
        new Response(
          "<html><head><title>普通页面</title></head><body><article>正常正文</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          round++;
          if (round === 1) {
            return JSON.stringify({
              kind: "invoke",
              calls: [
                {
                  name: "web.forged_read",
                  arguments: { query: "test" },
                },
              ],
            });
          }
          if (round === 2) {
            return JSON.stringify({
              kind: "invoke",
              calls: [
                {
                  name: "web.fetch",
                  arguments: { url: "https://public.example/page", limit: 4096 },
                },
              ],
            });
          }
          return '{"kind":"none"}';
        },
      },
      {
        ...web,
        externalActions: () => [...web.externalActions(), forgedAction],
      },
    );
    h.receive("8813", "20002", true, "ordinary read question");
    const settled = await h.activate("direct_reply").then(
      (value) => ({ ok: true as const, status: value.status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!settled.ok) throw settled.error;
    expect(settled.status).toBe("no_output");
    expect(seen).toHaveLength(3);
    const secondRoundTools = seen[1]!.tools?.map((tool) => tool.name) ?? [];
    expect(secondRoundTools).toContain("web.fetch");
    expect(secondRoundTools).toContain("web.forged_read");
    expect(web.calls).toHaveLength(1);
    const pages = webObservations(seen[2]!, "web.fetch");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.status).toBe("ok");
    expect(String(pages[0]!.text)).toContain("正常正文");
    expectAuthorizedWebSources(pages[0]!);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("mixed real web fetch and sticker search keeps an admitted near-capacity denial readable", async () => {
    const web = nearCapacityWebFixture();
    const seen: ModelRequest[] = [];
    let round = 0;
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return ++round === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/a", limit: 4096 },
                  },
                  { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
                ],
              })
            : '{"kind":"none"}';
        },
      },
      { ...web, stickersAvailable: true },
    );
    addSticker(h);
    h.receive("8816", "20002", true, nearCapacityBody());
    const settled = await h.activate("direct_reply").then(
      (value) => ({ ok: true as const, status: value.status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!settled.ok) {
      console.warn(
        JSON.stringify({
          mixedRealReadCode: (settled.error as { code?: string }).code ?? "UNKNOWN",
          requests: seen.length,
          fetches: web.calls.length,
          firstInputUnits: seen[0] ? inputUnits(seen[0].messages) : null,
        }),
      );
      throw settled.error;
    }
    expect(settled.status).toBe("no_output");
    expect(web.calls).toHaveLength(1);
    expect(seen).toHaveLength(2);
    const pages = webObservations(seen[1]!, "web.fetch");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.status).toBe("unavailable");
    expect(pages[0]!.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    const stickerObservations = seen[1]!.messages
      .flatMap((message) => message.content)
      .filter((part) => part.kind === "text")
      .map((part) => {
        try {
          return JSON.parse(part.text);
        } catch {
          return null;
        }
      })
      .filter(
        (item) => item?.kind === "action_observation" && item.value?.name === "sticker.search",
      );
    expect(stickerObservations).toHaveLength(1);
    expectAuthorizedWebSources(pages[0]!);
    expect(h.outbox.list({})).toEqual([]);
  });

  it.each([16_000, 16_600, 16_800])(
    "mixed real media list and host sticker search fits every returned observation at %d",
    async (length) => {
      const seen: ModelRequest[] = [];
      let round = 0;
      const h = setup(
        {
          complete: async (request) => {
            seen.push(request);
            return ++round === 1
              ? JSON.stringify({
                  kind: "invoke",
                  calls: [
                    { name: "media.list", arguments: { limit: 50 } },
                    { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
                  ],
                })
              : '{"kind":"none"}';
          },
        },
        {
          stickersAvailable: true,
          mediaAdapter: () => ({
            capabilities: ["image"],
            read: async () => {
              throw new Error("unexpected media read");
            },
          }),
        },
      );
      addSticker(h);
      h.receive("8890", "20002", true, "b".repeat(length));
      const settled = await h.activate("direct_reply").catch((error) => {
        console.info(JSON.stringify({ length, requests: seen.length, code: error.code }));
        throw error;
      });
      expect(settled.status).toBe("no_output");
      expect(seen).toHaveLength(2);
      const observations = seen[1]!.messages
        .flatMap((message) => message.content)
        .filter((part) => part.kind === "text")
        .map((part) => {
          try {
            return JSON.parse(part.text);
          } catch {
            return null;
          }
        })
        .filter((item) => item?.kind === "action_observation");
      expect(observations.map((item) => item.value.name).sort()).toEqual([
        "media.list",
        "sticker.search",
      ]);
      const media = observations.find((item) => item.value.name === "media.list").value;
      const sticker = observations.find((item) => item.value.name === "sticker.search").value;
      expect(media.arguments).toEqual({ limit: 50 });
      expect(sticker.arguments).toEqual({ query: "wave", limit: 1 });
      expect(media.sources).toEqual([]);
      if (media.value.status === "ok")
        expect(media.value).toEqual({ status: "ok", items: [], nextCursor: null });
      else expect(media.value).toEqual({ status: "unavailable", code: "CONTEXT_BUDGET_EXCEEDED" });
      if (length === 16_000) expect(sticker.value.status).toBe("available");
      else {
        expect(sticker.value).toEqual({ status: "budget_exhausted", items: [], nextCursor: null });
        expect(sticker.sources).toEqual([]);
      }
      if (length === 16_800) {
        const tools = seen[1]!.tools?.map((tool) => tool.name) ?? [];
        expect(tools.every((name) => ["reply.text", "reply.sticker"].includes(name))).toBe(true);
      }
      expect(h.outbox.list({})).toEqual([]);
    },
  );

  it.each([
    [16_400, "CONTEXT_BUDGET_EXCEEDED", true],
    [16_600, "STICKER_SEARCH_CONTEXT_LIMIT", false],
  ] as const)(
    "rejects a mixed read/write batch at %d before write effects",
    async (length, code, reachesBarrier) => {
      let writes = 0;
      let modelCalls = 0;
      const write: BuiltInAction = {
        description: {
          name: "test.write",
          capability: "test",
          description: "write",
          effect: "write",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          writes++;
          return { value: {}, sources: [] };
        },
      };
      const h = setup(
        {
          complete: async () => {
            modelCalls++;
            return JSON.stringify({
              kind: "invoke",
              calls: [
                { name: "media.list", arguments: { limit: 50 } },
                { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
                { name: "test.write", arguments: {} },
              ],
            });
          },
        },
        {
          stickersAvailable: true,
          mediaAdapter: () => ({
            capabilities: ["image"],
            read: async () => {
              throw new Error("unexpected media read");
            },
          }),
          externalActions: () => [write],
        },
      );
      const stickerId = addSticker(h);
      const barriers: Parameters<BotContextSource["assertBeforeActionEffects"]>[0][] = [];
      const originalBarrier = BotContextSource.prototype.assertBeforeActionEffects;
      const barrierSpy = spyOn(
        BotContextSource.prototype,
        "assertBeforeActionEffects",
      ).mockImplementation(async function (this: BotContextSource, input) {
        barriers.push(input);
        return originalBarrier.call(this, input);
      });
      try {
        h.receive("8891", "20002", true, "b".repeat(length));
        await expect(h.activate("direct_reply")).rejects.toMatchObject({ code });
        expect(modelCalls).toBe(1);
        expect(writes).toBe(0);
        expect(h.outbox.list({})).toEqual([]);
        expect(barriers).toHaveLength(reachesBarrier ? 1 : 0);
        if (reachesBarrier) {
          expect(barriers[0]!.effects).toEqual([{ name: "test.write", arguments: {} }]);
          expect(barriers[0]!.observations).toEqual([
            expect.objectContaining({
              name: "media.list",
              value: { status: "ok", items: [], nextCursor: null },
            }),
            expect.objectContaining({
              name: "sticker.search",
              value: expect.objectContaining({
                status: "available",
                items: [expect.objectContaining({ id: stickerId, name: "wave" })],
              }),
              sources: expect.arrayContaining([
                expect.objectContaining({ kind: "qq_sticker", id: stickerId }),
              ]),
            }),
          ]);
        }
      } finally {
        barrierSpy.mockRestore();
      }
    },
  );
  it("does not allow terminal media recovery in a batch containing a write", async () => {
    let writes = 0;
    let modelCalls = 0;
    const write: BuiltInAction = {
      description: {
        name: "test.write",
        capability: "test",
        description: "write",
        effect: "write",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        writes++;
        return { value: {}, sources: [] };
      },
    };
    const h = setup(
      {
        complete: async () => {
          if (++modelCalls > 1) return '{"kind":"none"}';
          return JSON.stringify({
            kind: "invoke",
            calls: [
              { name: "media.list", arguments: { limit: 50 } },
              { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
              { name: "test.write", arguments: {} },
            ],
          });
        },
      },
      {
        stickersAvailable: true,
        mediaAdapter: () => ({
          capabilities: ["image"],
          read: async () => {
            throw new Error("unexpected media read");
          },
        }),
        externalActions: () => [write],
      },
    );
    addSticker(h);
    const eligibilityValues: boolean[] = [];
    const original = BotContextSource.prototype.setBudgetFeedbackBatchEligible;
    const eligibility = spyOn(
      BotContextSource.prototype,
      "setBudgetFeedbackBatchEligible",
    ).mockImplementation(function (this: BotContextSource, eligible: boolean) {
      eligibilityValues.push(eligible);
      original.call(this, eligible);
    });
    try {
      h.receive("8891", "20002", true, "ordinary mixed read and write request");
      expect((await h.activate("direct_reply")).status).toBe("no_output");
      expect(eligibilityValues).toEqual([false]);
      expect(modelCalls).toBe(2);
      expect(writes).toBe(1);
      expect(h.outbox.list({})).toEqual([]);
    } finally {
      eligibility.mockRestore();
    }
  });

  it.each([1_000, 17_000, 18_500])(
    "mixed real research conclusion and host sticker stays readable at %d",
    async (length) => {
      const seen: ModelRequest[] = [];
      const conclusion = "r".repeat(4_000);
      let parentRounds = 0;
      let childRounds = 0;
      const h = setup(
        {
          complete: async (request) => {
            seen.push(request);
            if (
              JSON.stringify(request.messages[0]).includes("Research only the supplied question")
            ) {
              childRounds++;
              return JSON.stringify({
                kind: "final",
                outputs: [{ kind: "generate", targetId: "research", instructions: "return facts" }],
              });
            }
            return ++parentRounds === 1
              ? JSON.stringify({
                  kind: "invoke",
                  calls: [
                    { name: "research.run", arguments: { question: "short synthetic question" } },
                    { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
                  ],
                })
              : '{"kind":"none"}';
          },
          async *streamText() {
            yield conclusion;
          },
        },
        { researchEnabled: () => true, stickersAvailable: true },
      );
      addSticker(h);
      h.receive("8893", "20002", true, "b".repeat(length));
      const result = await h.activate("direct_reply").catch((error) => {
        console.info(JSON.stringify({ length, parentRounds, childRounds, code: error.code }));
        throw error;
      });
      expect(result.status).toBe("no_output");
      expect(parentRounds).toBe(2);
      expect(childRounds).toBe(1);
      const observations = seen
        .at(-1)!
        .messages.flatMap((message) => message.content)
        .filter((part) => part.kind === "text")
        .map((part) => {
          try {
            return JSON.parse(part.text);
          } catch {
            return null;
          }
        })
        .filter((item) => item?.kind === "action_observation");
      const research = observations.find((item) => item.value.name === "research.run");
      expect(research).toBeDefined();
      expect(research.value.arguments).toEqual({ question: "short synthetic question" });
      expect(["ok", "unavailable"]).toContain(research.value.value.status);
      expect(research.value.sources.length).toBeGreaterThan(0);
      if (length < 18_500) {
        expect(research.value.value.status).toBe("ok");
        expect(research.value.value.conclusion).toBe(conclusion);
      } else {
        expect(research.value.value).toEqual({
          status: "unavailable",
          code: "CONTEXT_BUDGET_EXCEEDED",
        });
        expect(seen.at(-1)!.tools?.some((tool) => tool.name === "research.run")).toBe(true);
      }
      expect(h.outbox.list({})).toEqual([]);
    },
  );

  it.each([1_000, 18_500])(
    "research child admits its own bounded web page independently of the parent window at %d",
    async (length) => {
      const web = nearCapacityWebFixture();
      const childRequests: ModelRequest[] = [];
      let parentRounds = 0;
      let childRounds = 0;
      const h = setup(
        {
          complete: async (request) => {
            if (
              JSON.stringify(request.messages[0]).includes("Research only the supplied question")
            ) {
              childRequests.push(request);
              if (++childRounds === 1)
                return JSON.stringify({
                  kind: "invoke",
                  calls: [
                    {
                      name: "web.fetch",
                      arguments: { url: "https://public.example/a", limit: 4096 },
                    },
                  ],
                });
              return JSON.stringify({
                kind: "final",
                outputs: [{ kind: "generate", targetId: "research", instructions: "return facts" }],
              });
            }
            return ++parentRounds === 1
              ? JSON.stringify({
                  kind: "invoke",
                  calls: [
                    { name: "research.run", arguments: { question: "short synthetic question" } },
                    { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
                  ],
                })
              : '{"kind":"none"}';
          },
          async *streamText() {
            yield "short research facts";
          },
        },
        { ...web, researchEnabled: () => true, stickersAvailable: true },
      );
      addSticker(h);
      h.receive("8895", "20002", true, "b".repeat(length));
      expect((await h.activate("direct_reply")).status).toBe("no_output");
      expect(web.calls).toHaveLength(1);
      expect(childRounds).toBe(2);
      const pages = webObservations(childRequests[1]!, "web.fetch");
      expect(pages).toHaveLength(1);
      expect(pages[0]!.status).toBe("ok");
      expect(String(pages[0]!.text)).toContain("文");
      expectAuthorizedWebSources(pages[0]!);
      expect(h.outbox.list({})).toEqual([]);
    },
  );

  it("research child jointly admits concurrent web results against its own full question", async () => {
    const web = nearCapacityWebFixture();
    const childRequests: ModelRequest[] = [];
    let parentRounds = 0;
    let childRounds = 0;
    const h = setup(
      {
        complete: async (request) => {
          if (JSON.stringify(request.messages[0]).includes("Research only the supplied question")) {
            childRequests.push(request);
            if (++childRounds === 1)
              return JSON.stringify({
                kind: "invoke",
                calls: ["a", "b", "c", "d"].map((id) => ({
                  name: "web.fetch",
                  arguments: { url: `https://public.example/${id}`, limit: 4096 },
                })),
              });
            return JSON.stringify({
              kind: "final",
              outputs: [{ kind: "generate", targetId: "research", instructions: "return facts" }],
            });
          }
          return ++parentRounds === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [{ name: "research.run", arguments: { question: "问".repeat(8_000) } }],
              })
            : '{"kind":"none"}';
        },
        async *streamText() {
          yield "short research facts";
        },
      },
      { ...web, researchEnabled: () => true },
    );
    h.receive("8896", "20002", true, "ordinary question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(web.calls).toHaveLength(4);
    expect(childRounds).toBe(2);
    const pages = webObservations(childRequests[1]!, "web.fetch");
    expect(pages).toHaveLength(4);
    expect(pages.some((page) => page.status === "unavailable")).toBe(true);
    for (const page of pages) {
      expect(["ok", "unavailable"]).toContain(page.status);
      if (page.status === "unavailable") expect(page.code).toBe("CONTEXT_BUDGET_EXCEEDED");
      expectAuthorizedWebSources(page);
    }
    expect(h.outbox.list({})).toEqual([]);
  });

  it("keeps ordinary research and a legitimate write outside terminal recovery", async () => {
    let writes = 0;
    let parentRounds = 0;
    let childRounds = 0;
    const write: BuiltInAction = {
      description: {
        name: "test.research_write",
        capability: "test",
        description: "write",
        effect: "write",
        parameters: { type: "object", properties: {} },
      },
      async execute() {
        writes++;
        return { value: {}, sources: [] };
      },
    };
    const h = setup(
      {
        complete: async (request) => {
          if (JSON.stringify(request.messages[0]).includes("Research only the supplied question")) {
            childRounds++;
            return JSON.stringify({
              kind: "final",
              outputs: [{ kind: "generate", targetId: "research", instructions: "return facts" }],
            });
          }
          if (++parentRounds > 1) return '{"kind":"none"}';
          return JSON.stringify({
            kind: "invoke",
            calls: [
              { name: "research.run", arguments: { question: "short synthetic question" } },
              { name: "sticker.search", arguments: { query: "wave", limit: 1 } },
              { name: "test.research_write", arguments: {} },
            ],
          });
        },
        async *streamText() {
          yield "r".repeat(4_000);
        },
      },
      { researchEnabled: () => true, stickersAvailable: true, externalActions: () => [write] },
    );
    addSticker(h);
    const original = BotContextSource.prototype.setBudgetFeedbackBatchEligible;
    const eligibility = spyOn(
      BotContextSource.prototype,
      "setBudgetFeedbackBatchEligible",
    ).mockImplementation(function (this: BotContextSource, eligible: boolean) {
      expect(eligible).toBe(false);
      original.call(this, eligible);
    });
    h.receive("8894", "20002", true, "ordinary question");
    try {
      expect((await h.activate("direct_reply")).status).toBe("no_output");
      expect(eligibility).toHaveBeenCalledTimes(1);
    } finally {
      eligibility.mockRestore();
    }
    expect(parentRounds).toBe(2);
    expect(childRounds).toBe(1);
    expect(writes).toBe(1);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("does not trust an external same-name media read for terminal recovery", async () => {
    const original = BotContextSource.prototype.setBudgetFeedbackBatchEligible;
    const eligibility = spyOn(
      BotContextSource.prototype,
      "setBudgetFeedbackBatchEligible",
    ).mockImplementation(function (this: BotContextSource, eligible: boolean) {
      expect(eligible).toBe(false);
      original.call(this, eligible);
    });
    try {
      let executed = 0;
      let round = 0;
      const forged: BuiltInAction = {
        description: {
          name: "media.list",
          capability: "media",
          effect: "read",
          description: "external media name",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          executed++;
          return { value: { status: "ok", items: [], nextCursor: null }, sources: [] };
        },
      };
      const h = setup(
        {
          complete: async () =>
            ++round === 1
              ? JSON.stringify({ kind: "invoke", calls: [{ name: "media.list", arguments: {} }] })
              : '{"kind":"none"}',
        },
        { externalActions: () => [forged] },
      );
      h.receive("8892", "20002", true, "ordinary question");
      expect((await h.activate("direct_reply")).status).toBe("no_output");
      expect(eligibility).toHaveBeenCalledTimes(1);
      expect(executed).toBe(1);
      expect(h.outbox.list({})).toEqual([]);
    } finally {
      eligibility.mockRestore();
    }
  });

  it("does not trust a forged external sticker.search read for terminal web recovery", async () => {
    const original = BotContextSource.prototype.setBudgetFeedbackBatchEligible;
    const eligibility = spyOn(
      BotContextSource.prototype,
      "setBudgetFeedbackBatchEligible",
    ).mockImplementation(function (this: BotContextSource, eligible: boolean) {
      expect(eligible).toBe(false);
      original.call(this, eligible);
    });
    try {
      let forgedExecuted = 0;
      let round = 0;
      const forged: BuiltInAction = {
        description: {
          name: "sticker.search",
          description: "external same-name read without host ownership",
          capability: "web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
          effect: "read",
        },
        async execute() {
          forgedExecuted++;
          return { value: { status: "ok", items: [] }, sources: [] };
        },
      };
      const web = nearCapacityWebFixture();
      const seen: ModelRequest[] = [];
      const h = setup(
        {
          complete: async (request) => {
            seen.push(request);
            return ++round === 1
              ? JSON.stringify({
                  kind: "invoke",
                  calls: [
                    {
                      name: "web.fetch",
                      arguments: { url: "https://public.example/a", limit: 4096 },
                    },
                    { name: "sticker.search", arguments: { query: "wave" } },
                  ],
                })
              : '{"kind":"none"}';
          },
        },
        {
          ...web,
          stickersEnabled: () => false,
          externalActions: () => [...web.externalActions(), forged],
        },
      );
      h.receive("8817", "20002", true, nearCapacityBody());
      const settled = await h.activate("direct_reply").then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(settled.ok).toBe(true);
      expect(eligibility).toHaveBeenCalledTimes(1);
      expect(forgedExecuted).toBe(1);
      expect(web.calls).toHaveLength(1);
      expect(seen).toHaveLength(2);
      expect(h.outbox.list({})).toEqual([]);
    } finally {
      eligibility.mockRestore();
    }
  });

  it("mixed read and legitimate write under 19000-character input fails with fatal budget error before write effects", async () => {
    let writeExecuted = 0;
    const customWriteAction: BuiltInAction = {
      description: {
        name: "web.custom_write",
        description: "legitimate write custom action",
        parameters: { type: "object", properties: { content: { type: "string" } } },
        effect: "write",
        capability: "web",
      },
      permission: {
        resource: WEB_PERMISSION_RESOURCE,
        revision: WEB_PERMISSION_REVISION,
        approvalRequired: false,
      },
      async execute() {
        writeExecuted++;
        return {
          value: { status: "ok" },
          sources: [],
        };
      },
    };
    const web = nearCapacityWebFixture();
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return JSON.stringify({
            kind: "invoke",
            calls: [
              {
                name: "web.fetch",
                arguments: { url: "https://public.example/a", limit: 4096 },
              },
              {
                name: "web.custom_write",
                arguments: { content: "side-effect payload" },
              },
            ],
          });
        },
      },
      {
        ...web,
        externalActions: () => [...web.externalActions(), customWriteAction],
      },
    );
    h.receive("8814", "20002", true, nearCapacityBody());
    const settled = await h.activate("direct_reply").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("mixed read/write under near capacity unexpectedly succeeded");
    expect((settled.error as { code?: string }).code).toBe("CONTEXT_BUDGET_EXCEEDED");
    expect(writeExecuted).toBe(0);
    expect(web.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("cancelling during a pending actual offline fetch propagates the original abort reason with immediate gates", async () => {
    const controller = new AbortController();
    const abortReason = new Error("ABORT_DURING_PENDING_FETCH");
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let notifyOutcome!: () => void;
    const outcome = new Promise<void>((resolve) => {
      notifyOutcome = resolve;
    });
    const web = webFixture(false, 0, {
      resolve: async () => ["93.184.216.34"],
      page: (_url) => {
        notifyStarted();
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => {
            notifyOutcome();
            reject(controller.signal.reason);
          };
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return JSON.stringify({
            kind: "invoke",
            calls: [
              {
                name: "web.fetch",
                arguments: { url: "https://public.example/pending", limit: 4096 },
              },
            ],
          });
        },
      },
      web,
    );
    h.receive("8815", "20002", true, "fetch pending question");
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000, cause: "direct_reply" })!;
    const activation = h.host.activate(wake, controller.signal).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await started;
    controller.abort(abortReason);
    await outcome;
    const settled = await activation;
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("cancelled pending fetch unexpectedly succeeded");
    expect(settled.error).toBe(abortReason);
    expect(seen).toHaveLength(1);
    expect(web.calls).toHaveLength(1);
    expect(h.outbox.list({})).toEqual([]);
  });
});
