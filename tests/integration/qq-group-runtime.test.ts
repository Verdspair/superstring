import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import type { BotCompressionJob } from "../../src/server/channels/onebot11/background-compression";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { failureCode } from "../../src/server/channels/onebot11/failure-code";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { readQqBinding, saveQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readEffectiveQqScheme,
  readQqGroupAgentConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeContext,
  schemePrompts,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import type { OneBotSendRequest } from "../../src/server/services/onebot-connection";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { updateQqBinding } from "../../src/server/services/qq-binding-contract";
import { recordInbound } from "../../src/server/services/qq-intake";
import type { QqSendPort } from "../../src/server/services/qq-send-transport";
import type { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type {
  QqGroupCapability,
  QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { decideInline, decideInvoke } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst, lastActionObservation } from "../harness/scenarios";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** 保存本群配置（整份提交的比较交换）：只改传进来的那一组，其余沿用当前值。 */
function setGroupConfig(
  orm: Orm,
  bindingId: string,
  change: { capabilities?: QqGroupCapability[]; overrides?: QqGroupSchemeOverrides },
) {
  const binding = readQqBinding(orm, bindingId);
  if (!binding) throw new Error("missing binding");
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme) throw new Error("missing scheme");
  const current = readQqGroupAgentConfig(orm, binding);
  return updateQqGroupConfig(orm, {
    bindingId,
    payload: {
      agent_id: binding.agentId,
      expected_binding_revision: binding.revision,
      expected_scheme_revision: scheme.revision,
      expected_revision: current.revision,
      overrides: { ...current.overrides, ...change.overrides },
      disabled_capabilities: change.capabilities ?? current.disabled_capabilities,
    },
  });
}

/**
 * 用真实 guard 签发一条当前能力来源：动作名按真实注册名（`memory.query`/`sticker.search`…）。
 * 修订是"停用纪元"的十进制串，不写死成 enabled/disabled 这类兼容值。
 */
function capabilityRef(h: OneBotHarness, actionName: string): SourceRef {
  const guard = new QqGroupCapabilityGuard(h.orm);
  const refs = guard.actionSources(
    { description: { name: actionName } } as unknown as Parameters<
      QqGroupCapabilityGuard["actionSources"]
    >[0],
    { kind: "qq_binding", id: h.bindingId, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
  );
  const ref = refs[0];
  if (ref === undefined) throw new Error(`capability source missing for ${actionName}`);
  return ref;
}

/** 走真实保存路径暂停本群（与 PUT /bindings 同构）：paused 与 revision 一起推进，不做裸 SQL。 */
function pauseGroup(orm: Orm): void {
  const current = readQqBinding(orm, BINDING_ID);
  if (current === null) throw new Error("missing binding");
  const result = updateQqBinding(current, { paused: true }, current.revision);
  if (result.kind !== "saved") throw new Error(`pause not saved: ${result.kind}`);
  saveQqBinding(orm, { binding: result.binding, expectedRevision: current.revision });
}

/** 走 create-runtime 装配的投递链：排队意图 → 授权复核 → 素材复核 → 发送。 */
function openDelivery(h: OneBotHarness) {
  const agentRuntime = new AgentRuntime({
    repository: h.runs,
    now: () => h.now(),
    model: {
      complete: async () => '{"kind":"none"}',
      async *streamText() {
        yield "";
      },
      completeMultimodal: async () => "",
    },
  });
  const sent: OneBotSendRequest[] = [];
  const runtime = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    journal: h.journal,
    agentRuntime,
    host: new ConversationHost({ runtime: agentRuntime }),
    gateway: {
      complete: async () => {
        throw new Error("DIRECT_GATEWAY_FORBIDDEN");
      },
      loadedContextCapacity: async () => 65536,
    },
    store: {
      copyExists: () => true,
      readCopy: () => new Uint8Array([1, 2, 3]),
    } as unknown as QqStickerStore,
    port: {
      async send(request) {
        sent.push(request);
        return { kind: "confirmed", messageId: `mock-${sent.length}` };
      },
    } satisfies QqSendPort,
    wake: () => {},
  });
  return { runtime, sent };
}

/** 排队一条出站意图：目标快照按当前绑定/方案取值，交付窗口用真实时钟（投递器不注入时钟）。 */
function queueIntent(
  h: OneBotHarness,
  runtime: ReturnType<typeof openDelivery>["runtime"],
  parts: ({ kind: "sticker"; stickerId: string } | { kind: "text"; text: string })[],
  sources: SourceRef[] = [],
) {
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("missing binding");
  const scheme = readQqScheme(h.orm, binding.schemeId);
  if (!scheme) throw new Error("missing scheme");
  const agent = getAgentRow(h.orm, binding.agentId);
  if (!agent) throw new Error("missing agent");
  const conversation = h.journal.get(h.conversationId);
  if (!conversation) throw new Error("missing conversation");
  const realNow = Date.now();
  const runId = crypto.randomUUID();
  h.runs.createRun({
    runId,
    specId: "onebot.reply",
    specVersion: "0.4.0",
    owner: {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: binding.agentId,
    },
    at: new Date(realNow).toISOString(),
  });
  const target: OutboundTarget = {
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
    bindingId: binding.id,
    bindingEpoch: conversation.bindingEpoch,
    bindingRevision: binding.revision,
    authorityRevision: binding.authorityRevision,
    ownerIdentityRevision: null,
    schemeId: binding.schemeId,
    schemeRevision: scheme.revision,
    agentConfigVersion: agent.configVersion,
    sources,
  };
  const delivery = runtime.outbox.commit({
    runId,
    conversationId: conversation.id,
    ordinal: 0,
    target,
    speechKind: "direct_reply",
    sourceThroughSeq: h.observedSeq(),
    deliverBy: new Date(realNow + 600_000).toISOString(),
    createdAt: new Date(realNow).toISOString(),
    expiresAt: new Date(realNow + 3_600_000).toISOString(),
    parts,
  });
  return delivery.id;
}

function stickerAsset(orm: Orm, collectionIds: string[]): string {
  const id = crypto.randomUUID();
  importQqSticker(orm, {
    id,
    copy: { fileName: `${id}.png`, byteSize: 128, mediaType: "image" },
    name: "素材.png",
    width: 64,
    height: 64,
    collectionIds,
  });
  setQqStickerEnabled(orm, id, true);
  return id;
}

/** 群聊宿主夹具：真实工作库 + 后台压缩任务捕获 + 压缩模型可阻塞。 */
function compressionGroup() {
  const clock = { seconds: 2_000_000_000 };
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const handle = openBusinessDb();
  handles.push(handle);
  const { db, orm } = handle;
  ensureDefaults(orm, "chat-model");
  updateQqSettings(orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(orm, {
    name: "compress-group",
    reply: { split_by_speaker: true },
    triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
  });
  orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  const journal = new ConversationEventRepository(db);
  const wakes = new WakeRepository(db);
  const outbox = new OutboundIntentRepository(db);
  const runs = new AgentRunRepository(db);
  let job: BotCompressionJob | undefined;
  let compressions = 0;
  let gate: (() => Promise<void>) | null = null;
  const runtime = new AgentRuntime({
    repository: runs,
    now,
    model: {
      complete: async (request) => {
        if (request.responseSchema?.$defs) {
          compressions += 1;
          await gate?.();
          const part = request.messages[1]?.content.find((entry) => entry.kind === "text");
          const data = JSON.parse(part?.kind === "text" ? part.text : "{}") as {
            events: { id: string; speaker: string }[];
          };
          return JSON.stringify({
            facts: data.events.map((entry) => ({
              kind: "fact",
              speaker: entry.speaker,
              text: "旧事实",
              source_ids: [entry.id],
            })),
          });
        }
        // 群聊判断档只出意图：回复档（水位压缩任务挂在这里）要等 generate 才物化。
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"20002","instructions":"respond"}]}';
      },
      async *streamText() {
        yield "收到";
      },
      completeMultimodal: async () => "",
    },
  });
  const gateway = {
    loadedContextCapacity: async () => 65536,
    complete: async () => {
      throw new Error("DIRECT_GATEWAY_FORBIDDEN");
    },
  };
  const adapter = new OneBot11Adapter({ orm, journal, wakes, nowSeconds: () => clock.seconds });
  const host = new OneBotHost({
    orm,
    journal,
    wakes,
    outbox,
    agentRuntime: runtime,
    gateway,
    stickers: { counts: ["confirmed"], isAvailable: () => false },
    enqueueCompression: (value) => {
      job = value;
    },
    policy: () => ({ maxSteps: 12, deliveryTtlSeconds: 600 }),
    now,
  });
  const receive = (id: string, text: string) =>
    recordInbound(
      orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: 20002,
          message_id: id,
          group_id: 30003,
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text } },
          ],
          sender: { nickname: "甲" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  // 调度器语义：把当前到点的唤醒全部跑完（可能不止一条）。
  const runWakes = async () => {
    let count = 0;
    for (;;) {
      const wake = wakes.claim({ at: now(), leaseMs: 120_000 });
      if (!wake) break;
      await host.activate(wake, new AbortController().signal);
      count += 1;
    }
    return count;
  };
  return {
    handle,
    db,
    orm,
    clock,
    scheme,
    journal,
    wakes,
    outbox,
    receive,
    runWakes,
    job: () => job,
    compressions: () => compressions,
    setGate: (value: (() => Promise<void>) | null) => {
      gate = value;
    },
  };
}

describe("本群生效方案真的进入运行时取值面", () => {
  it("场景提示词、节奏与上下文预算按本群差异生效，合并窗口改变唤醒就绪时刻", async () => {
    const scene = "GROUP-SCENE-MARKER-4101";
    const h = createOneBotHarness({ model: [decideInline("20002", "在的", [])] });
    setGroupConfig(h.orm, h.bindingId, {
      overrides: {
        prompts: { scene },
        rhythm: { merge_window_seconds: 30 },
        context: { reply_token_budget: 12_345 },
      },
    });
    const binding = readQqBinding(h.orm, h.bindingId)!;
    const base = readQqScheme(h.orm, binding.schemeId)!;
    const effective = readEffectiveQqScheme(h.orm, binding)!;
    // 差异真的落在生效值上，而基础方案保持不动。
    expect(schemePrompts(effective).scene).toBe(scene);
    expect(schemePrompts(base).scene).not.toBe(scene);
    expect(schemeRhythm(effective).merge_window_seconds).toBe(30);
    expect(schemeRhythm(base).merge_window_seconds).toBe(2);
    expect(schemeContext(effective).reply_token_budget).toBe(12_345);

    // 非即时路径（自主接话）的合并窗口取本群生效值：30 秒内领不到，30 秒后可领。
    h.receive({ id: "1", speaker: "20002", text: "随便说说" });
    const wantAt = (seconds: number) => new Date((h.clock.seconds + seconds) * 1000).toISOString();
    expect(h.wakes.peek({ at: wantAt(5) })).toBeNull();
    expect(h.wakes.peek({ at: wantAt(31) })).not.toBeNull();

    // 直接回应是即时路径：提示词与预算仍按本群生效值装配到决策上下文。
    h.receive({ id: "2", speaker: "20002", addressed: true, text: "在吗" });
    h.advance(31);
    const result = await h.activate("direct_reply");
    expect(result).not.toBeNull();
    await h.deliver();
    expect(h.sent).toHaveLength(1);
    expect(h.model!.calls.some((call) => call.text.includes(scene))).toBe(true);
  });

  it("媒体说明与帧参数按本群差异生效：视觉调用拿到本群提示词", async () => {
    const media = "GROUP-MEDIA-MARKER-4102";
    const h = createOneBotHarness({ vision: ["图里是一只猫"], model: [] });
    setGroupConfig(h.orm, h.bindingId, {
      overrides: { prompts: { media }, rhythm: { media_frame_count: 2 } },
    });
    const binding = readQqBinding(h.orm, h.bindingId)!;
    expect(schemeRhythm(readEffectiveQqScheme(h.orm, binding)!).media_frame_count).toBe(2);

    // 图 ID 必须来自 media.list 的真实返回：描述与分页读取都按同一张图走完。
    let mediaId: string | null = null;
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.list") {
        const id = observation.value?.items?.[0]?.id;
        if (id === undefined) throw new Error("missing listed image");
        mediaId = id;
        return [decideInvoke("media.describe", { id })];
      }
      if (observation?.name === "media.describe") {
        if (mediaId === null) throw new Error("missing media id");
        return [decideInvoke("media.note.read", { id: mediaId })];
      }
      if (observation?.name === "media.note.read") return [decideInline("20002", "图里是猫", [])];
      return null;
    });
    h.model?.push([decideInvoke("media.list", {})]);
    h.receive({ id: "1", speaker: "20002", addressed: true, image: "upstream-1", text: "看图" });
    await h.activate("direct_reply");
    await h.deliver();
    expect(h.visionCalls[0]?.prompt).toBe(media);
    expect(h.sent).toHaveLength(1);
  });
});

describe("系统能力中途停用", () => {
  it("停用记忆读取后：查询在硬边界被拒，整轮失败关闭，不发送", async () => {
    const h = createOneBotHarness({ model: [] });
    h.memory("金额是八十元", { name: "订单金额", summary: "订单金额" });
    const scripted = h.model!;
    const original = scripted.port.complete;
    let flipped = false;
    // 决策请求已经带着当时的工具目录出去；返回之前才停用。
    scripted.port.complete = async (request) => {
      if (!flipped && (request.tools ?? []).some((tool) => tool.name === "memory.query")) {
        flipped = true;
        setGroupConfig(h.orm, h.bindingId, { capabilities: ["memory_read"] });
      }
      return original(request);
    };
    h.restart();
    // 这一轮在 execute 硬边界整轮失败，脚本只有这一次调用会被消费。
    scripted.push([decideInvoke("memory.query", { query: "订单金额" })]);
    h.receive({ id: "1", speaker: "20002", addressed: true, text: "订单金额是多少" });
    let code: string | undefined;
    try {
      await h.activate("direct_reply");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    await h.deliver();
    // 目录在决策时仍可见（停用发生在目录装配之后），但执行点是硬边界：
    // guard 直接拒绝整轮，不回到模型，也不降级成"取不到"的信封。
    expect(h.model!.calls[0]?.tools).toContain("memory.query");
    expect(code).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(h.model!.calls).toHaveLength(1);
    expect(h.sent).toHaveLength(0);

    // 下一轮：目录里已经不再出现记忆工具，模型提出调用也立不住。
    scripted.push([decideInvoke("memory.query", { query: "订单金额" })]);
    h.advance(3);
    h.receive({ id: "2", speaker: "20002", addressed: true, text: "再查一次" });
    let second: string | undefined;
    try {
      await h.activate("direct_reply");
    } catch (error) {
      second = (error as { code?: string }).code;
    }
    expect(second).toBe("AGENT_ACTION_UNAVAILABLE");
    expect(h.model!.calls.at(-1)?.tools ?? []).not.toContain("memory.query");
    expect(h.sent).toHaveLength(0);
  });

  it("停用后仍在飞的正文读取被硬拒：整轮失败关闭，不发送", async () => {
    const h = createOneBotHarness({ model: [] });
    h.memory("金额是八十元", { name: "订单金额", summary: "订单金额" });
    const scripted = h.model!;
    driveToolFirst(h, (observation) => {
      if (observation?.name === "memory.query") {
        const item = observation.value?.items?.[0] as { bodyRef?: string } | undefined;
        if (item?.bodyRef !== undefined)
          return [decideInvoke("memory.read", { bodyRef: item.bodyRef, offset: 0, limit: 4096 })];
      }
      return null;
    });
    // 读取决策拿到候选之后、返回之前停用：正文读取这一硬边界必须整轮拒绝。
    const inner = scripted.port.complete;
    let flipped = false;
    scripted.port.complete = async (request) => {
      const observation = lastActionObservation(request.messages);
      if (!flipped && observation?.name === "memory.query" && observation.value?.status === "ok") {
        flipped = true;
        setGroupConfig(h.orm, h.bindingId, { capabilities: ["memory_read"] });
      }
      return inner(request);
    };
    h.restart();
    scripted.push([decideInvoke("memory.query", { query: "订单金额" })]);
    h.receive({ id: "1", speaker: "20002", addressed: true, text: "订单金额是多少" });
    let code: string | undefined;
    try {
      await h.activate("direct_reply");
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    await h.deliver();
    // 查询本身已返回候选（被拒的是后面的执行点）：至少两次决策——查询一次、读取一次。
    expect(h.model!.calls[0]?.tools).toContain("memory.query");
    expect(h.model!.calls.length).toBeGreaterThanOrEqual(2);
    expect(code).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(h.sent).toHaveLength(0);
  });

  it("排队回复携带的能力来源：停用后投递不再落地，旧纪元与任意状态串都不翻回可用", async () => {
    const h = createOneBotHarness({ model: [] });
    const { runtime, sent } = openDelivery(h);
    // 真实 guard 签发的当前引用随结果入队：绑定、助手与当前纪元都对齐，投递放行。
    const current = capabilityRef(h, "memory.query");
    const good = queueIntent(h, runtime, [{ kind: "text", text: "有依据的回复" }], [current]);
    expect(await runtime.delivery.runOnce()).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(runtime.outbox.get(good)?.status).toBe("confirmed");

    // 同一条引用（签发时有效），本群先停用再排队：来源失效，投递不得再落地。
    setGroupConfig(h.orm, h.bindingId, { capabilities: ["memory_read"] });
    const revoked = queueIntent(h, runtime, [{ kind: "text", text: "引用已失效" }], [current]);
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(revoked)?.status).toBe("stale");
    expect(sent).toHaveLength(1);

    // 停用后再恢复：旧纪元引用不复活（关闭再恢复不翻回可用）。
    setGroupConfig(h.orm, h.bindingId, { capabilities: [] });
    const oldEpoch = queueIntent(h, runtime, [{ kind: "text", text: "旧纪元引用" }], [current]);
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(oldEpoch)?.status).toBe("stale");
    expect(sent).toHaveLength(1);

    // 任意状态串（旧版硬编码的 enabled/disabled 这类）不是纪元串：一律按撤权处理。
    const arbitrary = queueIntent(
      h,
      runtime,
      [{ kind: "text", text: "任意状态串" }],
      [
        {
          kind: "qq_group_capability",
          id: JSON.stringify([BINDING_ID, DEFAULT_AGENT_ID, "memory_read"]),
          revision: "enabled",
        },
      ],
    );
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(arbitrary)?.status).toBe("stale");
    expect(sent).toHaveLength(1);
  });
});

describe("后台压缩的暂停与停用边界", () => {
  it("排队中的压缩任务在群暂停后失败，不开始模型调用、不写摘要", async () => {
    const h = compressionGroup();
    h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
    h.clock.seconds -= 30_000;
    h.receive("1", "旧问题");
    h.clock.seconds += 30_000;
    h.receive("2", "新问题");
    h.clock.seconds += 3;
    await h.runWakes();
    const job = h.job();
    if (!job) throw new Error("missing background job");

    // 暂停走真实保存路径（paused 与 revision 同步推进）；排队中的任务仍必须先过启动闸门。
    pauseGroup(h.orm);
    let code: string | undefined;
    try {
      await job.run(new AbortController().signal);
    } catch (error) {
      code = failureCode(error, { pattern: /^[A-Z][A-Z_]+$/, allowErrorCode: true });
    }
    expect(code).toBe("CONVERSATION_PAUSED");
    expect(h.compressions()).toBe(0);
    expect(h.db.query("SELECT count(*) AS n FROM qq_conversation_summaries").get()).toEqual({
      n: 0,
    });
  });

  it("已经开始的压缩任务跨暂停照旧完成并发布摘要", async () => {
    const h = compressionGroup();
    h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
    h.clock.seconds -= 30_000;
    h.receive("1", "旧问题");
    h.clock.seconds += 30_000;
    h.receive("2", "新问题");
    h.clock.seconds += 3;
    await h.runWakes();
    const job = h.job();
    if (!job) throw new Error("missing background job");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setGate(() => blocked);
    const run = job.run(new AbortController().signal);
    await waitUntil(() => h.compressions() === 1);
    // 任务已经在飞：暂停经真实保存路径落库（revision 真的涨了），只拦排队中的任务，
    // 不杀在跑的任务——发布阶段的既有边界不含 paused/revision。
    const before = readQqBinding(h.orm, BINDING_ID)!;
    pauseGroup(h.orm);
    const after = readQqBinding(h.orm, BINDING_ID)!;
    expect(after.paused).toBe(true);
    expect(after.revision).toBeGreaterThan(before.revision);
    h.setGate(null);
    release();
    await run;
    expect(h.db.query("SELECT through_seq FROM qq_conversation_summaries").get()).toEqual({
      through_seq: 1,
    });
  });

  it("已经开始的压缩任务在群停用历史摘要后发布被拒，不写摘要", async () => {
    const h = compressionGroup();
    h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
    h.clock.seconds -= 30_000;
    h.receive("1", "旧问题");
    h.clock.seconds += 30_000;
    h.receive("2", "新问题");
    h.clock.seconds += 3;
    await h.runWakes();
    const job = h.job();
    if (!job) throw new Error("missing background job");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setGate(() => blocked);
    const run = job.run(new AbortController().signal);
    await waitUntil(() => h.compressions() === 1);
    setGroupConfig(h.orm, BINDING_ID, { capabilities: ["history_summary"] });
    h.setGate(null);
    release();
    let code: string | undefined;
    try {
      await run;
    } catch (error) {
      code = failureCode(error, { pattern: /^[A-Z][A-Z_]+$/, allowErrorCode: true });
    }
    expect(code).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(h.db.query("SELECT count(*) AS n FROM qq_conversation_summaries").get()).toEqual({
      n: 0,
    });
  });
});

describe("排队中的表情素材按本群生效集合与撤权复核", () => {
  function stickerSetup() {
    const h = createOneBotHarness({ model: [] });
    const inside = createQqStickerCollection(h.orm, { name: "本群保留" });
    const outside = createQqStickerCollection(h.orm, { name: "本群排除" });
    const insideAsset = stickerAsset(h.orm, [inside.id]);
    const outsideAsset = stickerAsset(h.orm, [outside.id]);
    updateQqScheme(h.orm, h.scheme.id, {
      name: "group-harness",
      expectedRevision: 1,
      stickerCollections: [inside.id, outside.id],
    });
    // 本群选择只保留其中一个集合：生效集合是差异与授权的交集。
    setGroupConfig(h.orm, h.bindingId, {
      overrides: { sticker_collections: { collection_ids: [inside.id] } },
    });
    const { runtime, sent } = openDelivery(h);
    return { h, runtime, sent, inside, outside, insideAsset, outsideAsset };
  }

  it("本群集合之外的素材即使已排队也不发送，保留集合内的正常送达", async () => {
    const { h, runtime, sent, insideAsset, outsideAsset } = stickerSetup();
    const excluded = queueIntent(h, runtime, [{ kind: "sticker", stickerId: outsideAsset }]);
    await runtime.delivery.runOnce();
    // 生效集合之外＝素材复核不放行：部件按 not_sent 结算，意图的终态投影为 failed。
    expect(runtime.outbox.get(excluded)?.status).toBe("failed");
    expect(sent).toHaveLength(0);

    const delivered = queueIntent(
      h,
      runtime,
      [{ kind: "sticker", stickerId: insideAsset }],
      [capabilityRef(h, "sticker.search")],
    );
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(delivered)?.status).toBe("confirmed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message[0]?.type).toBe("image");
  });

  it("排队后本群停用表情：素材不再落地", async () => {
    const { h, runtime, sent, insideAsset } = stickerSetup();
    const queued = queueIntent(h, runtime, [{ kind: "sticker", stickerId: insideAsset }]);
    setGroupConfig(h.orm, h.bindingId, { capabilities: ["stickers"] });
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(queued)?.status).toBe("stale");
    expect(sent).toHaveLength(0);
  });

  it("基础方案收回素材授权（修订变化）后，排队中的素材不发送", async () => {
    const { h, runtime, sent, insideAsset, outside } = stickerSetup();
    const queued = queueIntent(h, runtime, [{ kind: "sticker", stickerId: insideAsset }]);
    updateQqScheme(h.orm, h.scheme.id, {
      name: "group-harness",
      expectedRevision: 2,
      // 收回「本群保留」集合的授权：基础方案只留另一个集合（传集合 ID，不是素材 ID）。
      stickerCollections: [outside.id],
    });
    await runtime.delivery.runOnce();
    expect(runtime.outbox.get(queued)?.status).toBe("stale");
    expect(sent).toHaveLength(0);
  });
});

describe("私聊没有本群停用面", () => {
  it("私聊绑定没有本群配置，排队投递照旧送达", async () => {
    const h = createOneBotHarness({ kind: "private", model: [] });
    const binding = readQqBinding(h.orm, h.bindingId)!;
    expect(readQqGroupAgentConfig(h.orm, binding).disabled_capabilities).toEqual([]);
    expect(readQqGroupAgentConfig(h.orm, binding).revision).toBe(0);
    const { runtime, sent } = openDelivery(h);
    const queued = queueIntent(h, runtime, [{ kind: "text", text: "在的" }]);
    expect(await runtime.delivery.runOnce()).toBeGreaterThan(0);
    expect(runtime.outbox.get(queued)?.status).toBe("confirmed");
    expect(sent).toHaveLength(1);
  });
});
