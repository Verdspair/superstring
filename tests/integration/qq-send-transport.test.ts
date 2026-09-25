// Delivering an authorized reply (ADR0018 §8.1/§8.2, P5o).
//
// The ledger is the product's memory of what the platform did, so these cases pin the mapping and
// the consequences separately: what each platform answer becomes on a part row, what that makes
// the reply's overall outcome, and which outcomes are allowed to write the assistant's own speech
// record (only a confirmed delivery may, because §8.2 says so and U13 keeps the rest undecided).

import { describe, expect, it } from "bun:test";
import { readQqSends } from "../../src/server/db/qq-send-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";
import type { QqPlannedOutput } from "../../src/server/services/qq-output-plan";
import { sendQqPreparedReply } from "../../src/server/services/qq-send-transport";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const NOW = 2_000_000_000;

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic-model");
  business.orm
    .insert(schema.qqSchemes)
    .values({ id: SCHEME_ID, name: "方案", revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
    .run();
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  const collection = createQqStickerCollection(business.orm, { name: "日常" });
  importQqSticker(business.orm, {
    id: ASSET_ID,
    name: "问好",
    copy: { fileName: `${ASSET_ID}.png`, byteSize: 1024, mediaType: "image" },
    width: 8,
    height: 8,
    collectionIds: [collection.id],
  });
  return business;
}

const scope = {
  accountId: "10001",
  conversationKind: "group" as const,
  peerId: "30003",
  agentId: AGENT_ID,
};

function plan(parts: QqPlannedOutput["parts"]): QqPlannedOutput {
  const stickers = parts.flatMap((part) => (part.kind === "sticker" ? [part.stickerId] : []));
  return {
    kind: "planned",
    shape: parts.length === 1 && parts[0]?.kind === "sticker" ? "sticker_only" : "mixed",
    parts,
    requestedStickers: stickers.length,
    chosenStickerIds: stickers,
    rejected: [],
    textOnlyBecauseStickersUnavailable: false,
  };
}

/** A transport that answers with a scripted result per request and records what it was asked. */
function fakePort(results: OneBotSendResult[]) {
  const requests: OneBotSendRequest[] = [];
  return {
    requests,
    send: async (request: OneBotSendRequest): Promise<OneBotSendResult> => {
      requests.push(request);
      return results[requests.length - 1] ?? { kind: "failed", retcode: 100 };
    },
  };
}

const DELIVERED = (id: string): OneBotSendResult => ({ kind: "confirmed", messageId: id });
const failed = { kind: "failed", retcode: 100 } as OneBotSendResult;
const unknown = { kind: "unknown", reason: "timeout" } as OneBotSendResult;
const notReady = { kind: "not_sent", reason: "not_ready" } as OneBotSendResult;

describe("one request per part, in the plan's order", () => {
  it("sends text alone and records a delivered reply as the assistant's own speech", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1")]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => "base64://AAAA" },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "在的" }]),
          text: "在的",
          sentAtSeconds: NOW,
        },
      );
      expect(record?.outcome).toBe("sent");
      expect(record?.log.deliveryMessageId).toBe("m-1");
      expect(record?.unrespondedRecord).toEqual({ kind: "recorded" });
      expect(port.requests).toEqual([
        { kind: "group", peerId: "30003", message: [{ type: "text", data: { text: "在的" } }] },
      ]);
      // §8.2's first row: only a delivered utterance enters the no-reply rule.
      const speeches = business.orm.select().from(schema.qqSpeechLog).all();
      expect(speeches).toHaveLength(1);
      expect(speeches[0]).toMatchObject({ kind: "chiming_in", peerId: "30003" });
    } finally {
      business.close();
    }
  });

  it("sends text then the sticker as two requests, and names the asset on the sticker's row", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1"), DELIVERED("m-2")]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: (id) => `base64://sticker-${id}` },
        {
          scope,
          kind: "idle_topic",
          plan: plan([
            { kind: "text", text: "大家早上好" },
            { kind: "sticker", stickerId: ASSET_ID },
          ]),
          text: "大家早上好",
          sentAtSeconds: NOW,
        },
      );
      expect(record?.outcome).toBe("sent");
      expect(port.requests).toHaveLength(2);
      expect(port.requests[1]?.message).toEqual([
        { type: "image", data: { file: `base64://sticker-${ASSET_ID}` } },
      ]);
      const parts = business.orm.select().from(schema.qqSendPart).all();
      expect(parts.map((part) => [part.partKind, part.result, part.stickerId])).toEqual([
        ["text", "confirmed", null],
        ["sticker", "confirmed", ASSET_ID],
      ]);
    } finally {
      business.close();
    }
  });
});

describe("a part that did not reach the platform is not_sent, never failed", () => {
  it("stops after a failed text and refuses to improvise the sticker into a message", async () => {
    const business = setup();
    try {
      const port = fakePort([failed]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => "base64://AAAA" },
        {
          scope,
          kind: "chiming_in",
          plan: plan([
            { kind: "text", text: "在的" },
            { kind: "sticker", stickerId: ASSET_ID },
          ]),
          text: "在的",
          sentAtSeconds: NOW,
        },
      );
      // One request only: the sticker would have been a different utterance (§8.1-6).
      expect(port.requests).toHaveLength(1);
      expect(record?.outcome).toBe("text_failed");
      expect(business.orm.select().from(schema.qqSendPart).all()).toMatchObject([
        { partKind: "text", result: "failed" },
        { partKind: "sticker", result: "not_sent" },
      ]);
      // A failed attempt writes the ledger and nothing else; whether it consumes the no-reply
      // slot is U13, which the record reports as pending rather than answering.
      expect(record?.unrespondedRecord).toEqual({ kind: "pending_decision", item: "U13" });
      expect(business.orm.select().from(schema.qqSpeechLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });

  it("treats an unknown text result the same way and never assumes it was delivered", async () => {
    const business = setup();
    try {
      const port = fakePort([unknown]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => "base64://AAAA" },
        {
          scope,
          kind: "chiming_in",
          plan: plan([
            { kind: "text", text: "在的" },
            { kind: "sticker", stickerId: ASSET_ID },
          ]),
          text: "在的",
          sentAtSeconds: NOW,
        },
      );
      expect(port.requests).toHaveLength(1);
      expect(record?.outcome).toBe("unknown");
      expect(record?.log.deliveryMessageId).toBeNull();
      expect(business.orm.select().from(schema.qqSpeechLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });

  it("records a vanished sticker copy as a part that never left, keeping the sent text", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1")]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([
            { kind: "text", text: "在的" },
            { kind: "sticker", stickerId: ASSET_ID },
          ]),
          text: "在的",
          sentAtSeconds: NOW,
        },
      );
      expect(port.requests).toHaveLength(1);
      expect(record?.outcome).toBe("partially_sent");
      expect(record?.log.deliveryMessageId).toBe("m-1");
      expect(business.orm.select().from(schema.qqSendPart).all()).toMatchObject([
        { partKind: "text", result: "confirmed" },
        { partKind: "sticker", result: "not_sent" },
      ]);
    } finally {
      business.close();
    }
  });

  it("records not_submitted when no connection is live, and writes no speech", async () => {
    const business = setup();
    try {
      const port = fakePort([notReady]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => "base64://AAAA" },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "在的" }]),
          text: "在的",
          sentAtSeconds: NOW,
        },
      );
      expect(record?.outcome).toBe("not_submitted");
      expect(record?.log.deliveryMessageId).toBeNull();
      expect(business.orm.select().from(schema.qqSpeechLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });
});

describe("the ledger is what the rest of the side reads", () => {
  it("keeps the sticker history per conversation, from the part row it just wrote", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-2")]);
      await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => "base64://AAAA" },
        {
          scope,
          kind: "idle_topic",
          plan: plan([{ kind: "sticker", stickerId: ASSET_ID }]),
          text: null,
          sentAtSeconds: NOW,
        },
      );
      const sends = readQqSends(business.orm, { kind: "qq", ...scope }, 10);
      expect(sends).toHaveLength(1);
      expect(sends[0]?.outcome).toBe("sent");
    } finally {
      business.close();
    }
  });

  it("writes nothing at all when the plan has no parts to deliver", async () => {
    const business = setup();
    try {
      const port = fakePort([]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        { scope, kind: "chiming_in", plan: plan([]), text: null, sentAtSeconds: NOW },
      );
      expect(record).toBeNull();
      expect(port.requests).toEqual([]);
      expect(business.orm.select().from(schema.qqSendLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });
});

// The store is only touched through the port in these cases; a real copy round-trip lives in the
// sticker tests, so this file stays about the send decision.
// 用户 2026-09-25：分开回给不同的人时要真的 @ 到对方。回复文案里写的是 [CQ:at,qq=号码]，
// 而数组形态的 message 不解析文本里的 CQ 码，所以发送通路必须显式拆段——否则群里看到的是一串
// 字面量。这一段钉的就是"拆成什么"和"什么绝不拆"。
describe("a mention written as a CQ code travels as an at segment", () => {
  it("splits one text part into at + text and keeps it one ledger row", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1")]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "[CQ:at,qq=20002] 刚才那句我同意" }]),
          text: "[CQ:at,qq=20002] 刚才那句我同意",
          sentAtSeconds: NOW,
        },
      );
      expect(record?.outcome).toBe("sent");
      expect(port.requests).toEqual([
        {
          kind: "group",
          peerId: "30003",
          message: [
            { type: "at", data: { qq: "20002" } },
            { type: "text", data: { text: " 刚才那句我同意" } },
          ],
        },
      ]);
      // The mention is inside the text part, not a part of its own: the ledger's granularity is
      // "one message per part" and that is what the platform received.
      expect(business.orm.select().from(schema.qqSendPart).all()).toMatchObject([
        { partKind: "text", result: "confirmed" },
      ]);
    } finally {
      business.close();
    }
  });

  it("puts the program's own recipient in front of the first part only", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1"), DELIVERED("m-2")]);
      const record = await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([
            { kind: "text", text: "张三你好" },
            { kind: "text", text: "顺便问一句" },
          ]),
          text: "张三你好",
          sentAtSeconds: NOW,
          // 0037: 收件人由这一轮的任务决定，不来自模型——所以它不可能 @ 错人。
          mention: "20002",
        },
      );
      expect(record?.outcome).toBe("sent");
      expect(port.requests.map((request) => request.message)).toEqual([
        [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: "张三你好" } },
        ],
        // 第二条不带 `@`：一次 @ 一个人，@ 完就不再重复。
        [{ type: "text", data: { text: "顺便问一句" } }],
      ]);
    } finally {
      business.close();
    }
  });

  it("adds no mention when the round has no recipient", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1")]);
      await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "idle_topic",
          plan: plan([{ kind: "text", text: "大家最近在玩什么" }]),
          text: "大家最近在玩什么",
          sentAtSeconds: NOW,
          mention: null,
        },
      );
      expect(port.requests[0]?.message).toEqual([
        { type: "text", data: { text: "大家最近在玩什么" } },
      ]);
    } finally {
      business.close();
    }
  });

  it("leaves text without a mention, and anything that is not a numbered at, alone", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1"), DELIVERED("m-2")]);
      await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "普通一句话" }]),
          text: "普通一句话",
          sentAtSeconds: NOW,
        },
      );
      await sendQqPreparedReply(
        business.orm,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "[CQ:at,qq=all] 大家" }]),
          text: "[CQ:at,qq=all] 大家",
          sentAtSeconds: NOW,
        },
      );
      expect(port.requests[0]?.message).toEqual([{ type: "text", data: { text: "普通一句话" } }]);
      // Only plain digits become a mention: an @all spelling is not in the taxonomy and must not
      // silently turn into one.
      expect(port.requests[1]?.message).toEqual([
        { type: "text", data: { text: "[CQ:at,qq=all] 大家" } },
      ]);
    } finally {
      business.close();
    }
  });
});

describe("the send port's shape", () => {
  it("is the transport's own request type, not a private one", () => {
    const request: OneBotSendRequest = {
      kind: "private",
      peerId: "20002",
      message: [{ type: "text", data: { text: "在的" } }],
    };
    expect(request.kind).toBe("private");
  });
});
