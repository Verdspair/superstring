import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { createSkillActions } from "../../src/server/skills/actions";
import { loadMergedSkillCatalog } from "../../src/server/skills/config";
import { skillSourceAccess } from "../../src/server/skills/sources";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";

const dirs: string[] = [];
const handles: ReturnType<typeof openBusinessDb>[] = [];
const fixtureRoot = path.resolve(import.meta.dir, "../../artifacts/validation/agent-skills");
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const handle of handles.splice(0)) handle.close();
});
function workspace(): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const dir = mkdtempSync(path.join(fixtureRoot, "qq-skill-metadata-"));
  dirs.push(dir);
  return dir;
}
function actionNamed(actions: ReturnType<typeof createSkillActions>, name: string) {
  const action = actions.find((candidate) => candidate.description.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action;
}
const context = {
  owner: { kind: "test", id: "run", agentId: "agent" },
  signal: new AbortController().signal,
};

describe("skill metadata discovery", () => {
  it("carries the authorized catalog name/description metadata before any catalog call", () => {
    const actions = createSkillActions();
    const catalog = loadMergedSkillCatalog();
    expect(catalog.skills.length).toBeGreaterThan(0);
    const description = actionNamed(actions, "skill.catalog").description.description;
    for (const skill of catalog.skills) {
      expect(description).toContain(`${skill.metadata.name}: ${skill.metadata.description}`);
    }
    // Metadata only: skill bodies never travel in the first-round description.
    expect(description).not.toContain("no second model confirmation or review round follows");
    expect(description).not.toContain("continue with `nextOffset` until it is `null`");
  });

  it("leaves bodies to on-demand skill.read and keeps the catalog description body-free", async () => {
    const permissions = new PermissionService(
      new FilePermissionStore(path.join(workspace(), "p.json")),
    );
    const executor = new ActionExecutor(permissions);
    const actions = createSkillActions();
    const value = (
      await executor.execute(
        actionNamed(actions, "skill.read"),
        { name: "system-qq-reply" },
        context,
      )
    ).value as { status: string; kind: string; instructions: string; bodyChars: number };
    expect(value).toMatchObject({ status: "ok", kind: "task_guidance" });
    expect(value.instructions).toContain("End the turn with one `speech.reply` call");
    expect(value.bodyChars).toBe([...value.instructions].length);
    const description = actionNamed(actions, "skill.catalog").description.description;
    expect(description).not.toContain("End the turn with one `speech.reply` call");
  });

  it("stops advertising skill actions when the skills module is disabled", () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    const journal = new ConversationEventRepository(handle.db);
    const conversation = journal.ensureWeb(
      createSession(handle.orm, "qq-skill-metadata", { modelName: "model" }).id,
      DEFAULT_USER_ID,
    )!;
    const service = (modules: Record<string, boolean>) =>
      new AgentTaskService({
        repository: new AgentTaskRepository(handle.db),
        orm: handle.orm,
        executor: new ActionExecutor(
          new PermissionService(new FilePermissionStore(path.join(workspace(), "p.json"))),
        ),
        actions: () => createSkillActions(),
        execution: () => ExecutionPolicySchema.parse({ modules }),
      });
    const disabled = service({ skills: false })
      .conversationActions(conversation.id)
      .map((action) => action.description.name);
    expect(disabled.filter((name) => name.startsWith("skill."))).toEqual([]);
    const enabled = service({})
      .conversationActions(conversation.id)
      .map((action) => action.description.name);
    expect(enabled).toContain("skill.catalog");
    expect(enabled).toContain("skill.read");
  });

  it("keeps the original skill source revocation on stale revisions", () => {
    const entry = loadMergedSkillCatalog().skills.find(
      (skill) => skill.metadata.name === "system-qq-reply",
    )!;
    expect(entry.origin).toBe("system");
    const source = { kind: "skill_document", id: entry.metadata.name, revision: entry.revision };
    expect(skillSourceAccess(undefined, source)).toBe("available");
    expect(skillSourceAccess(undefined, { ...source, revision: "stale" })).toBe("revoked");
  });
});
