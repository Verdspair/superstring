import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
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
import { QQ_MEDIA_RULE } from "../../src/server/services/qq-prompt-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

/**
 * QQ 装配预算的两个断言。合成的库、模型网关与助手都在这里自建：不改产品源码、不读真实
 * data/local/state、不调模型、不发消息、不碰任何真实账号或聊天正文。唯一的输入是内存
 * SQLite 里的两条合成入站消息，标记串是测试自己造的。
 *
 * 1. 窗口收窄后资料段必须跟着收窄。选中的原文被裁到只剩最新一条时，事实投影
 *    （qq_message_facts 资料段）必须按同一份选择重建。否则被裁掉的那条历史正文仍以事实身份
 *    留在材料里：窗口少了一条，资料段却没少，成本不随窗口下降。
 * 2. 单条 mandatory 装不下时仍是合法拒绝。最新一条永远保留，装不下就是装不下，不静默丢弃、
 *    不放宽上限。用来把「合法拒绝」和「上面那个缺陷」分开。
 */
const OLD_BODY = `OLDBODYMARKER${"o".repeat(600)}`;
const NEW_BODY = `NEWBODYMARKER${"n".repeat(40)}`;

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/**
 * 夹具时钟固定在模块加载那一刻。
 *
 * 二分过程会开很多个库，每个库都重新 `Date.now()` 的话，跨过一秒就会让 `occurredAtSeconds`
 * 与 `nowSeconds` 的相对关系整体平移，测出来的"最小容量"带秒级噪声。固定一次即可让同一
 * 轮里所有夹具看到同一个 now。
 */
const FIXED_SECONDS = Math.floor(Date.now() / 1000);
const FIXED_NOW = new Date(FIXED_SECONDS * 1000).toISOString();

function setup(input: { tokenBudget?: number } = {}) {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "reply-model");
  const seconds = FIXED_SECONDS;
  const now = FIXED_NOW;
  updateQqSettings(handle.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(handle.orm, {
    name: "budget-diagnostics",
    context: { ...QQ_CONTEXT_DEFAULT, reply_token_budget: input.tokenBudget ?? 16384 },
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
  const journal = new ConversationEventRepository(handle.db);
  const outbox = new OutboundIntentRepository(handle.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    // 每个 source 实例在构造时冻结当时的容量探针值（与真实同轮冻结同构）。
    loadedContextCapacity: async () => probe.capacity,
    complete: async () => '{"facts":[]}',
    async *streamChat() {
      yield "unused";
    },
  };
  const probe = { capacity: 65536 };
  const runs = new AgentRunRepository(handle.db);
  const spec: AgentSpec = {
    id: "test.budget",
    model: "reply-model",
    context: "conversation",
    instructions: QQ_MEDIA_RULE,
    availableActions: [],
    limits: { steps: 16 },
  };
  const buildSource = () =>
    new BotContextSource({
      ...handle,
      gateway,
      agentRuntime: createAgentRuntime({ gateway, repository: runs }),
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
    });
  /**
   * 一条合成入站消息，带完整的事实快照行。
   *
   * qq_message_facts 那一行不能省：没有它，projectQqMessageFacts 的 eventById/projectOne 会
   * 落空，projectedFacts 恒为空，资料段根本不会出现——那样测的就不是收窄同步，而是空转
   * （我第一版就踩了这个坑：夹具缺这行，测试假绿）。parts 里的 text 必须与
   * qq_observation_text.body 逐字一致，否则 visibleFactState 判 text-mismatch，正文会被换成
   * unavailable；那是正确的 fail-closed 行为，不是本例要测的东西。
   */
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
  /** 装一次，返回 source 与材料；失败时返回 null（不吞掉别的错误类型）。 */
  const attempt = (capacity: number) => {
    probe.capacity = capacity;
    const source = buildSource();
    return source
      .read({ signal: new AbortController().signal, observations: [] })
      .then((material) => ({ ok: true as const, source, material }))
      .catch((error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));
  };
  return { ...handle, seed, attempt };
}

const closeAll = () => {
  for (const handle of handles.splice(0)) handle.close();
};

/** 二分出「这组消息装得下的最小容量」。每次都新开一个库、装完立刻关，不留连接。 */
async function minCapacity(messages: { text: string; age: number }[]): Promise<number> {
  let lo = 1024;
  let hi = 1 << 18;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const handle = setup();
    for (const message of messages) handle.seed(message.text, message.age);
    const result = await handle.attempt(mid);
    closeAll();
    if (result.ok) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe("QQ 装配预算", () => {
  it("窗口收窄后资料段跟着收窄：未选中的消息不再以事实身份留在材料里", async () => {
    // 门槛不取自"两条完整装得下"（那是被修行为：自裁本来就该让收窄后的结果更省）。
    // 这里只证明一件事：**凡是这一轮没选中的消息，它的身体都不该再出现在材料里**。
    // 1.05 + 8 只是本夹具的合成余量（让装配走完收窄路径），不是产品常数、也不是用户参数。
    const newestOnly = await minCapacity([{ text: NEW_BODY, age: 0 }]);
    const capacity = Math.floor(newestOnly * 1.05) + 8;

    const handle = setup();
    const seededOld = handle.seed(OLD_BODY, 1);
    const seededNew = handle.seed(NEW_BODY, 0);
    const result = await handle.attempt(capacity);

    if (!result.ok) {
      throw new Error(
        `容量 ${capacity} 下装配被 ${result.code} 打死；「只剩最新一条」在 ${newestOnly} 就装得下，` +
          `这里多给了合成余量，所以失败不是容量真装不下。`,
      );
    }

    // 判据按**这一轮实际选中的来源**走，不写死"必须只剩一条"：窗口收窄到几条都不影响结论，
    // 只要没被选中的那条不留在材料里就成立。合成余量若让窗口还能装下两条，这里同样通过。
    const selected = new Set(
      (result.source.selection?.messages ?? []).flatMap((message) =>
        (message.sources ?? [])
          .filter((source) => source.kind === "qq_observation")
          .map((source) => source.id),
      ),
    );
    expect(selected.has(seededNew)).toBe(true);
    const pending = JSON.stringify(result.material.pending);
    if (selected.has(seededOld)) {
      // 窗口仍收了它：两条正文都在是**合法**的，不算失败。
      expect(pending).toContain("OLDBODYMARKER");
    } else {
      // 窗口丢了它：它必须连事实身份一起消失，否则成本不随裁剪下降。
      expect(pending).not.toContain("OLDBODYMARKER");
    }
    expect(pending).toContain("NEWBODYMARKER");
  }, 120_000);

  it("单条 mandatory 装不下时仍合法拒绝：不静默丢弃、不放宽上限", async () => {
    const probe = setup();
    probe.seed(NEW_BODY, 0);
    const rejected = await probe.attempt(1024);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    closeAll();

    // 容量够时同一条消息照常装下：拒绝由容量决定，不是这条消息本身不可装配。
    const room = setup();
    room.seed(NEW_BODY, 0);
    const accepted = await room.attempt(65536);
    expect(accepted.ok).toBe(true);
    expect(accepted.ok === true && JSON.stringify(accepted.material.pending)).toContain(
      "NEWBODYMARKER",
    );
  });
});
