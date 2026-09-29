import {
  type SkillCatalogResponse,
  type SkillDetailResponse,
  SkillMetadataSchema,
} from "../../shared/contracts/skill";
import { PermissionError } from "../permissions/service";
import { loadSkillCatalog, readSkillDocument } from "./config";

export function skillCatalogView(root: string): SkillCatalogResponse {
  const catalog = loadSkillCatalog(root);
  return {
    skills: catalog.skills
      .map((entry) => ({
        name: entry.metadata.name,
        description: entry.metadata.description,
        revision: entry.revision,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    problems: catalog.problems.map((problem) => ({ skill: problem.skill, code: problem.code })),
  };
}

export function skillDetail(root: string, name: string): SkillDetailResponse | null {
  if (!SkillMetadataSchema.shape.name.safeParse(name).success) return null;
  const catalog = loadSkillCatalog(root);
  const entry = catalog.skills.find((candidate) => candidate.metadata.name === name);
  if (entry) return readSkillDocument(entry);
  const problem = catalog.problems.find((candidate) => candidate.skill === name);
  if (problem) throw new PermissionError(problem.code);
  return null;
}
