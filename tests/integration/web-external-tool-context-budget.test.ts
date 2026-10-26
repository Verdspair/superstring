import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime, createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { inputUnits } from "../../src/server/agent/context-engine";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const HEAD = "web-tool-full-start";
const TAIL = "web-tool-full-end";
const payload = (length: number) => `${HEAD}${"x".repeat(length)}${TAIL}`;

async function runResults(results: readonly string[]) {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  const session = createSession(h.orm, "synthetic", { modelName: "synthetic" });
  const prepared = prepareTurn(
    h.orm,
    session.id,
    "current question must survive",
    "web-external-fit",
  );
  const turn = getTurnByRequest(h.orm, session.id, "web-external-fit");
  if (!turn || !prepared.generationToken) throw new Error("synthetic turn missing");
  const runtime = {
    ...prepared.runtime,
    p5_config: {
      ...prepared.runtime.p5_config,
      context_window: 65536,
      max_output_tokens: 512,
      safety_margin_ratio: 0,
      retrieval_mode: "off" as const,
      compression_enabled: false,
    },
  };
  const sent: ModelRequest[] = [];
  const executed: string[] = [];
  const actions: BuiltInAction[] = results.map((text, index) => ({
    description: {
      name: `mcp.fixture.read_${index}`,
      capability: "external.read",
      effect: "read",
      description: "synthetic read",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      executed.push(String(index));
      return { value: { text }, sources: [] };
    },
  }));
  const model: ModelPort = {
    defaultModel: "synthetic",
    async complete(request) {
      sent.push(request);
      return sent.length === 1
        ? JSON.stringify({
            kind: "invoke",
            calls: actions.map((action) => ({ name: action.description.name, arguments: {} })),
          })
        : JSON.stringify({ kind: "none" });
    },
    async *streamText() {
      yield "unused";
    },
    async completeMultimodal() {
      return "unused";
    },
  };
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 5 },
    async listModels() {
      return ["synthetic"];
    },
    async probeModelLoaded() {
      return true;
    },
    async loadedContextCapacity() {
      return 65536;
    },
    async complete() {
      throw new Error("no gateway inference in fixture");
    },
    async *streamChat() {
      yield await Promise.reject(new Error("no gateway inference in fixture"));
    },
  };
  const repository = new AgentRunRepository(h.db);
  const source = new WebContextSource({
    ...h,
    gateway,
    agentRuntime: createAgentRuntime({ gateway, repository }),
    builder: new ContextBuilder({ ...h, gateway }),
    runtime,
    sessionId: session.id,
    turnId: turn.id,
    generationToken: prepared.generationToken,
    maxSteps: 4,
    extraActions: actions,
  });
  const result = await new AgentRuntime({ model, repository }).run(source.spec, {
    owner: { kind: "web_turn", id: turn.id, agentId: DEFAULT_AGENT_ID, userId: DEFAULT_USER_ID },
    context: source,
    actions: source.actions,
    authorizedTargets: ["reply"],
    outputMode: "buffered",
  });
  return { result, sent, executed };
}

function observations(
  request: ModelRequest,
): { name: string; value: { text?: string; status?: string; code?: string } }[] {
  return request.messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.kind !== "text") return [];
      try {
        const value = JSON.parse(part.text);
        return value.kind === "action_observation" ? [value.value] : [];
      } catch {
        return [];
      }
    }),
  );
}

describe("Web main external read result fitting", () => {
  it("keeps a complete result unchanged when it fits", async () => {
    const body = payload(35000);
    const f = await runResults([body]);
    expect(f.result.status).toBe("no_output");
    expect(f.executed).toEqual(["0"]);
    expect(f.sent).toHaveLength(2);
    expect(observations(f.sent[1]!)[0]?.value.text).toBe(body);
  });

  it("returns an explicit refusal instead of carrying an irreducible oversized result forward", async () => {
    const f = await runResults([payload(120000)]);
    expect(f.result.status).toBe("no_output");
    expect(f.executed).toEqual(["0"]);
    expect(f.sent).toHaveLength(2);
    expect(observations(f.sent[1]!)[0]?.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
    const text = JSON.stringify(f.sent[1]!.messages);
    expect(text).not.toContain(HEAD);
    expect(text).not.toContain(TAIL);
    expect(text).toContain("current question must survive");
  });

  it("reserves two concurrent read results jointly rather than accepting both in isolation", async () => {
    const f = await runResults([payload(35000), payload(35000)]);
    expect(f.result.status).toBe("no_output");
    expect(f.executed).toEqual(["0", "1"]);
    expect(f.sent).toHaveLength(2);
    const values = observations(f.sent[1]!).map((entry) => entry.value);
    expect(values.filter((value) => value.text?.startsWith(HEAD))).toHaveLength(1);
    expect(values.filter((value) => value.status === "unavailable")).toHaveLength(1);
    expect(inputUnits(f.sent[1]!.messages)).toBeLessThanOrEqual(65024);
  });
});
