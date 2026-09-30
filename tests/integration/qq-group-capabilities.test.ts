import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import type { ModelPort } from "../../src/server/agent/model-port";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  insertQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { mcpActionName } from "../../src/server/mcp/actions";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { PermissionService } from "../../src/server/permissions/service";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";
import type {
  QqGroupCapability,
  QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";

type BusinessHandle = ReturnType<typeof openBusinessDb>;

const handles: BusinessHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const ALL_CAPABILITIES: readonly QqGroupCapability[] = [
  "memory_read",
  "memory_organize",
  "knowledge_read",
  "web",
  "media",
  "stickers",
  "tasks",
  "research",
  "code",
  "mcp",
  "skills",
  "history_summary",
];

function makeBinding(h: BusinessHandle, name: string, kind: "group" | "private", peerId: string) {
  const scheme = createQqScheme(h.orm, { name });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind,
    peerId,
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  return insertQqBinding(h.orm, created.binding);
}

function groupSetup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const binding = makeBinding(h, "capabilities", "group", "30003");
  const owner: RunOwner = { kind: "qq_binding", id: binding.id, agentId: DEFAULT_AGENT_ID };
  const guard = new QqGroupCapabilityGuard(h.orm);
  return { h, binding, owner, guard };
}

function writeCaps(
  h: BusinessHandle,
  bindingId: string,
  disabled: readonly QqGroupCapability[],
  expectedRevision: number,
  overrides: QqGroupSchemeOverrides = {},
) {
  writeQqGroupAgentConfigRow(h.orm, {
    bindingId,
    agentId: DEFAULT_AGENT_ID,
    overrides,
    disabledCapabilities: disabled,
    expectedRevision,
  });
}

function fixtureAction(
  name: string,
  effect: "read" | "write" = "read",
  ran?: string[],
): BuiltInAction {
  return {
    permission: { resource: name, revision: "v1", approvalRequired: false },
    description: { name, capability: "test", description: name, parameters: {}, effect },
    async execute() {
      ran?.push(name);
      return { value: { ok: true }, sources: [] };
    },
  };
}

/** 可悬挂的动作：调用方控制它何时返回（用于在飞行窗口内翻转能力）。 */
function heldAction(name: string, gate: Promise<void>, ran?: string[]): BuiltInAction {
  return {
    permission: { resource: name, revision: "v1", approvalRequired: false },
    description: { name, capability: "test", description: name, parameters: {}, effect: "read" },
    async execute() {
      ran?.push(name);
      await gate;
      return { value: { ok: true }, sources: [] };
    },
  };
}

function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

function permissionsFor(actions: readonly BuiltInAction[]): PermissionService {
  let policy: PermissionPolicy = {
    version: 1,
    grants: actions.map((action) => ({
      resource: action.description.name,
      revision: "v1",
      approved: false,
      directories: [],
    })),
  };
  return new PermissionService({
    read: () => ({ revision: "test", policy }),
    replace: (_expected, next) => {
      policy = next;
      return { revision: "test", policy };
    },
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function leafRuntime(
  h: BusinessHandle,
  guard: QqGroupCapabilityGuard,
  onCall: () => void = () => {},
) {
  const repository = new AgentRunRepository(h.db);
  const model: ModelPort = {
    async complete() {
      onCall();
      return "leaf-output";
    },
    async *streamText() {
      yield "leaf-output";
    },
    async completeMultimodal() {
      return "leaf-output";
    },
  };
  const runtime = new AgentRuntime({
    model,
    repository,
    assertLeaf: (owner, specId) => guard.assertLeaf(owner, specId),
  });
  return { runtime, repository };
}

const leafInput = (owner: RunOwner) => ({
  messages: [{ role: "user", content: "hello" }],
  owner,
});

describe("QQ group capability guard", () => {
  it("maps the runtime-registered action names, including MCP, research and code", () => {
    const { h, binding, owner, guard } = groupSetup();
    const mapped: ReadonlyArray<[string, QqGroupCapability]> = [
      ["research.run", "research"],
      ["code.run", "code"],
      ["sticker.search", "stickers"],
      ["media.list", "media"],
      ["memory.query", "memory_read"],
      ["knowledge.query", "knowledge_read"],
      ["web.search", "web"],
      ["task.start", "tasks"],
      ["skill.catalog", "skills"],
      [mcpActionName("server-1", "tool/one"), "mcp"],
    ];
    for (const [name] of mapped) expect(guard.actionAllowed(fixtureAction(name), owner)).toBe(true);
    writeCaps(h, binding.id, ALL_CAPABILITIES, 0);
    for (const [name] of mapped)
      expect([name, guard.actionAllowed(fixtureAction(name), owner)]).toEqual([name, false]);
    expect(codeOf(() => guard.assertAction(fixtureAction("research.run"), owner))).toBe(
      "QQ_GROUP_CAPABILITY_DISABLED",
    );
  });

  it("constrains only the bound group conversation; private, web and unknown channels stay untouched", () => {
    const { h, binding, owner, guard } = groupSetup();
    writeCaps(h, binding.id, ["research"], 0);

    const events = new ConversationEventRepository(h.db);
    const conversation = events.ensureOneBot(binding.id);
    if (!conversation) throw new Error("conversation");
    const conversationOwner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      agentId: DEFAULT_AGENT_ID,
    };
    expect(guard.allowed(conversationOwner, "research")).toBe(false);
    expect(guard.allowed(conversationOwner, "media")).toBe(true);

    // 绑定存在但助手对不上：按停用处理，不借同群配置放行。
    const wrongAgent: RunOwner = { ...conversationOwner, agentId: crypto.randomUUID() };
    expect(guard.allowed(wrongAgent, "media")).toBe(false);
    expect(guard.allowed({ ...owner, agentId: crypto.randomUUID() }, "media")).toBe(false);

    const privateBinding = makeBinding(h, "capabilities-private", "private", "20002");
    writeCaps(h, privateBinding.id, ["research"], 0);
    expect(guard.allowed({ kind: "qq_binding", id: privateBinding.id }, "research")).toBe(true);

    const session = createSession(h.orm, "web", { modelName: "model" });
    const web = events.ensureWeb(session.id, DEFAULT_USER_ID);
    if (!web) throw new Error("web conversation");
    expect(
      guard.allowed({ kind: "conversation", id: web.id, agentId: web.agentId }, "research"),
    ).toBe(true);
    expect(guard.allowed({ kind: "web_turn", id: "turn-1" }, "research")).toBe(true);
  });

  it("rejects misused and unknown refs; unrelated edits and other capabilities do not revoke evidence", () => {
    const { h, binding, owner, guard } = groupSetup();
    const research = fixtureAction("research.run");
    // 无记录＝纪元 0、能力跟随：正常启用。
    const [ref] = guard.actionSources(research, owner);
    expect(ref.revision).toBe("0");
    expect(guard.sourceAccess(ref, owner)).toBe("available");

    // 改无关字段（节奏类覆盖）不失效已读来源。
    writeCaps(h, binding.id, [], 0, { rhythm: { reply_cooldown_seconds: 5 } });
    expect(guard.sourceAccess(ref, owner)).toBe("available");
    writeCaps(h, binding.id, [], 1, { rhythm: { reply_cooldown_seconds: 9 } });
    expect(guard.sourceAccess(ref, owner)).toBe("available");

    // 翻别的能力（media 停用又恢复）不动 research 的纪元。
    writeCaps(h, binding.id, ["media"], 2);
    expect(guard.sourceAccess(ref, owner)).toBe("available");
    writeCaps(h, binding.id, [], 3);
    expect(guard.sourceAccess(ref, owner)).toBe("available");

    // 跨群/跨助手复用同一条引用＝失效。
    const otherBinding = makeBinding(h, "capabilities-other", "group", "30004");
    expect(guard.sourceAccess(ref, { kind: "qq_binding", id: otherBinding.id })).toBe("revoked");
    expect(guard.sourceAccess(ref, { ...owner, agentId: crypto.randomUUID() })).toBe("revoked");

    // 畸形 id、未登记能力、旧状态串与错纪元一律 fail closed：不做向后兼容。
    expect(
      guard.sourceAccess({ kind: "qq_group_capability", id: "not-json", revision: "0" }, owner),
    ).toBe("revoked");
    expect(
      guard.sourceAccess(
        {
          kind: "qq_group_capability",
          id: JSON.stringify([binding.id, DEFAULT_AGENT_ID, "nope"]),
          revision: "0",
        },
        owner,
      ),
    ).toBe("revoked");
    expect(guard.sourceAccess({ ...ref, revision: "enabled" }, owner)).toBe("revoked");
    expect(guard.sourceAccess({ ...ref, revision: "1" }, owner)).toBe("revoked");
    expect(
      guard.sourceAccess({ kind: "external_document", id: "remote", revision: "1" }, owner),
    ).toBeUndefined();

    // 停用该能力：旧引用立即失效，停用期间不再签发新证据。
    writeCaps(h, binding.id, ["research"], 4);
    expect(guard.sourceAccess(ref, owner)).toBe("revoked");
    expect(guard.actionSources(research, owner)).toEqual([]);
    expect(codeOf(() => guard.assertSources(owner, [ref]))).toBe("QQ_GROUP_CAPABILITY_DISABLED");
  });

  it("keeps the epoch monotonic across off and on: the pre-off ref never revives", () => {
    const { h, binding, owner, guard } = groupSetup();
    const research = fixtureAction("research.run");
    const [before] = guard.actionSources(research, owner);
    expect(before.revision).toBe("0");
    expect(guard.sourceAccess(before, owner)).toBe("available");

    // 跟随 → 停用 → 恢复：每次翻转 +1，旧纪元引用不复活。
    writeCaps(h, binding.id, ["research"], 0);
    expect(guard.sourceAccess(before, owner)).toBe("revoked");
    writeCaps(h, binding.id, [], 1);
    expect(guard.sourceAccess(before, owner)).toBe("revoked");
    const [after] = guard.actionSources(research, owner);
    expect(after.revision).toBe("2");
    expect(guard.sourceAccess(after, owner)).toBe("available");
  });

  it("refuses a disabled action at the executor boundary and revokes its un-submitted evidence", async () => {
    const { h, binding, owner, guard } = groupSetup();
    const ran: string[] = [];
    const research = fixtureAction("research.run", "read", ran);
    const executor = new ActionExecutor(permissionsFor([research]), undefined, guard);
    const context = { owner, signal: new AbortController().signal };

    const result = await executor.execute(research, {}, context);
    expect(ran).toEqual(["research.run"]);
    const ref = result.sources.find((source) => source.kind === "qq_group_capability");
    expect(ref?.revision).toBe("0");
    guard.assertSources(owner, result.sources);

    writeCaps(h, binding.id, ["research"], 0);
    expect(executor.allowed(research, context)).toBe(false);
    expect(codeOf(() => executor.assert(research, context))).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    await expect(executor.execute(research, {}, context)).rejects.toMatchObject({
      code: "QQ_GROUP_CAPABILITY_DISABLED",
    });
    expect(ran).toEqual(["research.run"]);
    expect(codeOf(() => guard.assertSources(owner, result.sources))).toBe(
      "QQ_GROUP_CAPABILITY_DISABLED",
    );
    if (!ref) throw new Error("missing capability ref");
    expect(guard.sourceAccess(ref, owner)).toBe("revoked");
  });

  it("captures the epoch at begin: an off-and-on flip during a call fails hard, not by minting a new epoch", async () => {
    const { h, binding, owner, guard } = groupSetup();
    const { gate, release } = deferred();
    const ran: string[] = [];
    const research = heldAction("research.run", gate, ran);
    const executor = new ActionExecutor(permissionsFor([research]), undefined, guard);
    const context = { owner, signal: new AbortController().signal };

    const pending = executor.execute(research, {}, context, {
      // 飞行中停用再恢复：当前状态又是启用，但捕获纪元的引用已过期，且不得被映射成工具错误。
      mapToolError: () => ({ value: { recovered: true }, sources: [] }),
    });
    writeCaps(h, binding.id, ["research"], 0);
    writeCaps(h, binding.id, [], 1);
    release();
    await expect(pending).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(ran).toEqual(["research.run"]);

    // 恢复后的新结果按当前纪元（0 → 停用 → 恢复 ＝ 2）签发。
    const next = await executor.execute(research, {}, context);
    const ref = next.sources.find((source) => source.kind === "qq_group_capability");
    expect(ref?.revision).toBe("2");
    guard.assertSources(owner, next.sources);
  });

  it("keeps each batch action's own begin refs: the expired capture blocks the batch", async () => {
    const { h, binding, owner, guard } = groupSetup();
    const { gate, release } = deferred();
    const research = heldAction("research.run", gate);
    const executor = new ActionExecutor(permissionsFor([research]), undefined, guard);
    const context = { owner, signal: new AbortController().signal };

    const pending = executor.executeBatch([{ action: research, arguments: {} }], context);
    writeCaps(h, binding.id, ["research"], 0);
    writeCaps(h, binding.id, [], 1);
    release();
    await expect(pending).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
  });

  it("does not fail a captured result for unrelated scheme edits or other capability flips", async () => {
    const { h, binding, owner, guard } = groupSetup();
    const { gate, release } = deferred();
    const research = heldAction("research.run", gate);
    const executor = new ActionExecutor(permissionsFor([research]), undefined, guard);
    const context = { owner, signal: new AbortController().signal };

    const pending = executor.execute(research, {}, context);
    writeCaps(h, binding.id, [], 0, { rhythm: { reply_cooldown_seconds: 5 } });
    writeCaps(h, binding.id, ["media"], 1);
    writeCaps(h, binding.id, [], 2);
    release();
    const result = await pending;
    const ref = result.sources.find((source) => source.kind === "qq_group_capability");
    expect(ref?.revision).toBe("0");
    guard.assertSources(owner, result.sources);
  });
});

describe("QQ group capability guard in leaf runs", () => {
  it("never calls the model and records no step when the capability is already off", async () => {
    const { h, binding, owner, guard } = groupSetup();
    writeCaps(h, binding.id, ["media"], 0);
    let calls = 0;
    const { runtime } = leafRuntime(h, guard, () => calls++);
    await expect(
      runtime.completeLeaf({ id: "media.describe", model: "model" }, leafInput(owner)),
    ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(calls).toBe(0);
    expect(h.db.query("SELECT status,error_code FROM agent_runs").get()).toEqual({
      status: "failed",
      error_code: "QQ_GROUP_CAPABILITY_DISABLED",
    });
    expect(h.db.query("SELECT COUNT(*) AS n FROM agent_steps").get()).toEqual({ n: 0 });
  });

  it("records the step as failed when the capability is revoked while the model call is in flight", async () => {
    const { h, binding, owner, guard } = groupSetup();
    let calls = 0;
    const { runtime } = leafRuntime(h, guard, () => {
      calls++;
      writeCaps(h, binding.id, ["media"], 0);
    });
    await expect(
      runtime.completeLeaf({ id: "media.describe", model: "model" }, leafInput(owner)),
    ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(calls).toBe(1);
    expect(
      h.db.query("SELECT status,error_code FROM agent_steps ORDER BY step_no DESC LIMIT 1").get(),
    ).toEqual({ status: "failed", error_code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(h.db.query("SELECT status,error_code FROM agent_runs").get()).toEqual({
      status: "failed",
      error_code: "QQ_GROUP_CAPABILITY_DISABLED",
    });
  });

  it("keeps a leaf result out of the run when the capability bounces off and on while in flight", async () => {
    const { h, binding, owner, guard } = groupSetup();
    let calls = 0;
    const { runtime } = leafRuntime(h, guard, () => {
      calls++;
      // 只在第一次调用飞行中停用再恢复：当前状态又是启用，但捕获纪元已过期。
      if (calls === 1) {
        writeCaps(h, binding.id, ["media"], 0);
        writeCaps(h, binding.id, [], 1);
      }
    });
    await expect(
      runtime.completeLeaf({ id: "media.describe", model: "model" }, leafInput(owner)),
    ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(calls).toBe(1);
    expect(
      h.db.query("SELECT status,error_code FROM agent_steps ORDER BY step_no DESC LIMIT 1").get(),
    ).toEqual({ status: "failed", error_code: "QQ_GROUP_CAPABILITY_DISABLED" });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_steps WHERE status = 'completed'").get(),
    ).toEqual({ n: 0 });
    expect(h.db.query("SELECT status,error_code FROM agent_runs").get()).toEqual({
      status: "failed",
      error_code: "QQ_GROUP_CAPABILITY_DISABLED",
    });

    // 恢复后的新叶子正常完成。
    await runtime.completeLeaf({ id: "media.describe", model: "model" }, leafInput(owner));
    expect(calls).toBe(2);
    expect(
      h.db.query("SELECT status,error_code FROM agent_runs ORDER BY rowid DESC LIMIT 1").get(),
    ).toEqual({ status: "completed", error_code: null });
  });

  it("keeps unmapped leaves running with every capability off, including the QQ main gate", async () => {
    const { h, binding, owner, guard } = groupSetup();
    writeCaps(h, binding.id, ALL_CAPABILITIES, 0);
    const seen: string[] = [];
    const { runtime } = leafRuntime(h, guard, () => seen.push("call"));
    for (const id of ["onebot.initiative.evaluate", "knowledge.organize"])
      await runtime.completeLeaf({ id, model: "model" }, leafInput(owner));
    // 素材标注的 owner 是 qq_sticker（不是群的绑定），不属停用面。
    await runtime.completeLeaf(
      { id: "sticker.annotate", model: "model" },
      leafInput({ kind: "qq_sticker", id: "asset-1" }),
    );
    expect(seen.length).toBe(3);
  });
});

describe("QQ group capability guard in durable tasks", () => {
  it("follows the group switch for task evidence and the enqueue boundary", async () => {
    const { h, binding, guard } = groupSetup();
    updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const conversation = new ConversationEventRepository(h.db).ensureOneBot(binding.id);
    if (!conversation) throw new Error("conversation");
    const conversationOwner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    };
    const ran: string[] = [];
    const readCall = fixtureAction("fixture.read", "read", ran);
    const permissions = permissionsFor([readCall]);
    const executor = new ActionExecutor(permissions, undefined, guard);
    const repository = new AgentTaskRepository(h.db);
    let now = "2026-09-30T00:00:00.000Z";
    const service = new AgentTaskService({
      repository,
      orm: h.orm,
      executor,
      actions: () => [readCall],
      now: () => now,
      resolveSource: (source, actor) => permissions.sourceAccess(source, actor),
    });
    const plan = { calls: [{ name: "fixture.read", arguments: {} }] };
    const task = service.enqueue(conversation.id, plan, {
      owner: conversationOwner,
      requestId: "q1",
    });
    expect(await service.runOnce()).toBe(true);
    expect(repository.get(task.id)?.status).toBe("completed");
    expect(ran).toEqual(["fixture.read"]);

    const reader = service
      .actions(conversation.id)
      .find((action) => action.description.name === "task.read");
    if (!reader) throw new Error("missing task reader");
    const result = await reader.execute(
      { taskId: task.id },
      { owner: conversationOwner, signal: new AbortController().signal },
    );
    const ref = result.sources.find((source) => source.kind === "agent_task");
    if (!ref) throw new Error("missing task source ref");
    expect(service.sourceAccess(ref, conversationOwner)).toBe("available");

    // 改无关能力不失效任务来源。
    writeCaps(h, binding.id, ["media"], 0);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("available");

    // 停用「任务」：既有任务来源立即失效，新任务也进不来。
    writeCaps(h, binding.id, ["media", "tasks"], 1);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("revoked");
    expect(
      codeOf(() =>
        service.enqueue(conversation.id, plan, { owner: conversationOwner, requestId: "q2" }),
      ),
    ).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    // 元数据读取不属执行面：巡检仍能看到这条任务。
    now = "2026-09-30T00:01:00.000Z";
    expect(service.inspect(task.id)?.status).toBe("completed");
  });

  it("freezes the tasks epoch at enqueue: an off-and-on flip during a call fails the task", async () => {
    const { h, binding, guard } = groupSetup();
    const now = "2026-09-30T00:00:00.000Z";
    const { gate, release } = deferred();
    const ran: string[] = [];
    const readCall = heldAction("fixture.read", gate, ran);
    updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const conversation = new ConversationEventRepository(h.db).ensureOneBot(binding.id);
    if (!conversation) throw new Error("conversation");
    const conversationOwner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    };
    const permissions = permissionsFor([readCall]);
    const executor = new ActionExecutor(permissions, undefined, guard);
    const repository = new AgentTaskRepository(h.db);
    const service = new AgentTaskService({
      repository,
      orm: h.orm,
      executor,
      actions: () => [readCall],
      now: () => now,
      resolveSource: (source, actor) => permissions.sourceAccess(source, actor),
    });
    const plan = { calls: [{ name: "fixture.read", arguments: {} }] };
    const task = service.enqueue(conversation.id, plan, {
      owner: conversationOwner,
      requestId: "q1",
    });
    // 入队时刻冻结「任务」能力纪元：queued+inflight 期间的关闭恢复不得重用。
    expect(task.sources).toContainEqual({
      kind: "qq_group_capability",
      id: JSON.stringify([binding.id, DEFAULT_AGENT_ID, "tasks"]),
      revision: "0",
    });
    const running = service.runOnce();
    // 飞行中关闭再恢复：当前又是启用，但入队纪元已过期，未提交结果不得完成。
    writeCaps(h, binding.id, ["tasks"], 0);
    writeCaps(h, binding.id, [], 1);
    release();
    expect(await running).toBe(true);
    const done = repository.get(task.id);
    expect(done?.status).toBe("failed");
    expect(done?.calls[0]?.status).toBe("failed");
    expect(done?.calls[0]?.result).toBeNull();
    expect(ran).toEqual(["fixture.read"]);
  });

  it("does not revive an old task source after tasks is disabled and re-enabled; unrelated flips keep it", async () => {
    const { h, binding, guard } = groupSetup();
    const now = "2026-09-30T00:00:00.000Z";
    const readCall = fixtureAction("fixture.read");
    updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const conversation = new ConversationEventRepository(h.db).ensureOneBot(binding.id);
    if (!conversation) throw new Error("conversation");
    const conversationOwner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
    };
    const permissions = permissionsFor([readCall]);
    const executor = new ActionExecutor(permissions, undefined, guard);
    const repository = new AgentTaskRepository(h.db);
    const service = new AgentTaskService({
      repository,
      orm: h.orm,
      executor,
      actions: () => [readCall],
      now: () => now,
      resolveSource: (source, actor) => permissions.sourceAccess(source, actor),
    });
    const plan = { calls: [{ name: "fixture.read", arguments: {} }] };
    const task = service.enqueue(conversation.id, plan, {
      owner: conversationOwner,
      requestId: "q1",
    });
    expect(await service.runOnce()).toBe(true);
    expect(repository.get(task.id)?.status).toBe("completed");
    const reader = service
      .actions(conversation.id)
      .find((action) => action.description.name === "task.read");
    if (!reader) throw new Error("missing task reader");
    const result = await reader.execute(
      { taskId: task.id },
      { owner: conversationOwner, signal: new AbortController().signal },
    );
    const ref = result.sources.find((source) => source.kind === "agent_task");
    if (!ref) throw new Error("missing task source ref");
    expect(service.sourceAccess(ref, conversationOwner)).toBe("available");

    // 无关能力翻转不失效任务来源。
    writeCaps(h, binding.id, ["media"], 0);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("available");
    writeCaps(h, binding.id, [], 1);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("available");

    // 停用「任务」→ 恢复：入队纪元已过期，旧任务来源不得复活。
    writeCaps(h, binding.id, ["tasks"], 2);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("revoked");
    writeCaps(h, binding.id, [], 3);
    expect(service.sourceAccess(ref, conversationOwner)).toBe("revoked");
  });
});
