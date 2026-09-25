import { Hono } from "hono";
import {
  AgentKnowledgeReadUpdateSchema,
  KnowledgeBatchGrantSchema,
  KnowledgeCategoryCreateSchema,
  KnowledgeCategoryDeleteSchema,
  KnowledgeCategoryUpdateSchema,
  KnowledgeDocumentUpdateSchema,
  KnowledgeGrantUpdateSchema,
  KnowledgeImportSchema,
  KnowledgeRevisionSchema,
  KnowledgeSettingsUpdateSchema,
} from "../../shared/contracts/knowledge";
import { OrganizationSettingsUpdateSchema } from "../../shared/contracts/organization";
import type { BusinessDbHandle } from "../db/connection";
import { KnowledgeReadRepository } from "../db/knowledge-read-repository";
import { KnowledgeRepository } from "../db/knowledge-repository";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../db/organization-repository";
import { fail } from "../errors";
import type { KnowledgeModule } from "../modules/contracts";
import { parseBody, parseUuidParam, readJsonBody } from "./validation";

export function knowledgeRoutes(
  business: BusinessDbHandle,
  module?: Pick<KnowledgeModule, "ingest">,
): Hono {
  const router = new Hono();
  const repository = new KnowledgeRepository(business.db);
  const ingest = async (
    input: Parameters<KnowledgeRepository["importDocument"]>[0],
    importType: "text" | "txt" | "md" = "text",
  ) => {
    const document = repository.importDocument(input, importType);
    if (module?.ingest) {
      try {
        await module.ingest({
          id: document.id,
          revision: String(document.content_version),
          payload: { input, importType },
        });
      } catch {
        // Import success is already durable; preserve its identity rather than tell the user to
        // retry an upload that exists. The default backend's maintenance consumes the same queue.
        console.warn("knowledge ingestion notification failed; imported document remains queued");
      }
    }
    return document;
  };
  router.get("/organization/settings", (c) => c.json(readOrganizationSettings(business.orm)));
  router.put("/organization/settings", async (c) =>
    c.json(
      updateOrganizationSettings(
        business.orm,
        parseBody(OrganizationSettingsUpdateSchema, await readJsonBody(c.req.raw)),
      ),
    ),
  );
  router.get("/knowledge/settings", (c) => c.json(repository.settings()));
  router.put("/knowledge/settings", async (c) =>
    c.json(
      repository.updateSettings(
        parseBody(KnowledgeSettingsUpdateSchema, await readJsonBody(c.req.raw)),
      ),
    ),
  );
  router.get("/knowledge/categories", (c) => c.json(repository.categories()));
  router.post("/knowledge/categories", async (c) => {
    const body = parseBody(KnowledgeCategoryCreateSchema, await readJsonBody(c.req.raw));
    return c.json(repository.createCategory(body.name), 201);
  });
  router.patch("/knowledge/categories/:id", async (c) => {
    const body = parseBody(KnowledgeCategoryUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(repository.renameCategory(c.req.param("id"), body.name, body.expected_revision));
  });
  router.delete("/knowledge/categories/:id", async (c) => {
    const body = parseBody(KnowledgeCategoryDeleteSchema, await readJsonBody(c.req.raw));
    repository.deleteCategory(c.req.param("id"), body.expected_revision, body.move_to);
    return c.body(null, 204);
  });
  router.get("/knowledge/documents", (c) => c.json(repository.documents()));
  router.post("/knowledge/documents", async (c) =>
    c.json(await ingest(parseBody(KnowledgeImportSchema, await readJsonBody(c.req.raw))), 201),
  );
  router.post("/knowledge/import", async (c) => {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      fail("KNOWLEDGE_IMPORT_INVALID", "请选择 UTF-8 编码的 txt 或 md 文件", 422);
    }
    const file = form.get("file");
    const fields = [...form.keys()];
    if (
      !(file instanceof File) ||
      form.getAll("file").length !== 1 ||
      fields.some((key) => !["file", "category_id", "name"].includes(key)) ||
      form.getAll("category_id").length !== 1 ||
      form.getAll("name").length > 1
    )
      fail("KNOWLEDGE_IMPORT_INVALID", "一次只能导入一个 txt 或 md 文件", 422);
    const extension = file.name.toLowerCase().endsWith(".txt")
      ? "txt"
      : file.name.toLowerCase().endsWith(".md")
        ? "md"
        : null;
    if (!extension) fail("KNOWLEDGE_IMPORT_INVALID", "仅支持 txt 或 md 文件", 422);
    let original: string;
    try {
      original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      fail("KNOWLEDGE_IMPORT_INVALID", "文件不是有效的 UTF-8 文本", 422);
    }
    const body = parseBody(KnowledgeImportSchema, {
      name: form.get("name") ?? file.name,
      category_id: form.get("category_id"),
      original_text: original,
    });
    return c.json(await ingest(body, extension), 201);
  });
  router.post("/knowledge/grants/batch", async (c) =>
    c.json(
      repository.batchGrants(parseBody(KnowledgeBatchGrantSchema, await readJsonBody(c.req.raw))),
    ),
  );
  router.get("/knowledge/documents/:id", (c) =>
    c.json(repository.detail(parseUuidParam(c.req.param("id")))),
  );
  router.patch("/knowledge/documents/:id", async (c) =>
    c.json(
      repository.updateDocument(
        parseUuidParam(c.req.param("id")),
        parseBody(KnowledgeDocumentUpdateSchema, await readJsonBody(c.req.raw)),
      ),
    ),
  );
  router.put("/knowledge/documents/:id/grants", async (c) => {
    const body = parseBody(KnowledgeGrantUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(
      repository.replaceGrants(
        parseUuidParam(c.req.param("id")),
        body.expected_revision,
        body.agent_ids,
      ),
    );
  });
  router.delete("/knowledge/documents/:id", async (c) => {
    const body = parseBody(KnowledgeRevisionSchema, await readJsonBody(c.req.raw));
    repository.deleteDocument(parseUuidParam(c.req.param("id")), body.expected_revision);
    return c.body(null, 204);
  });
  router.get("/agents/:id/knowledge", (c) =>
    c.json(repository.agentDocuments(parseUuidParam(c.req.param("id")))),
  );
  const reading = new KnowledgeReadRepository(business.db);
  router.get("/agents/:id/knowledge-read-settings", (c) =>
    c.json(reading.settings(parseUuidParam(c.req.param("id")))),
  );
  router.put("/agents/:id/knowledge-read-settings", async (c) =>
    c.json(
      reading.update(
        parseUuidParam(c.req.param("id")),
        parseBody(AgentKnowledgeReadUpdateSchema, await readJsonBody(c.req.raw)),
      ),
    ),
  );
  return router;
}
