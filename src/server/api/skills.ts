import { Hono } from "hono";
import {
  SkillCatalogResponseSchema,
  SkillDetailResponseSchema,
} from "../../shared/contracts/skill";
import { skillCatalogView, skillDetail } from "../skills/management";
import { managementErrors, managementGuard } from "./management";

const errors = {
  SKILL_NOT_FOUND: [404, "技能不存在或未安装"],
  SKILL_FILE_TOO_LARGE: [409, "技能文档或 YAML 头部超过宿主大小上限"],
  SKILL_PATH_ESCAPE: [409, "技能路径越出目录边界或使用了目录链接"],
  SKILL_FILE_INVALID: [409, "SKILL.md 不是可读的普通文件"],
  SKILL_NAME_MISMATCH: [409, "技能目录名与文档声明的名称不一致"],
  SKILL_NAME_RESERVED: [409, "技能名称属于系统组件，不能由外置技能覆盖"],
  SKILL_DOCUMENT_INVALID: [409, "技能需要以合法 YAML 头部开头的 SKILL.md 文档"],
  SKILL_METADATA_INVALID: [409, "技能文档的标准元数据不合法"],
  PERMISSION_REVISION_CHANGED: [409, "技能文档已更改，请刷新后重试"],
  SKILL_CATALOG_UNAVAILABLE: [503, "技能目录不可读，请检查目录访问权限"],
} as const;

/** GET 每次都重新扫描磁盘：刷新即重新读取，没有需要失效的缓存。 */
export function skillsRoutes(root: string | undefined, enabled: () => boolean = () => true): Hono {
  const router = new Hono();
  router.onError(managementErrors(errors));
  router.use("*", managementGuard());
  router.get("/", (c) =>
    c.json(SkillCatalogResponseSchema.parse(skillCatalogView(root, enabled()))),
  );
  router.get("/:name", (c) => {
    const detail = skillDetail(root, c.req.param("name"), enabled());
    return detail
      ? c.json(SkillDetailResponseSchema.parse(detail))
      : c.json({ error: { code: "SKILL_NOT_FOUND", message: "技能不存在或未安装" } }, 404);
  });
  return router;
}
