import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import * as schema from "../../src/server/db/schema";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { decideInvoke, rawText, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

describe("OneBotHost quote and mention authorization", () => {
  it("authorized quote reference sets replyToMessageId and delivers reply segment", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "收到消息并引用回复",
              replyToMessageId: "-1001",
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-1001", speaker: "20002", text: "请核对本条消息", addressed: true });
    await h.activate("direct_reply");
    await h.deliver();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([
      { type: "reply", data: { id: "-1001" } },
      { type: "text", data: { text: "收到消息并引用回复" } },
    ]);
  });

  it("undisclosed or unknown message ID is rejected with CONTEXT_SOURCE_INVALID", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "尝试引用不存在的消息",
              replyToMessageId: "-9999",
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-1001", speaker: "20002", text: "真实消息", addressed: true });

    let thrown: unknown;
    try {
      await h.activate("direct_reply");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.sent).toHaveLength(0);
  });

  it("quote plus explicit mention delivers reply, text, and at segments without duplication", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "引用并艾特你",
              replyToMessageId: "-1001",
              mentionIds: ["20002"],
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-1001", speaker: "20002", text: "待办事项", addressed: true });
    await h.activate("direct_reply");
    await h.deliver();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([
      { type: "reply", data: { id: "-1001" } },
      { type: "text", data: { text: "引用并艾特你" } },
      { type: "at", data: { qq: "20002" } },
    ]);
  });

  it("unauthorized mention ID from unknown member is rejected with CONTEXT_SOURCE_INVALID", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "非法艾特陌生人",
              mentionIds: ["888888888888"],
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-1001", speaker: "20002", text: "讨论", addressed: true });

    let thrown: unknown;
    try {
      await h.activate("direct_reply");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.sent).toHaveLength(0);
  });

  it("delivers an explicit mention without a phantom text or recipient mention", async () => {
    const h = createOneBotHarness({
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "",
              mentionIds: ["20002"],
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-1002", speaker: "20002", text: "请艾特我", addressed: true });
    await h.activate("direct_reply");
    await h.deliver();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([{ type: "at", data: { qq: "20002" } }]);
  });

  it("keeps a private quoted source in its private conversation scope", async () => {
    const h = createOneBotHarness({
      kind: "private",
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "私聊里引用回复",
              replyToMessageId: "-2001",
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-2001", text: "私聊引用源" });
    await h.activate("direct_reply");
    await h.deliver();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.kind).toBe("private");
    expect(h.sent[0]?.message).toEqual([
      { type: "reply", data: { id: "-2001" } },
      { type: "text", data: { text: "私聊里引用回复" } },
    ]);
  });

  it("does not deliver a staged quote after its canonical source body changes", async () => {
    const h = createOneBotHarness({
      kind: "private",
      model: [
        decideInvoke("speech.reply", {
          outputs: [
            {
              kind: "inline",
              targetId: "20002",
              text: "引用已变化的消息",
              replyToMessageId: "-3001",
            },
          ],
        }),
      ],
    });
    h.receive({ id: "-3001", text: "原始引用内容" });
    await h.activate("direct_reply");
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.list({ conversationId: h.conversationId })[0]?.status).toBe("planned");

    h.orm
      .update(schema.qqObservationText)
      .set({ body: "变更后的引用内容" })
      .where(eq(schema.qqObservationText.body, "原始引用内容"))
      .run();
    // The generic harness deliberately authorizes every delivery; this boundary uses
    // the production composition so source revision checks are actually exercised.
    const gateway = {
      loadedContextCapacity: async () => 65536,
      complete: async () => {
        throw new Error("delivery fixture must not call a model");
      },
    };
    const runtime = createAgentRuntime({ repository: h.runs });
    const composed = createOneBotConversationRuntime({
      db: h.db,
      orm: h.orm,
      journal: h.journal,
      gateway,
      agentRuntime: runtime,
      host: new ConversationHost({ runtime }),
      store: new QqStickerStore({
        directory: "artifacts/validation/qq-reply-delivery-fixture-unused",
      }),
      port: {
        async send(request) {
          h.sent.push(request);
          return { kind: "confirmed", messageId: "fixture-must-not-send" };
        },
      },
      wake() {},
    });
    await composed.delivery.runOnce();

    expect(h.sent).toHaveLength(0);
    expect(h.outbox.list({ conversationId: h.conversationId })[0]?.status).toBe("stale");
  });

  it("accepts a model-generated quote draft and sends ordinary text without implicit mentions", async () => {
    const h = createOneBotHarness({
      kind: "private",
      model: [
        rawText(
          JSON.stringify({
            kind: "final",
            outputs: [
              {
                kind: "generate",
                targetId: "20002",
                instructions: "引用后回答",
                replyToMessageId: "-4001",
                stickerIds: [],
              },
            ],
          }),
        ),
        say("模型生成的引用答复"),
      ],
    });
    h.receive({ id: "-4001", text: "生成回复的引用源" });
    await h.activate("direct_reply");
    await h.deliver();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toEqual([
      { type: "reply", data: { id: "-4001" } },
      { type: "text", data: { text: "模型生成的引用答复" } },
    ]);
  });
});
