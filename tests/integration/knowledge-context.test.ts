import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeReadRepository } from "../../src/server/db/knowledge-read-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { knowledgeTerms } from "../../src/server/modules/knowledge-module";
import type { ContextUsage } from "../../src/shared/contracts/context-usage";
import { runtimeFixtureBusiness } from "../harness/business-db";

let db: BusinessDbHandle;
let repo: KnowledgeRepository;
let gateway: ModelGateway;
let completeCalls: Parameters<ModelGateway["complete"]>[0][];
let streamCalls: Parameters<ModelGateway["streamChat"]>[0][];
const question = "温度低时允许启动吗，阈值多少？";
const source = "\uFEFF低于10°C时禁止启动。\r\n阈值42.5，维护模式除外。𠮷";
beforeEach(() => {
  db = runtimeFixtureBusiness(openBusinessDb(), "synthetic");
  ensureDefaults(db.orm, "synthetic");
  repo = new KnowledgeRepository(db.db);
  completeCalls = [];
  streamCalls = [];
  gateway = {
    config: { baseUrl: "http://synthetic.invalid/v1", model: "synthetic", timeoutSeconds: 1 },
    async listModels() {
      return ["synthetic"];
    },
    async loadedContextCapacity() {
      return 32768;
    },
    async probeModelLoaded() {
      return true;
    },
    async complete(call) {
      completeCalls.push(call);
      const decisionContent = call.messages[0]?.content;
      if (
        typeof decisionContent === "string" &&
        decisionContent.includes("Return exactly one JSON decision")
      )
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
        });
      const shape = call.responseSchema?.properties as { ids?: { items?: { enum?: string[] } } };
      return JSON.stringify({ ids: shape?.ids?.items?.enum ?? [] });
    },
    async *streamChat(call) {
      streamCalls.push(call);
      yield "合成回答";
    },
  };
});
afterEach(() => db.close());
function add(text = source, grant = true, name = "设备规程") {
  const doc = repo.importDocument({ name, category_id: "default", original_text: text });
  return grant ? repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]) : doc;
}
function active(text = question) {
  const session = createSession(db.orm, "合成会话", { modelName: "synthetic" });
  const request = crypto.randomUUID();
  const prepared = prepareTurn(db.orm, session.id, text, request);
  const turn = getTurnByRequest(db.orm, session.id, request);
  if (!turn || !prepared.generationToken) throw new Error("Missing turn");
  return { session, request, prepared, turn, token: prepared.generationToken };
}
function revoke(id: string) {
  const doc = repo.detail(id);
  repo.replaceGrants(id, doc.revision, []);
}
type CompleteCall = Parameters<ModelGateway["complete"]>[0];
interface ObservationData {
  name: string;
  value: { status: string; items: Array<Record<string, unknown>> };
}
function observations(call: CompleteCall): ObservationData[] {
  return call.messages.flatMap((message) => {
    try {
      if (typeof message.content !== "string") return [];
      const data = JSON.parse(message.content) as { kind?: string; value?: ObservationData };
      return data.kind === "action_observation" && data.value ? [data.value] : [];
    } catch {
      return [];
    }
  });
}
function observation(call: CompleteCall, name: string): ObservationData | undefined {
  return observations(call).find((item) => item.name === name);
}
function bodyRefOf(call: CompleteCall): string {
  const catalog = observation(call, "knowledge.query");
  const bodyRef = (catalog?.value.items[0] as { bodyRef?: string } | undefined)?.bodyRef;
  if (!bodyRef) throw new Error("knowledge.query did not return a bodyRef");
  return bodyRef;
}
function finalDecision() {
  return JSON.stringify({
    kind: "final",
    outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
  });
}
function invokeQuery() {
  return JSON.stringify({
    kind: "invoke",
    calls: [{ name: "knowledge.query", arguments: { query: "启动" } }],
  });
}
/** 决策请求走脚本；其它叶子调用保持 beforeEach 桩的行为。 */
function installDecisions(script: (call: CompleteCall, index: number) => string): CompleteCall[] {
  const base = gateway.complete.bind(gateway);
  const seen: CompleteCall[] = [];
  gateway.complete = async (call) => {
    const decisionContent = call.messages[0]?.content;
    if (
      !(
        typeof decisionContent === "string" &&
        decisionContent.includes("Return exactly one JSON decision")
      )
    )
      return base(call);
    seen.push(call);
    return script(call, seen.length);
  };
  return seen;
}

describe("authorized knowledge context", () => {
  it("finds Chinese short questions and exact numeric terms", () => {
    expect(knowledgeTerms("启动条件 42.5")).toContain("启动");
    expect(knowledgeTerms("启动条件 42.5")).toContain("42.5");
  });
  it("builds chat context without prefetching knowledge even when a probe coincides with revocation", async () => {
    const doc = add();
    const a = active();
    let probes = 0;
    gateway.loadedContextCapacity = async () => {
      if (++probes === 2) revoke(doc.id);
      return 32768;
    };
    const builder = new ContextBuilder({ orm: db.orm, db: db.db, gateway });
    const usages: ContextUsage[] = [];
    const messages = await builder.build({
      sessionId: a.session.id,
      currentTurnId: a.turn.id,
      runtime: a.prepared.runtime,
      generationToken: a.token,
      onUsage: (usage) => usages.push(usage),
    });
    // 撤权发生在第二次容量探测时：装配本身不碰知识，所以既不该触发选择器，也不该连坐。
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(completeCalls).toHaveLength(0);
    expect(streamCalls).toHaveLength(0);
    const text = JSON.stringify(messages);
    expect(text).toContain("允许启动");
    expect(text).not.toContain("42.5");
    expect(text).not.toContain("禁止启动");
    expect(text).not.toContain("设备规程");
    expect(usages.at(-1)?.components.knowledge).toBe(0);
    const saved = db.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turn_knowledge_snapshots")
      .get();
    expect(saved?.count ?? 0).toBe(0);
    // 知识撤权只影响知识来源，装配检查点（轮次/纠正）仍然有效。
    expect(() => builder.assertCurrent(a.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
  });
  it("HTTP chat reads knowledge through tools and cannot resurrect a revoked grant", async () => {
    const doc = add();
    const session = createSession(db.orm, "HTTP合成", { modelName: "synthetic" });
    const app = createApp({
      business: db,
      gateway,
      browserStateSecret: "synthetic-knowledge-context",
    });
    const send = (key: string) =>
      app.request("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id, message: question, client_request_id: key }),
      });
    const keyA = crypto.randomUUID();

    // 1) 工具式读取：query → read，正文在下一步决策可见；消费后撤权，最终写入前的复查必须硬失败。
    const decisionsA = installDecisions((call, index) => {
      if (index === 1) return invokeQuery();
      if (index === 2)
        return JSON.stringify({
          kind: "invoke",
          calls: [{ name: "knowledge.read", arguments: { bodyRef: bodyRefOf(call) } }],
        });
      revoke(doc.id);
      return finalDecision();
    });
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "不应生成";
    };
    const first = await (await send(keyA)).text();
    expect(first).toContain("CONTEXT_SOURCE_INVALID");
    // 失败点必须是「来源已撤权」的复查，而不是别的预算/协议问题。
    expect(first).toContain("授权已撤销");
    expect(streamCalls).toHaveLength(0);
    expect(decisionsA).toHaveLength(3);
    expect(JSON.stringify(decisionsA[1])).toContain("设备规程");
    expect(JSON.stringify(decisionsA[2])).toContain("42.5");

    // 2) 同 id 重试：turn 里冻结的读取配置仍生效（现行配置已关闭），但已撤权的资料不会复活。
    const readConfig = new KnowledgeReadRepository(db.db);
    const enabled = readConfig.settings(DEFAULT_AGENT_ID);
    readConfig.update(DEFAULT_AGENT_ID, {
      expected_revision: enabled.revision,
      config: { ...enabled.config, enabled: false },
    });
    const decisionsB = installDecisions((_call, index) =>
      index === 1 ? invokeQuery() : finalDecision(),
    );
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "重试回答";
    };
    const retry = await (await send(keyA)).text();
    expect(retry).toContain("done");
    expect(decisionsB).toHaveLength(2);
    // 冻结快照仍广告知识工具：重试没有改用「现行已关闭」的配置（按真实 advertised action 断言）。
    expect(decisionsB[0]?.messages[0]?.content).toContain('"name":"knowledge.query"');
    const retryDecision = decisionsB[1];
    if (!retryDecision) throw new Error("missing retry decision request");
    expect(observation(retryDecision, "knowledge.query")?.value).toMatchObject({
      status: "ok",
      items: [],
    });
    expect(JSON.stringify(decisionsB)).not.toContain("42.5");
    expect(JSON.stringify(streamCalls.at(-1))).not.toContain("42.5");
    expect(streamCalls).toHaveLength(1);

    // 3) 新请求读现行配置：关闭读取后不再广告知识工具，也不读取任何资料。
    const decisionsC1 = installDecisions(() => finalDecision());
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "关闭回答";
    };
    expect(await (await send(crypto.randomUUID())).text()).toContain("done");
    expect(decisionsC1).toHaveLength(1);
    // 关闭读取后 knowledge.* 不得出现在真实 advertised action 列表里；system 引导文本
    // （system-evidence-reading）可以仍提到动作名——那只是 skill metadata，不是授予。
    expect(decisionsC1[0]?.messages[0]?.content).not.toContain('"name":"knowledge.query"');
    expect(decisionsC1[0]?.messages[0]?.content).not.toContain('"name":"knowledge.read"');
    expect(JSON.stringify(streamCalls.at(-1))).not.toContain("42.5");

    // 4) 新请求按新授权：重新授权后资料重新可读，并随观测进入生成输入。
    const current = repo.detail(doc.id);
    repo.replaceGrants(doc.id, current.revision, [DEFAULT_AGENT_ID]);
    const disabled = readConfig.settings(DEFAULT_AGENT_ID);
    readConfig.update(DEFAULT_AGENT_ID, {
      expected_revision: disabled.revision,
      config: { ...disabled.config, enabled: true },
    });
    const decisionsC2 = installDecisions((call, index) => {
      if (index === 1) return invokeQuery();
      if (index === 2)
        return JSON.stringify({
          kind: "invoke",
          calls: [{ name: "knowledge.read", arguments: { bodyRef: bodyRefOf(call) } }],
        });
      return finalDecision();
    });
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "完整回答";
    };
    expect(await (await send(crypto.randomUUID())).text()).toContain("done");
    expect(decisionsC2).toHaveLength(3);
    expect(JSON.stringify(decisionsC2[2])).toContain("42.5");
    expect(JSON.stringify(streamCalls.at(-1))).toContain("42.5");
    expect(streamCalls).toHaveLength(3);
  });
});
