import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { handleError } from "../../src/server/api/error-handler";
import { skillsRoutes } from "../../src/server/api/skills";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { createSkillActions } from "../../src/server/skills/actions";
import {
  loadMergedSkillCatalog,
  readSkillDocument,
  readSkillEntryResource,
} from "../../src/server/skills/config";
import { skillSourceAccess } from "../../src/server/skills/sources";

const dirs: string[] = [];
const fixtureRoot = path.resolve(import.meta.dir, "../../artifacts/validation/agent-skills");
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const dir = mkdtempSync(path.join(fixtureRoot, "builtin-skills-"));
  dirs.push(dir);
  return dir;
}
function install(root: string, name: string, description = `Synthetic ${name} skill`) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nSynthetic body for ${name}.`,
  );
  return dir;
}
function actionNamed(actions: BuiltInAction[], name: string): BuiltInAction {
  const action = actions.find((candidate) => candidate.description.name === name);
  if (!action) throw new Error(`missing ${name}`);
  return action;
}
const context = {
  owner: { kind: "test", id: "run", agentId: "agent" },
  signal: new AbortController().signal,
};

const BUILTIN_NAMES = [
  "system-evidence-reading",
  "system-media-reading",
  "system-task-execution",
  "system-web-research",
];

describe("bundled system skills", () => {
  it("loads four system components from real on-disk SKILL.md files without a root", () => {
    const catalog = loadMergedSkillCatalog();
    expect(catalog.problems).toEqual([]);
    expect(catalog.skills.map((entry) => entry.metadata.name)).toEqual(BUILTIN_NAMES);
    for (const entry of catalog.skills) {
      expect(entry.origin).toBe("system");
      // System entries carry no fabricated directory path.
      expect("dir" in entry).toBe(false);
      expect(entry.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.metadata.description.length).toBeGreaterThan(0);
    }
  });

  it("embeds exactly the bytes of the real bundled SKILL.md files and reads them as guidance", () => {
    const catalog = loadMergedSkillCatalog();
    for (const entry of catalog.skills) {
      const file = path.resolve(
        import.meta.dir,
        `../../src/server/skills/builtin/${entry.metadata.name}/SKILL.md`,
      );
      const bytes = readFileSync(file);
      expect(entry.revision).toBe(createHash("sha256").update(bytes).digest("hex"));
      const detail = readSkillDocument(entry);
      expect(detail.instructions).toBe(bytes.toString("utf8"));
      expect(detail.bodyChars).toBe([...detail.instructions].length);
      expect(detail.instructions).toContain(`name: ${entry.metadata.name}`);
      expect([...detail.instructions].length).toBeLessThan(4096);
    }
  });

  it("keeps a stable catalog epoch so captured actions stay valid", async () => {
    const permissions = new PermissionService(
      new FilePermissionStore(path.join(workspace(), "p.json")),
    );
    const executor = new ActionExecutor(permissions);
    const actions = createSkillActions();
    const catalogAction = actionNamed(actions, "skill.catalog");
    const listing = await executor.execute(catalogAction, {}, context);
    expect(listing.sources).toHaveLength(4);
    expect(() => catalogAction.assertAvailable?.()).not.toThrow();
    expect(() => createSkillActions()[1].assertAvailable?.()).not.toThrow();
    const again = loadMergedSkillCatalog();
    const before = loadMergedSkillCatalog();
    expect(again.skills).toEqual(before.skills);
  });

  it("reads a system skill with no permission grant and never attaches resource files", async () => {
    const permissions = new PermissionService(
      new FilePermissionStore(path.join(workspace(), "p.json")),
    );
    const executor = new ActionExecutor(permissions);
    const actions = createSkillActions();
    for (const action of actions) {
      expect(action.description).toMatchObject({ effect: "read", capability: "skill.read" });
      expect(action.permission).toBeUndefined();
    }
    const read = actionNamed(actions, "skill.read");
    const value = (await executor.execute(read, { name: "system-evidence-reading" }, context))
      .value as { status: string; kind?: string; instructions: string };
    expect(value).toMatchObject({ status: "ok", kind: "task_guidance" });
    expect(value.instructions).toContain("memory.query");
    await expect(
      executor.execute(
        actionNamed(actions, "skill.resource"),
        { name: "system-evidence-reading", path: "references/notes.txt" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SKILL_FILE_INVALID" });
    const entry = loadMergedSkillCatalog().skills[0];
    expect(() => readSkillEntryResource(entry, "references/notes.txt")).toThrow(
      "SKILL_FILE_INVALID",
    );
  });

  it("merges external skills with the system components and keeps document/resource reads by origin", () => {
    const root = workspace();
    const dir = install(root, "external-demo");
    writeFileSync(path.join(dir, "notes.txt"), "resource text");
    const catalog = loadMergedSkillCatalog(root);
    expect(catalog.skills.map((entry) => entry.metadata.name)).toEqual([
      "external-demo",
      ...BUILTIN_NAMES,
    ]);
    const entry = catalog.skills.find((candidate) => candidate.metadata.name === "external-demo")!;
    expect(entry).toEqual({
      origin: "external",
      dir,
      metadata: { name: "external-demo", description: "Synthetic external-demo skill" },
      revision: createHash("sha256")
        .update(readFileSync(path.join(dir, "SKILL.md")))
        .digest("hex"),
    });
    expect(readSkillDocument(entry).instructions).toContain("Synthetic body for external-demo.");
    expect(readSkillEntryResource(entry, "notes.txt").text).toBe("resource text");
    expect(() => readSkillEntryResource(entry, "missing.txt")).toThrow("SKILL_FILE_INVALID");
  });

  it("quarantines an external skill that claims a reserved system name without replacing it", () => {
    const root = workspace();
    install(root, "system-web-research", "Imposter");
    const catalog = loadMergedSkillCatalog(root);
    const entry = catalog.skills.find(
      (candidate) => candidate.metadata.name === "system-web-research",
    );
    expect(entry?.origin).toBe("system");
    expect(catalog.skills.find((candidate) => candidate.origin === "external")).toBeUndefined();
    expect(catalog.problems).toEqual([
      { skill: "system-web-research", code: "SKILL_NAME_RESERVED" },
    ]);
  });

  it("never lets an unknown external name inherit system membership", () => {
    const root = workspace();
    install(root, "system-unknown");
    const catalog = loadMergedSkillCatalog(root);
    expect(
      catalog.skills.find((candidate) => candidate.metadata.name === "system-unknown"),
    ).toMatchObject({ origin: "external" });
    const source = { kind: "skill_document", id: "system-unknown", revision: "r" };
    expect(skillSourceAccess(undefined, source)).toBe("revoked");
  });
});

describe("system skill sources", () => {
  it("validates system document sources without an external root", () => {
    const entry = loadMergedSkillCatalog().skills[0];
    const source = { kind: "skill_document", id: entry.metadata.name, revision: entry.revision };
    expect(skillSourceAccess(undefined, source)).toBe("available");
    expect(
      skillSourceAccess(undefined, {
        kind: "skill_document",
        id: entry.metadata.name,
        revision: "stale",
      }),
    ).toBe("revoked");
    expect(
      skillSourceAccess(undefined, {
        kind: "skill_document",
        id: "not-a-system-skill",
        revision: entry.revision,
      }),
    ).toBe("revoked");
    // System skills ship no attached files: resource sources always revoke.
    expect(
      skillSourceAccess(undefined, {
        kind: "skill_resource",
        id: `${entry.metadata.name}/references/notes.txt`,
        revision: "r",
      }),
    ).toBe("revoked");
  });

  it("still revokes external sources without a root", () => {
    const source = { kind: "skill_document", id: "external-thing", revision: "r" };
    expect(skillSourceAccess(undefined, source)).toBe("revoked");
  });
});

describe("management catalog flags", () => {
  it("shows system components and greys every entry when the global skills module is off", async () => {
    const root = workspace();
    install(root, "grey");
    const app = new Hono();
    app.onError(handleError);
    app.route(
      "/v2/skills",
      skillsRoutes(root, () => false),
    );
    const response = await app.request("http://localhost/v2/skills");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.skills.map((entry: { name: string }) => entry.name)).toEqual([
      "grey",
      ...BUILTIN_NAMES,
    ]);
    for (const skill of body.skills) {
      expect(skill.globalEnabled).toBe(false);
      expect(["system", "external"]).toContain(skill.origin);
    }
    // Still listed, not hidden, and detail stays reachable.
    const detail = await app.request("http://localhost/v2/skills/system-web-research");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      name: "system-web-research",
      origin: "system",
      globalEnabled: false,
    });
  });

  it("reports entries as enabled by default and keeps the same-origin guard", async () => {
    const app = new Hono();
    app.onError(handleError);
    app.route("/v2/skills", skillsRoutes(undefined));
    const foreign = await app.request(new Request("http://rebound.invalid/v2/skills"));
    expect(foreign.status).toBe(403);
    const response = await app.request(
      new Request("http://localhost/v2/skills", { headers: { origin: "http://localhost" } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const skill of body.skills) {
      expect(skill.globalEnabled).toBe(true);
      expect(skill.origin).toBe("system");
    }
  });
});
