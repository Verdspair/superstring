// 技能管理投影（P7-b）：目录、坏清单诊断与受限详情都从同一套加载器读出，
// 不建立第二份技能注册表；授权、批准与执行仍走统一权限。

import path from "node:path";
import type { SkillCatalogResponse, SkillDetailResponse } from "../../shared/contracts/skill";
import { loadSkillCatalog, readSkillText } from "./config";

export function skillCatalogView(root: string): SkillCatalogResponse {
  const catalog = loadSkillCatalog(root);
  return {
    skills: catalog.skills
      .map((entry) => ({
        name: entry.manifest.name,
        description: entry.manifest.description,
        revision: entry.revision,
        scriptCount: entry.manifest.scripts.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    problems: catalog.problems.map((problem) => ({ skill: problem.skill, code: problem.code })),
  };
}

export function skillDetail(root: string, name: string): SkillDetailResponse | null {
  const entry = loadSkillCatalog(root).skills.find((candidate) => candidate.manifest.name === name);
  if (!entry) return null;
  const body = readSkillText(entry.dir, entry.manifest.body, entry.manifest.bodyMaxChars * 4);
  // 与 skill.read 同一条规则：正文按 Unicode 字符计数，超了就拒绝而不是悄悄截断。
  if ([...body].length > entry.manifest.bodyMaxChars)
    throw Object.assign(new Error("技能正文超过声明的上限"), { code: "SKILL_BODY_TOO_LARGE" });
  return {
    name: entry.manifest.name,
    description: entry.manifest.description,
    revision: entry.revision,
    scriptCount: entry.manifest.scripts.length,
    instructions: body,
    bodyChars: [...body].length,
    scripts: entry.manifest.scripts.map((script) => ({
      name: script.name,
      description: script.description,
      command: script.command,
      args: [...script.args],
      directories: [...script.directories],
      resolvedDirectories: script.directories.map((directory) =>
        path.resolve(entry.dir, directory),
      ),
      timeoutMs: script.timeoutMs,
      maxOutputChars: script.maxOutputChars,
      resource: `skill.${entry.manifest.name}.${script.name}`,
    })),
  };
}
