import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { createRuntime } from "../../src/server/runtime";
import { createSkillActions } from "../../src/server/skills/actions";
import { loadSkillCatalog } from "../../src/server/skills/config";
import { runSkillScript } from "../../src/server/skills/runner";
import { SkillManifestSchema } from "../../src/shared/contracts/skill";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(code = "process.stdout.write('script-output')") {
  const base = mkdtempSync(path.join(tmpdir(), "skills-test-"));
  directories.push(base);
  const root = path.join(base, "skills");
  const dir = path.join(root, "demo");
  mkdirSync(dir, { recursive: true });
  const manifest = SkillManifestSchema.parse({
    name: "demo",
    description: "Test skill",
    scripts: [
      {
        name: "run",
        description: "Test script",
        path: "main.mjs",
        command: process.execPath,
        timeoutMs: 10_000,
      },
    ],
  });
  writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "SKILL.md"), "private-skill-instructions");
  writeFileSync(path.join(dir, "main.mjs"), code);
  const permissions = new PermissionService(
    new FilePermissionStore(path.join(base, "permissions.json")),
  );
  const executor = new ActionExecutor(permissions);
  const grant = (action: ReturnType<typeof createSkillActions>[number], dirs: string[] = []) => {
    if (!action.permission) throw new Error("missing requirement");
    permissions.replace(permissions.snapshot().revision, {
      version: 1,
      grants: [
        {
          resource: action.permission.resource,
          revision: action.permission.revision,
          approved: true,
          directories: dirs,
        },
      ],
    });
  };
  return { base, root, dir, manifest, executor, permissions, grant };
}
const context = {
  owner: { kind: "test", id: "run", agentId: "agent" },
  signal: new AbortController().signal,
};

describe("Skills use unified permissions", () => {
  it.each(["/chat", "/v2/chat"])(
    "manages and executes approved scripts through %s",
    async (endpoint) => {
      const h = setup();
      const business = openBusinessDb();
      ensureDefaults(business.orm, "fixture");
      let decisions = 0;
      let allowScript = true;
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
        listModels: async () => [],
        loadedContextCapacity: async () => 65536,
        probeModelLoaded: async () => true,
        complete: async (request) => {
          const exposed = request.tools?.some((tool) => tool.name === "skill.demo.run") ?? false;
          expect(exposed).toBe(allowScript);
          if (allowScript && ++decisions === 1)
            return JSON.stringify({
              kind: "invoke",
              calls: [{ name: "skill.demo.run", arguments: { args: [] } }],
            });
          if (allowScript) {
            expect(JSON.stringify(request.messages)).toContain("taskId");
            expect(JSON.stringify(request.messages)).not.toContain("script-output");
          }
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
          });
        },
        async *streamChat() {
          yield "answer";
        },
      };
      const runtime = createRuntime({
        business,
        gateway,
        browserStateSecret: "synthetic-permission-test",
        skillRoot: h.root,
        permissionConfigPath: path.join(h.base, "permissions.json"),
      });
      try {
        const info = await (await runtime.app.request("/v2/permissions")).json();
        const script = info.resources.find(
          (resource: { name: string }) => resource.name === "skill.demo.run",
        );
        expect(script).toMatchObject({ approvalRequired: true });
        const approved = await runtime.app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: info.revision,
            policy: {
              version: 1,
              grants: [
                {
                  resource: script.resource,
                  approved: true,
                  revision: script.revision,
                  directories: [],
                },
              ],
            },
          }),
        });
        expect(approved.status).toBe(200);
        const session = createSession(business.orm, "permission conversation", {
          modelName: "fixture",
        });
        const request = (id: string) =>
          runtime.app.request(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              session_id: session.id,
              message: "use the script",
              client_request_id: id,
            }),
          });
        expect(await (await request("approved")).text()).not.toContain("event: error");
        expect(decisions).toBe(2);
        await runtime.tasks.runOnce();
        const conversation = new ConversationEventRepository(business.db).ensureWeb(session.id);
        if (!conversation) throw new Error("missing conversation");
        const task = runtime.tasks.list({ conversationId: conversation.id, limit: 50 }).items[0];
        expect(task.status).toBe("completed");
        const body = runtime.tasks.readBody(task.id, 0, "result", { offset: 0, limit: 2048 });
        expect(body?.status).toBe("available");
        expect(JSON.parse(body?.text ?? "null")).toMatchObject({
          status: "ok",
          output: "script-output",
        });
        h.permissions.replace(h.permissions.snapshot().revision, { version: 1, grants: [] });
        allowScript = false;
        expect(await (await request("revoked")).text()).toContain("answer");
      } finally {
        await runtime.stop();
      }
    },
    15_000,
  );

  it("loads metadata before instructions and keeps scripts hidden until approved", async () => {
    const h = setup();
    const actions = createSkillActions(h.root);
    const [catalog, read, script] = actions;
    expect(h.executor.allowed(script, context)).toBe(false);
    const listing = await h.executor.execute(catalog, {}, context);
    expect(listing.value).toMatchObject({ items: [{ name: "demo", description: "Test skill" }] });
    expect(JSON.stringify(listing)).not.toContain("private-skill-instructions");
    expect((await h.executor.execute(read, { name: "demo" }, context)).value).toMatchObject({
      instructions: "private-skill-instructions",
    });
    await expect(h.executor.execute(script, { args: [] }, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    h.grant(script);
    expect((await h.executor.execute(script, { args: [] }, context)).value).toMatchObject({
      status: "ok",
      output: "script-output",
    });
  });

  it("invalidates both captured and new script actions after the approved code changes", async () => {
    const h = setup();
    const captured = createSkillActions(h.root)[2];
    h.grant(captured);
    writeFileSync(path.join(h.dir, "main.mjs"), "throw new Error('changed code must not execute')");
    await expect(h.executor.execute(captured, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_REVISION_CHANGED",
    });
    const changed = createSkillActions(h.root)[2];
    await expect(h.executor.execute(changed, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_REVISION_CHANGED",
    });
  });

  it("requires declared outside directories to be granted independently and does not inherit unrelated secrets", async () => {
    const h = setup(
      "process.stdout.write(JSON.stringify({dirs:JSON.parse(process.env.SUPERSTRING_SKILL_DIRS),network:process.env.SUPERSTRING_SKILL_NETWORK,secret:process.env.SKILL_TEST_SECRET??null}))",
    );
    const extra = path.join(h.base, "files");
    mkdirSync(extra);
    h.manifest.scripts[0].directories = [extra];
    writeFileSync(path.join(h.dir, "skill.json"), JSON.stringify(h.manifest));
    const script = createSkillActions(h.root)[2];
    h.grant(script);
    await expect(h.executor.execute(script, {}, context)).rejects.toMatchObject({
      code: "PERMISSION_DIRECTORY_DENIED",
    });
    h.grant(script, [extra]);
    const before = process.env.SKILL_TEST_SECRET;
    process.env.SKILL_TEST_SECRET = "test-secret-never-copy";
    try {
      const result = await h.executor.execute(script, {}, context);
      const value = result.value as { output: string };
      expect(JSON.parse(value.output)).toEqual({ dirs: [extra], network: "allow", secret: null });
    } finally {
      if (before === undefined) delete process.env.SKILL_TEST_SECRET;
      else process.env.SKILL_TEST_SECRET = before;
    }
  });

  it("rejects cancelled calls before spawn and bounds native output and wall clock", async () => {
    const h = setup("process.stdout.write('x'.repeat(100))");
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(
      runSkillScript({
        skillDir: h.dir,
        script: h.manifest.scripts[0],
        arguments: [],
        granted: [],
        signal: cancelled.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(
      await runSkillScript({
        skillDir: h.dir,
        script: { ...h.manifest.scripts[0], maxOutputChars: 10 },
        arguments: [],
        granted: [],
        signal: context.signal,
      }),
    ).toMatchObject({ status: "unavailable", code: "SKILL_OUTPUT_TOO_LARGE" });
    writeFileSync(path.join(h.dir, "main.mjs"), "setInterval(()=>{},1000)");
    expect(
      await runSkillScript({
        skillDir: h.dir,
        script: { ...h.manifest.scripts[0], timeoutMs: 100 },
        arguments: [],
        granted: [],
        signal: context.signal,
      }),
    ).toMatchObject({ status: "unavailable", code: "SKILL_TIMEOUT" });
  });

  it("does not follow a skill-directory junction or an escaped entry into unrelated files", () => {
    const h = setup();
    const escaped = path.join(h.base, "outside");
    mkdirSync(escaped);
    writeFileSync(path.join(escaped, "outside.mjs"), "process.stdout.write('outside')");
    symlinkSync(escaped, path.join(h.dir, "linked"), "junction");
    h.manifest.scripts[0].path = "linked/outside.mjs";
    writeFileSync(path.join(h.dir, "skill.json"), JSON.stringify(h.manifest));
    expect(loadSkillCatalog(h.root).problems).toContainEqual({
      skill: "demo",
      code: "SKILL_PATH_ESCAPE",
    });
    h.manifest.scripts[0].path = "../../outside/outside.mjs";
    writeFileSync(path.join(h.dir, "skill.json"), JSON.stringify(h.manifest));
    expect(loadSkillCatalog(h.root).skills).toHaveLength(0);
    expect(readFileSync(path.join(escaped, "outside.mjs"), "utf8")).toContain("outside");
  });
});
