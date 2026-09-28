import { Hono } from "hono";
import {
  SkillCatalogResponseSchema,
  SkillDetailResponseSchema,
} from "../../shared/contracts/skill";
import { skillCatalogView, skillDetail } from "../skills/management";
import { managementErrors, managementGuard } from "./management";

const errors = {
  SKILL_NOT_FOUND: [404, "技能不存在或未安装"],
  SKILL_BODY_TOO_LARGE: [409, "技能正文超过清单声明的上限"],
  SKILL_FILE_TOO_LARGE: [409, "技能文件超过声明的上限"],
  SKILL_PATH_ESCAPE: [409, "技能文件越出技能目录"],
  SKILL_NAME_MISMATCH: [409, "技能目录名与清单名不一致"],
  SKILL_MANIFEST_INVALID: [409, "技能清单不合法"],
  SKILL_CATALOG_UNAVAILABLE: [503, "技能目录不可读，请检查目录访问权限"],
} as const;

/** GET 每次都重新扫描磁盘：刷新即重新读取，没有需要失效的缓存。 */
export function skillsRoutes(root: string): Hono {
  const router = new Hono();
  router.onError(managementErrors(errors));
  router.use("*", managementGuard());
  router.get("/", (c) => c.json(SkillCatalogResponseSchema.parse(skillCatalogView(root))));
  router.get("/:name", (c) => {
    const detail = skillDetail(root, c.req.param("name"));
    return detail
      ? c.json(SkillDetailResponseSchema.parse(detail))
      : c.json({ error: { code: "SKILL_NOT_FOUND", message: "技能不存在或未安装" } }, 404);
  });
  return router;
}
