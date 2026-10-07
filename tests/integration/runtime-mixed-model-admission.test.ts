// 混合入口共用模型准入（规格 §9/§10）：Web /v2/chat、QQ 一次 direct 消息（真实 adapter/scheduler）
// 与后台叶子（原 AgentRuntime.completeMessageLeaf）跑在同一个 production runtime（createRuntime
// 原装配）上，共用同一个 ModelPort 与同一份策略。断言依据是**真实 loopback HTTP 在飞重叠**
// （本地 port 0 桩按请求记账），不是 Promise.all 的口头并行；超预算拒绝必须发生在 HTTP 之前。
//
// 边界：隔离合成业务库（openBusinessDb 内存）、自有 loopback 桩（port 0，finally 关闭）、不启真实
// 服务（不调 runtime.start）、不读真实 data/config、不接真实 QQ/模型。QQ 直连走真实 adapter/scheduler
// + bot-host，正常首 call 用合法 terminal/final；不硬编码调用次数迎合。
import { afterEach, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { createSession, DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createRuntime } from "../../src/server/runtime";
import type { QqIntakeRuntime } from "../../src/server/services/qq-intake";

const MODEL = "local/mix";
const PEER = "20002";

const sockets = new Set<import("node:net").Socket>();
function listen(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => resolve());
  });
}

/** 等到条件成立；超时抛错，绝不 sleep 固定时长来制造并发。 */
async function waitFor(condition: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const envelope = (content: string) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
});

/**
 * loopback 模型桩：chat/completions 请求一律挂住，直到测试放行——因此“在飞”就是服务端真实收到的
 * 并发。非流式请求按**请求本身**给最小合法 body（QQ 回复档 → terminal speech.reply；Web 决策 →
 * generate final；后台叶子 → 纯文本），不靠调用序号猜。全局在飞与按服务在飞分别记峰值。
 */
function providerStub() {
  const held: { service: string; respond: () => void }[] = [];
  const arrival: string[] = [];
  let total = 0;
  let peakTotal = 0;
  const byService = new Map<string, number>();
  const peakService = new Map<string, number>();
  const handler: http.RequestListener = (req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("/models")) {
      // OpenAI 目录 + LM Studio 原生目录（capacity）。桩只回目录，不做业务判断。
      if (url.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: MODEL,
                loaded_instances: [{ id: MODEL, config: { context_length: 65536 } }],
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        model?: string;
        stream?: boolean;
        messages?: unknown;
        response_format?: unknown;
      };
      const service = String(body.model ?? "local").split("/")[0] ?? "local";
      total += 1;
      peakTotal = Math.max(peakTotal, total);
      byService.set(service, (byService.get(service) ?? 0) + 1);
      peakService.set(
        service,
        Math.max(peakService.get(service) ?? 0, byService.get(service) ?? 0),
      );
      arrival.push(service);
      const messages = JSON.stringify(body.messages ?? []);
      const respond = () => {
        total -= 1;
        byService.set(service, (byService.get(service) ?? 0) - 1);
        if (body.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"stream"}}]}\n\n');
          res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        const content = messages.includes("这是 OneBot")
          ? JSON.stringify({
              kind: "invoke",
              calls: [
                {
                  name: "speech.reply",
                  arguments: { outputs: [{ kind: "inline", targetId: PEER, text: "QQAnswer" }] },
                },
              ],
            })
          : body.response_format !== undefined
            ? JSON.stringify({
                kind: "final",
                outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
              })
            : "BgAnswer";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope(content)));
      };
      held.push({ service, respond });
    });
  };
  return {
    handler,
    inFlight: () => total,
    peakTotal: () => peakTotal,
    peakService: (service: string) => peakService.get(service) ?? 0,
    arrival: () => [...arrival],
    heldCount: () => held.length,
    releaseOne() {
      const entry = held.shift();
      entry?.respond();
    },
    releaseAll() {
      while (held.length > 0) held.shift()?.respond();
    },
  };
}
type Stub = ReturnType<typeof providerStub>;

const servers: Server[] = [];
const stubs: Stub[] = [];
const runtimes: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const stub of stubs.splice(0)) stub.releaseAll();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const server of servers.splice(0)) await close(server);
});

/** 同一 production factory + 隔离合成库 + 自有 loopback 网关；配额 global 2 / provider 2。 */
async function buildRuntime(stub: Stub) {
  const { server, port } = await listen(stub.handler);
  servers.push(server);
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sends: unknown[] = [];
  const intake = {
    state: { phase: "ready" },
    connection: {
      async send(request: unknown) {
        sends.push(request);
        return { kind: "confirmed", messageId: String(sends.length) };
      },
    },
    async start() {},
    stop() {},
  } as unknown as QqIntakeRuntime;
  const runtime = createRuntime({
    business,
    gateway: createLmStudioClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: MODEL,
      timeoutSeconds: 5,
    }),
    qqIntake: intake,
    browserStateSecret: "mixed-admission-synthetic-secret",
    botConversationPolicy: { modelCallConcurrency: 2 },
  });
  runtimes.push(runtime);
  return { runtime, business, sends };
}

/** 一次 QQ direct 私聊消息：真实 adapter/scheduler 路径。 */
function seedQqDirect(business: ReturnType<typeof openBusinessDb>) {
  updateQqSettings(business.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(business.orm, {
    name: "mixed",
    reply: { split_by_speaker: false },
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
  });
  const now = new Date().toISOString();
  const nowSeconds = Math.floor(Date.now() / 1000);
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: crypto.randomUUID(),
      accountId: "10001",
      conversationKind: "private",
      peerId: PEER,
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  business.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: "mixed-1",
      accountId: "10001",
      conversationKind: "private",
      peerId: PEER,
      agentId: DEFAULT_AGENT_ID,
      messageId: "1",
      occurredAtSeconds: nowSeconds,
      speakerKind: "member",
      speakerId: PEER,
      recordedAt: now,
      addressed: 1,
    })
    .run();
  business.orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: "mixed-1",
      body: "private hello",
      occurredAtSeconds: nowSeconds,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      recordedAt: now,
    })
    .run();
}

it("三个入口共用同一 runtime/端口与策略：真实 HTTP 在飞重叠受 global≤2 与 provider≤2 同时约束", async () => {
  const stub = providerStub();
  stubs.push(stub);
  const { runtime, business, sends } = await buildRuntime(stub);

  const session = createSession(business.orm, "Mixed", { modelName: MODEL });
  // 三入口并发发起：Web /v2/chat（决策 + 生成）、QQ 一次 direct（真实 adapter/scheduler，terminal
  // speech.reply）、后台叶子（原 completeMessageLeaf）。桩挂住响应，逼出端口真实排队。
  const web = runtime.app.request("/v2/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: session.id,
      message: "hello",
      client_request_id: "mixed-web",
    }),
  });
  await waitFor(() => stub.inFlight() === 1, "web decision in flight");
  seedQqDirect(business);
  const qq = runtime.botWorker.runCycle();
  await waitFor(() => stub.inFlight() === 2, "qq decision in flight");
  const background = runtime.agentRuntime.completeMessageLeaf(
    { id: "mixed.background" },
    {
      owner: { kind: "test_job", id: "mixed-bg", userId: "u", agentId: DEFAULT_AGENT_ID },
      messages: [{ role: "user", content: [{ kind: "text", text: "background" }] }],
    },
  );
  // 已两条在飞＝正重叠；第三个入口（后台）与 Web 的后续生成都被挡在 HTTP 之外，只能等名额。
  // 边放行边让队列排空，全程峰值必须停在两把帽以内。
  while (stub.arrival().length < 4) {
    stub.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  stub.releaseAll();

  const webText = await (await web).text();
  const backgroundText = await background;
  await qq;
  await waitFor(() => sends.length > 0, "qq direct send");

  // 三个入口都真正到达了同一个 loopback 端口；并发期间确实两条同时在飞；两把帽都没被越过。
  expect(stub.arrival().length).toBeGreaterThanOrEqual(3);
  expect(stub.peakTotal()).toBe(2);
  expect(stub.peakService("local")).toBe(2);
  // 等价输出与运行记录按入口区分。
  expect(webText).toContain("event: completed");
  expect(backgroundText).toBe("BgAnswer");
  const runs = business.db
    .query("SELECT spec_id,owner_kind FROM agent_runs ORDER BY rowid")
    .all() as { spec_id: string; owner_kind: string }[];
  expect(runs.map((row) => row.spec_id)).toContain("conversation.web");
  expect(runs.map((row) => row.spec_id)).toContain("onebot.main");
  expect(runs.map((row) => row.spec_id)).toContain("mixed.background");
  expect(runs.map((row) => row.owner_kind)).toContain("web_turn");
  expect(runs.map((row) => row.owner_kind)).toContain("conversation");
  expect(runs.map((row) => row.owner_kind)).toContain("test_job");
});

it("父任务树预算超限：第 N 次调用在真实 HTTP 之前被拒（loopback 未收到该请求）", async () => {
  const stub = providerStub();
  stubs.push(stub);
  const { runtime } = await buildRuntime(stub);
  const owner = { kind: "test_job", id: "mixed-budget", userId: "u", agentId: DEFAULT_AGENT_ID };

  // 预算 1：本树只允许一次模型调用。第一次叶子真发 HTTP（放行），第二次必须不发而抛。
  const group = runtime.agentRuntime.runTaskGroup(
    { id: "mixed.budget.parent", version: "1" },
    { owner, budget: { maxCalls: 1 } },
    async () => {
      const first = runtime.agentRuntime.completeMessageLeaf(
        { id: "budget.leaf.1" },
        { owner, messages: [{ role: "user", content: [{ kind: "text", text: "one" }] }] },
      );
      await waitFor(() => stub.inFlight() === 1, "first budget leaf in flight");
      stub.releaseOne();
      await first;
      await runtime.agentRuntime.completeMessageLeaf(
        { id: "budget.leaf.2" },
        { owner, messages: [{ role: "user", content: [{ kind: "text", text: "two" }] }] },
      );
    },
  );
  await expect(group).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });

  // 真实 loopback 只收到第一次调用；第二次在 HTTP 之前就被拒。
  expect(stub.arrival()).toHaveLength(1);
});
