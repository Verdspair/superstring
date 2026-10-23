import type { SourceRef } from "../../shared/contracts/evidence";
import {
  assertSkillRootListable,
  loadSkillByName,
  readSkillEntryResource,
  skillResourceRevision,
  systemSkillDocumentRevision,
} from "./config";

/** Inspection must not throw: a missing or unreadable root, catalog or resource reads as "revoked". */
export function skillSourceAccess(
  root: string | undefined,
  source: SourceRef,
): "available" | "revoked" | undefined {
  if (source.kind !== "skill_document" && source.kind !== "skill_resource") return undefined;
  try {
    // 与全量目录同一判据：根存在但不可列举时整份拒绝（系统条目也 revoked），缺失＝空目录。
    assertSkillRootListable(root);
    if (source.kind === "skill_document") {
      const systemRevision = systemSkillDocumentRevision(source.id);
      if (systemRevision !== undefined)
        return systemRevision === source.revision ? "available" : "revoked";
      // 系统技能不需要外部 root；外置技能在 root 撤销（undefined）时整体失效。
      if (root === undefined) return "revoked";
      const entry = loadSkillByName(root, source.id);
      return entry.revision === source.revision ? "available" : "revoked";
    }
    const slash = source.id.indexOf("/");
    if (slash <= 0 || slash === source.id.length - 1) return "revoked";
    const name = source.id.slice(0, slash);
    const relative = source.id.slice(slash + 1);
    // 系统组件没有资源文件：全量目录路径在这里同样是拒绝，不是“找不到再回退”。
    if (systemSkillDocumentRevision(name) !== undefined) return "revoked";
    if (root === undefined) return "revoked";
    const entry = loadSkillByName(root, name);
    const resource = readSkillEntryResource(entry, relative);
    return skillResourceRevision(entry.revision, relative, resource.sha256) === source.revision
      ? "available"
      : "revoked";
  } catch {
    return "revoked";
  }
}
