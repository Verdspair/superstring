import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  OneBotConnection,
  type OneBotConnectionConfig,
  type OneBotSendRequest,
  type OneBotSocket,
} from "../../src/server/services/onebot-connection";
import { qqReplySegments } from "../../src/server/services/qq-send-transport";

const NOW = "2026-10-08T05:00:00.000Z";
const LATER = "2026-10-08T06:00:00.000Z";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "44444444-4444-4444-8444-444444444444";
const dir = mkdtempSync(path.join(tmpdir(), "qq-reply-wire-"));
const dbPath = path.join(dir, "business.sqlite");
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
});

class SendSocket extends EventTarget implements OneBotSocket {
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  terminate() {
    this.readyState = 3;
  }
  send(payload: string) {
    const request = JSON.parse(payload) as {
      action: string;
      params: Record<string, unknown>;
      echo: string;
    };
    this.sent.push(request);
    const data =
      request.action === "get_login_info"
        ? { user_id: 10001 }
        : request.action === "get_status"
          ? { online: true, good: true }
          : { message_id: 987654321 };
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }),
      }),
    );
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}

async function sendThroughConnection(message: OneBotSendRequest["message"]) {
  const socket = new SendSocket();
  const config: OneBotConnectionConfig = {
    url: "ws://127.0.0.1:3000/",
    accessToken: "synthetic-token",
    accountId: "10001",
    connectTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  };
  const connection = new OneBotConnection(config, {
    onMessage: () => {},
    socketFactory: () => socket,
  });
  const connected = connection.connect();
  socket.open();
  expect(await connected).toEqual({ kind: "ready", accountId: "10001" });
  const result = await connection.send({ kind: "group", peerId: "30003", message });
  connection.disconnect();
  return { result, sent: socket.sent };
}

function createIntent() {
  mkdirSync(dir, { recursive: true });
  const business = openBusinessDb({ path: dbPath });
  handles.push(business);
  ensureDefaults(business.orm, "synthetic-model");
  business.db
    .query("INSERT INTO qq_schemes(id,name,revision,created_at,updated_at) VALUES(?,?,1,?,?)")
    .run(SCHEME_ID, "synthetic", NOW, NOW);
  business.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(BINDING_ID, "10001", "group", "30003", DEFAULT_AGENT_ID, SCHEME_ID, NOW, NOW);
  const journal = new ConversationEventRepository(business.db);
  const conversation = journal.ensureOneBot(BINDING_ID);
  if (!conversation) throw new Error("synthetic conversation was not created");
  new AgentRunRepository(business.db).createRun({
    runId: "synthetic-run",
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: NOW,
  });
  const outbox = new OutboundIntentRepository(business.db);
  outbox.commit({
    id: INTENT_ID,
    runId: "synthetic-run",
    conversationId: conversation.id,
    ordinal: 0,
    target: {
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId: BINDING_ID,
      bindingEpoch: conversation.bindingEpoch,
    },
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: LATER,
    createdAt: NOW,
    expiresAt: LATER,
    parts: [
      {
        kind: "text",
        text: "quoted words",
        replyToMessageId: "platform-message:88",
        mentions: ["20002"],
      },
      {
        kind: "sticker",
        stickerId: "synthetic-sticker",
        replyToMessageId: "sticker-source:9",
        mentions: ["30004"],
      },
    ],
  });
  return { business, outbox };
}

describe("QQ reply/mention segments and persisted metadata", () => {
  it("preserves text, mention-only, quote and mixed quote/mention combinations as native segments", () => {
    expect(qqReplySegments({ text: "plain text" })).toEqual([
      { type: "text", data: { text: "plain text" } },
    ]);
    expect(qqReplySegments({ text: "", mentions: ["20002"] })).toEqual([
      { type: "at", data: { qq: "20002" } },
    ]);
    expect(qqReplySegments({ text: "reply words", replyToMessageId: "q-7" })).toEqual([
      { type: "reply", data: { id: "q-7" } },
      { type: "text", data: { text: "reply words" } },
    ]);
    expect(
      qqReplySegments({
        text: "reply words",
        replyToMessageId: "q-8",
        mentions: ["20002", "30003"],
      }),
    ).toEqual([
      { type: "reply", data: { id: "q-8" } },
      { type: "text", data: { text: "reply words" } },
      { type: "at", data: { qq: "20002" } },
      { type: "at", data: { qq: "30003" } },
    ]);
  });

  it("keeps quoted stickers on one real image carrier and rejects empty/non-mention text carriers", () => {
    expect(
      qqReplySegments({
        stickerFile: "base64://synthetic-image",
        replyToMessageId: "q-image",
        mentions: ["20002"],
      }),
    ).toEqual([
      { type: "reply", data: { id: "q-image" } },
      { type: "at", data: { qq: "20002" } },
      { type: "image", data: { file: "base64://synthetic-image" } },
    ]);
    expect(() => qqReplySegments({ text: "", replyToMessageId: "q-empty" })).toThrow(TypeError);
    expect(() =>
      qqReplySegments({ text: "", replyToMessageId: "q-empty-at", mentions: [] }),
    ).toThrow(TypeError);
    expect(
      qqReplySegments({ text: "", replyToMessageId: "q-at-only", mentions: ["20002"] }),
    ).toEqual([
      { type: "reply", data: { id: "q-at-only" } },
      { type: "at", data: { qq: "20002" } },
    ]);
    expect(() => qqReplySegments({ text: "", mentions: [] })).toThrow(TypeError);
    expect(() => qqReplySegments({ text: "x", replyToMessageId: "" })).toThrow(TypeError);
  });

  it("accepts mention-only and quoted sticker segments through the existing OneBot send request", async () => {
    const mentionOnly = await sendThroughConnection(
      qqReplySegments({ text: "", mentions: ["20002"] }),
    );
    expect(mentionOnly.result.kind).toBe("confirmed");
    expect(mentionOnly.sent.at(-1)).toMatchObject({
      action: "send_group_msg",
      params: { message: [{ type: "at", data: { qq: "20002" } }] },
    });

    const quotedSticker = await sendThroughConnection(
      qqReplySegments({
        stickerFile: "base64://synthetic-image",
        replyToMessageId: "q-image",
        mentions: ["20002"],
      }),
    );
    expect(quotedSticker.result.kind).toBe("confirmed");
    expect(quotedSticker.sent.at(-1)).toMatchObject({
      params: {
        message: [
          { type: "reply", data: { id: "q-image" } },
          { type: "at", data: { qq: "20002" } },
          { type: "image", data: { file: "base64://synthetic-image" } },
        ],
      },
    });
  });

  it("persists quote and mention fields across database reopen and sends the retrieved first part unchanged", async () => {
    let { business, outbox } = createIntent();
    const conversationId = outbox.row(INTENT_ID)?.conversation_id;
    expect(conversationId).toBeTruthy();
    const first = outbox.parts(INTENT_ID)[0];
    expect(JSON.parse(first?.payload ?? "null")).toEqual({
      text: "quoted words",
      mentions: ["20002"],
      replyToMessageId: "platform-message:88",
    });
    const sticker = outbox.parts(INTENT_ID)[1];
    expect(JSON.parse(sticker?.payload ?? "null")).toEqual({
      stickerId: "synthetic-sticker",
      mentions: ["30004"],
      replyToMessageId: "sticker-source:9",
    });
    const original = handles.splice(handles.indexOf(business), 1)[0];
    original.close();

    business = openBusinessDb({ path: dbPath });
    handles.push(business);
    outbox = new OutboundIntentRepository(business.db);
    const claim = outbox.claimPart(INTENT_ID, NOW);
    expect(claim?.payload).toEqual({
      text: "quoted words",
      mentions: ["20002"],
      replyToMessageId: "platform-message:88",
    });
    if (!claim || !("text" in claim.payload)) throw new Error("text payload missing");
    const wire = qqReplySegments(claim.payload);
    const sent = await sendThroughConnection(wire);
    expect(sent.result).toEqual({ kind: "confirmed", messageId: "987654321" });
    expect(sent.sent.at(-1)).toMatchObject({
      action: "send_group_msg",
      params: {
        group_id: 30003,
        message: [
          { type: "reply", data: { id: "platform-message:88" } },
          { type: "text", data: { text: "quoted words" } },
          { type: "at", data: { qq: "20002" } },
        ],
      },
    });

    outbox.settlePart(claim.part.id, { status: "confirmed", messageId: "987654321" }, NOW);
    const stickerClaim = outbox.claimPart(INTENT_ID, NOW);
    expect(stickerClaim?.payload).toEqual({
      stickerId: "synthetic-sticker",
      mentions: ["30004"],
      replyToMessageId: "sticker-source:9",
    });
    if (!stickerClaim || !("stickerId" in stickerClaim.payload))
      throw new Error("sticker payload missing");
    const stickerWire = qqReplySegments({
      stickerFile: "base64://resolved-synthetic-sticker",
      mentions: stickerClaim.payload.mentions,
      replyToMessageId: stickerClaim.payload.replyToMessageId,
    });
    const stickerSent = await sendThroughConnection(stickerWire);
    expect(stickerSent.sent.at(-1)).toMatchObject({
      action: "send_group_msg",
      params: {
        message: [
          { type: "reply", data: { id: "sticker-source:9" } },
          { type: "at", data: { qq: "30004" } },
          { type: "image", data: { file: "base64://resolved-synthetic-sticker" } },
        ],
      },
    });
  });
});
