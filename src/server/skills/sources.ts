import type { SourceRef } from "../../shared/contracts/evidence";
import { loadMergedSkillCatalog, readSkillEntryResource, skillResourceRevision } from "./config";

/** Inspection must not throw: a missing or unreadable root, catalog or resource reads as "revoked". */
export function skillSourceAccess(
  root: string | undefined,
  source: SourceRef,
): "available" | "revoked" | undefined {
  if (source.kind !== "skill_document" && source.kind !== "skill_resource") return undefined;
  try {
    const catalog = loadMergedSkillCatalog(root);
    if (source.kind === "skill_document") {
      const entry = catalog.skills.find((skill) => skill.metadata.name === source.id);
      // 系统技能不需要外部 root；外置技能在 root 撤销（undefined）时整体失效。
      return entry && entry.revision === source.revision ? "available" : "revoked";
    }
    const slash = source.id.indexOf("/");
    if (slash <= 0 || slash === source.id.length - 1) return "revoked";
    const entry = catalog.skills.find((skill) => skill.metadata.name === source.id.slice(0, slash));
    if (!entry) return "revoked";
    const relative = source.id.slice(slash + 1);
    const resource = readSkillEntryResource(entry, relative);
    return skillResourceRevision(entry.revision, relative, resource.sha256) === source.revision
      ? "available"
      : "revoked";
  } catch {
    return "revoked";
  }
}
