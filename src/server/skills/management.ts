import {
  type SkillCatalogResponse,
  type SkillDetailResponse,
  SkillMetadataSchema,
} from "../../shared/contracts/skill";
import { PermissionError } from "../permissions/service";
import { loadMergedSkillCatalog, readSkillDocument } from "./config";

/** 目录带 flags：origin 区分系统/外置；globalEnabled=false 表示全局 skills 模块停用（灰显，不隐藏）。 */
export function skillCatalogView(root?: string, globalEnabled = true): SkillCatalogResponse {
  const catalog = loadMergedSkillCatalog(root);
  return {
    skills: catalog.skills
      .map((entry) => ({
        name: entry.metadata.name,
        description: entry.metadata.description,
        revision: entry.revision,
        origin: entry.origin,
        globalEnabled,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    problems: catalog.problems.map((problem) => ({ skill: problem.skill, code: problem.code })),
  };
}

export function skillDetail(
  root: string | undefined,
  name: string,
  globalEnabled = true,
): SkillDetailResponse | null {
  if (!SkillMetadataSchema.shape.name.safeParse(name).success) return null;
  const catalog = loadMergedSkillCatalog(root);
  const entry = catalog.skills.find((candidate) => candidate.metadata.name === name);
  if (entry) return { ...readSkillDocument(entry), origin: entry.origin, globalEnabled };
  const problem = catalog.problems.find((candidate) => candidate.skill === name);
  if (problem) throw new PermissionError(problem.code);
  return null;
}
