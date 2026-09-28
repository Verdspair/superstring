import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createCodeMode } from "../../src/server/agent/code-mode";
import { inspectContext } from "../../src/server/agent/context-access";
import { handleError } from "../../src/server/api/error-handler";
import { permissionRoutes } from "../../src/server/api/permissions";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  evaluatePermission,
  FilePermissionStore,
  PermissionService,
} from "../../src/server/permissions/service";
import type {
  PermissionPolicy,
  PermissionRequirement,
} from "../../src/shared/contracts/permissions";

const dirs: string[] = [];
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = { kind: "test", id: "run", agentId: "a" };
const context = { owner, signal: new AbortController().signal };
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "permissions-"));
  dirs.push(dir);
  const file = path.join(dir, "permissions.json");
  const service = new PermissionService(new FilePermissionStore(file));
  const executor = new ActionExecutor(service);
  const replace = (policy: PermissionPolicy) =>
    service.replace(service.snapshot().revision, policy);
  return { dir, file, service, executor, replace };
}
const requirement: PermissionRequirement = {
  resource: "mcp.notes.read",
  revision: "one",
  approvalRequired: false,
};
function action(permission = requirement): BuiltInAction {
  return {
    permission,
    description: {
      name: permission.resource,
      description: "read notes",
      capability: "mcp.notes",
      parameters: {},
      effect: "read",
    },
    async execute() {
      return { value: "data", sources: [] };
    },
  };
}
const allow = (resource = requirement.resource) => ({
  version: 1 as const,
  grants: [{ resource, approved: false, directories: [] }],
});

describe("shared permission policy", () => {
  it("checks actor scope, effect, approval version and directory grants without broad fallbacks", () => {
    const policy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "skill.demo.export",
          revision: "v1",
          approved: true,
          agentIds: ["a"],
          directories: [path.resolve("export")],
        },
      ],
    };
    const request: PermissionRequirement = {
      resource: "skill.demo.export",
      revision: "v1",
      approvalRequired: true,
      directories: [path.resolve("export/data")],
    };
    expect(evaluatePermission(policy, request, owner, "direct", "write", false)).toEqual({
      allowed: true,
    });
    expect(
      evaluatePermission(policy, request, { ...owner, agentId: "b" }, "direct", "write", false),
    ).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(
      evaluatePermission(policy, { ...request, revision: "v2" }, owner, "direct", "write", false),
    ).toMatchObject({ code: "PERMISSION_REVISION_CHANGED" });
    expect(
      evaluatePermission(
        policy,
        { ...request, directories: [path.resolve("export-other")] },
        owner,
        "direct",
        "write",
        false,
      ),
    ).toMatchObject({ code: "PERMISSION_DIRECTORY_DENIED" });
    expect(evaluatePermission(policy, request, owner, "sandbox", "write", true)).toMatchObject({
      code: "PERMISSION_MODE_DENIED",
    });
    expect(evaluatePermission(policy, request, owner, "subtask", "write", true)).toMatchObject({
      code: "PERMISSION_MODE_DENIED",
    });
  });

  it("replaces policies by revision and rejects corrupt or duplicate policy rather than reviving a cache", () => {
    const h = setup();
    expect(h.service.snapshot()).toEqual({ revision: "", policy: { version: 1, grants: [] } });
    const saved = h.replace(allow());
    expect(saved.revision).not.toBe("");
    expect(() => h.service.replace("", { version: 1, grants: [] })).toThrow(
      "PERMISSION_POLICY_CONFLICT",
    );
    expect(() =>
      h.replace({ version: 1, grants: [...allow().grants, ...allow().grants] }),
    ).toThrow();
    writeFileSync(h.file, "invalid");
    expect(() => h.executor.allowed(action(), context)).toThrow("PERMISSION_POLICY_INVALID");
  });

  it("revokes already captured actions and rejects results when approval changes in flight", async () => {
    const h = setup();
    h.replace(allow());
    const captured = action();
    expect((await h.executor.execute(captured, {}, context)).value).toBe("data");
    h.replace({ version: 1, grants: [] });
    await expect(h.executor.execute(captured, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    h.replace(allow());
    const midflight: BuiltInAction = {
      ...captured,
      async execute() {
        h.replace({ version: 1, grants: [] });
        return { value: "should not escape", sources: [] };
      },
    };
    await expect(h.executor.execute(midflight, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("never maps a caught authority failure into a recoverable tool error", async () => {
    const h = setup();
    h.replace(allow());
    let valid = true;
    let mapped = 0;
    const target: BuiltInAction = {
      ...action(),
      async execute(_args, context) {
        valid = false;
        try {
          context.assertAuthority?.();
        } catch {}
        valid = true;
        throw new Error("ordinary-looking failure");
      },
    };
    await expect(
      h.executor.execute(target, {}, context, {
        assertCurrent() {
          if (!valid) throw new Error("authority lost");
        },
        mapToolError(error) {
          mapped++;
          return error;
        },
      }),
    ).rejects.toThrow("authority lost");
    expect(mapped).toBe(0);
  });

  it("filters runtime tool advertisements and cannot let model output widen its grant", async () => {
    const h = setup();
    const db = openBusinessDb();
    handles.push(db);
    const protectedAction = action();
    let executed = 0;
    protectedAction.execute = async () => {
      executed++;
      return { value: "ok", sources: [] };
    };
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(db.db),
      actionExecutor: h.executor,
      model: {
        complete: async (request) => {
          expect(request.tools).toEqual([]);
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: requirement.resource, arguments: {} }],
          });
        },
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    await expect(
      runtime.run(
        {
          id: "permission-test",
          context: "conversation",
          availableActions: [protectedAction.description],
          limits: { steps: 2 },
        },
        {
          owner,
          actions: [protectedAction],
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_ACTION_UNAVAILABLE" });
    expect(executed).toBe(0);
  });

  it("rechecks permission after a model sees a granted tool but before its side effect", async () => {
    const h = setup();
    h.replace(allow());
    const db = openBusinessDb();
    handles.push(db);
    const protectedAction = action();
    let executed = false;
    protectedAction.execute = async () => {
      executed = true;
      return { value: "ok", sources: [] };
    };
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(db.db),
      actionExecutor: h.executor,
      model: {
        complete: async (request) => {
          expect(request.tools?.[0].name).toBe(requirement.resource);
          h.replace({ version: 1, grants: [] });
          return JSON.stringify({
            kind: "invoke",
            calls: [{ name: requirement.resource, arguments: {} }],
          });
        },
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    await expect(
      runtime.run(
        {
          id: "revoke-test",
          context: "conversation",
          availableActions: [protectedAction.description],
          limits: { steps: 2 },
        },
        {
          owner,
          actions: [protectedAction],
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(executed).toBe(false);
  });

  it("does not publish a final reply after evidence permission is revoked during the final decision", async () => {
    const h = setup();
    h.replace(allow());
    const db = openBusinessDb();
    handles.push(db);
    const tool = action();
    let calls = 0;
    let published = false;
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(db.db),
      actionExecutor: h.executor,
      model: {
        complete: async () => {
          if (++calls === 1)
            return JSON.stringify({
              kind: "invoke",
              calls: [{ name: requirement.resource, arguments: {} }],
            });
          h.replace({ version: 1, grants: [] });
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "inline", targetId: "reply", text: "private result" }],
          });
        },
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    await expect(
      runtime.run(
        {
          id: "publication",
          context: "conversation",
          availableActions: [tool.description],
          limits: { steps: 3 },
        },
        {
          owner,
          actions: [tool],
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
          async commitOutputs() {
            published = true;
            return undefined;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(published).toBe(false);
  });

  it("uses the same policy in PTC and keeps revocation a hard failure even if the runner catches it", async () => {
    const h = setup();
    h.replace(allow());
    let executed = false;
    const target = action();
    target.execute = async () => {
      executed = true;
      return { value: "private", sources: [] };
    };
    const mode = createCodeMode({
      actions: [target],
      executor: h.executor,
      runner: {
        available: true,
        async run({ bindings }) {
          expect(Object.keys(bindings)).toEqual([requirement.resource]);
          h.replace({ version: 1, grants: [] });
          try {
            await bindings[requirement.resource]({});
          } catch {}
          return { conclusion: "caught denial" };
        },
      },
    });
    if (!mode.action) throw new Error("missing code action");
    await expect(mode.action.execute({ script: "read" }, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(executed).toBe(false);
  });

  it("redacts stored external evidence after revocation through the existing source resolver", async () => {
    const h = setup();
    h.replace(allow());
    const db = openBusinessDb();
    handles.push(db);
    const repository = new AgentRunRepository(db.db);
    const runOwner = { ...owner, userId: DEFAULT_USER_ID };
    let steps = 0;
    const runtime = new AgentRuntime({
      repository,
      actionExecutor: h.executor,
      model: {
        complete: async () =>
          ++steps === 1
            ? JSON.stringify({
                kind: "invoke",
                calls: [{ name: requirement.resource, arguments: {} }],
              })
            : '{"kind":"none"}',
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    const tool = action();
    const result = await runtime.run(
      {
        id: "inspection",
        context: "conversation",
        availableActions: [tool.description],
        limits: { steps: 3 },
      },
      {
        owner: runOwner,
        actions: [tool],
        authorizedTargets: ["reply"],
        outputMode: "buffered",
        context: {
          async read() {
            return {};
          },
        },
      },
    );
    const last = repository.getRun(result.runId)?.steps.at(-1);
    if (!last) throw new Error("missing step");
    const handle = { runId: result.runId, stepId: last.stepId };
    const inspect = () =>
      inspectContext(
        db.db,
        repository,
        handle,
        { userId: DEFAULT_USER_ID },
        new Date().toISOString(),
        (source, identity) => h.service.sourceAccess(source, identity),
      );
    expect(inspect()?.status).toBe("exact");
    h.replace({ version: 1, grants: [] });
    expect(inspect()?.status).toBe("revoked");
    expect(repository.getContext(handle)?.messages).toBeNull();
  });

  it("exposes management separately from agent actions with schema, origin and revision checks", async () => {
    const h = setup();
    const app = new Hono();
    app.onError(handleError);
    app.route(
      "/v2/permissions",
      permissionRoutes(h.service, () => [action()]),
    );
    const response = await app.request("/v2/permissions");
    expect(response.status).toBe(200);
    expect((await app.request("http://rebound.invalid/v2/permissions")).status).toBe(403);
    expect((await response.json()).resources[0]).toMatchObject({
      resource: requirement.resource,
      revision: "one",
    });
    const update = { expectedRevision: "", policy: allow() };
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json", origin: "https://untrusted.invalid" },
          body: JSON.stringify(update),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(422);
  });
});
