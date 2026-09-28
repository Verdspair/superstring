import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { skillsRoutes } from "../../src/server/api/skills";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function skill(root: string, name: string, manifest: unknown, files: Record<string, string> = {}) {
  mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, name, "skill.json"), JSON.stringify(manifest));
  writeFileSync(
    path.join(root, name, "SKILL.md"),
    files["SKILL.md"] ?? `# ${name}\n\nSynthetic skill body.`,
  );
  for (const file of manifestScriptPaths(manifest)) {
    const target = path.join(root, name, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, files[file] ?? "console.log('synthetic');");
  }
}
function manifestScriptPaths(manifest: unknown): string[] {
  const scripts = (manifest as { scripts?: { path?: unknown }[] }).scripts ?? [];
  return scripts.flatMap((script) => (typeof script.path === "string" ? [script.path] : []));
}
function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-admin-"));
  dirs.push(dir);
  const app = new Hono();
  app.onError(handleError);
  app.route("/v2/skills", skillsRoutes(dir));
  return { dir, app };
}
const scriptCommand = process.execPath;

describe("skills management", () => {
  it("lists installed skills, keeps script-less ones visible and names broken ones by code", async () => {
    const f = workspace();
    skill(f.dir, "demo", {
      name: "demo",
      description: "Synthetic demo skill",
      scripts: [
        {
          name: "echo",
          description: "Echo the arguments",
          path: "echo.mjs",
          command: scriptCommand,
          directories: ["data"],
        },
      ],
    });
    skill(f.dir, "plain", { name: "plain", description: "No scripts here" });
    mkdirSync(path.join(f.dir, "broken"), { recursive: true });
    writeFileSync(path.join(f.dir, "broken", "skill.json"), "{ not json");
    const catalog = await (await f.app.request("/v2/skills")).json();
    expect(catalog.skills.map((entry: { name: string }) => entry.name)).toEqual(["demo", "plain"]);
    expect(catalog.skills[0].scriptCount).toBe(1);
    expect(catalog.skills[1].scriptCount).toBe(0);
    expect(catalog.skills[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.problems).toEqual([{ skill: "broken", code: "SKILL_MANIFEST_INVALID" }]);
  });

  it("returns the declared script facts and the unified permission resource name", async () => {
    const f = workspace();
    skill(f.dir, "demo", {
      name: "demo",
      description: "Synthetic demo skill",
      scripts: [
        {
          name: "echo",
          description: "Echo the arguments",
          path: "echo.mjs",
          command: scriptCommand,
          args: ["echo.mjs"],
          directories: ["data"],
        },
      ],
    });
    const detail = await (await f.app.request("/v2/skills/demo")).json();
    expect(detail.instructions).toContain("Synthetic skill body.");
    expect(detail.bodyChars).toBeGreaterThan(0);
    expect(detail.scripts[0]).toMatchObject({
      name: "echo",
      resource: "skill.demo.echo",
      directories: ["data"],
      timeoutMs: 60_000,
      maxOutputChars: 20_000,
    });
    expect(detail.scripts[0].resolvedDirectories).toEqual([path.join(f.dir, "demo", "data")]);
  });

  it("answers unknown, traversal-shaped and differently-cased names with 404", async () => {
    const f = workspace();
    skill(f.dir, "demo", { name: "demo", description: "Synthetic demo skill" });
    expect((await f.app.request("/v2/skills/missing")).status).toBe(404);
    expect((await f.app.request("/v2/skills/Demo")).status).toBe(404);
    expect((await f.app.request("/v2/skills/..%2F..%2Fsecret")).status).toBe(404);
    expect((await f.app.request("/v2/skills/%2e%2e")).status).toBe(404);
  });

  it("refuses a body over the declared limit with the same code as execution", async () => {
    const f = workspace();
    skill(
      f.dir,
      "huge",
      { name: "huge", description: "Over-long body", bodyMaxChars: 100 },
      { "SKILL.md": "x".repeat(200) },
    );
    const response = await f.app.request("/v2/skills/huge");
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SKILL_BODY_TOO_LARGE");
  });

  it("keeps the local boundary and reports an absent directory as empty, not broken", async () => {
    const f = workspace();
    expect((await f.app.request("http://rebound.invalid/v2/skills")).status).toBe(403);
    expect(await (await f.app.request("/v2/skills")).json()).toEqual({ skills: [], problems: [] });
  });
});
