import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { ContextEngine } from "../../src/server/agent/context-engine";
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
 * 并发资料 READ 边界的近容量回归（夹具口径同 qq-concurrent-initial-fit）。
 * 合成库/网关/助手自建，不读真实数据、不调模型、不发消息；并发资料走真实生产读取器
 * （pending 的 qq_conversation_tasks 种子），cost/fits 全为生产实现，无 fitter stub。
 * 初始 read 装下全量旧历史与完整并发事实后，同一 peer 侧状态真实增多（第二个在飞任务）
 * 再读：READ 边界必须先按既有窗口裁剪口径裁掉可选旧历史、保最新输入与完整并发事实整体
 * 在场，而不是在还能装下之前就 hard fail。真正装不下时仍合法拒绝（既有回归覆盖）。
 */
const OLD_BODY = (index: number) => `OLDHISTORY${index}-` + "o".repeat(600);
const NEW_BODY = "NEWESTINPUT-" + "n".repeat(40);
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
    name: "concurrent-boundary-fit",
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
    id: "test.concurrent-boundary-fit",
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
  /** 同会话×纪元×Agent 的另一个在飞任务（pending，无租约/到期）；生产读取器的唯一种子面。 */
  const seedPeerTask = (taskId: string) => {
    const at = now;
    handle.db
      .query(
        `INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
          source_from_seq,source_through_seq,status,cancellation_requested,source_expires_at,lease_expires_at,created_at,updated_at,platform_message_id,lease_token)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        taskId,
        `key-${taskId}`,
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
        `platform-${taskId}`,
        null,
      );
  };
  const setCapacity = (capacity: number) => {
    probe.capacity = capacity;
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
  return { ...handle, seed, seedPeerTask, attempt, buildSource, setCapacity, spec };
}

const pendingText = (material: unknown) => {
  const m = material as { history?: unknown[]; pending?: unknown[] };
  return JSON.stringify([...(m.history ?? []), ...(m.pending ?? [])]);
};

/** 二分出「这些消息按当前装配口径装得下且全部标记都在材料里」的最小容量。 */
async function minCapacityWithMarkers(
  seeds: { text: string; age: number }[],
  markers: string[],
  options: { peerTaskIds?: string[] } = {},
): Promise<number> {
  let lo = 1024;
  let hi = 1 << 18;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    for (const taskId of options.peerTaskIds ?? []) handle.seedPeerTask(taskId);
    const result = await handle.attempt(mid);
    const fitted =
      result.ok && markers.every((marker) => pendingText(result.material).includes(marker));
    for (const open of handles.splice(0)) open.close();
    if (fitted) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe("QQ 并发资料 READ 边界的近容量重拟合", () => {
  it("并发状态在两次 read 之间增多时，READ 边界裁掉可选旧历史保住完整并发事实，而不是未拟合先打死", async () => {
    const seeds = [
      ...[0, 1, 2, 3].map((index) => ({ text: OLD_BODY(index), age: 4 - index })),
      { text: NEW_BODY, age: 0 },
    ];
    const oldMarkers = [0, 1, 2, 3].map((index) => `OLDHISTORY${index}`);
    const peerA = "peer-concurrent-task-a";
    const peerB = "peer-concurrent-task-b";
    // 初始容量：全量旧历史 + 第一个并发任务的完整事实包恰好装下 + 小余量（不裁剪）。
    // 增大后的并发包远超该余量，全装不下；唯一可裁的可选材料就是旧历史。
    const capacity =
      (await minCapacityWithMarkers(seeds, [...oldMarkers, "NEWESTINPUT-", peerA], {
        peerTaskIds: [peerA],
      })) + CAPACITY_MARGIN;

    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    handle.seedPeerTask(peerA);

    // 第一次 read：初始容量下全量旧历史与完整并发事实都在场（建立缓存视图）。
    // 后续用同一个 source 实例再读：READ 边界回归钉在缓存视图的刷新路径上。
    const first = await handle.attempt(capacity);
    if (!first.ok) {
      throw new Error(`初始容量 ${capacity} 下首次 read 被打死：${first.code}`);
    }
    const initialPending = pendingText(first.material);
    expect(initialPending).toContain("NEWESTINPUT-");
    expect(initialPending).toContain("qq_concurrent_jobs");
    expect(initialPending).toContain(peerA);
    for (const marker of oldMarkers) expect(initialPending).toContain(marker);

    // 同一 peer 侧真实状态增多：第二个在飞任务让生产并发包真实变大，同一 source 再次 read。
    handle.seedPeerTask(peerB);
    const second = await first.source
      .read({ signal: new AbortController().signal, observations: [] })
      .then((material) => ({ ok: true as const, material }))
      .catch((error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));

    // RED（当前实现）：READ prelude 的并发刷新在还能拟合之前就 CONTEXT_BUDGET_EXCEEDED
    // （发生在 view 重建/窗口裁剪之前）。期望：先按既有窗口裁剪口径裁可选旧历史再拟合。
    if (!second.ok) {
      throw new Error(
        `并发状态增多后 READ 被打死：${second.code}。READ 边界应先按既有窗口裁剪口径` +
          `裁掉可选旧历史、保最新输入与完整并发事实，能装下之前不得 hard fail。`,
      );
    }
    const pending = pendingText(second.material);
    expect(pending).toContain("NEWESTINPUT-");
    // 完整并发事实包（生产读取器的 data_only 投影）必须整体在场：两个 peer 任务都在。
    expect(pending).toContain("qq_concurrent_jobs");
    expect(pending).toContain(peerA);
    expect(pending).toContain(peerB);
    // full 基线连"完整窗口 + 增大后的并发包"都装不下（增长远超余量），唯一可裁的
    // 可选材料就是旧历史：至少一条 OLDHISTORY 必须已被裁掉。
    expect(oldMarkers.some((marker) => !pending.includes(marker))).toBe(true);
  });

  it("动作边界：同一 source 上新增动作观测后，READ/动作共享的 view 边界裁旧历史保并发事实，不死轮", async () => {
    const seeds = [
      ...[0, 1, 2, 3].map((index) => ({ text: OLD_BODY(index), age: 4 - index })),
      { text: NEW_BODY, age: 0 },
    ];
    const oldMarkers = [0, 1, 2, 3].map((index) => `OLDHISTORY${index}`);
    const peerA = "peer-concurrent-task-a";
    const peerB = "peer-concurrent-task-b";
    const capacity =
      (await minCapacityWithMarkers(seeds, [...oldMarkers, "NEWESTINPUT-", peerA], {
        peerTaskIds: [peerA],
      })) + CAPACITY_MARGIN;

    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    handle.seedPeerTask(peerA);
    const first = await handle.attempt(capacity);
    if (!first.ok) {
      throw new Error(`初始容量 ${capacity} 下首次 read 被打死：${first.code}`);
    }
    // 同 peer 侧状态增多后，带着真实新增动作观测（media.list / sticker.search）对
    // 同一 source 再读：共享 view 边界必须以当前材料 + 当前观测现量重拟合，裁可选
    // 旧历史保住完整并发事实，而不是失败。
    handle.seedPeerTask(peerB);
    const second = await first.source
      .read({
        signal: new AbortController().signal,
        observations: [
          {
            id: crypto.randomUUID(),
            name: "media.list",
            arguments: {},
            value: { status: "ok", items: [] },
            sources: [],
          },
          {
            id: crypto.randomUUID(),
            name: "sticker.search",
            arguments: { query: "boundary" },
            value: { status: "ok", text: "r" },
            sources: [],
          },
        ],
      })
      .then((material) => ({ ok: true as const, material }))
      .catch((error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));
    if (!second.ok) {
      throw new Error(
        `动作边界后并发状态增多 READ 被打死：${second.code}。共享 view 边界应重拟合` +
          `（裁可选旧历史）而不是失败。`,
      );
    }
    const pending = pendingText(second.material);
    expect(pending).toContain("NEWESTINPUT-");
    expect(pending).toContain("qq_concurrent_jobs");
    expect(pending).toContain(peerA);
    expect(pending).toContain(peerB);
    expect(oldMarkers.some((marker) => !pending.includes(marker))).toBe(true);
    // 同档去重：decisionTier=reply 时 fitter 对同一档只走一次 view 边界（现读一次）。
    let projectionReads = 0;
    const originalSteps = first.source["readConcurrentJobsFactSteps"].bind(first.source);
    const observed = first.source as unknown as {
      readConcurrentJobsFactSteps: typeof originalSteps;
    };
    observed.readConcurrentJobsFactSteps = function* (...args: Parameters<typeof originalSteps>) {
      projectionReads++;
      return yield* originalSteps(...args);
    };
    const fit = await first.source.actionResultFitter(
      "web.fetch",
      { url: "https://public.example/dedupe" },
      new AbortController().signal,
      true,
    );
    expect(fit({ status: "ok", text: "small" }, [])).toBe(true);
    expect(projectionReads).toBe(1);
  });

  it("生成相边界：并发状态增多后共享 view 边界重拟合不死轮", async () => {
    const seeds = [
      ...[0, 1, 2, 3].map((index) => ({ text: OLD_BODY(index), age: 4 - index })),
      { text: NEW_BODY, age: 0 },
    ];
    const oldMarkers = [0, 1, 2, 3].map((index) => `OLDHISTORY${index}`);
    const peerA = "peer-concurrent-task-a";
    const peerB = "peer-concurrent-task-b";
    const capacity =
      (await minCapacityWithMarkers(seeds, [...oldMarkers, "NEWESTINPUT-", peerA], {
        peerTaskIds: [peerA],
      })) + CAPACITY_MARGIN;
    const handle = setup();
    for (const item of seeds) handle.seed(item.text, item.age);
    handle.seedPeerTask(peerA);
    const first = await handle.attempt(capacity);
    if (!first.ok) throw new Error(`首次 read 失败：${first.code}`);
    handle.seedPeerTask(peerB);
    const prepared = await first.source.prepareGeneration(
      { kind: "generate", targetId: "alice", instructions: "answer" },
      {
        context: new ContextEngine().render(handle.spec, first.material, [], ["alice"]),
        outputId: "generated-output",
        signal: new AbortController().signal,
      },
    );
    if (!prepared.context) throw new Error("Expected prepared generation context");
    const text = prepared.context.messages
      .flatMap((m) => m.content.flatMap((p) => (p.kind === "text" ? [p.text] : [])))
      .join("");
    expect(text).toContain(peerB);
    expect(oldMarkers.some((marker) => !text.includes(marker))).toBe(true);
  });

  it("真正不可拟合仍合法拒绝：并发事实超出全部容量时 READ 失败", async () => {
    const handle = setup();
    handle.seed(NEW_BODY, 0);
    handle.seedPeerTask("peer-a");
    const rejected = await handle.attempt(1024);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.code).toBe("CONTEXT_BUDGET_EXCEEDED");
  });
});
