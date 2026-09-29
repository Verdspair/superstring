import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme, updateQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  nowSeconds = 2_000_000_000;
const specId = "onebot.main";
function setup(
  model?: Partial<ModelPort>,
  options: {
    stickersAvailable?: boolean;
    stickersEnabled?: () => boolean;
  } = {},
) {
  const clock = { seconds: nowSeconds };
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "chat-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "test",
    reply: { split_by_speaker: false },
    triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "private",
      peerId: "20002",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now: () => new Date(clock.seconds * 1000).toISOString(),
    model: {
      complete: async (request) => {
        requests.push(request);
        const handler = model?.complete;
        if (handler) return await handler(request);
        return '{"kind":"none"}';
      },
      async *streamText(request) {
        requests.push(request);
        const handler = model?.streamText;
        if (handler) {
          yield* handler(request);
          return;
        }
        yield "first\nsecond";
      },
      completeMultimodal: async () => "",
    },
  });
  const gateway = {
    loadedContextCapacity: async () => 65536,
    complete: async () => {
      throw new Error("DIRECT_GATEWAY_FORBIDDEN");
    },
  } as unknown as ModelGateway;
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
    gateway,
    agentRuntime: runtime,
    stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
    stickersEnabled: options.stickersEnabled,
    policy: () => ({ maxSteps: 12, deliveryTtlSeconds: 600, retentionDays: 14 }),
    now: () => new Date(clock.seconds * 1000).toISOString(),
  });
  const receive = (id: string, text = "hello") =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "private",
          sub_type: "friend",
          time: clock.seconds,
          self_id: 10001,
          user_id: 20002,
          message_id: id,
          message: [{ type: "text", data: { text } }],
          sender: { nickname: "Peer" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  return {
    ...h,
    clock,
    gateway,
    journal,
    wakes,
    outbox,
    runs,
    runtime,
    requests,
    adapter,
    host,
    receive,
    scheme,
  };
}
const stamp = (seconds = nowSeconds) => new Date(seconds * 1000).toISOString();
async function activate(h: ReturnType<typeof setup>) {
  const wake = h.wakes.claim({ at: stamp(h.clock.seconds), leaseMs: 120000 })!;
  return h.host.activate(wake, new AbortController().signal);
}
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
function modelData(request: ModelRequest, kind: string) {
  return request.messages
    .flatMap((message) => message.content)
    .flatMap((part) => {
      if (part.kind !== "text") return [];
      try {
        const data = JSON.parse(part.text);
        return data.kind === kind ? [data.value] : [];
      } catch {
        return [];
      }
    });
}
function stickerObservation(request: ModelRequest): {
  items: { id: string; name: string }[];
  nextCursor: string | null;
  status: string;
} {
  const matches = modelData(request, "action_observation").filter(
    (value) => value.name === "sticker.search",
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches.at(-1).value;
}
function decision(kind: string, output: Record<string, unknown>) {
  return JSON.stringify({ kind, outputs: [output] });
}
function selectorRuns(h: ReturnType<typeof setup>) {
  return (
    h.db
      .query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.sticker.select'")
      .get() as { n: number }
  ).n;
}
function payloads(h: ReturnType<typeof setup>, id: string) {
  return h.outbox.parts(id).map((part) => JSON.parse(part.payload!));
}
const invokeSearch = JSON.stringify({
  kind: "invoke",
  name: "sticker.search",
  arguments: { query: "wave" },
});
describe("explicit sticker tools without an auto selector", () => {
  it("delivers the sticker picked from this run's search and never runs a selector leaf", async () => {
    let calls = 0,
      generations = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1) return invokeSearch;
          return decision("final", {
            kind: "generate",
            targetId: "20002",
            instructions: "answer",
            stickerIds: [stickerObservation(request).items[0].id],
          });
        },
        async *streamText() {
          generations++;
          yield "你好";
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "发个招手表情包");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(2);
    expect(generations).toBe(1);
    // 两条决策请求带工具，一条生成请求是纯文本流；多出来的任何调用都说明有选择叶子。
    expect(h.requests).toHaveLength(3);
    expect(h.requests.slice(0, 2).every((request) => (request.tools ?? []).length > 0)).toBe(true);
    expect(h.requests.at(-1)!.tools ?? []).toHaveLength(0);
    expect(selectorRuns(h)).toBe(0);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "你好" }, { stickerId: id }]);
  });
  it("sends a text-only reply for an explicit empty choice in one decision with no search", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async () => {
          calls++;
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "不用表情",
            stickerIds: [],
          });
        },
      },
      { stickersAvailable: true },
    );
    addSticker(h);
    h.receive("1");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(selectorRuns(h)).toBe(0);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "不用表情" }]);
  });
  it("asks once more with bounded feedback when a draft with candidates omits the choice", async () => {
    let calls = 0,
      generations = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1)
            return decision("final", {
              kind: "generate",
              targetId: "20002",
              instructions: "answer",
            });
          expect(JSON.stringify(request.messages)).toContain("output_feedback");
          expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_REQUIRED");
          expect(generations).toBe(0);
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "好的",
            stickerIds: [],
          });
        },
        async *streamText() {
          generations++;
          yield "should not generate";
        },
      },
      { stickersAvailable: true },
    );
    addSticker(h);
    h.receive("1", "在吗");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(2);
    expect(generations).toBe(0);
    expect(h.requests).toHaveLength(2);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "好的" }]);
  });
  it("bounds repeated omission at the configured step budget instead of looping forever", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls > 1)
            expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_REQUIRED");
          return decision("final", { kind: "inline", targetId: "20002", text: "你好" });
        },
      },
      { stickersAvailable: true },
    );
    addSticker(h);
    h.receive("1");
    await expect(activate(h)).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT" });
    expect(calls).toBe(12);
    expect(h.outbox.list({})).toEqual([]);
  });
  it("refuses a guessed id until this run's search discloses one", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1)
            return decision("final", {
              kind: "inline",
              targetId: "20002",
              text: "",
              stickerIds: ["00000000-0000-4000-8000-000000000000"],
            });
          if (calls === 2) {
            expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_UNAVAILABLE");
            return invokeSearch;
          }
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "",
            stickerIds: [stickerObservation(request).items[0].id],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "来个表情");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(3);
    expect(selectorRuns(h)).toBe(0);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ stickerId: id }]);
  });
  it("refuses an id disclosed by an earlier run until this run searches on its own", async () => {
    let calls = 0,
      disclosed = "";
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1) return invokeSearch;
          if (calls === 2) {
            disclosed = stickerObservation(request).items[0].id;
            return decision("final", {
              kind: "inline",
              targetId: "20002",
              text: "第一轮",
              stickerIds: [],
            });
          }
          if (calls === 3)
            return decision("final", {
              kind: "inline",
              targetId: "20002",
              text: "第二轮",
              stickerIds: [disclosed],
            });
          if (calls === 4) {
            expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_UNAVAILABLE");
            return invokeSearch;
          }
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "第二轮",
            stickerIds: [stickerObservation(request).items[0].id],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "打个招呼");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(2);
    h.receive("2", "再来");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(5);
    const intents = h.outbox.list({});
    expect(intents).toHaveLength(2);
    expect(payloads(h, intents[0]!.id)).toEqual([{ text: "第一轮" }]);
    expect(payloads(h, intents[1]!.id)).toEqual([{ text: "第二轮" }, { stickerId: id }]);
  });
  it("refuses an id that fell into the repeat interval before the pick was staged", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1) return invokeSearch;
          if (calls === 2) {
            const id = stickerObservation(request).items[0].id;
            // 搜索之后、提交之前，这张图在会话里“刚发过”：最短重复间隔把它移出当前目录。
            recordQqSend(h.orm, {
              scope: {
                kind: "qq",
                accountId: "10001",
                conversationKind: "private",
                peerId: "20002",
                agentId: DEFAULT_AGENT_ID,
              },
              kind: "direct_reply",
              sentAtSeconds: nowSeconds - 10,
              text: null,
              parts: [
                {
                  kind: "sticker",
                  result: "confirmed",
                  messageId: "recent-sticker",
                  stickerId: id,
                },
              ],
            });
            return decision("final", {
              kind: "inline",
              targetId: "20002",
              text: "",
              stickerIds: [id],
            });
          }
          expect(JSON.stringify(request.messages)).toContain("STICKER_SELECTION_UNAVAILABLE");
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "那算了",
            stickerIds: [],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "来张图");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(3);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "那算了" }]);
    expect(JSON.stringify(h.outbox.list({}))).not.toContain(id);
  });
  it("supports an explicit sticker-only reply", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          if (calls === 1) return invokeSearch;
          return decision("final", {
            kind: "inline",
            targetId: "20002",
            text: "",
            stickerIds: [stickerObservation(request).items[0].id],
          });
        },
      },
      { stickersAvailable: true },
    );
    const id = addSticker(h);
    h.receive("1", "只发表情");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(2);
    const intents = h.outbox.list({});
    expect(intents).toHaveLength(1);
    expect(payloads(h, intents[0]!.id)).toEqual([{ stickerId: id }]);
    expect(selectorRuns(h)).toBe(0);
  });
  it("normalizes an omitted choice and hides search when the sticker module is off", async () => {
    let calls = 0;
    const tools: string[][] = [];
    const h = setup(
      {
        complete: async (request) => {
          calls++;
          tools.push((request.tools ?? []).map((tool) => tool.name));
          expect(JSON.stringify(request.messages)).toContain("disabled");
          return decision("final", { kind: "inline", targetId: "20002", text: "普通回复" });
        },
      },
      { stickersAvailable: true, stickersEnabled: () => false },
    );
    addSticker(h);
    h.receive("1");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(1);
    expect(tools[0]).not.toContain("sticker.search");
    expect(selectorRuns(h)).toBe(0);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "普通回复" }]);
  });
  it("treats an enabled module without candidates as no sticker decision", async () => {
    let calls = 0;
    const h = setup({
      complete: async () => {
        calls++;
        return decision("final", { kind: "inline", targetId: "20002", text: "没有图也回复" });
      },
    });
    h.receive("1");
    expect((await activate(h)).status).toBe("completed");
    expect(calls).toBe(1);
    expect(selectorRuns(h)).toBe(0);
    expect(payloads(h, h.outbox.list({})[0]!.id)).toEqual([{ text: "没有图也回复" }]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id=?").get(specId),
    ).toMatchObject({ n: 1 });
  });
});
