import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type SkillManifest, SkillManifestSchema } from "../../shared/contracts/skill";
import { containsPath, PermissionError } from "../permissions/service";

export interface SkillEntry {
  readonly dir: string;
  readonly manifest: SkillManifest;
  readonly revision: string;
}
export interface SkillCatalog {
  readonly skills: readonly SkillEntry[];
  readonly problems: readonly { skill: string; code: string }[];
}
export function resolveSkillFile(dir: string, relative: string): string {
  const candidate = path.resolve(dir, relative);
  if (!containsPath(dir, candidate)) throw new PermissionError("SKILL_PATH_ESCAPE");
  const resolved = realpathSync(candidate);
  if (!containsPath(realpathSync(dir), resolved)) throw new PermissionError("SKILL_PATH_ESCAPE");
  if (!statSync(resolved).isFile()) throw new PermissionError("SKILL_FILE_INVALID");
  return resolved;
}
export function readSkillText(dir: string, file: string, maxBytes: number): string {
  const resolved = resolveSkillFile(dir, file);
  if (statSync(resolved).size > maxBytes) throw new PermissionError("SKILL_FILE_TOO_LARGE");
  return readFileSync(resolved, "utf8");
}
export function loadSkill(dir: string): SkillEntry {
  const manifest = SkillManifestSchema.parse(JSON.parse(readSkillText(dir, "skill.json", 65_536)));
  if (manifest.name !== path.basename(dir)) throw new PermissionError("SKILL_NAME_MISMATCH");
  const digest = createHash("sha256").update(JSON.stringify(manifest));
  digest.update(readSkillText(dir, manifest.body, manifest.bodyMaxChars * 4));
  for (const script of manifest.scripts) digest.update(readSkillText(dir, script.path, 1_048_576));
  return { dir: realpathSync(dir), manifest, revision: digest.digest("hex") };
}
export function loadSkillCatalog(root: string): SkillCatalog {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { skills: [], problems: [] };
    throw new PermissionError("SKILL_CATALOG_UNAVAILABLE");
  }
  const skills: SkillEntry[] = [];
  const problems: { skill: string; code: string }[] = [];
  for (const name of names) {
    try {
      skills.push(loadSkill(path.resolve(root, name)));
    } catch (error) {
      problems.push({
        skill: name,
        code: error instanceof PermissionError ? error.code : "SKILL_MANIFEST_INVALID",
      });
    }
  }
  return { skills, problems };
}
