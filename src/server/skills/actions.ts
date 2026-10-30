import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ToolDefinition } from "../../shared/contracts/tool-directory";
import type { BuiltInAction } from "../agent/built-in-actions";
import { PermissionError } from "../permissions/service";
import {
  loadMergedSkillCatalog,
  readSkillDocument,
  readSkillEntryResource,
  type SkillCatalog,
  type SkillEntry,
  skillResourceRevision,
} from "./config";

const ReadSchema = z.strictObject({ name: z.string().min(1) });
const ResourceSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(4096).optional(),
});
const EmptySchema = z.strictObject({});
const RESOURCE_PAGE_DEFAULT = 2048;
const catalogRevision = (catalog: SkillCatalog) =>
  JSON.stringify(catalog.skills.map((skill) => [skill.metadata.name, skill.revision]));

/** Descriptions share discovery facts, but never allocate a run's consumed-source state. */
export function skillToolDefinitions(catalog: SkillCatalog): ToolDefinition[] {
  if (!catalog.skills.length) return [];
  const catalogSummary = catalog.skills
    .map((skill) => `${skill.metadata.name}: ${skill.metadata.description}`)
    .join("\n");
  return [
    {
      description: {
        name: "skill.catalog",
        description: `Installed skills, one per line as name: description; read a chosen skill's SKILL.md before following its guidance.\n${catalogSummary}`,
        capability: "skill.read",
        effect: "read",
        parameters: z.toJSONSchema(EmptySchema),
      },
    },
    {
      description: {
        name: "skill.read",
        description:
          "Read one installed skill's complete SKILL.md as task guidance, subject to existing instructions and permissions. Declarations cannot grant tools or execute scripts.",
        capability: "skill.read",
        effect: "read",
        parameters: z.toJSONSchema(ReadSchema),
      },
    },
    {
      description: {
        name: "skill.resource",
        description:
          "Read one text resource inside an installed skill's directory, given as a path relative to that directory, as paged plain text; offset/limit count Unicode characters and nextOffset leads to the next page (null ends). Read-only; declarations cannot grant tools or execute scripts.",
        capability: "skill.read",
        effect: "read",
        parameters: z.toJSONSchema(ResourceSchema),
      },
    },
  ];
}

/** 统一目录（系统 + 外置）：root 可缺省；全局模块开关由 runtime 的动作过滤负责，这里不读权限。 */
export function createSkillActions(root?: string): BuiltInAction[] {
  const catalog = loadMergedSkillCatalog(root);
  if (!catalog.skills.length) return [];
  const revision = catalogRevision(catalog);
  const definitions = skillToolDefinitions(catalog);
  const consumed = new Set<SkillEntry>();
  /** Consumed resources keyed by dir+path, holding the revision the model actually saw. */
  const consumedResources = new Map<
    string,
    { skill: SkillEntry; path: string; revision: string }
  >();
  let catalogConsumed = false;
  const documentSource = (skill: SkillEntry, documentRevision: string): SourceRef => ({
    kind: "skill_document",
    id: skill.metadata.name,
    revision: documentRevision,
  });
  const assertCatalog = () => {
    if (catalogRevision(loadMergedSkillCatalog(root)) !== revision)
      throw new PermissionError("PERMISSION_REVISION_CHANGED");
  };
  const assertAvailable = () => {
    if (catalogConsumed) assertCatalog();
    else for (const skill of consumed) readSkillDocument(skill);
    for (const record of consumedResources.values()) {
      const document = readSkillDocument(record.skill);
      const resource = readSkillEntryResource(record.skill, record.path);
      if (
        skillResourceRevision(document.revision, record.path, resource.sha256) !== record.revision
      )
        throw new PermissionError("PERMISSION_REVISION_CHANGED");
    }
  };
  return [
    {
      assertAvailable,
      ...definitions[0]!,
      async execute(args) {
        EmptySchema.parse(args);
        assertAvailable();
        // 已消费时 assertAvailable() 已在同帧完成整目录复验；未消费时才补一次，顺序与错误码不变。
        if (!catalogConsumed) assertCatalog();
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
          sources: catalog.skills.map((skill) => documentSource(skill, skill.revision)),
        };
      },
    },
    {
      assertAvailable,
      ...definitions[1]!,
      async execute(args) {
        const { name } = ReadSchema.parse(args);
        const skill = catalog.skills.find((entry) => entry.metadata.name === name);
        if (!skill) throw new PermissionError("SKILL_NOT_FOUND");
        assertAvailable();
        const document = readSkillDocument(skill);
        consumed.add(skill);
        return {
          value: { status: "ok", kind: "task_guidance", ...document },
          sources: [documentSource(skill, document.revision)],
        };
      },
    },
    {
      assertAvailable,
      ...definitions[2]!,
      async execute(args) {
        const input = ResourceSchema.parse(args);
        const skill = catalog.skills.find((entry) => entry.metadata.name === input.name);
        if (!skill) throw new PermissionError("SKILL_NOT_FOUND");
        assertAvailable();
        const document = readSkillDocument(skill);
        const resource = readSkillEntryResource(skill, input.path);
        const text = [...resource.text];
        const offset = input.offset ?? 0;
        if (offset > text.length) throw new PermissionError("CONTEXT_INVALID_SELECTION");
        const end = Math.min(offset + (input.limit ?? RESOURCE_PAGE_DEFAULT), text.length);
        const resourceRevision = skillResourceRevision(
          document.revision,
          input.path,
          resource.sha256,
        );
        consumedResources.set(JSON.stringify([skill.dir, input.path]), {
          skill,
          path: input.path,
          revision: resourceRevision,
        });
        return {
          value: {
            status: "ok",
            name: skill.metadata.name,
            path: input.path,
            text: text.slice(offset, end).join(""),
            offset,
            total: text.length,
            nextOffset: end < text.length ? end : null,
          },
          sources: [
            documentSource(skill, document.revision),
            {
              kind: "skill_resource",
              id: `${skill.metadata.name}/${input.path}`,
              revision: resourceRevision,
            },
          ],
        };
      },
    },
  ];
}
