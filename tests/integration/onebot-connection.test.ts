import { afterEach, describe, expect, it } from "bun:test";
import { type ServerWebSocket, serve } from "bun";
import {
  OneBotConnection,
  type OneBotConnectionConfig,
  type OneBotSendRequest,
  type OneBotSocket,
  type OneBotSocketFactory,
} from "../../src/server/services/onebot-connection";
import type { QqMessageResult } from "../../src/server/services/onebot-protocol";

type Request = { action: string; params: Record<string, unknown>; echo: string };
class FakeSocket extends EventTarget implements OneBotSocket {
  readyState = 0;
  sent: Request[] = [];
  terminations = 0;
  failSend = false;
  onSend?: (request: Request) => void;
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  terminate() {
    this.terminations++;
    this.readyState = 3;
  }
  send(payload: string) {
    if (this.failSend) throw new Error("private transport details");
    const request: Request = JSON.parse(payload);
    this.sent.push(request);
    this.onSend?.(request);
  }
  respond(request: Request, data: unknown, patch: Record<string, unknown> = {}) {
    this.message({ status: "ok", retcode: 0, data, echo: request.echo, ...patch });
  }
}
const config: OneBotConnectionConfig = {
  url: "ws://127.0.0.1:3000/",
  accessToken: "synthetic-token",
  accountId: "10001",
  connectTimeoutMs: 1000,
  requestTimeoutMs: 500,
};
const outgoing: OneBotSendRequest = {
  kind: "group",
  peerId: "30003",
  message: [{ type: "text", data: { text: "测试[CQ:image,file=literal]" } }],
};
const event = (patch: Record<string, unknown> = {}) => ({
  time: 123,
  self_id: 10001,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: -12,
  user_id: 20002,
  group_id: 30003,
  message: [{ type: "text", data: { text: "你好" } }],
  ...patch,
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(
  patch: Partial<OneBotConnectionConfig> = {},
  consumer?: (value: QqMessageResult) => void | Promise<void>,
) {
  const sockets: FakeSocket[] = [];
  const messages: QqMessageResult[] = [];
  const requests: Array<{ url: string; options: Parameters<OneBotSocketFactory>[1] }> = [];
  const connection = new OneBotConnection(
    { ...config, ...patch },
    {
      onMessage:
        consumer ??
        ((value) => {
          messages.push(value);
        }),
      socketFactory: (url, options) => {
        requests.push({ url, options });
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  cleanups.push(() => connection.disconnect());
  return { connection, sockets, messages, requests };
}
function automaticIdentity(
  socket: FakeSocket,
  data: unknown = { user_id: 10001 },
  status: unknown = { online: true, good: true },
) {
  socket.onSend = (request) => {
    if (request.action === "get_login_info") socket.respond(request, data);
    if (request.action === "get_status") socket.respond(request, status);
  };
}
async function ready(f = fixture()) {
  const connecting = f.connection.connect();
  const socket = f.sockets.at(-1);
  if (!socket) throw new Error("Missing synthetic socket");
  automaticIdentity(socket);
  socket.open();
  expect(await connecting).toEqual({ kind: "ready", accountId: "10001" });
  return { ...f, socket };
}

describe("OneBot connection lifecycle", () => {
  it("is inert until connected, uses a header token, and requires identity plus status", async () => {
    const f = fixture({ accountId: "010001" });
    expect(f.sockets).toHaveLength(0);
    expect(f.connection.state).toEqual({ phase: "idle" });
    const promise = f.connection.connect();
    expect(f.connection.connect()).toBe(promise);
    expect(f.requests[0]).toEqual({
      url: config.url,
      options: { headers: { Authorization: "Bearer synthetic-token" } },
    });
    const socket = f.sockets[0];
    socket.open();
    expect(f.connection.state.phase).toBe("verifying");
    expect(await f.connection.send(outgoing)).toEqual({ kind: "not_sent", reason: "not_ready" });
    socket.message(event());
    expect(f.messages).toHaveLength(0);
    socket.respond(socket.sent[0], { user_id: "010001", nickname: "ignored" });
    await Promise.resolve();
    expect(f.connection.state.phase).toBe("verifying");
    expect(socket.sent[1].action).toBe("get_status");
    socket.respond(socket.sent[1], { online: true, good: true });
    expect(await promise).toEqual({ kind: "ready", accountId: "10001" });
    expect(f.connection.pendingCount).toBe(0);
    const snapshot = f.connection.state;
    snapshot.phase = "idle";
    expect(f.connection.state.phase).toBe("ready");
  });

  it("rejects credential-bearing URLs and invalid config without exposing values", () => {
    for (const patch of [
      { url: "https://example.invalid/secret" },
      { url: "ws://user:private@localhost/" },
      { url: "ws://localhost/?access_token=private" },
      { url: "ws://localhost/#private" },
      { url: "private malformed url" },
      { accessToken: "" },
      { accessToken: "x\r\nprivate" },
      { accountId: "0" },
      { connectTimeoutMs: 0 },
      { requestTimeoutMs: Infinity },
      { requestTimeoutMs: 2 ** 31 },
    ]) {
      expect(() => fixture(patch)).toThrow("Invalid OneBot connection configuration");
    }
  });

  it("sanitizes synchronous connection errors and never reconnects itself", async () => {
    let attempts = 0;
    const connection = new OneBotConnection(config, {
      onMessage: () => {},
      socketFactory: () => {
        attempts++;
        throw new Error("synthetic-token private address");
      },
    });
    expect(await connection.connect()).toEqual({ kind: "failed", reason: "connect_error" });
    expect(connection.state).toEqual({ phase: "closed", reason: "connect_error" });
    expect(attempts).toBe(1);
    expect(connection.pendingCount).toBe(0);
  });

  it("handles post-open authentication rejection before a correlated identity response", async () => {
    const f = fixture();
    const promise = f.connection.connect();
    const socket = f.sockets[0];
    socket.open();
    socket.message({ status: "failed", retcode: 1403, wording: "secret token" });
    expect(await promise).toEqual({ kind: "failed", reason: "authentication_failed" });
    expect(f.connection.pendingCount).toBe(0);
    expect(socket.terminations).toBe(1);
    socket.respond(socket.sent[0], { user_id: 10001 });
    expect(f.connection.state.phase).toBe("closed");
  });

  it("handles correlated authentication denial and generic handshake failure", async () => {
    for (const [retcode, reason] of [
      [1401, "authentication_failed"],
      [1200, "handshake_failed"],
    ] as const) {
      const f = fixture();
      const promise = f.connection.connect();
      const socket = f.sockets[0];
      socket.open();
      socket.respond(socket.sent[0], null, { status: "failed", retcode });
      expect(await promise).toEqual({ kind: "failed", reason });
    }
  });

  it("rejects a different account and malformed identity", async () => {
    for (const [data, reason] of [
      [{ user_id: 10002 }, "account_mismatch"],
      [{ user_id: 0 }, "identity_invalid"],
      [null, "identity_invalid"],
    ] as const) {
      const f = fixture();
      const promise = f.connection.connect();
      const socket = f.sockets[0];
      automaticIdentity(socket, data);
      socket.open();
      expect(await promise).toEqual({ kind: "failed", reason });
      expect(socket.sent).toHaveLength(1);
    }
  });

  it("rejects offline, unhealthy and invalid status but accepts good with unknown online", async () => {
    for (const [status, reason] of [
      [{ online: false, good: true }, "account_offline"],
      [{ online: true, good: false }, "account_offline"],
      [{ good: true }, "status_invalid"],
      [{ online: "true", good: true }, "status_invalid"],
    ] as const) {
      const f = fixture();
      const promise = f.connection.connect();
      const socket = f.sockets[0];
      automaticIdentity(socket, { user_id: 10001 }, status);
      socket.open();
      expect(await promise).toEqual({ kind: "failed", reason });
    }
    const f = fixture();
    const promise = f.connection.connect();
    automaticIdentity(f.sockets[0], { user_id: 10001 }, { online: null, good: true });
    f.sockets[0].open();
    expect((await promise).kind).toBe("ready");
  });

  it("does not become ready after a heartbeat or identity change overtakes the status continuation", async () => {
    for (const [input, reason] of [
      [event({ self_id: 10002 }), "account_mismatch"],
      [
        {
          post_type: "meta_event",
          meta_event_type: "heartbeat",
          self_id: 10001,
          status: { online: false, good: false },
        },
        "account_offline",
      ],
    ] as const) {
      const f = fixture();
      const promise = f.connection.connect();
      const socket = f.sockets[0];
      socket.onSend = (request) => {
        if (request.action === "get_login_info") socket.respond(request, { user_id: 10001 });
        if (request.action === "get_status") {
          socket.respond(request, { online: true, good: true });
          socket.message(input);
        }
      };
      socket.open();
      expect(await promise).toEqual({ kind: "failed", reason });
      expect(f.connection.state).toEqual({ phase: "closed", reason });
      expect(f.connection.pendingCount).toBe(0);
    }
  });

  it("bounds unopened connections and silent identity verification", async () => {
    const f = fixture({ connectTimeoutMs: 20 });
    expect(await f.connection.connect()).toEqual({ kind: "failed", reason: "connect_timeout" });
    expect(f.sockets[0].terminations).toBe(1);
    const g = fixture({ requestTimeoutMs: 20 });
    const promise = g.connection.connect();
    g.sockets[0].open();
    expect(await promise).toEqual({ kind: "failed", reason: "handshake_failed" });
    expect(g.connection.pendingCount).toBe(0);
  });

  it("allows stop during connection and identity verification without leaked waiters", async () => {
    for (const open of [false, true]) {
      const f = fixture();
      const promise = f.connection.connect();
      if (open) f.sockets[0].open();
      f.connection.disconnect();
      f.connection.disconnect();
      expect(await promise).toEqual({ kind: "failed", reason: "stopped" });
      expect(f.connection.pendingCount).toBe(0);
      expect(f.sockets[0].terminations).toBe(1);
    }
  });

  it("delivers normalized observations and invalid-format diagnostics, not self or notice events", async () => {
    const f = await ready();
    f.socket.message(event());
    f.socket.message(event({ user_id: 10001 }));
    f.socket.message({ post_type: "notice", self_id: 10001 });
    f.socket.message(event({ message: "CQ string" }));
    expect(f.messages).toHaveLength(2);
    expect(f.messages[0]).toMatchObject({
      kind: "message",
      observation: { accountId: "10001", text: "你好" },
    });
    expect(f.messages[1]).toEqual({ kind: "invalid", reason: "unsupported_message_format" });
  });

  it("invalidates readiness when account changes or a heartbeat reports offline", async () => {
    for (const [input, reason] of [
      [event({ self_id: 10002 }), "account_mismatch"],
      [
        {
          post_type: "meta_event",
          meta_event_type: "heartbeat",
          self_id: 10001,
          status: { online: false, good: false },
        },
        "account_offline",
      ],
    ] as const) {
      const f = await ready();
      const sending = f.connection.send(outgoing);
      f.socket.message(input);
      expect(f.connection.state).toEqual({ phase: "closed", reason });
      expect(await sending).toEqual({ kind: "unknown", reason: "disconnected" });
      expect(f.messages).toHaveLength(0);
    }
  });

  it("terminates malformed or binary protocol frames with a controlled reason", async () => {
    for (const data of ["not json private details", "null", "[]", new ArrayBuffer(8)]) {
      const f = await ready();
      f.socket.dispatchEvent(new MessageEvent("message", { data }));
      expect(f.connection.state).toEqual({ phase: "closed", reason: "protocol_error" });
    }
  });

  it("contains synchronous and asynchronous consumer failures", async () => {
    for (const consumer of [
      () => {
        throw new Error("private message");
      },
      () => Promise.reject(new Error("private message")),
    ]) {
      const f = await ready(fixture({}, consumer));
      f.socket.message(event());
      await Promise.resolve();
      expect(f.connection.state).toEqual({ phase: "closed", reason: "consumer_error" });
    }
  });

  it("does not let an old asynchronous consumer failure close a newer connection", async () => {
    const failed = Promise.withResolvers<void>();
    const f = await ready(fixture({}, () => failed.promise));
    f.socket.message(event());
    f.connection.disconnect();
    await ready(f);
    failed.reject(new Error("old consumer"));
    await Promise.resolve();
    expect(f.connection.state.phase).toBe("ready");
  });
});

describe("OneBot request correlation and uncertain delivery", () => {
  it("routes group/private arrays and matches concurrent out-of-order responses", async () => {
    const f = await ready();
    const first = f.connection.send(outgoing);
    const second = f.connection.send({
      kind: "private",
      peerId: "020002",
      message: [
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { file: "asset.gif" } },
        { type: "face", data: { id: "123" } },
      ],
    });
    const a = f.socket.sent[2];
    const b = f.socket.sent[3];
    expect(a.action).toBe("send_group_msg");
    expect(a.params.group_id).toBe(30003);
    expect(b.action).toBe("send_private_msg");
    expect(b.params.user_id).toBe(20002);
    expect(a.params.message).toEqual(outgoing.message);
    expect(new Set(f.socket.sent.map((r) => r.echo)).size).toBe(4);
    f.socket.respond(b, { message_id: -2 });
    f.socket.respond(a, { message_id: -1 });
    expect(await first).toEqual({ kind: "confirmed", messageId: "-1" });
    expect(await second).toEqual({ kind: "confirmed", messageId: "-2" });
    expect(f.connection.pendingCount).toBe(0);
  });

  it("keeps failed, async, contradictory and missing-ID receipts distinct", async () => {
    const f = await ready();
    for (const [patch, expected] of [
      [
        { status: "failed", retcode: 1200, wording: "secret" },
        { kind: "failed", retcode: 1200 },
      ],
      [
        { status: "async", retcode: 1 },
        { kind: "unknown", reason: "async" },
      ],
      [
        { status: "failed", retcode: 0 },
        { kind: "unknown", reason: "malformed_receipt" },
      ],
      [{}, { kind: "unknown", reason: "missing_message_id" }],
    ] as const) {
      const sending = f.connection.send(outgoing);
      f.socket.respond(f.socket.sent.at(-1) as Request, null, patch);
      expect(await sending).toEqual(expected);
    }
  });

  it("does not resolve from a foreign echo or an event carrying a matching echo", async () => {
    const f = await ready();
    const sending = f.connection.send(outgoing);
    const request = f.socket.sent[2];
    f.socket.respond(request, { message_id: 111 }, { echo: "foreign" });
    f.socket.message(
      event({ echo: request.echo, status: "ok", retcode: 0, data: { message_id: 111 } }),
    );
    expect(f.connection.pendingCount).toBe(1);
    f.socket.respond(request, { message_id: 222 });
    expect(await sending).toEqual({ kind: "confirmed", messageId: "222" });
  });

  it("marks timeouts unknown, ignores late responses and never resends", async () => {
    const f = await ready(fixture({ requestTimeoutMs: 20 }));
    const sending = f.connection.send(outgoing);
    expect(await sending).toEqual({ kind: "unknown", reason: "timeout" });
    f.socket.respond(f.socket.sent[2], { message_id: 111 });
    expect(await sending).toEqual({ kind: "unknown", reason: "timeout" });
    expect(f.socket.sent.filter((r) => r.action.startsWith("send_")).length).toBe(1);
    expect(f.connection.pendingCount).toBe(0);
  });

  it("settles all outstanding sends on disconnect and requires explicit reconnect", async () => {
    for (const stop of [false, true]) {
      const f = await ready();
      const a = f.connection.send(outgoing);
      const b = f.connection.send(outgoing);
      if (stop) f.connection.disconnect();
      else f.socket.close();
      expect(await a).toEqual({ kind: "unknown", reason: "disconnected" });
      expect(await b).toEqual({ kind: "unknown", reason: "disconnected" });
      expect(await f.connection.send(outgoing)).toEqual({ kind: "not_sent", reason: "not_ready" });
      expect(f.connection.pendingCount).toBe(0);
      expect(f.sockets).toHaveLength(1);
      expect(f.socket.sent).toHaveLength(4);
    }
  });

  it("guards stale socket callbacks and old echoes after explicit reconnect", async () => {
    const f = await ready();
    const old = f.socket;
    const sending = f.connection.send(outgoing);
    const oldRequest = old.sent[2];
    old.close();
    expect((await sending).kind).toBe("unknown");
    const fresh = await ready(f);
    const next = f.connection.send(outgoing);
    const nextRequest = fresh.socket.sent[2];
    expect(nextRequest.echo).not.toBe(oldRequest.echo);
    old.message(event());
    old.dispatchEvent(new Event("error"));
    old.open();
    fresh.socket.respond(oldRequest, { message_id: 1 });
    expect(f.connection.state.phase).toBe("ready");
    expect(f.connection.pendingCount).toBe(1);
    expect(f.messages).toHaveLength(0);
    fresh.socket.respond(nextRequest, { message_id: 2 });
    expect(await next).toEqual({ kind: "confirmed", messageId: "2" });
  });

  it("treats send exceptions as unknown and closes the transport", async () => {
    const f = await ready();
    f.socket.failSend = true;
    expect(await f.connection.send(outgoing)).toEqual({
      kind: "unknown",
      reason: "transport_error",
    });
    expect(f.connection.state).toEqual({ phase: "closed", reason: "connect_error" });
    expect(f.connection.pendingCount).toBe(0);
  });

  it("rejects unsafe destinations and malformed segments before sending", async () => {
    const f = await ready();
    for (const patch of [
      { peerId: "9007199254740993" },
      { peerId: "0" },
      { peerId: "-1" },
      { kind: "other" },
      { message: [] },
      { message: "CQ string" },
      { message: [{ type: "text", data: { text: "" } }] },
      { message: [{ type: "image", data: { file: "asset", unexpected: true } }] },
      { message: [{ type: "record", data: { file: "voice" } }] },
    ])
      expect(await f.connection.send({ ...outgoing, ...patch } as OneBotSendRequest)).toEqual({
        kind: "not_sent",
        reason: "invalid_request",
      });
    expect(f.socket.sent).toHaveLength(2);
  });
});

describe("OneBot native loopback transport", () => {
  function server(
    onRequest?: (socket: ServerWebSocket<undefined>, request: Request) => void,
    deny = false,
  ) {
    const received: Request[] = [];
    const upgrades: Array<{ authorization: string | null; url: string }> = [];
    const listener = serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch(request, server) {
        upgrades.push({ authorization: request.headers.get("authorization"), url: request.url });
        if (server.upgrade(request, { data: undefined })) return;
        return new Response("Upgrade required", { status: 400 });
      },
      websocket: {
        open(socket) {
          if (deny) {
            socket.send(JSON.stringify({ status: "failed", retcode: 1403 }));
            socket.close();
          }
        },
        message(socket, raw) {
          const request: Request = JSON.parse(raw.toString());
          received.push(request);
          if (deny) return;
          if (request.action === "get_login_info" || request.action === "get_status") {
            socket.send(
              JSON.stringify({
                status: "ok",
                retcode: 0,
                echo: request.echo,
                data:
                  request.action === "get_login_info"
                    ? { user_id: 10001 }
                    : { online: true, good: true },
              }),
            );
          } else onRequest?.(socket, request);
        },
      },
    });
    cleanups.push(() => listener.stop(true));
    const observations: QqMessageResult[] = [];
    const connection = new OneBotConnection(
      {
        ...config,
        url: `ws://127.0.0.1:${listener.port}/`,
        connectTimeoutMs: 2000,
        requestTimeoutMs: 1000,
      },
      {
        onMessage: (value) => {
          observations.push(value);
        },
      },
    );
    cleanups.push(() => connection.disconnect());
    return { listener, received, upgrades, connection, observations };
  }

  it("sends Bearer only in headers and receives arrays and correlated replies on one socket", async () => {
    const f = server((socket, request) => {
      socket.send(JSON.stringify(event()));
      socket.send(
        JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data: { message_id: -77 } }),
      );
    });
    expect(await f.connection.connect()).toEqual({ kind: "ready", accountId: "10001" });
    expect(await f.connection.send(outgoing)).toEqual({ kind: "confirmed", messageId: "-77" });
    expect(f.upgrades).toHaveLength(1);
    expect(f.upgrades[0].authorization).toBe("Bearer synthetic-token");
    expect(f.upgrades[0].url).not.toContain("synthetic-token");
    expect(f.received.map((r) => r.action)).toEqual([
      "get_login_info",
      "get_status",
      "send_group_msg",
    ]);
    expect(f.observations).toHaveLength(1);
    expect(f.connection.pendingCount).toBe(0);
  });

  it("recognizes native post-open authentication denial", async () => {
    const f = server(undefined, true);
    expect(await f.connection.connect()).toEqual({
      kind: "failed",
      reason: "authentication_failed",
    });
    expect(f.connection.pendingCount).toBe(0);
  });

  it("returns unknown after server-side disconnect without repeating the send", async () => {
    const f = server((socket) => socket.close());
    expect((await f.connection.connect()).kind).toBe("ready");
    expect(await f.connection.send(outgoing)).toEqual({ kind: "unknown", reason: "disconnected" });
    expect(f.received.filter((r) => r.action.startsWith("send_"))).toHaveLength(1);
    expect(f.connection.pendingCount).toBe(0);
  });
});
