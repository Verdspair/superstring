import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { skillsRoutes } from "../../src/server/api/skills";
import { SYSTEM_SKILL_NAMES } from "../../src/server/skills/config";
import {
  SkillCatalogResponseSchema,
  SkillDetailResponseSchema,
} from "../../src/shared/contracts/skill";

const dirs: string[] = [];
const fixtureRoot = path.resolve(import.meta.dir, "../../artifacts/validation/agent-skills");
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function skill(root: string, name: string, fields = "", body = "Synthetic skill body.") {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const text = `---\nname: ${name}\ndescription: Synthetic ${name} skill\n${fields}---\n# ${name}\n\n${body}`;
  writeFileSync(path.join(dir, "SKILL.md"), text);
  return text;
}
function workspace() {
  mkdirSync(fixtureRoot, { recursive: true });
  const dir = mkdtempSync(path.join(fixtureRoot, "backend-admin-fixture-"));
  dirs.push(dir);
  const app = new Hono();
  app.onError(handleError);
  app.route("/v2/skills", skillsRoutes(dir));
  return { dir, app };
}

describe("standard skills management", () => {
  it("lists document-only skills and isolates invalid metadata and legacy entries", async () => {
    const f = workspace();
    skill(f.dir, "demo");
    skill(f.dir, "plain");
    skill(f.dir, "invalid", "license: 123\n");
    mkdirSync(path.join(f.dir, "ordinary"));
    mkdirSync(path.join(f.dir, "legacy"));
    writeFileSync(path.join(f.dir, "legacy", "skill.json"), "{ not json");
    const response = await f.app.request("/v2/skills");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const catalog = SkillCatalogResponseSchema.parse(await response.json());
    expect(catalog.skills.map((entry) => entry.name)).toEqual([
      "demo",
      "plain",
      ...SYSTEM_SKILL_NAMES,
    ]);
    expect(Object.keys(catalog.skills[0]).sort()).toEqual([
      "description",
      "globalEnabled",
      "name",
      "origin",
      "revision",
    ]);
    expect(catalog.skills[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.problems).toEqual([
      { skill: "invalid", code: "SKILL_METADATA_INVALID" },
      { skill: "legacy", code: "SKILL_DOCUMENT_INVALID" },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("Synthetic skill body.");
  });

  it("returns complete original instructions and optional standard metadata without script declarations", async () => {
    const f = workspace();
    const text = skill(
      f.dir,
      "demo",
      'license: "  MIT  "\ncompatibility: >-\n  Requires synthetic\n  data only.\nmetadata:\n  author: "  fixture  "\n  version: "01"\nallowed-tools: "  Read Bash(git:*)  "\nscripts: [{name: run, command: ignored}]\n',
      `\u{10428}${"x".repeat(25_000)}\n---\nEND`,
    );
    writeFileSync(path.join(f.dir, "demo", "skill.json"), "not JSON");
    const response = await f.app.request("/v2/skills/demo");
    expect(response.status).toBe(200);
    const detail = SkillDetailResponseSchema.parse(await response.json());
    expect(detail).toMatchObject({
      name: "demo",
      description: "Synthetic demo skill",
      instructions: text,
      bodyChars: [...text].length,
      license: "  MIT  ",
      compatibility: "Requires synthetic data only.",
      metadata: { author: "  fixture  ", version: "01" },
      "allowed-tools": "  Read Bash(git:*)  ",
    });
    expect(detail).not.toHaveProperty("scripts");
    expect(detail).not.toHaveProperty("scriptCount");
    expect(detail).not.toHaveProperty("resource");
  });

  it("round-trips prototype-shaped string metadata through the API contract", async () => {
    const f = workspace();
    skill(f.dir, "demo", 'metadata: {__proto__: "literal", constructor: "exact"}\n');
    const response = await f.app.request("/v2/skills/demo");
    expect(response.status).toBe(200);
    const detail = SkillDetailResponseSchema.parse(await response.json());
    expect(JSON.stringify(detail.metadata)).toBe('{"__proto__":"literal","constructor":"exact"}');
  });

  it("keeps on-demand text resources out of the management catalog and detail", async () => {
    const f = workspace();
    skill(f.dir, "demo");
    mkdirSync(path.join(f.dir, "demo", "references"), { recursive: true });
    writeFileSync(path.join(f.dir, "demo", "references", "notes.txt"), "RESOURCE-BODY-MARKER");
    writeFileSync(
      path.join(f.dir, "demo", "references", "icon.png"),
      Buffer.from([0x89, 0x50, 0x00]),
    );
    const catalog = await (await f.app.request("/v2/skills")).json();
    const detail = await (await f.app.request("/v2/skills/demo")).json();
    expect(JSON.stringify(catalog)).not.toContain("RESOURCE-BODY-MARKER");
    expect(JSON.stringify(detail)).not.toContain("RESOURCE-BODY-MARKER");
    expect(Object.keys(catalog.skills[0]).sort()).toEqual([
      "description",
      "globalEnabled",
      "name",
      "origin",
      "revision",
    ]);
    expect(detail).not.toHaveProperty("resources");
    expect(detail).not.toHaveProperty("resource");
  });

  it("rescans catalog and detail on each request instead of retaining stale or invalid entries", async () => {
    const f = workspace();
    skill(f.dir, "demo");
    const first = await (await f.app.request("/v2/skills/demo")).json();
    const replacement = skill(f.dir, "demo", "license: Apache-2.0\n", "replacement");
    const second = await (await f.app.request("/v2/skills/demo")).json();
    expect(second.instructions).toBe(replacement);
    expect(second.revision).not.toBe(first.revision);
    skill(f.dir, "new-skill");
    expect((await (await f.app.request("/v2/skills")).json()).skills).toHaveLength(
      2 + SYSTEM_SKILL_NAMES.length,
    );
    writeFileSync(path.join(f.dir, "demo", "SKILL.md"), "missing frontmatter");
    const catalog = await (await f.app.request("/v2/skills")).json();
    expect(catalog.skills.map((entry: { name: string }) => entry.name)).toEqual([
      "new-skill",
      ...SYSTEM_SKILL_NAMES,
    ]);
    expect(catalog.problems).toContainEqual({ skill: "demo", code: "SKILL_DOCUMENT_INVALID" });
    const invalid = await f.app.request("/v2/skills/demo");
    expect(invalid.status).toBe(409);
    expect((await invalid.json()).error.code).toBe("SKILL_DOCUMENT_INVALID");
  });

  it("answers unknown, traversal-shaped, ordinary and differently-cased names with 404", async () => {
    const f = workspace();
    skill(f.dir, "demo");
    mkdirSync(path.join(f.dir, "ordinary"));
    for (const name of [
      "missing",
      "Demo",
      "ordinary",
      "..%2F..%2Fsecret",
      "%2e%2e",
      "..%5Csecret",
    ]) {
      expect((await f.app.request(`/v2/skills/${name}`)).status).toBe(404);
    }
  });

  it("allows valid Unicode names and descriptions above the retired 500-character limit", async () => {
    const f = workspace();
    skill(f.dir, "技能-٢");
    writeFileSync(
      path.join(f.dir, "技能-٢", "SKILL.md"),
      `---\nname: 技能-٢\ndescription: ${"\u{10428}".repeat(1024)}\n---\n正文`,
    );
    const response = await f.app.request(`/v2/skills/${encodeURIComponent("技能-٢")}`);
    expect(response.status).toBe(200);
    expect((await response.json()).description).toBe("\u{10428}".repeat(1024));
  });

  it("reports oversized documents as problems and returns a stable error for their detail", async () => {
    const f = workspace();
    skill(f.dir, "huge", "", "x".repeat(1_048_576));
    const catalog = await (await f.app.request("/v2/skills")).json();
    expect(catalog.problems).toEqual([{ skill: "huge", code: "SKILL_FILE_TOO_LARGE" }]);
    expect(catalog.skills.map((entry: { name: string }) => entry.name)).toEqual(SYSTEM_SKILL_NAMES);
    const response = await f.app.request("/v2/skills/huge");
    expect(response.status).toBe(409);
    const error = (await response.json()).error;
    expect(error.code).toBe("SKILL_FILE_TOO_LARGE");
    expect(error.message).not.toContain("清单");
  });

  it("preserves local and same-origin guards for catalog and detail", async () => {
    const f = workspace();
    skill(f.dir, "demo");
    for (const endpoint of ["/v2/skills", "/v2/skills/demo"]) {
      for (const request of [
        new Request(`http://rebound.invalid${endpoint}`),
        new Request(`http://localhost${endpoint}`, {
          headers: { origin: "https://outside.invalid" },
        }),
        new Request(`http://localhost${endpoint}`, { headers: { "sec-fetch-site": "cross-site" } }),
      ]) {
        const response = await f.app.request(request);
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect((await response.json()).error.code).toBe("PERMISSION_MANAGEMENT_FORBIDDEN");
      }
      expect(
        (
          await f.app.request(`http://localhost${endpoint}`, {
            headers: { origin: "http://localhost" },
          })
        ).status,
      ).toBe(200);
    }
  });

  it("reports a missing catalog as empty and a non-directory catalog as unavailable", async () => {
    const f = workspace();
    rmSync(f.dir, { recursive: true });
    const absent = await (await f.app.request("/v2/skills")).json();
    expect(absent.skills.map((entry: { name: string }) => entry.name)).toEqual(SYSTEM_SKILL_NAMES);
    expect(absent.problems).toEqual([]);
    writeFileSync(f.dir, "synthetic non-directory");
    const response = await f.app.request("/v2/skills");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SKILL_CATALOG_UNAVAILABLE");
  });
});
