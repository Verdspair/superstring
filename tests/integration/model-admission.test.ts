// 模型准入：双条件名额（整机总帽 + 服务帽同时可用才占）、等待不占整机、同服务 FIFO 且可跳过
// 被服务帽挡住者推进空闲服务、动态升降、取消摘队与在飞释放。
// 断言依据是**真实 HTTP 在飞重叠**（本地 loopback 桩按请求记账），不是 Promise.all 的口头并行。
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import {
  createModelAdmission,
  createModelPort,
  type ManagedModelAdmission,
} from "../../src/server/agent/model-port";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

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
const CATALOG = ["svc-a/a1", "svc-a/a2", "svc-a/a3", "svc-b/b1", "svc-b/b2"];

/** loopback 模型桩：chat 请求一直挂住直到测试放行，因此"在飞"就是服务端真实收到的并发。 */
function admissionStub() {
  const perModel = new Map<string, number>();
  const peakPerModel = new Map<string, number>();
  const perService = new Map<string, number>();
  const peakPerService = new Map<string, number>();
  const arrival: string[] = [];
  let total = 0;
  let peak = 0;
  const held: { model: string; respond: () => void }[] = [];
  const handler: http.RequestListener = (req, res) => {
    if (!(req.url ?? "").endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: CATALOG.map((id) => ({ id })) }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const model = String((JSON.parse(raw) as { model?: unknown }).model ?? "");
      const service = model.split("/")[0] ?? "local";
      total += 1;
      peak = Math.max(peak, total);
      perModel.set(model, (perModel.get(model) ?? 0) + 1);
      peakPerModel.set(model, Math.max(peakPerModel.get(model) ?? 0, perModel.get(model) ?? 0));
      perService.set(service, (perService.get(service) ?? 0) + 1);
      peakPerService.set(
        service,
        Math.max(peakPerService.get(service) ?? 0, perService.get(service) ?? 0),
      );
      arrival.push(model);
      held.push({
        model,
        respond: () => {
          total -= 1;
          perModel.set(model, (perModel.get(model) ?? 0) - 1);
          perService.set(service, (perService.get(service) ?? 0) - 1);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
          );
        },
      });
    });
  };
  const release = (model?: string) => {
    const index = model === undefined ? 0 : held.findIndex((entry) => entry.model === model);
    if (index < 0 || held.length === 0) return;
    const [entry] = held.splice(index, 1);
    entry.respond();
  };
  return {
    handler,
    inFlight: () => total,
    peakTotal: () => peak,
    peakOf: (model: string) => peakPerModel.get(model) ?? 0,
    peakOfService: (service: string) => peakPerService.get(service) ?? 0,
    arrival: () => [...arrival],
    release,
    releaseAll() {
      while (held.length > 0) release();
    },
  };
}
type Stub = ReturnType<typeof admissionStub>;

/** 等到条件成立；超时抛错避免测试永久挂住。 */
async function waitFor(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const text = (model: string) => ({
  messages: [{ role: "user" as const, content: [{ kind: "text" as const, text: "hi" }] }],
  model,
});

const servers: Server[] = [];
const activeStubs: Stub[] = [];
let started: Promise<unknown>[] = [];
/** 记录本次用例启动的调用：先标记为已处理（避免关闭桩时的拒绝变成未捕获错误），测试仍可 await。 */
function spawn<T>(promise: Promise<T>): Promise<T> {
  started.push(promise);
  promise.catch(() => {});
  return promise;
}
afterEach(async () => {
  for (const stub of activeStubs.splice(0)) stub.releaseAll();
  await Promise.allSettled(started);
  started = [];
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const server of servers.splice(0)) await close(server);
});

/** 建一个打到自有 loopback 桩的真实端口（真实网关、真实 HTTP、真实 wire）。 */
async function portWith(options: {
  total?: number | (() => number);
  perProvider?: number | (() => number);
  onPolicyChange?: (listener: () => void) => () => void;
}) {
  const stub = admissionStub();
  activeStubs.push(stub);
  const { server, port } = await listen(stub.handler);
  servers.push(server);
  const gateway = createLmStudioClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: CATALOG[0] as string,
    timeoutSeconds: 5,
  });
  const client = createModelPort({
    gateway,
    ...(options.total === undefined ? {} : { modelCallConcurrency: options.total }),
    ...(options.perProvider === undefined ? {} : { providerConcurrency: options.perProvider }),
    providerKey: (model) => model?.split("/")[0] ?? "local",
    ...(options.onPolicyChange === undefined ? {} : { onPolicyChange: options.onPolicyChange }),
  });
  return { stub, client };
}

/** 受控 gateway：streamChat/vision 的节奏由测试掌握，用来验证生成器退出路径是否归还名额。 */
function controlledPort() {
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const gateway = {
    async complete() {
      return "ok";
    },
    async *streamChat(request: { signal?: AbortSignal }) {
      events.push("stream:enter");
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(request.signal?.reason ?? new Error("aborted"));
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        yield "first";
        await Promise.race([gate.promise, aborted]);
        yield "second";
      } finally {
        events.push("stream:exit");
      }
    },
  };
  const vision = {
    async annotate() {
      events.push("vision:enter");
      return "vision-ok";
    },
  };
  const client = createModelPort({
    gateway,
    vision,
    modelCallConcurrency: 1,
    providerConcurrency: 1,
    providerKey: () => "svc-a",
  });
  return { client, events, open: () => gate.resolve() };
}

describe("model admission", () => {
  it("准入要求两个名额同时可用：真实 HTTP 在飞重叠受总帽与服务帽同时约束", async () => {
    const { stub, client } = await portWith({ total: 4, perProvider: 1 });
    const calls = ["svc-a/a1", "svc-a/a2", "svc-b/b1", "svc-b/b2"].map((model) =>
      spawn(client.complete(text(model))),
    );
    await waitFor(() => stub.inFlight() === 2, "two services in flight");
    // 两个服务各一条真实在飞；同服务第二条被服务帽挡住，整机帽 4 不拦。
    expect(new Set(stub.arrival())).toEqual(new Set(["svc-a/a1", "svc-b/b1"]));
    stub.releaseAll();
    await waitFor(() => stub.arrival().length === 4, "both same-service second calls admitted");
    stub.releaseAll();
    await Promise.all(calls);
    // 服务帽按服务键聚合：同服务不同模型也不得同时两条在飞。
    expect(stub.peakOfService("svc-a")).toBe(1);
    expect(stub.peakOfService("svc-b")).toBe(1);
    expect(stub.peakTotal()).toBe(2);
  });

  it("等待服务名额不占整机名额：忙服务排队时另一服务照常发出", async () => {
    const { stub, client } = await portWith({ total: 2, perProvider: 1 });
    const a1 = spawn(client.complete(text("svc-a/a1")));
    await waitFor(() => stub.inFlight() === 1, "svc-a/a1 in flight");
    const a2 = spawn(client.complete(text("svc-a/a2")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b1 = spawn(client.complete(text("svc-b/b1")));
    await waitFor(() => stub.inFlight() === 2, "svc-b/b1 admitted");
    // 总帽 2 被 a1 + b1 占满；a2 仍排队（旧实现里 a2 会先占整机帽再等服务帽）。
    expect(stub.arrival()).toEqual(["svc-a/a1", "svc-b/b1"]);
    stub.release("svc-a/a1");
    await waitFor(() => stub.arrival().includes("svc-a/a2"), "svc-a/a2 admitted after release");
    stub.releaseAll();
    await Promise.all([a1, a2, b1]);
  });

  it("同服务保持到达序，队首被服务帽挡住时后面的空闲服务不被卡住", async () => {
    const { stub, client } = await portWith({ total: 3, perProvider: 1 });
    const a1 = spawn(client.complete(text("svc-a/a1")));
    await waitFor(() => stub.inFlight() === 1, "a1 in flight");
    const a2 = spawn(client.complete(text("svc-a/a2")));
    const a3 = spawn(client.complete(text("svc-a/a3")));
    const b1 = spawn(client.complete(text("svc-b/b1")));
    // a2/a3 排在队首序列里，但被 svc-a 帽挡住；b1 直接推进（跳过暂不可用的服务）。
    await waitFor(() => stub.arrival().includes("svc-b/b1"), "b1 skipped past busy svc-a");
    expect(stub.arrival()).toEqual(["svc-a/a1", "svc-b/b1"]);
    stub.release("svc-a/a1");
    await waitFor(() => stub.arrival().includes("svc-a/a2"), "a2 next in same-service order");
    stub.release("svc-a/a2");
    await waitFor(() => stub.arrival().includes("svc-a/a3"), "a3 after a2, not before");
    expect(stub.arrival()).toEqual(["svc-a/a1", "svc-b/b1", "svc-a/a2", "svc-a/a3"]);
    stub.releaseAll();
    await Promise.all([a1, a2, a3, b1]);
  });

  it("只有整机帽时仍按整机上限并发（不因缺服务帽而放宽或收紧）", async () => {
    const { stub, client } = await portWith({ total: 1 });
    const first = spawn(client.complete(text("svc-a/a1")));
    await waitFor(() => stub.inFlight() === 1, "first in flight");
    const second = spawn(client.complete(text("svc-b/b1")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.inFlight()).toBe(1);
    expect(stub.peakTotal()).toBe(1);
    stub.release("svc-a/a1");
    await waitFor(() => stub.arrival().includes("svc-b/b1"), "second admitted after release");
    stub.releaseAll();
    await Promise.all([first, second]);
    expect(stub.peakTotal()).toBe(1);
  });

  it("调高上限经策略通知唤醒等待队列，在飞请求不被中止（无定时轮询）", async () => {
    let total = 1;
    let notify: (() => void) | null = null;
    const { stub, client } = await portWith({
      total: () => total,
      onPolicyChange: (listener) => {
        notify = listener;
        return () => {
          notify = null;
        };
      },
    });
    const first = spawn(client.complete(text("svc-a/a1")));
    await waitFor(() => stub.inFlight() === 1, "first in flight");
    const queued = spawn(client.complete(text("svc-a/a2")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.arrival()).toEqual(["svc-a/a1"]);
    total = 3;
    (notify as unknown as () => void)();
    await waitFor(() => stub.arrival().includes("svc-a/a2"), "queued call drained");
    // 在飞请求没有被中止：两条都在飞，桩仍持有两边。
    expect(stub.inFlight()).toBe(2);
    stub.releaseAll();
    await Promise.all([first, queued]);
  });

  it("取消未获名额者只摘队不占名额；在飞取消后名额可复用", async () => {
    const { stub, client } = await portWith({ total: 1, perProvider: 1 });
    const controller = new AbortController();
    const first = spawn(client.complete({ ...text("svc-a/a1"), signal: controller.signal }));
    await waitFor(() => stub.inFlight() === 1, "first in flight");
    const queuedController = new AbortController();
    const queued = spawn(client.complete({ ...text("svc-a/a2"), signal: queuedController.signal }));
    queuedController.abort(new Error("queued cancel"));
    await expect(queued).rejects.toThrow("queued cancel");
    // 摘队后 a2 从未到达服务端。
    expect(stub.arrival()).toEqual(["svc-a/a1"]);
    controller.abort(new Error("in-flight cancel"));
    await expect(first).rejects.toThrow("in-flight cancel");
    stub.releaseAll();
    await waitFor(() => stub.inFlight() === 0, "in-flight slot released");
    const next = spawn(client.complete(text("svc-a/a3")));
    await waitFor(() => stub.arrival().includes("svc-a/a3"), "slot reusable after cancel");
    stub.releaseAll();
    await expect(next).resolves.toBe("ok");
  });

  it("观察面只作当前提示：占用与释放都通知，可用性随之翻转，退订后不再收到", async () => {
    const admission = createModelAdmission({
      total: 1,
      perProvider: 1,
      providerKey: (model) => model?.split("/")[0] ?? "local",
    });
    let notifications = 0;
    const unsubscribe = admission.subscribe(() => {
      notifications += 1;
    });
    expect(admission.available("svc-a/a1")).toBe(true);
    expect(admission.available("svc-b/b1")).toBe(true);
    const release = await admission.acquire("svc-a/a1");
    expect(admission.available("svc-a/a1")).toBe(false);
    expect(admission.available("svc-b/b1")).toBe(false); // 总帽 1 已满
    expect(notifications).toBeGreaterThan(0);
    const before = notifications;
    release();
    expect(admission.available("svc-a/a1")).toBe(true);
    expect(notifications).toBeGreaterThan(before);
    unsubscribe();
    const snapshot = notifications;
    const second = await admission.acquire("svc-a/a1");
    expect(notifications).toBe(snapshot);
    second();
  });

  it("订阅回调抛错不改变名额状态（订阅者异常不能吞掉或泄漏名额）", async () => {
    const admission = createModelAdmission({ total: 1 });
    admission.subscribe(() => {
      throw new Error("listener boom");
    });
    const release = await admission.acquire("svc-a/a1");
    expect(admission.available("svc-a/a1")).toBe(false);
    release();
    expect(admission.available("svc-a/a1")).toBe(true);
  });

  it("无任何上限时不设闸：可用性恒真且直接透传", async () => {
    const { stub, client } = await portWith({});
    const calls = ["svc-a/a1", "svc-a/a2", "svc-b/b1"].map((model) =>
      spawn(client.complete(text(model))),
    );
    await waitFor(() => stub.inFlight() === 3, "all three in flight");
    expect(stub.peakTotal()).toBe(3);
    stub.releaseAll();
    await Promise.all(calls);
    expect(client.admission?.available("svc-a/a1")).toBe(true);
  });

  it("调低上限不中断在飞请求，释放后不按旧值追加超发", async () => {
    let total = 2;
    const { stub, client } = await portWith({ total: () => total });
    const first = spawn(client.complete(text("svc-a/a1")));
    const second = spawn(client.complete(text("svc-a/a2")));
    await waitFor(() => stub.inFlight() === 2, "two in flight at limit 2");
    total = 1;
    // 在飞请求不被中止：桩仍持有两条。
    expect(stub.inFlight()).toBe(2);
    const queued = spawn(client.complete(text("svc-a/a3")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.arrival()).toEqual(["svc-a/a1", "svc-a/a2"]);
    stub.release("svc-a/a1");
    await waitFor(() => stub.inFlight() === 1, "one left in flight after release");
    // 调低后释放一个名额，整机已在飞 1 条，等于新上限，不得放进 a3 造成超发。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.arrival()).toEqual(["svc-a/a1", "svc-a/a2"]);
    stub.release("svc-a/a2");
    await waitFor(() => stub.arrival().includes("svc-a/a3"), "a3 admitted only once below limit");
    stub.releaseAll();
    await Promise.all([first, second, queued]);
    expect(stub.peakTotal()).toBe(2);
  });

  it("上限调高后一次刷新可推进多个等待者", async () => {
    let total = 1;
    const admission: ManagedModelAdmission = createModelAdmission({ total: () => total });
    const first = await admission.acquire("svc-a/a1");
    const second = admission.acquire("svc-a/a2");
    const third = admission.acquire("svc-b/b1");
    let secondDone = false;
    let thirdDone = false;
    void second.then(() => {
      secondDone = true;
    });
    void third.then(() => {
      thirdDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([secondDone, thirdDone]).toEqual([false, false]);
    total = 3;
    admission.refresh();
    const [secondRelease, thirdRelease] = await Promise.all([second, third]);
    expect([secondDone, thirdDone]).toEqual([true, true]);
    first();
    secondRelease();
    thirdRelease();
    expect(admission.available("svc-a/a1")).toBe(true);
  });

  it("streamText 正常耗尽与消费方提前 return 后都归还名额（真实 model-port 路径）", async () => {
    const { client, events, open } = controlledPort();
    // 正常耗尽：读到结尾，生成器 return 后名额归还。
    const iterator = client.streamText(text("svc-a/a1"));
    expect((await iterator.next()).value).toBe("first");
    open();
    expect((await iterator.next()).value).toBe("second");
    expect((await iterator.next()).done).toBe(true);
    expect(events).toContain("stream:exit");
    expect(client.admission?.available("svc-a/a1")).toBe(true);

    // 消费方在 yield 之间 return：生成器的 finally 必须释放名额。
    const consumer = client.streamText(text("svc-a/a2"));
    const first = await consumer.next();
    expect(first.value).toBe("first");
    await consumer.return(undefined);
    expect(events).toContain("stream:exit");
    expect(client.admission?.available("svc-a/a2")).toBe(true);
    open();
  });

  it("streamText 抛出/被取消后名额可复用，且同 shared quota 的 completeMultimodal 受同一上限约束", async () => {
    const { client, events, open } = controlledPort();
    // 取消在途 stream：名额随生成器 finally 释放。
    const controller = new AbortController();
    const stream = client.streamText({ ...text("svc-a/a3"), signal: controller.signal });
    expect((await stream.next()).value).toBe("first");
    controller.abort(new Error("stream cancel"));
    await expect(stream.next()).rejects.toThrow("stream cancel");
    expect(client.admission?.available("svc-a/a3")).toBe(true);
    open();
    expect(events).toContain("stream:exit");

    // shared quota：一条完成的 completeMultimodal 与文本共用同一名额池。
    await expect(
      client.completeMultimodal({ model: "svc-a/a1", prompt: "p", images: [] }),
    ).resolves.toBe("vision-ok");
    expect(events).toContain("vision:enter");
    expect(client.admission?.available()).toBe(true);
  });
});
