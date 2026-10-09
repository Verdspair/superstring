// D2 outbox 发送领域的真实并发/顺序/恢复事实（规格 §4.3/§8.2）。
//
// 真实 SQLite + 真实 OutboundDelivery + 真实 loopback HTTP 服务：端口收到整段真实请求体才算
// "在飞"，因此并发不是 Promise.all 的口头并行。覆盖：
//   * 不同会话的 intent 在各自车道上真实 HTTP 重叠：慢群不挡快群；
//   * 同一 intent 的多个部件严格串行（前一个 settle 后才 claim 下一个），顺序即 ordinal；
//   * claim 唯一性：同一部件不会被两个并发投递各发一次；
//   * unknown 回执不重放，也不把后续部件 improvisation 成新消息；
//   * 结构化 mentions 按 payload 原样编码进真实 HTTP 请求体（正文 CQ 保持字面）。
// 不读真实 data/config，不发真实 QQ。

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import type { Socket } from "node:net";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";

const now = "2026-10-01T16:00:00.000000Z";
const later = "2026-10-01T17:00:00.000000Z";
const BINDING = "11111111-1111-4111-8111-111111111111";
const BINDING_B = "22222222-2222-4222-8222-222222222222";

const sockets = new Set<Socket>();
const servers: Server[] = [];
const handles: ReturnType<typeof openBusinessDb>[] = [];
const running: Promise<number>[] = [];
const activeStubs: OneBotStub[] = [];

afterEach(async () => {
  // 先放行仍挂住的桩请求并等所有 runOnce 收口，再关库/关服务：在途投递被关库打断不是产品行为。
  for (const stub of activeStubs.splice(0)) stub.releaseAll();
  await Promise.allSettled(running.splice(0));
  for (const handle of handles.splice(0)) handle.close();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type Wire = { peerId: string; message: unknown };
type OneBotStub = {
  handler: http.RequestListener;
  inflight: Wire[];
  arrivals: string[];
  releaseFor: (peerId: string, messageId: string) => void;
  releaseAll: () => void;
};

/**
 * loopback OneBot 桩：读全每条 send 的真实请求体后挂住，直到测试放行——因此"在飞"就是服务端
 * 真实持有的并发请求，不是 Promise.all 的口头并行。
 */
function onebotStub(
  results: (input: { peerId: string; messageId: string }) => unknown,
): OneBotStub {
  const inflight: Wire[] = [];
  const arrivals: string[] = [];
  const held: Array<{ wire: Wire; respond: (value: unknown) => void }> = [];
  const handler: http.RequestListener = (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { params?: { peerId?: unknown } };
      const wire: Wire = { peerId: String(parsed.params?.peerId ?? ""), message: parsed.params };
      arrivals.push(wire.peerId);
      inflight.push(wire);
      held.push({
        wire,
        respond: (value) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        },
      });
    });
  };
  const take = (peerId: string) => {
    const index = held.findIndex((entry) => entry.wire.peerId === peerId);
    if (index < 0) throw new Error(`no inflight request for ${peerId}`);
    const [entry] = held.splice(index, 1);
    inflight.splice(inflight.indexOf(entry.wire), 1);
    return entry;
  };
  const stub: OneBotStub = {
    handler,
    inflight,
    arrivals,
    releaseFor(peerId, messageId) {
      take(peerId).respond(results({ peerId, messageId }));
    },
    releaseAll() {
      while (held.length > 0) {
        const entry = held.shift()!;
        inflight.splice(inflight.indexOf(entry.wire), 1);
        entry.respond(results({ peerId: entry.wire.peerId, messageId: "released" }));
      }
    },
  };
  activeStubs.push(stub);
  return stub;
}

async function listen(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  const server = http.createServer(handler);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { server, port: (server.address() as { port: number }).port };
}

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  const journal = new ConversationEventRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const addConversation = (bindingId: string, peerId: string) => {
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
      )
      .run(bindingId, "90001", "group", peerId, DEFAULT_AGENT_ID, now, now);
    const conversation = journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error(`fixture: ensureOneBot(${bindingId}) returned null`);
    return conversation.id;
  };
  const commitIntent = (
    conversationId: string,
    bindingId: string,
    intentId: string,
    parts: (
      | { kind: "text"; text: string; mentions?: readonly string[] }
      | { kind: "sticker"; stickerId: string }
    )[],
  ) => {
    const runId = `run-${intentId}`;
    new AgentRunRepository(h.db).createRun({
      runId,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversationId },
      at: now,
    });
    const binding = h.db
      .query(
        "SELECT account_id AS accountId,conversation_kind AS conversationKind,peer_id AS peerId,authority_revision AS authorityRevision FROM qq_bindings WHERE id=?",
      )
      .get(bindingId) as {
      accountId: string;
      conversationKind: "group" | "private";
      peerId: string;
      authorityRevision: number;
    };
    const epoch = (
      h.db.query("SELECT binding_epoch AS n FROM conversations WHERE id=?").get(conversationId) as {
        n: number;
      }
    ).n;
    const target: OutboundTarget = {
      accountId: binding.accountId,
      conversationKind: binding.conversationKind,
      peerId: binding.peerId,
      agentId: DEFAULT_AGENT_ID,
      bindingId,
      bindingEpoch: epoch,
      authorityRevision: binding.authorityRevision,
    };
    outbox.commit({
      id: intentId,
      runId,
      conversationId,
      ordinal: 0,
      target,
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: later,
      createdAt: now,
      expiresAt: later,
      parts,
    });
    const row = outbox.row(intentId);
    if (!row) throw new Error("fixture: intent missing");
    return row;
  };
  return { h, journal, outbox, addConversation, commitIntent };
}
type Fixture = ReturnType<typeof setup>;

/** 真实 HTTP 端口的 OneBot 发送端口（真实 wire，非合成函数返回值）。 */
function httpPort(port: number) {
  const url = `http://127.0.0.1:${port}/`;
  return {
    async send(request: OneBotSendRequest): Promise<OneBotSendResult> {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send_group_msg", params: request, echo: "e" }),
      });
      const receipt = (await response.json()) as {
        status: string;
        retcode: number;
        data?: { message_id?: string };
      };
      const messageId = receipt.data?.message_id;
      if (receipt.status === "ok" && receipt.retcode === 0 && messageId !== undefined) {
        return { kind: "confirmed", messageId };
      }
      return { kind: "failed", retcode: receipt.retcode };
    },
  };
}

function deliveryFor(f: Fixture, port: number, deliveryConcurrency?: number) {
  return new OutboundDelivery({
    orm: f.h.orm,
    repository: f.outbox,
    journal: f.journal,
    stickerFile: () => null,
    authorize: () => true,
    now: () => now,
    port: httpPort(port),
    ...(deliveryConcurrency === undefined ? {} : { deliveryConcurrency }),
  });
}

function runOnceTracked(f: Fixture, port: number): Promise<number> {
  const run = deliveryFor(f, port).runOnce();
  running.push(run);
  return run;
}
const okResult = ({ messageId }: { peerId: string; messageId: string }) => ({
  status: "ok",
  retcode: 0,
  data: { message_id: messageId },
});

async function waitFor(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("outbox delivery: cross-conversation real HTTP parallelism", () => {
  it("a slow group's in-flight request does not hold up a different conversation's send", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    const slow = f.commitIntent(conversationA, BINDING, "intent-slow", [
      { kind: "text", text: "慢群", mentions: [] },
    ]);
    const fast = f.commitIntent(conversationB, BINDING_B, "intent-fast", [
      { kind: "text", text: "快群", mentions: [] },
    ]);

    const run = runOnceTracked(f, port);
    // 等到两个会话的真实请求都在飞：没有全局串行，慢群停在服务端也不挡快群。
    await waitFor(() => stub.inflight.length === 2, "both conversations in flight");
    expect(new Set(stub.inflight.map((wire) => wire.peerId))).toEqual(new Set(["30003", "30004"]));

    // 先放行慢群，再放行快群：两边结算互不依赖。
    stub.releaseFor("30003", "-1");
    await waitFor(() => f.outbox.get(slow.id)?.status === "confirmed", "slow settled");
    // 慢群已结算，快群的请求仍在（边界仍在飞，说明它没有等慢群）。
    expect(stub.inflight.map((wire) => wire.peerId)).toEqual(["30004"]);
    stub.releaseFor("30004", "-2");
    await run;
    expect(f.outbox.get(slow.id)?.status).toBe("confirmed");
    expect(f.outbox.get(fast.id)?.status).toBe("confirmed");
  });

  it("a second conversation starts sending while the first one's request is still open", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    f.commitIntent(conversationA, BINDING, "intent-a", [{ kind: "text", text: "A" }]);
    f.commitIntent(conversationB, BINDING_B, "intent-b", [{ kind: "text", text: "B" }]);
    const run = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 2, "two parallel sends");
    expect(stub.arrivals.sort()).toEqual(["30003", "30004"]);
    stub.releaseFor("30003", "-1");
    stub.releaseFor("30004", "-2");
    await run;
    expect(f.outbox.list({}).map((d) => d.status)).toEqual(["confirmed", "confirmed"]);
  });
});

describe("outbox delivery: the send resource bound is shared by the instance", () => {
  it("with a 1-lane send resource, two conversations never have requests in flight together", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    f.commitIntent(conversationA, BINDING, "cap-a", [{ kind: "text", text: "A" }]);
    f.commitIntent(conversationB, BINDING_B, "cap-b", [{ kind: "text", text: "B" }]);
    const delivery = deliveryFor(f, port, 1);
    const run = delivery.runOnce();
    running.push(run);
    await waitFor(() => stub.inflight.length === 1, "one request only");
    // 上限 1＝完全串行：另一个会话的请求必须等这一条放行后才出现。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.inflight.length).toBe(1);
    stub.releaseFor(stub.inflight[0]!.peerId, "-1");
    await waitFor(() => stub.inflight.length === 1 && stub.arrivals.length === 2, "second request");
    stub.releaseFor(stub.inflight[0]!.peerId, "-2");
    await run;
    expect(stub.arrivals.length).toBe(2);
  });

  it("with a 2-lane send resource, two conversations overlap while a shared counter still bounds them", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const conversationC = f.addConversation("33333333-3333-4333-8333-333333333333", "30005");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    f.commitIntent(conversationA, BINDING, "cap2-a", [{ kind: "text", text: "A" }]);
    f.commitIntent(conversationB, BINDING_B, "cap2-b", [{ kind: "text", text: "B" }]);
    f.commitIntent(conversationC, "33333333-3333-4333-8333-333333333333", "cap2-c", [
      { kind: "text", text: "C" },
    ]);
    const delivery = deliveryFor(f, port, 2);
    const run = delivery.runOnce();
    running.push(run);
    await waitFor(() => stub.inflight.length === 2, "two conversations overlap");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 第三条会话被共享上限挡住，不会因为两个 runOnce/多车道而超发到 3。
    expect(stub.inflight.length).toBe(2);
    expect(stub.arrivals.length).toBe(2);
    stub.releaseFor(stub.inflight[0]!.peerId, "-1");
    await waitFor(() => stub.arrivals.length === 3, "third starts after a slot frees");
    while (stub.inflight.length > 0) stub.releaseFor(stub.inflight[0]!.peerId, "-x");
    await run;
    expect(stub.arrivals.length).toBe(3);
  });
});

describe("outbox delivery: dynamic resource changes and stop", () => {
  it("lowering the limit while work is queued never overshoots the new limit", async () => {
    const f = setup();
    const conversations = [
      f.addConversation(BINDING, "30003"),
      f.addConversation(BINDING_B, "30004"),
      f.addConversation("33333333-3333-4333-8333-333333333333", "30005"),
    ];
    const bindings = [BINDING, BINDING_B, "33333333-3333-4333-8333-333333333333"];
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    conversations.forEach((conversation, index) => {
      f.commitIntent(conversation, bindings[index]!, `dyn-${index}`, [
        { kind: "text", text: `c${index}` },
      ]);
    });
    // 上限先是 2：两个会话在飞，第三个在排队。
    let limit = 2;
    const delivery = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      port: httpPort(port),
      deliveryConcurrency: () => limit,
    });
    const run = delivery.runOnce();
    running.push(run);
    await waitFor(() => stub.inflight.length === 2, "two in flight at limit 2");
    await waitFor(() => stub.arrivals.length === 2, "third queued, not sent");
    // 动态下调到 1：放行一条后仍只有 1 条在飞（旧值 2 不得放排队者进来补位）。
    limit = 1;
    stub.releaseFor(stub.inflight[0]!.peerId, "-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stub.arrivals.length).toBe(2);
    expect(stub.inflight.length).toBe(1);
    // 放行第二条后，唯一空名额才轮到排队者；始终不超过新上限 1。
    stub.releaseFor(stub.inflight[0]!.peerId, "-2");
    await waitFor(() => stub.arrivals.length === 3, "queued work admitted after a full free");
    expect(stub.inflight.length).toBe(1);
    while (stub.inflight.length > 0) stub.releaseFor(stub.inflight[0]!.peerId, "-x");
    await run;
    expect(stub.arrivals.length).toBe(3);
  });

  it("after stop, waiting work is not sent and no new HTTP request appears", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    f.commitIntent(conversationA, BINDING, "stop-a", [{ kind: "text", text: "A" }]);
    f.commitIntent(conversationB, BINDING_B, "stop-b", [{ kind: "text", text: "B" }]);
    // 上限 1：一条在飞，另一条在等名额。
    const delivery = deliveryFor(f, port, 1);
    const run = delivery.runOnce();
    running.push(run);
    await waitFor(() => stub.inflight.length === 1, "one in flight");
    delivery.stop();
    // 放行在飞的那条：它照常结算，但等待者不得发出新请求。
    stub.releaseFor(stub.inflight[0]!.peerId, "-1");
    await run;
    expect(stub.arrivals.length).toBe(1);
    expect(f.outbox.list({}).filter((d) => d.status === "confirmed")).toHaveLength(1);
    expect(f.outbox.list({}).filter((d) => d.status === "planned")).toHaveLength(1);
  });
});

describe("outbox delivery: one intent's parts are strictly serial and in ordinal order", () => {
  it("claims the next part only after the previous one settles", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    const intent = f.commitIntent(conversation, BINDING, "intent-parts", [
      { kind: "text", text: "第一段", mentions: [] },
      { kind: "text", text: "第二段", mentions: [] },
      { kind: "text", text: "第三段", mentions: [] },
    ]);
    const run = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 1, "only the first part in flight");
    // 第一个部件还没 settle 时，第二个部件绝不能被 claim（同一 intent 内严格串行）。
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual([
      "sending",
      "planned",
      "planned",
    ]);
    stub.releaseFor("30003", "-1");
    await waitFor(() => stub.arrivals.length === 2, "second part sent");
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual([
      "confirmed",
      "sending",
      "planned",
    ]);
    stub.releaseFor("30003", "-2");
    await waitFor(() => stub.arrivals.length === 3, "third part sent");
    stub.releaseFor("30003", "-3");
    await run;
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
  });

  it("two concurrent runOnce on the same conversation never let a later intent start past a stuck earlier one", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    // 同一会话两个不同 intent，同一时刻都是 planned：intent1 先创建（created_at/ordinal 决定先序）。
    const earlier = f.commitIntent(conversation, BINDING, "intent-earlier", [
      { kind: "text", text: "先到", mentions: [] },
    ]);
    const later = f.commitIntent(conversation, BINDING, "intent-later", [
      { kind: "text", text: "后到", mentions: [] },
    ]);
    const first = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 1, "earlier intent in flight");
    // intent1 的真实请求仍挂住（未 settle）。此时再起一轮 runOnce：
    // 同一会话里 intent1 的部件仍是 sending，intent2 不得越过它提前发送（同人窗口不能倒序）。
    const second = runOnceTracked(f, port);
    await second;
    expect(stub.arrivals).toEqual(["30003"]);
    expect(f.outbox.parts(earlier.id).map((part) => part.status)).toEqual(["sending"]);
    expect(f.outbox.parts(later.id).map((part) => part.status)).toEqual(["planned"]);
    // 放行 intent1 后才轮到 intent2。
    stub.releaseFor("30003", "-1");
    await waitFor(() => stub.arrivals.length === 2, "later intent sent after settle");
    stub.releaseFor("30003", "-2");
    await first;
    expect(f.outbox.parts(earlier.id).map((part) => part.status)).toEqual(["confirmed"]);
    expect(f.outbox.parts(later.id).map((part) => part.status)).toEqual(["confirmed"]);
  });

  it("a second concurrent runOnce cannot claim the same part twice (claim uniqueness)", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    const intent = f.commitIntent(conversation, BINDING, "intent-unique", [
      { kind: "text", text: "唯一", mentions: [] },
    ]);
    const first = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 1, "first claim in flight");
    // 同一部件在途时再跑一轮：原本事务保证没有第二个发送方抢到它。
    const second = runOnceTracked(f, port);
    await second;
    expect(stub.arrivals.length).toBe(1);
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual(["sending"]);
    stub.releaseFor("30003", "-1");
    await first;
    expect(stub.arrivals.length).toBe(1);
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual(["confirmed"]);
  });
});

describe("outbox delivery: active conversation drain notices and shutdown", () => {
  it("coalesces same-conversation commits during an active lane into one scoped outbox re-read", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    const first = f.commitIntent(conversation, BINDING, "active-first", [
      { kind: "text", text: "first", mentions: [] },
    ]);
    const pendingCalls: Array<string | undefined> = [];
    const pending = f.outbox.pending.bind(f.outbox);
    f.outbox.pending = (conversationId) => {
      pendingCalls.push(conversationId);
      return pending(conversationId);
    };
    const delivery = deliveryFor(f, port, 1);
    const run = delivery.runOnce(conversation);
    running.push(run);
    await waitFor(() => stub.inflight.length === 1, "first conversation send");
    const late = Array.from({ length: 8 }, (_, index) => {
      const id = `active-late-${String(index + 1).padStart(2, "0")}`;
      const intent = f.commitIntent(conversation, BINDING, id, [
        { kind: "text", text: id, mentions: [] },
      ]);
      delivery.notifyCommitted(conversation);
      expect(f.outbox.get(intent.id)?.status).toBe("planned");
      return intent;
    });
    expect(pendingCalls).toEqual([conversation]);
    stub.releaseFor("30003", "first-receipt");
    for (let index = 1; index < 9; index += 1) {
      await waitFor(() => stub.inflight.length === 1, `intent ${index} enters send lane`);
      stub.releaseFor("30003", `receipt-${index}`);
    }
    await run;
    expect(stub.arrivals).toEqual(Array(9).fill("30003"));
    expect(f.outbox.get(first.id)?.status).toBe("confirmed");
    for (const intent of late) expect(f.outbox.get(intent.id)?.status).toBe("confirmed");
    expect(pendingCalls).toEqual([conversation, conversation]);
  });

  it("stop drain waits for sibling conversation receipt after another lane rejects", async () => {
    const f = setup();
    const conversationA = f.addConversation(BINDING, "30003");
    const conversationB = f.addConversation(BINDING_B, "30004");
    const first = f.commitIntent(conversationA, BINDING, "drain-reject-a", [
      { kind: "text", text: "A", mentions: [] },
    ]);
    const second = f.commitIntent(conversationB, BINDING_B, "drain-held-b", [
      { kind: "text", text: "B", mentions: [] },
    ]);
    let releaseB: () => void = () => {};
    let enteredB = false;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const sends: string[] = [];
    const failedPartId = f.outbox.parts(first.id)[0]!.id;
    const settlePart = f.outbox.settlePart.bind(f.outbox);
    f.outbox.settlePart = (partId, result, at) => {
      if (partId === failedPartId) throw new Error("synthetic receipt persistence failure");
      return settlePart(partId, result, at);
    };
    const delivery = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      deliveryConcurrency: 2,
      port: {
        async send(request) {
          sends.push(request.peerId);
          if (request.peerId === "30003") return { kind: "confirmed", messageId: "receipt-a" };
          enteredB = true;
          await gateB;
          return { kind: "confirmed", messageId: "receipt-b" };
        },
      },
    });
    const run = delivery.runOnce();
    running.push(run);
    try {
      await waitFor(() => enteredB, "second conversation send is in flight");
      delivery.stop();
      let idle = false;
      const drain = delivery.waitForIdle().then(() => {
        idle = true;
      });
      await Promise.resolve();
      expect(idle).toBe(false);
      releaseB();
      await expect(run).rejects.toThrow("synthetic receipt persistence failure");
      await drain;
      expect(idle).toBe(true);
      expect(sends.sort()).toEqual(["30003", "30004"]);
      expect(f.outbox.get(first.id)?.status).toBe("delivering");
      expect(f.outbox.parts(second.id)[0]?.status).toBe("confirmed");
      expect(f.outbox.get(second.id)?.status).toBe("confirmed");
      delivery.recover();
      expect(f.outbox.get(first.id)?.status).toBe("unknown");
      await delivery.runOnce();
      expect(sends).toHaveLength(2);
    } finally {
      releaseB();
      delivery.stop();
      await delivery.waitForIdle();
    }
  });

  it("stop waits for an in-flight receipt, prevents new sends, and leaves later durable work pending", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    const first = f.commitIntent(conversation, BINDING, "stop-first", [
      { kind: "text", text: "first", mentions: [] },
    ]);
    const delivery = deliveryFor(f, port, 1);
    const run = delivery.runOnce();
    running.push(run);
    await waitFor(() => stub.inflight.length === 1, "stop test send");
    const second = f.commitIntent(conversation, BINDING, "stop-later", [
      { kind: "text", text: "later", mentions: [] },
    ]);
    delivery.stop();
    let idle = false;
    const drain = delivery.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    stub.releaseFor("30003", "stop-receipt");
    await run;
    await drain;
    expect(idle).toBe(true);
    expect(stub.arrivals).toEqual(["30003"]);
    expect(f.outbox.parts(first.id)[0]?.status).toBe("confirmed");
    expect(f.outbox.get(second.id)?.status).toBe("planned");
  });
});

describe("outbox delivery: unknown results are recorded, never replayed", () => {
  it("a failed first part leaves the rest not_sent and recovery sends nothing again", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(() => ({ status: "failed", retcode: 1200 }));
    const { port } = await listen(stub.handler);
    const intent = f.commitIntent(conversation, BINDING, "intent-failed", [
      { kind: "text", text: "第一段", mentions: [] },
      { kind: "text", text: "第二段", mentions: [] },
    ]);
    const run = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 1, "first part in flight");
    stub.releaseFor("30003", "-1");
    await run;
    // 非 confirmed 的结算把后续 planned 部件标 not_sent，不 improvise 成新消息。
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual(["failed", "not_sent"]);
    expect(f.outbox.get(intent.id)?.status).toBe("failed");
    // 重启后 recover + runOnce：没有新的真实请求发出，也不把已尝试过的当未生成重放。
    const resumed = deliveryFor(f, port);
    resumed.recover();
    const again = resumed.runOnce();
    running.push(again);
    expect(await again).toBe(0);
    expect(stub.arrivals.length).toBe(1);
  });

  it("a transport-unknown part is recorded as unknown and recovery never resends it", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const intent = f.commitIntent(conversation, BINDING, "intent-transport-unknown", [
      { kind: "text", text: "不知道发没发", mentions: [] },
    ]);
    let requests = 0;
    const delivery = new OutboundDelivery({
      orm: f.h.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      port: {
        async send() {
          requests++;
          return { kind: "unknown", reason: "transport_error" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(requests).toBe(1);
    expect(f.outbox.parts(intent.id).map((part) => part.status)).toEqual(["unknown"]);
    delivery.recover();
    expect(await delivery.runOnce()).toBe(0);
    expect(requests).toBe(1);
  });
});

describe("outbox delivery: structured mentions reach the real HTTP body literally", () => {
  it("sends the body verbatim and encodes only payload mentions as at segments", async () => {
    const f = setup();
    const conversation = f.addConversation(BINDING, "30003");
    const stub = onebotStub(okResult);
    const { port } = await listen(stub.handler);
    f.commitIntent(conversation, BINDING, "intent-wire-mentions", [
      { kind: "text", text: "正文 [CQ:at,qq=30001] 保持", mentions: ["20002"] },
    ]);
    const run = runOnceTracked(f, port);
    await waitFor(() => stub.inflight.length === 1, "request in flight");
    expect(stub.inflight[0]?.message).toEqual({
      kind: "group",
      peerId: "30003",
      message: [
        { type: "text", data: { text: "正文 [CQ:at,qq=30001] 保持" } },
        { type: "at", data: { qq: "20002" } },
      ],
    });
    stub.releaseFor("30003", "-1");
    await run;
  });
});
