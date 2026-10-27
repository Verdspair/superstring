import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openConnection, toOrmHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import {
  BUSINESS_MIGRATION_FILES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

describe("knowledge visibility storage", () => {
  it("has a nullable classification distinct from document grants", () => {
    const business = openBusinessDb();
    try {
      const columns = business.db.query("PRAGMA table_info(knowledge_documents)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      const visibility = columns.find((column) => column.name === "visibility");
      expect(visibility).toMatchObject({ type: "TEXT", notnull: 0 });
      const grants = business.db.query("PRAGMA table_info(knowledge_grants)").all() as Array<{
        name: string;
      }>;
      expect(grants.map((column) => column.name)).toEqual(
        expect.arrayContaining(["document_id", "agent_id", "token"]),
      );
    } finally {
      business.close();
    }
  });

  it("classifies newly imported user text as private without granting access", () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const repo = new KnowledgeRepository(business.db);
      const doc = repo.importDocument({
        name: "synthetic",
        category_id: "default",
        original_text: "user supplied text",
      });
      const stored = business.db
        .query("SELECT * FROM knowledge_documents WHERE id = ?")
        .get(doc.id) as Record<string, unknown>;
      expect(stored.visibility).toBe("private");
      expect(
        business.db
          .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
          .get(doc.id, DEFAULT_AGENT_ID),
      ).toBeNull();
    } finally {
      business.close();
    }
  });

  it("preserves a schema 73 document and grant token during upgrade", () => {
    const db = openConnection();
    try {
      const resources = BUSINESS_MIGRATION_FILES.map((file) =>
        readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
      );
      for (const migration of resources.slice(0, 73)) db.exec(migration);
      db.exec("PRAGMA user_version = 73");
      const handle = toOrmHandle(db);
      ensureDefaults(handle.orm, "synthetic");
      const agentBefore = db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID);
      db.query(
        "INSERT INTO knowledge_documents (id,category_id,name,original_text,import_type,created_at,updated_at) VALUES (?, 'default', ?, ?, 'text', ?, ?)",
      ).run("old-doc", "old", "original", "now", "now");
      db.query(
        "INSERT INTO knowledge_grants (document_id,agent_id,token,created_at) VALUES (?, ?, ?, ?)",
      ).run("old-doc", DEFAULT_AGENT_ID, "old-token", "now");
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 75 });
      expect(
        db
          .query("SELECT original_text,visibility FROM knowledge_documents WHERE id = ?")
          .get("old-doc"),
      ).toEqual({ original_text: "original", visibility: null });
      expect(
        db
          .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
          .get("old-doc", DEFAULT_AGENT_ID),
      ).toEqual({ token: "old-token" });
      expect(db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID)).toEqual(
        agentBefore,
      );
    } finally {
      db.close();
    }
  });

  it("changes classification and explicit recipients atomically with revision and token preservation", () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const repo = new KnowledgeRepository(business.db);
      const doc = repo.importDocument({
        name: "synthetic",
        category_id: "default",
        original_text: "original",
      });
      const granted = repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID], "public");
      expect(granted.visibility).toBe("public");
      expect(granted.agent_ids).toEqual([DEFAULT_AGENT_ID]);
      const tokenBefore = business.db
        .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
        .get(doc.id, DEFAULT_AGENT_ID);
      expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toEqual([
        expect.objectContaining({ id: doc.id, visibility: "public" }),
      ]);
      const noop = repo.replaceGrants(doc.id, granted.revision, [DEFAULT_AGENT_ID], "public");
      expect(noop.revision).toBe(granted.revision);
      expect(
        business.db
          .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
          .get(doc.id, DEFAULT_AGENT_ID),
      ).toEqual(tokenBefore);
      expect(() => repo.replaceGrants(doc.id, doc.revision, [], "private")).toThrow();
      expect(repo.detail(doc.id)).toMatchObject({
        visibility: "public",
        agent_ids: [DEFAULT_AGENT_ID],
        revision: granted.revision,
      });
      const revoked = repo.replaceGrants(doc.id, granted.revision, [], "public");
      const regranted = repo.replaceGrants(doc.id, revoked.revision, [DEFAULT_AGENT_ID], "public");
      const tokenAfter = business.db
        .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
        .get(doc.id, DEFAULT_AGENT_ID);
      expect(tokenAfter).not.toEqual(tokenBefore);
      expect(regranted.original_text).toBe("original");
      expect(regranted.content_version).toBe(doc.content_version);
    } finally {
      business.close();
    }
  });

  it("allows only the two classifications or historical null", () => {
    const business = openBusinessDb();
    try {
      ensureDefaults(business.orm, "synthetic");
      const repo = new KnowledgeRepository(business.db);
      const doc = repo.importDocument({
        name: "synthetic",
        category_id: "default",
        original_text: "user supplied text",
      });
      const columns = business.db.query("PRAGMA table_info(knowledge_documents)").all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === "visibility")).toBe(true);
      business.db
        .query("UPDATE knowledge_documents SET visibility = NULL WHERE id = ?")
        .run(doc.id);
      business.db
        .query("UPDATE knowledge_documents SET visibility = 'public' WHERE id = ?")
        .run(doc.id);
      business.db
        .query("UPDATE knowledge_documents SET visibility = 'private' WHERE id = ?")
        .run(doc.id);
      expect(() =>
        business.db
          .query("UPDATE knowledge_documents SET visibility = 'global' WHERE id = ?")
          .run(doc.id),
      ).toThrow();
    } finally {
      business.close();
    }
  });
});
