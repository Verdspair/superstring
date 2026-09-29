import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { createSession, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { createRuntime } from "../../src/server/runtime";
import { createSkillActions } from "../../src/server/skills/actions";
import { loadSkill, loadSkillCatalog, resolveSkillFile } from "../../src/server/skills/config";

const directories: string[] = [];
const fixtureRoot = path.resolve(import.meta.dir, "../../artifacts/validation/agent-skills");
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function document(
  name = "demo",
  description = "Test skill",
  fields = "",
  body = "private-skill-instructions",
) {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${fields}---\n${body}`;
}
function install(root: string, name: string, text = document(name)) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), text);
  return dir;
}
function setup(text = document()) {
  mkdirSync(fixtureRoot, { recursive: true });
  const base = mkdtempSync(path.join(fixtureRoot, "backend-fixture-"));
  directories.push(base);
  const root = path.join(base, "skills");
  const dir = install(root, "demo", text);
  const permissions = new PermissionService(
    new FilePermissionStore(path.join(base, "permissions.json")),
  );
  return { base, root, dir, permissions, executor: new ActionExecutor(permissions) };
}
const context = {
  owner: { kind: "test", id: "run", agentId: "agent" },
  signal: new AbortController().signal,
};
function problem(text: string, code = "SKILL_DOCUMENT_INVALID") {
  const h = setup(text);
  expect(loadSkillCatalog(h.root)).toEqual({ skills: [], problems: [{ skill: "demo", code }] });
}

describe("standard SKILL.md metadata", () => {
  it("loads only SKILL.md, hashes its original bytes and keeps the body out of the catalog", () => {
    const text = document();
    const h = setup(text);
    const entry = loadSkill(h.dir);
    expect(entry).toEqual({
      dir: h.dir,
      metadata: { name: "demo", description: "Test skill" },
      revision: createHash("sha256").update(text).digest("hex"),
    });
    expect(JSON.stringify(loadSkillCatalog(h.root))).not.toContain("private-skill-instructions");
    expect(existsSync(path.join(h.dir, "skill.json"))).toBe(false);
  });

  it.each([501, 1024])("accepts a %i-code-point description without trimming", (length) => {
    const description = ` ${"\u{10428}".repeat(length - 2)} `;
    const h = setup(document("demo", description));
    expect(loadSkill(h.dir).metadata.description).toBe(description);
  });
  it.each(["", " \t\n", "x".repeat(1025), "\u{10428}".repeat(1025)])(
    "rejects an invalid description (%#)",
    (description) => {
      problem(document("demo", description), "SKILL_METADATA_INVALID");
    },
  );
  it.each(["a", "a-1", "技能-٢", "école", "\u{10428}".repeat(64), "a".repeat(64)])(
    "accepts a standard Unicode name (%#)",
    (name) => {
      const h = setup();
      expect(loadSkill(install(h.root, name)).metadata.name).toBe(name);
    },
  );
  it.each([
    "",
    "-demo",
    "demo-",
    "de--mo",
    "Demo",
    "École",
    "\u{10400}",
    "a_b",
    "a.b",
    "a b",
    "a".repeat(65),
    "\u{10428}".repeat(65),
  ])("rejects an invalid name (%#)", (name) => {
    problem(document(name), "SKILL_METADATA_INVALID");
  });
  it("requires the declared name to match the directory", () => {
    problem(document("other"), "SKILL_NAME_MISMATCH");
  });
  it("preserves all optional strings, metadata keys and experimental allowed-tools", () => {
    const h = setup(
      document(
        "demo",
        "Test skill",
        'license: "  MIT  "\ncompatibility: "  local only  "\nmetadata:\n  author: "  synthetic  "\n  version: "01"\n  "1": "true"\nallowed-tools: "  Bash(git:*) Read  "\n',
      ),
    );
    expect(loadSkill(h.dir).metadata).toEqual({
      name: "demo",
      description: "Test skill",
      license: "  MIT  ",
      compatibility: "  local only  ",
      metadata: { author: "  synthetic  ", version: "01", "1": "true" },
      "allowed-tools": "  Bash(git:*) Read  ",
    });
  });
  it("accepts empty optional license and allowed-tools and 500 compatibility code points", () => {
    const h = setup(
      document(
        "demo",
        "Test skill",
        `license: ""\nallowed-tools: ""\ncompatibility: "${"\u{10428}".repeat(500)}"\n`,
      ),
    );
    expect(loadSkill(h.dir).metadata.compatibility).toBe("\u{10428}".repeat(500));
  });
  it("preserves prototype-shaped metadata keys without accepting non-string values or polluting objects", () => {
    const h = setup(
      document(
        "demo",
        "Test skill",
        'metadata: {__proto__: "literal", constructor: "exact", prototype: "yes"}\n',
      ),
    );
    expect(JSON.stringify(loadSkill(h.dir).metadata.metadata)).toBe(
      '{"__proto__":"literal","constructor":"exact","prototype":"yes"}',
    );
    problem(
      document("demo", "Test skill", "metadata: {__proto__: {polluted: yes}}\n"),
      "SKILL_METADATA_INVALID",
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it.each([
    "license: 123\n",
    "license: null\n",
    "compatibility: false\n",
    'compatibility: "  "\n',
    `compatibility: "${"x".repeat(501)}"\n`,
    "metadata: []\n",
    "metadata: null\n",
    "metadata: {version: 1}\n",
    "metadata: {enabled: true}\n",
    "metadata: {nested: {x: value}}\n",
    "allowed-tools: [Read, Bash]\n",
    "allowed-tools: null\n",
  ])("does not coerce malformed optional fields (%#)", (fields) => {
    problem(document("demo", "Test skill", fields), "SKILL_METADATA_INVALID");
  });
  it.each([
    "name: 123\ndescription: valid",
    "name: demo\ndescription: true",
    "name: demo",
    "description: valid",
  ])("rejects missing or non-string required fields (%#)", (fields) => {
    problem(`---\n${fields}\n---\nbody`, "SKILL_METADATA_INVALID");
  });
});

describe("bounded YAML frontmatter", () => {
  it("handles quoted scalars, folded and literal blocks, BOM and CRLF without rewriting the file", async () => {
    const text =
      '\uFEFF---\r\nname: "demo"\r\ndescription: >-\r\n  Read: a quoted value\r\n  and continue.\r\nlicense: |\r\n  line one\r\n  line two\r\ncompatibility: " yes "\r\nmetadata: {mode: "on", value: "true"}\r\n---\r\n# Body\r\n---\r\nAnother section\r\n';
    const h = setup(text);
    expect(loadSkill(h.dir).metadata).toMatchObject({
      description: "Read: a quoted value and continue.",
      license: "line one\nline two\n",
      compatibility: " yes ",
      metadata: { mode: "on", value: "true" },
    });
    const [, read] = createSkillActions(h.root);
    expect((await h.executor.execute(read, { name: "demo" }, context)).value).toMatchObject({
      instructions: text,
      bodyChars: [...text].length,
    });
  });
  it.each([
    "# no frontmatter",
    "\n---\nname: demo\ndescription: valid\n---\nbody",
    "--- name: demo\n---\nbody",
    "---\nname: demo\ndescription: valid",
    "---\nname: demo\ndescription: valid\n--- trailing\nbody",
    "---\nname: demo\nname: demo\ndescription: valid\n---\nbody",
    "---\nname: demo\ndescription: !custom value\n---\nbody",
    "---\nname: demo\ndescription: !<tag:example.test,2026:code> value\n---\nbody",
    "---\nname: demo\ndescription: [unterminated\n---\nbody",
    "---\n- demo\n- description\n---\nbody",
    "---\nscalar\n---\nbody",
    "---\nnull\n---\nbody",
    "---\nname: demo\ndescription: valid\nmetadata: &loop {cycle: *loop}\n---\nbody",
    "---\nname: demo\ndescription: valid\nunknown: &loop [*loop]\n---\nbody",
    "---\nname: demo\ndescription: valid\nmetadata: {1: value}\n---\nbody",
    "---\nname: demo\ndescription: valid\nmetadata: {version: one, version: two}\n---\nbody",
    "---\nname: demo\ndescription: valid\nunknown: !custom {value: synthetic}\n---\nbody",
    "---\nname: demo\ndescription: valid\n---\u2028not-a-delimiter-line",
    `---\nname: demo\ndescription: valid\nunknown: ${"[".repeat(80)}x${"]".repeat(80)}\n---\nbody`,
  ])("rejects malformed, tagged, cyclic or overly deep YAML (%#)", (text) => problem(text));
  it("accepts bounded scalar aliases but rejects excessive alias expansion", () => {
    const h = setup('---\nname: demo\ndescription: &text "Test skill"\nlicense: *text\n---\nbody');
    expect(loadSkill(h.dir).metadata.license).toBe("Test skill");
    problem(
      `---\nname: demo\ndescription: &text valid\nunknown: [${Array(101).fill("*text").join(", ")}]\n---\nbody`,
    );
  });
  it("rejects YAML parser warnings rather than accepting an unresolved tag", () => {
    problem(document("demo", "Test skill", "unknown: !!binary eA==\n"));
  });
  it("bounds the original file and frontmatter by bytes, not a declaration in the file", () => {
    problem(document("demo", "Test skill", "", "x".repeat(1_048_576)), "SKILL_FILE_TOO_LARGE");
    problem(
      document("demo", "Test skill", `unknown: "${"x".repeat(65_536)}"\n`),
      "SKILL_FILE_TOO_LARGE",
    );
    problem(document("demo", "Test skill", "", "界".repeat(350_000)), "SKILL_FILE_TOO_LARGE");
  });
  it("rejects invalid UTF-8 instead of replacing original bytes", () => {
    const h = setup();
    writeFileSync(
      path.join(h.dir, "SKILL.md"),
      Buffer.concat([Buffer.from(document()), Buffer.from([0xff])]),
    );
    expect(loadSkillCatalog(h.root).problems).toEqual([
      { skill: "demo", code: "SKILL_DOCUMENT_INVALID" },
    ]);
  });
  it("accepts exact host byte limits and an empty Markdown body", async () => {
    const empty = document("demo", "Test skill", "", "");
    const text = empty + "x".repeat(1_048_576 - Buffer.byteLength(empty));
    const h = setup(text);
    const [, read] = createSkillActions(h.root);
    expect((await h.executor.execute(read, { name: "demo" }, context)).value).toMatchObject({
      instructions: text,
      bodyChars: text.length,
    });
    const fields = "name: demo\ndescription: valid\n";
    const frontmatter = `${fields}#${"x".repeat(65_536 - Buffer.byteLength(fields) - 2)}\n`;
    writeFileSync(path.join(h.dir, "SKILL.md"), `---\n${frontmatter}---`);
    expect(loadSkill(h.dir).metadata.name).toBe("demo");
    writeFileSync(path.join(h.dir, "SKILL.md"), empty);
    expect(loadSkill(h.dir).metadata.description).toBe("Test skill");
  });
  it("returns the entire document, including frontmatter and later separators, without truncation", async () => {
    const text = document(
      "demo",
      "Test skill",
      "bodyMaxChars: 1\n",
      `# Start\n${"\u{10428}".repeat(25_000)}\n---\nEND`,
    );
    const h = setup(text);
    const [, read] = createSkillActions(h.root);
    expect((await h.executor.execute(read, { name: "demo" }, context)).value).toMatchObject({
      instructions: text,
      bodyChars: [...text].length,
    });
  });
});

describe("skill discovery and path boundaries", () => {
  it("isolates invalid entries and diagnoses legacy manifests without reading their contents", () => {
    const h = setup();
    mkdirSync(path.join(h.root, "ordinary"));
    mkdirSync(path.join(h.root, "legacy"));
    mkdirSync(path.join(h.root, "legacy", "skill.json"));
    install(h.root, "no-header", "# legacy body");
    writeFileSync(path.join(h.root, "no-header", "skill.json"), "not JSON");
    install(h.root, "mismatch", document("other"));
    const catalog = loadSkillCatalog(h.root);
    expect(catalog.skills.map((entry) => entry.metadata.name)).toEqual(["demo"]);
    expect(catalog.problems).toEqual([
      { skill: "legacy", code: "SKILL_DOCUMENT_INVALID" },
      { skill: "mismatch", code: "SKILL_NAME_MISMATCH" },
      { skill: "no-header", code: "SKILL_DOCUMENT_INVALID" },
    ]);
  });
  it("requires the exact uppercase filename even on case-insensitive filesystems", () => {
    const h = setup();
    renameSync(path.join(h.dir, "SKILL.md"), path.join(h.dir, "skill.md"));
    expect(loadSkillCatalog(h.root).problems).toEqual([
      { skill: "demo", code: "SKILL_DOCUMENT_INVALID" },
    ]);
  });
  it("rejects a document directory, an escaped file and a package junction", () => {
    const h = setup();
    const outside = path.join(h.base, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "SKILL.md"), document("linked"));
    symlinkSync(outside, path.join(h.root, "linked"), "junction");
    symlinkSync(outside, path.join(h.dir, "linked"), "junction");
    expect(() => resolveSkillFile(h.dir, "linked/SKILL.md")).toThrow("SKILL_PATH_ESCAPE");
    expect(() => resolveSkillFile(h.dir, "../../outside/SKILL.md")).toThrow("SKILL_PATH_ESCAPE");
    expect(() => loadSkill(path.join(h.root, "linked"))).toThrow("SKILL_PATH_ESCAPE");
    expect(loadSkillCatalog(h.root).problems).toContainEqual({
      skill: "linked",
      code: "SKILL_PATH_ESCAPE",
    });
    rmSync(path.join(h.dir, "SKILL.md"));
    mkdirSync(path.join(h.dir, "SKILL.md"));
    expect(loadSkillCatalog(h.root).problems).toContainEqual({
      skill: "demo",
      code: "SKILL_FILE_INVALID",
    });
    rmSync(path.join(h.dir, "SKILL.md"), { recursive: true });
    symlinkSync(outside, path.join(h.dir, "SKILL.md"), "junction");
    expect(loadSkillCatalog(h.root).problems).toContainEqual({
      skill: "demo",
      code: "SKILL_PATH_ESCAPE",
    });
  });
  it("refuses a package replaced by a junction after its document was consumed", async () => {
    const h = setup();
    const [, read] = createSkillActions(h.root);
    await h.executor.execute(read, { name: "demo" }, context);
    const relocated = path.join(h.base, "relocated");
    renameSync(h.dir, relocated);
    symlinkSync(relocated, h.dir, "junction");
    expect(() => read.assertAvailable?.()).toThrow("SKILL_PATH_ESCAPE");
  });
  it("distinguishes an absent catalog from an unreadable catalog", () => {
    const h = setup();
    expect(loadSkillCatalog(path.join(h.base, "missing"))).toEqual({ skills: [], problems: [] });
    const notDirectory = path.join(h.base, "not-directory");
    writeFileSync(notDirectory, "synthetic");
    expect(() => loadSkillCatalog(notDirectory)).toThrow("SKILL_CATALOG_UNAVAILABLE");
  });
});

describe("document-only skill actions", () => {
  it("ignores legacy scripts and unknown frontmatter capabilities without reading or executing resources", async () => {
    const h = setup(
      document(
        "demo",
        "Test skill",
        "allowed-tools: Bash\nscripts: [{name: run, command: ignored}]\ncapability: skill.execute\npermissions: {approved: true}\n",
      ),
    );
    mkdirSync(path.join(h.dir, "skill.json"));
    mkdirSync(path.join(h.dir, "scripts"));
    const marker = path.join(h.base, "executed");
    writeFileSync(
      path.join(h.dir, "scripts", "main.mjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    );
    const actions = createSkillActions(h.root);
    expect(actions.map((action) => action.description.name)).toEqual([
      "skill.catalog",
      "skill.read",
    ]);
    for (const action of actions) {
      expect(action.description).toMatchObject({ effect: "read", capability: "skill.read" });
      expect(action.permission).toBeUndefined();
    }
    const listing = await h.executor.execute(actions[0], {}, context);
    expect(listing.value).toMatchObject({ items: [{ name: "demo", description: "Test skill" }] });
    expect(JSON.stringify(listing)).not.toContain("private-skill-instructions");
    expect(Object.keys(loadSkill(h.dir).metadata).sort()).toEqual([
      "allowed-tools",
      "description",
      "name",
    ]);
    const detail = (await h.executor.execute(actions[1], { name: "demo" }, context)).value;
    expect(detail).toMatchObject({ name: "demo", "allowed-tools": "Bash" });
    expect(detail).not.toHaveProperty("scripts");
    expect(detail).not.toHaveProperty("scriptCount");
    expect(existsSync(marker)).toBe(false);
    rmSync(path.join(h.dir, "scripts"), { recursive: true });
    rmSync(path.join(h.dir, "skill.json"), { recursive: true });
    for (const action of actions) expect(() => action.assertAvailable?.()).not.toThrow();
  });
  it("hard-fails captured reads and later checkpoints after document changes", async () => {
    const h = setup();
    const actions = createSkillActions(h.root);
    await h.executor.execute(actions[1], { name: "demo" }, context);
    writeFileSync(path.join(h.dir, "SKILL.md"), document("demo", "changed"));
    for (const action of actions)
      expect(() => action.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
    await expect(h.executor.execute(actions[1], { name: "demo" }, context)).rejects.toMatchObject({
      code: "PERMISSION_REVISION_CHANGED",
    });
    expect(
      (await h.executor.execute(createSkillActions(h.root)[1], { name: "demo" }, context)).value,
    ).toMatchObject({ description: "changed" });
  });
  it("checks the selected revision before its first read and tracks every subsequently consumed document", async () => {
    const h = setup();
    const other = install(h.root, "other");
    const [, read] = createSkillActions(h.root);
    writeFileSync(path.join(other, "SKILL.md"), document("other", "changed"));
    expect(() => read.assertAvailable?.()).not.toThrow();
    await h.executor.execute(read, { name: "demo" }, context);
    expect(() => read.assertAvailable?.()).not.toThrow();
    await expect(h.executor.execute(read, { name: "other" }, context)).rejects.toMatchObject({
      code: "PERMISSION_REVISION_CHANGED",
    });
    const [, current] = createSkillActions(h.root);
    await h.executor.execute(current, { name: "demo" }, context);
    await h.executor.execute(current, { name: "other" }, context);
    rmSync(path.join(other, "SKILL.md"));
    expect(() => current.assertAvailable?.()).toThrow();
  });
  it("invalidates a consumed catalog when document revisions or catalog membership change", async () => {
    const h = setup();
    const [catalog] = createSkillActions(h.root);
    await h.executor.execute(catalog, {}, context);
    install(h.root, "new-skill");
    expect(() => catalog.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
    const [current] = createSkillActions(h.root);
    await h.executor.execute(current, {}, context);
    writeFileSync(path.join(h.dir, "SKILL.md"), document("demo", "changed"));
    expect(() => current.assertAvailable?.()).toThrow("PERMISSION_REVISION_CHANGED");
  });
  it.each(["missing", "Demo", "../../demo"])(
    "refuses unknown and path-shaped read names (%s)",
    async (name) => {
      const h = setup();
      await expect(
        h.executor.execute(createSkillActions(h.root)[1], { name }, context),
      ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    },
  );

  it.each(["/chat", "/v2/chat"])(
    "reads standard documents through %s without script actions or permission resources",
    async (endpoint) => {
      const text = document("demo", "Test skill", "license: MIT\nallowed-tools: Bash\n");
      const h = setup(text);
      writeFileSync(
        path.join(h.dir, "skill.json"),
        JSON.stringify({
          name: "demo",
          scripts: [{ name: "run", command: process.execPath, path: "main.mjs" }],
        }),
      );
      writeFileSync(path.join(h.dir, "main.mjs"), "throw new Error('must never execute')");
      const business = openBusinessDb();
      ensureDefaults(business.orm, "fixture");
      let decisions = 0;
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
        listModels: async () => [],
        loadedContextCapacity: async () => 65536,
        probeModelLoaded: async () => true,
        complete: async (request) => {
          const tools = request.tools?.map((tool) => tool.name) ?? [];
          expect(tools).toContain("skill.catalog");
          expect(tools).toContain("skill.read");
          expect(tools).not.toContain("skill.demo.run");
          const messages = JSON.stringify(request.messages);
          decisions++;
          if (decisions === 1) {
            expect(messages).not.toContain("private-skill-instructions");
            return JSON.stringify({
              kind: "invoke",
              calls: [{ name: "skill.catalog", arguments: {} }],
            });
          }
          if (decisions === 2) {
            expect(messages).toContain("Test skill");
            expect(messages).not.toContain("private-skill-instructions");
            return JSON.stringify({
              kind: "invoke",
              calls: [{ name: "skill.read", arguments: { name: "demo" } }],
            });
          }
          expect(messages).toContain("private-skill-instructions");
          expect(messages).toContain("license: MIT");
          expect(messages).not.toContain("taskId");
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
        browserStateSecret: "synthetic-skill-test",
        skillRoot: h.root,
        permissionConfigPath: path.join(h.base, "permissions.json"),
        qqStickerDirectory: path.join(h.base, "stickers"),
      });
      try {
        const info = await (await runtime.app.request("/v2/permissions")).json();
        expect(
          info.resources.filter((resource: { name: string }) => resource.name.startsWith("skill.")),
        ).toEqual([]);
        const session = createSession(business.orm, "document conversation", {
          modelName: "fixture",
        });
        const response = await runtime.app.request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: session.id,
            message: "use the document",
            client_request_id: "standard-document",
          }),
        });
        const result = await response.text();
        expect(response.status).toBe(200);
        expect(result).not.toContain("event: error");
        expect(result).toContain("answer");
        expect(decisions).toBe(3);
      } finally {
        await runtime.stop();
      }
    },
    15_000,
  );

  it.each(["/chat", "/v2/chat"])(
    "stops %s at the runtime checkpoint if a consumed document changes during a model call",
    async (endpoint) => {
      const h = setup();
      const business = openBusinessDb();
      ensureDefaults(business.orm, "fixture");
      let decisions = 0;
      let generations = 0;
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "fixture", timeoutSeconds: 1 },
        listModels: async () => [],
        loadedContextCapacity: async () => 65536,
        probeModelLoaded: async () => true,
        complete: async () => {
          if (++decisions === 1)
            return JSON.stringify({
              kind: "invoke",
              calls: [{ name: "skill.read", arguments: { name: "demo" } }],
            });
          writeFileSync(
            path.join(h.dir, "SKILL.md"),
            document("demo", "changed during model call"),
          );
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "generate", targetId: "reply", instructions: "must not generate" }],
          });
        },
        async *streamChat() {
          generations++;
          yield "must not publish";
        },
      };
      const runtime = createRuntime({
        business,
        gateway,
        browserStateSecret: "synthetic-skill-test",
        skillRoot: h.root,
        permissionConfigPath: path.join(h.base, "permissions.json"),
        qqStickerDirectory: path.join(h.base, "stickers"),
      });
      try {
        const session = createSession(business.orm, "changed document", { modelName: "fixture" });
        const response = await runtime.app.request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: session.id,
            message: "read then answer",
            client_request_id: "changed-document",
          }),
        });
        const result = await response.text();
        expect(result).toContain(
          endpoint === "/chat" ? "MODEL_ERROR" : "PERMISSION_REVISION_CHANGED",
        );
        expect(business.db.query("SELECT status, error_code FROM agent_runs").all()).toContainEqual(
          {
            status: "failed",
            error_code: "PERMISSION_REVISION_CHANGED",
          },
        );
        expect(result).not.toContain("must not publish");
        expect(decisions).toBe(2);
        expect(generations).toBe(0);
      } finally {
        await runtime.stop();
      }
    },
    15_000,
  );
});
