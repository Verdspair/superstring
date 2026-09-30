import { afterEach, describe, expect, it } from "bun:test";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  insertQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import type { Orm } from "../../src/server/db/repositories";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/** 合成网关：本文件只读运行上下文，任何模型调用都属意外。 */
const gateway: ModelGateway = {
  config: { baseUrl: "http://unused.invalid", model: "test-model", timeoutSeconds: 1 },
  async listModels() {
    return [];
  },
  async loadedContextCapacity() {
    return null;
  },
  async probeModelLoaded() {
    return false;
  },
  async complete() {
    throw new Error("no model call in this test");
  },
  async *streamChat() {
    yield "";
  },
};

function setup() {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const scheme = createQqScheme(business.orm, { name: "app-guard" });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(business.orm, created.binding);
  const repository = new AgentRunRepository(business.db);
  const snapshot = (sources: SourceRef[], owner: RunOwner) => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const at = new Date().toISOString();
    repository.createRun({ runId, specId: "test", specVersion: "1", owner, at });
    repository.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "test-model",
      phase: "leaf",
      at,
      messages: [{ role: "user", content: [{ kind: "text", text: "private original" }] }],
      sources,
    });
    return { runId, stepId };
  };
  return { business, repository, binding, snapshot };
}

const groupOwner = (bindingId: string): RunOwner => ({
  kind: "qq_binding",
  id: bindingId,
  agentId: DEFAULT_AGENT_ID,
});

/** 真实签发路径：memory 读取动作在能力跟随（纪元 0）时由 guard 发出的引用，不手写状态串。 */
function groupCapabilityRef(orm: Orm, bindingId: string): SourceRef {
  const action: BuiltInAction = {
    description: {
      name: "memory.query",
      capability: "test",
      description: "memory.query",
      parameters: {},
      effect: "read",
    },
    async execute() {
      return { value: { ok: true }, sources: [] };
    },
  };
  const [ref] = new QqGroupCapabilityGuard(orm).actionSources(action, groupOwner(bindingId));
  if (!ref) throw new Error("missing capability ref");
  return ref;
}

const emptyOverrides = {
  triggers: {},
  rhythm: {},
  context: {},
  compression: {},
  output_reserve: {},
  stickers: {},
  prompts: {},
  reply: {},
};

describe("createApp QQ group capability guard", () => {
  it("resolves an enabled group capability from the guard, and a permissive resolver cannot override its revocation", async () => {
    const { business, repository, binding, snapshot } = setup();
    const resolved: string[] = [];
    // 默认装配：不注入 runtime、不给全局权限（local off），默认执行器与叶子边界都拿同一个 guard。
    const app = createApp({
      business,
      gateway,
      resolveSource(source) {
        resolved.push(source.kind);
        return "available";
      },
    });
    const handle = snapshot([groupCapabilityRef(business.orm, binding.id)], groupOwner(binding.id));
    const url = `/v2/runs/${handle.runId}/context/${handle.stepId}`;

    const enabled = await (await app.request(url)).json();
    expect(enabled.status).toBe("exact");
    expect(repository.getContext(handle)?.messages?.[0].content).toContainEqual({
      kind: "text",
      text: "private original",
    });
    // 群能力引用由内置 guard 判定，外部解析器看不到这条引用。
    expect(resolved).not.toContain("qq_group_capability");

    writeQqGroupAgentConfigRow(business.orm, {
      bindingId: binding.id,
      agentId: DEFAULT_AGENT_ID,
      overrides: emptyOverrides,
      disabledCapabilities: ["memory_read"],
      expectedRevision: 0,
    });
    const revoked = await (await app.request(url)).json();
    expect(revoked.status).toBe("revoked");
    expect(repository.getContext(handle)?.messages).toBeNull();
    expect(resolved).not.toContain("qq_group_capability");
  });

  it("keeps the injected resolver for non-QQ sources", async () => {
    const { business, binding, snapshot } = setup();
    const resolved: string[] = [];
    const app = createApp({
      business,
      gateway,
      resolveSource(source) {
        resolved.push(source.kind);
        return "available";
      },
    });
    const handle = snapshot(
      [{ kind: "external_document", id: "remote", revision: "1" }],
      groupOwner(binding.id),
    );
    const body = await (
      await app.request(`/v2/runs/${handle.runId}/context/${handle.stepId}`)
    ).json();
    expect(body.status).toBe("exact");
    expect(resolved).toContain("external_document");
  });
});
