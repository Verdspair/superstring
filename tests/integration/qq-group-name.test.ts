// 0053 QQ 群显示名：显示备注 > OneBot 群本名 > 既有"群聊 群号"回退；群号独立恒在。
// 覆盖四条自然路径：连接 ready 即对已绑定群只读取名（不等新消息）、PATCH 备注与重置、
// 刷新本名不覆写备注、私聊/Web 拒绝与越界请求。全部走 fake socket / 合成库。

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { handleError } from "../../src/server/api/error-handler";
import { subscribeConversationChanges } from "../../src/server/conversation/conversation-changes";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  readQqGroupName,
  saveQqCustomName,
  saveQqOriginalName,
} from "../../src/server/db/qq-group-name-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { OneBotConnection, type OneBotSocket } from "../../src/server/services/onebot-connection";
import { QqIntakeRuntime } from "../../src/server/services/qq-intake";
import {
  ConversationGroupNamePatchSchema,
  ConversationSummarySchema,
} from "../../src/shared/contracts/conversation";

const TOKEN = "synthetic-token";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_ID = "11111111-1111-4111-8111-111111111112";
const GROUP = { accountId: "10001", kind: "group" as const, peerId: "30003" };

/** Same shape as the transport tests' fake, so both layers are exercised alike. */
class FakeSocket extends EventTarget implements OneBotSocket {
  readyState = 0;
  sent: Array<{ action: string; params: Record<string, unknown>; echo: string }> = [];
  onSend?: (request: { action: string; params: Record<string, unknown>; echo: string }) => void;
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  deliver(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
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
    this.onSend?.(request);
  }
  respond(request: { echo: string }, data: unknown) {
    this.deliver({ status: "ok", retcode: 0, data, echo: request.echo });
  }
}

function completeHandshake(socket: FakeSocket) {
  socket.onSend = (request) => {
    if (request.action === "get_login_info") socket.respond(request, { user_id: 10001 });
    if (request.action === "get_status") socket.respond(request, { online: true, good: true });
  };
  socket.open();
}

function wireMessage(messageId: number) {
  return {
    time: 1_000,
    self_id: 10001,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: messageId,
    user_id: 20002,
    group_id: 30003,
    message: [{ type: "text", data: { text: "群友说喜欢猫" } }],
  };
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "qwen/qwen3-4b-2507");
  const scheme = createQqScheme(business.orm, { name: "群名方案" });
  const insert = (
    id: string,
    conversation: { accountId: string; kind: "group" | "private"; peerId: string },
  ) =>
    business.orm
      .insert(schema.qqBindings)
      .values({
        id,
        accountId: conversation.accountId,
        conversationKind: conversation.kind,
        peerId: conversation.peerId,
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
  const dir = mkdtempSync(path.join(tmpdir(), "ss-qq-name-"));
  const journal = new ConversationEventRepository(business.db);
  const app = new Hono()
    .onError(handleError)
    .route("/v2/conversations", conversationRoutes(business.db, { includeShared: true }));
  return {
    business,
    db: business.db,
    orm: business.orm,
    journal,
    app,
    keyPath: path.join(dir, "qq-transport.key"),
    dir,
    insert,
  };
}

function dispose(h: ReturnType<typeof setup>) {
  h.business.close();
  rmSync(h.dir, { recursive: true, force: true });
}

async function waitFor(check: () => boolean, tries = 200) {
  for (let attempt = 0; attempt < tries && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

function enableTransport(h: ReturnType<typeof setup>) {
  const current = readQqSettings(h.orm);
  updateQqSettings(h.orm, {
    enabled: true,
    accountId: "10001",
    expectedRevision: current.revision,
  });
  updateQqTransportConfig(h.orm, {
    endpoint: "ws://127.0.0.1:3000/",
    token: TOKEN,
    expectedRevision: readQqSettings(h.orm).revision,
    keyPath: h.keyPath,
  });
}

const handles: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) dispose(h);
});

describe("qq group display names (0053)", () => {
  it("names bound groups once the connection is ready, without waiting for a message", async () => {
    const h = setup();
    handles.push(h);
    h.insert(BINDING_ID, GROUP);
    enableTransport(h);
    const conversation = h.journal.ensureOneBot(BINDING_ID)!;
    const sockets: FakeSocket[] = [];
    const runtime = new QqIntakeRuntime({
      orm: h.orm,
      transportKeyPath: h.keyPath,
      connectTimeoutMs: 500,
      requestTimeoutMs: 200,
      socketFactory: (): OneBotSocket => {
        const socket = new FakeSocket();
        sockets.push(socket);
        // Handshake after the transport has attached its listeners.
        queueMicrotask(() => completeHandshake(socket));
        return socket;
      },
    });
    expect(await runtime.start()).toEqual({ phase: "ready", accountId: "10001" });
    // The one read-only naming call is already out; until it answers the summary keeps
    // the number fallback and the group number stays independently visible.
    const naming = sockets[0]!.sent.find((request) => request.action === "get_group_info")!;
    expect(naming.params).toEqual({ group_id: 30003, no_cache: false });
    const unnamed = h.journal.get(conversation.id);
    // No row yet: the block still carries the number, and the remark is directly
    // editable without waiting for the bot side to report a name.
    expect(unnamed).toMatchObject({
      title: "群聊 30003",
      qqGroup: { number: "30003", originalName: null, customName: null },
    });
    const remark = await h.app.request(`/v2/conversations/${conversation.id}/name`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "我的备注" }),
    });
    expect(remark.status).toBe(200);
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "我的备注",
      qqGroup: { number: "30003", originalName: null, customName: "我的备注" },
    });
    sockets[0]!.respond(naming, {
      group_id: 30003,
      group_name: "测试群",
      member_count: 3,
      max_member_count: 100,
    });
    await waitFor(() => readQqGroupName(h.db, "10001", "30003")?.qqName === "测试群");
    // The bot side's name lands as originalName; the remark set before it wins the title.
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "我的备注",
      qqGroup: { number: "30003", originalName: "测试群", customName: "我的备注" },
    });
    // A later group message does not ask again: one naming call per (connection, group).
    const before = sockets[0]!.sent.filter((request) => request.action === "get_group_info").length;
    sockets[0]!.deliver(wireMessage(-12));
    await Bun.sleep(20);
    expect(sockets[0]!.sent.filter((request) => request.action === "get_group_info")).toHaveLength(
      before,
    );
    runtime.stop();
  });

  it("stores the remark through PATCH, publishes one change and resets to the default", async () => {
    const h = setup();
    handles.push(h);
    h.insert(BINDING_ID, GROUP);
    saveQqOriginalName(h.db, "10001", "30003", "测试群");
    const conversation = h.journal.ensureOneBot(BINDING_ID)!;
    // The ensure's own publication flushes in a microtask; drain it so the
    // subscription below observes only the PATCH change.
    await Bun.sleep(0);
    const changes: string[] = [];
    const unsubscribe = subscribeConversationChanges(h.db, (change) =>
      changes.push(change.conversationId),
    );
    const patch = (body: unknown) =>
      h.app.request(`/v2/conversations/${conversation.id}/name`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const response = await patch(ConversationGroupNamePatchSchema.parse({ name: "我的备注" }));
    expect(response.status).toBe(200);
    const summary = ConversationSummarySchema.parse(await response.json());
    expect(summary).toMatchObject({
      title: "我的备注",
      qqGroup: { number: "30003", originalName: "测试群", customName: "我的备注" },
    });
    await waitFor(() => changes.length >= 1);
    expect(changes).toEqual([conversation.id]);
    // null and blank both clear the remark, falling back to the group's own name.
    expect((await patch({ name: null })).status).toBe(200);
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "测试群",
      qqGroup: { customName: null },
    });
    await patch({ name: "   " });
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "测试群",
      qqGroup: { customName: null },
    });
    unsubscribe();
  });

  it("refreshes the original name on reconnect without overwriting the remark", () => {
    const h = setup();
    handles.push(h);
    h.insert(BINDING_ID, GROUP);
    saveQqOriginalName(h.db, "10001", "30003", "旧本名");
    saveQqCustomName(h.db, "10001", "30003", "我的备注");
    saveQqOriginalName(h.db, "10001", "30003", "新本名");
    expect(readQqGroupName(h.db, "10001", "30003")).toEqual({
      qqName: "新本名",
      customName: "我的备注",
    });
    const conversation = h.journal.ensureOneBot(BINDING_ID)!;
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "我的备注",
      qqGroup: { originalName: "新本名", customName: "我的备注" },
    });
    saveQqCustomName(h.db, "10001", "30003", null);
    expect(h.journal.get(conversation.id)).toMatchObject({
      title: "新本名",
      qqGroup: { originalName: "新本名", customName: null },
    });
  });

  it("opens the rename only for QQ groups and refuses oversized bodies", async () => {
    const h = setup();
    handles.push(h);
    h.insert(BINDING_ID, GROUP);
    h.insert(PRIVATE_ID, { accountId: "10001", kind: "private", peerId: "40004" });
    const group = h.journal.ensureOneBot(BINDING_ID)!;
    const conversation = h.journal.ensureOneBot(PRIVATE_ID)!;
    const session = createSession(h.orm, "网页会话", { modelName: "fixture" });
    const web = h.journal.ensureWeb(session.id)!;
    const patch = (id: string, body: unknown, json = true) =>
      h.app.request(`/v2/conversations/${id}/name`, {
        method: "PATCH",
        headers: json ? { "content-type": "application/json" } : {},
        body: json ? JSON.stringify(body) : "not-json",
      });
    expect((await patch(conversation.id, { name: "备注" })).status).toBe(404);
    expect((await patch(web.id, { name: "备注" })).status).toBe(404);
    expect((await patch(group.id, { name: "字".repeat(101) })).status).toBe(422);
    expect((await patch(group.id, undefined, false)).status).toBe(422);
  });

  it("keeps get_group_info read-only and tolerant to junk answers", async () => {
    const h = setup();
    handles.push(h);
    const socket = new FakeSocket();
    const connection = new OneBotConnection(
      {
        url: "ws://127.0.0.1:3000/",
        accessToken: TOKEN,
        accountId: "10001",
        connectTimeoutMs: 500,
        requestTimeoutMs: 200,
      },
      { onMessage: () => {}, socketFactory: () => socket },
    );
    expect(await connection.getGroupName("30003")).toBeNull();
    let nameReply: unknown = { group_id: 30003, group_name: " 群名 " };
    socket.onSend = (request) => {
      if (request.action === "get_login_info") socket.respond(request, { user_id: 10001 });
      else if (request.action === "get_status")
        socket.respond(request, { online: true, good: true });
      else if (request.action === "get_group_info") socket.respond(request, nameReply);
    };
    const pending = connection.connect();
    socket.open();
    expect(await pending).toEqual({ kind: "ready", accountId: "10001" });
    expect(await connection.getGroupName("30003")).toBe("群名");
    nameReply = { group_id: 30003, group_name: "   " };
    expect(await connection.getGroupName("30003")).toBeNull();
    connection.disconnect();
  });
});
