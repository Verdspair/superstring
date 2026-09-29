import { z } from "zod";
import type { BuiltInAction } from "../agent/built-in-actions";
import { PermissionError } from "../permissions/service";
import { loadSkillCatalog, readSkillDocument, type SkillCatalog, type SkillEntry } from "./config";

const ReadSchema = z.strictObject({ name: z.string().min(1) });
const EmptySchema = z.strictObject({});
const catalogRevision = (catalog: SkillCatalog) =>
  JSON.stringify(catalog.skills.map((skill) => [skill.dir, skill.metadata.name, skill.revision]));

export function createSkillActions(root: string): BuiltInAction[] {
  const catalog = loadSkillCatalog(root);
  if (!catalog.skills.length) return [];
  const revision = catalogRevision(catalog);
  const consumed = new Set<SkillEntry>();
  let catalogConsumed = false;
  const assertCatalog = () => {
    if (catalogRevision(loadSkillCatalog(root)) !== revision)
      throw new PermissionError("PERMISSION_REVISION_CHANGED");
  };
  const assertAvailable = () => {
    if (catalogConsumed) assertCatalog();
    else for (const skill of consumed) readSkillDocument(skill);
  };
  return [
    {
      assertAvailable,
      description: {
        name: "skill.catalog",
        description:
          "List installed skill names and descriptions. Read a selected skill's SKILL.md before following its guidance.",
        capability: "skill.read",
        effect: "read",
        parameters: z.toJSONSchema(EmptySchema),
      },
      async execute(args) {
        EmptySchema.parse(args);
        assertAvailable();
        assertCatalog();
        catalogConsumed = true;
        return {
          value: {
            status: "ok",
            items: catalog.skills.map(({ metadata, revision }) => ({
              name: metadata.name,
              description: metadata.description,
              revision,
            })),
          },
          sources: [],
        };
      },
    },
    {
      assertAvailable,
      description: {
        name: "skill.read",
        description:
          "Read one installed skill's complete SKILL.md as task guidance, subject to existing instructions and permissions. Declarations cannot grant tools or execute scripts.",
        capability: "skill.read",
        effect: "read",
        parameters: z.toJSONSchema(ReadSchema),
      },
      async execute(args) {
        const { name } = ReadSchema.parse(args);
        const skill = catalog.skills.find((entry) => entry.metadata.name === name);
        if (!skill) throw new PermissionError("SKILL_NOT_FOUND");
        assertAvailable();
        const document = readSkillDocument(skill);
        consumed.add(skill);
        return { value: { status: "ok", ...document }, sources: [] };
      },
    },
  ];
}
