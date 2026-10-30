// Delivering an authorized reply (ADR0018 §8.1/§8.2, P5o).
//
// The ledger is the product's memory of what the platform did, so these cases pin the mapping and
// the consequences separately: what each platform answer becomes on a part row, what that makes
// the reply's overall outcome, and which outcomes are allowed to write the assistant's own speech
// record (only a confirmed delivery may, because §8.2 says so and U13 keeps the rest undecided).

import { describe, expect, it } from "bun:test";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { readQqSends } from "../../src/server/db/qq-send-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import * as schema from "../../src/server/db/schema";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";
import { qqSendOutcomeEffect } from "../../src/server/services/qq-output-contract";
import { planQqOutput, type QqPlannedOutput } from "../../src/server/services/qq-output-plan";
import { qqReplySegments } from "../../src/server/services/qq-send-transport";
import { createOneBotHarness } from "../harness/onebot";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const NOW = 2_000_000_000;

function setup() {
  const h = createOneBotHarness({ nowSeconds: NOW, model: [] });
  const collection = createQqStickerCollection(h.orm, { name: "日常" });
  importQqSticker(h.orm, {
    id: ASSET_ID,
    name: "问好",
    copy: { fileName: `${ASSET_ID}.png`, byteSize: 1024, mediaType: "image" },
    width: 8,
    height: 8,
    collectionIds: [collection.id],
  });
  expect(h.receive({ id: "84001", speaker: "20002", addressed: true })).toMatchObject({
    kind: "recorded",
    recorded: true,
    hasText: true,
  });
  expect(h.lastEventSeq).toBeGreaterThan(0);
  const runId = crypto.randomUUID();
  h.runs.createRun({
    runId,
    specId: "synthetic-delivery",
    specVersion: "1",
    owner: { kind: "conversation", id: h.conversationId, agentId: AGENT_ID },
    at: h.now(),
  });
  return { ...h, runId };
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

async function deliverPlan(
  business: ReturnType<typeof setup>,
  ports: {
    send: (request: OneBotSendRequest) => Promise<OneBotSendResult>;
    stickerFile: (id: string) => string | null;
  },
  input: {
    kind: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";
    plan: QqPlannedOutput;
    text: string | null;
    sentAtSeconds: number;
    mention?: string | null;
    scope: typeof scope;
  },
) {
  const intent = business.outbox.commit({
    runId: business.runId,
    conversationId: business.conversationId,
    ordinal: business.outbox.list({}).length,
    target: {
      ...input.scope,
      bindingId: business.bindingId,
      bindingEpoch: 1,
      ...(input.mention ? { participantId: input.mention } : {}),
    },
    speechKind: input.kind,
    sourceThroughSeq: business.lastEventSeq,
    deliverBy: new Date((NOW + 600) * 1000).toISOString(),
    createdAt: business.now(),
    expiresAt: new Date((NOW + 3600) * 1000).toISOString(),
    parts: input.plan.parts.map((part) =>
      part.kind === "text"
        ? { kind: "text" as const, text: part.text }
        : { kind: "sticker" as const, stickerId: part.stickerId },
    ),
  });
  const delivery = new OutboundDelivery({
    orm: business.orm,
    repository: business.outbox,
    journal: business.journal,
    port: { send: ports.send },
    stickerFile: ports.stickerFile,
    authorize: () => true,
    now: () => business.now(),
  });
  await delivery.deliver(intent.id);
  const legacyId = business.outbox.row(intent.id)?.legacy_send_id;
  const log = business.orm
    .select()
    .from(schema.qqSendLog)
    .all()
    .find((row) => row.id === legacyId);
  if (!log) throw new Error("missing actual receipt projection");
  return { outcome: log.outcome, log };
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
      const record = await deliverPlan(
        business,
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
      expect(qqSendOutcomeEffect(record?.outcome).entersUnresponded).toBe(true);
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
      const record = await deliverPlan(
        business,
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
      const record = await deliverPlan(
        business,
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
      expect(qqSendOutcomeEffect(record?.outcome).entersUnresponded).toBe("pending");
      expect(business.orm.select().from(schema.qqSendPart).all()).toMatchObject([
        { partKind: "text", result: "failed" },
        { partKind: "sticker", result: "not_sent" },
      ]);
      // A failed attempt writes the ledger and nothing else; whether it consumes the no-reply
      // slot is U13, which the record reports as pending rather than answering.
      expect(business.orm.select().from(schema.qqSpeechLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });

  it("treats an unknown text result the same way and never assumes it was delivered", async () => {
    const business = setup();
    try {
      const port = fakePort([unknown]);
      const record = await deliverPlan(
        business,
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
      const record = await deliverPlan(
        business,
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
      const record = await deliverPlan(
        business,
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
      await deliverPlan(
        business,
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
      const intentsBefore = business.outbox.list({});
      expect(
        planQqOutput({
          text: null,
          requestedStickers: 0,
          maxStickerCount: 1,
          candidates: [],
          minRepeatSeconds: null,
          avoidRecent: false,
        }),
      ).toEqual({ kind: "abandoned", reason: "empty_reply" });
      expect(business.outbox.list({})).toEqual(intentsBefore);
      expect(port.requests).toEqual([]);
      expect(business.orm.select().from(schema.qqSendLog).all()).toEqual([]);
    } finally {
      business.close();
    }
  });
});

// The store is only touched through the port in these cases; a real copy round-trip lives in the
// sticker tests, so this file stays about the send decision.
// 分开回给不同的人时要真的 @ 到对方。回复文案里写的是 [CQ:at,qq=号码]，
// 而数组形态的 message 不解析文本里的 CQ 码，所以发送通路必须显式拆段——否则群里看到的是一串
// 字面量。这一段钉的就是"拆成什么"和"什么绝不拆"。
describe("a mention written as a CQ code travels as an at segment", () => {
  it("splits one text part into at + text and keeps it one ledger row", async () => {
    const business = setup();
    try {
      const port = fakePort([DELIVERED("m-1")]);
      const record = await deliverPlan(
        business,
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
      const record = await deliverPlan(
        business,
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
          { type: "text", data: { text: " 张三你好" } },
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
      await deliverPlan(
        business,
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
      await deliverPlan(
        business,
        { send: port.send, stickerFile: () => null },
        {
          scope,
          kind: "chiming_in",
          plan: plan([{ kind: "text", text: "普通一句话" }]),
          text: "普通一句话",
          sentAtSeconds: NOW,
        },
      );
      await deliverPlan(
        business,
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

describe("qqReplySegments: two wire semantics (structured mentions vs legacy part)", () => {
  it("sends a new part's body literally, even when it still spells a CQ at-code", () => {
    const segments = qqReplySegments({ text: "[CQ:at,qq=20002] 在吗", mentions: [] });
    expect(segments).toEqual([{ type: "text", data: { text: "[CQ:at,qq=20002] 在吗" } }]);
  });

  it("encodes structured mention ids as at segments after the body, and never the old program recipient", () => {
    const segments = qqReplySegments({ text: "你们看这个", mentions: ["20002", "30003"] }, "20001");
    expect(segments).toEqual([
      { type: "text", data: { text: "你们看这个" } },
      { type: "at", data: { qq: "20002" } },
      { type: "at", data: { qq: "30003" } },
    ]);
  });

  it("throws a protocol error on a non-numeric mention id instead of inventing or dropping a target", () => {
    expect(() => qqReplySegments({ text: "在的", mentions: ["all"] })).toThrow(TypeError);
    expect(() => qqReplySegments({ text: "在的", mentions: [""] })).toThrow(TypeError);
  });

  it("replays a legacy part (no mentions) on its own wire: subject CQ at plus the ordinal-0 recipient", () => {
    const segments = qqReplySegments({ text: "[CQ:at,qq=20002] 刚才那句我同意" }, "20001");
    expect(segments).toEqual([
      { type: "at", data: { qq: "20001" } },
      { type: "at", data: { qq: "20002" } },
      { type: "text", data: { text: " 刚才那句我同意" } },
    ]);
  });
});
