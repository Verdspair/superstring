import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import {
  BotContextSource,
  type BotContextSourceOptions,
} from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

/**
 * 并发任务资料与初始装配预算的近容量回归（夹具口径同 qq-context-budget-diagnostics）。
 * 合成库/网关/助手自建，不读真实数据、不调模型、不发消息；并发资料走真实生产读取器
 * （一行 pending 的 qq_conversation_tasks 种子），cost/fits 全为生产实现。
 * 初始装配必须从窗口/整包拟合起就计入并发资料：裁可选旧历史保最新输入与完整并发事实，
 * 不 late append 打死 final_fit；真正强制超限仍合法拒绝。
 */
const OLD_BODY = (index: number) => `OLDHISTORY${index}-` + "o".repeat(600);
const NEW_BODY = "NEWESTINPUT-" + "n".repeat(40);
const PEER_TASK_ID = "peer-concurrent-task";
const CAPACITY_MARGIN = 16;

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const FIXED_SECONDS = Math.floor(Date.now() / 1000);
const FIXED_NOW = new Date(FIXED_SECONDS * 1000).toISOString();

function setup() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "reply-model");
  const seconds = FIXED_SECONDS;
  const now = FIXED_NOW;
  updateQqSettings(handle.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(handle.orm, {
    name: "concurrent-initial-fit",
    context: { ...QQ_CONTEXT_DEFAULT },
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
  const binding = insertQqBinding(handle.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(handle.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  const journal = new ConversationEventRepository(handle.db);
  const outbox = new OutboundIntentRepository(handle.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const probe = { capacity: 65536 };
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => probe.capacity,
    complete: async () => '{"facts":[]}',
    async *streamChat() {
      yield "unused";
    },
  };
  const spec: AgentSpec = {
    id: "test.concurrent-fit",
    model: "reply-model",
    context: "conversation",
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16 },
  };
  const buildSource = (onDiagnostic?: BotContextSourceOptions["onDiagnostic"]) =>
    new BotContextSource({
      ...handle,
      gateway,
      agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(handle.db) }),
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
      ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    });
  const seed = (text: string, age = 0) => {
    const eventKey = crypto.randomUUID();
    handle.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqMessageFacts)
      .values({
        eventKey,
        legacyDisplayName: "member",
        nameState: "legacy",
        parts: JSON.stringify([{ kind: "text", text }]),
        revision: 1,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(eventKey, binding.id);
    return eventKey;
  };
  /** 同会话×纪元×Agent 的另一个在飞任务（pending，无租约/到期）；生产读取器唯一的种子面。 */
  const seedPeerTask = () => {
    const at = now;
    handle.db
      .query(
        `INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
          source_from_seq,source_through_seq,status,cancellation_requested,source_expires_at,lease_expires_at,created_at,updated_at,platform_message_id,lease_token)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        PEER_TASK_ID,
        `key-${PEER_TASK_ID}`,
        conversation.id,
        1,
        DEFAULT_AGENT_ID,
        "mention",
        "direct_reply",
        1,
        1,
        "pending",
        0,
        null,
        null,
        at,
        at,
        `platform-${PEER_TASK_ID}`,
        null,
      );
  };
  const attempt = (
    capacity: number,
    options: { onDiagnostic?: BotContextSourceOptions["onDiagnostic"] } = {},
  ) => {
    probe.capacity = capacity;
    const source = buildSource(options.onDiagnostic);
    return source
      .read({ signal: new AbortController().signal, observations: [] })
      .then((material) => ({ ok: true as const, source, material }))
      .catch((error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));
  };
  return { ...handle, seed, seedPeerTask, attempt };
}

const pendingText = (material: unknown) => {
  const m = material as { history?: unknown[]; pending?: unknown[] };
  return JSON.stringify([...(m.history ?? []), ...(m.pending ?? [])]);
};

/** 二分出「这些消息按当前装配口径装得下且全部标记都在材料里」的最小容量。 */
async function minCapacityWithMarkers(
  seeds: { text: string; age: number }[],
  markers: string[],
  options: { peer?: boolean } = {},
): Promise<number> {
  let lo = 1024;
  let hi = 1 << 18;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    if (options.peer) handle.seedPeerTask();
    const result = await handle.attempt(mid);
    const fitted =
      result.ok && markers.every((marker) => pendingText(result.material).includes(marker));
    for (const open of handles.splice(0)) open.close();
    if (fitted) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe("QQ 并发任务资料的初始装配预算", () => {
  it("近容量时裁掉可选旧历史也要保住最新输入与完整并发事实，而不是 late append 打死 final_fit", async () => {
    const seeds = [
      ...[0, 1, 2, 3].map((index) => ({ text: OLD_BODY(index), age: 4 - index })),
      { text: NEW_BODY, age: 0 },
    ];
    const oldMarkers = [0, 1, 2, 3].map((index) => `OLDHISTORY${index}`);
    // 基线：无并发任务时，全部旧历史 + 最新输入恰好装得下的最小容量。
    const full = await minCapacityWithMarkers(seeds, oldMarkers);
    const capacity = full + CAPACITY_MARGIN;

    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    handle.seedPeerTask();
    const result = await handle.attempt(capacity);

    if (!result.ok) {
      throw new Error(
        `容量 ${capacity}（无并发基线 ${full} + ${CAPACITY_MARGIN}）下装配被 ${result.code} 打死；` +
          `并发资料应在窗口/整包拟合口径内从初始就计入，裁掉可选旧历史后必然装得下。`,
      );
    }
    const pending = pendingText(result.material);
    expect(pending).toContain("NEWESTINPUT-");
    // 完整并发事实包（生产读取器的 data_only 投影）必须整体在场。
    expect(pending).toContain("qq_concurrent_jobs");
    expect(pending).toContain(PEER_TASK_ID);
    // full + 16 连"完整窗口 + 并发资料"都装不下（并发包远大于 16 字节），唯一可裁的
    // 可选材料就是旧历史：至少一条 OLDHISTORY 必须已被裁掉。
    expect(oldMarkers.some((marker) => !pending.includes(marker))).toBe(true);
  });

  it("真正的强制超限仍然合法拒绝：最新输入 + 并发资料 + 协议都装不下时 CONTEXT_BUDGET_EXCEEDED", async () => {
    const handle = setup();
    handle.seed(NEW_BODY, 0);
    handle.seedPeerTask();
    const rejected = await handle.attempt(1024);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.code).toBe("CONTEXT_BUDGET_EXCEEDED");
  });
});
