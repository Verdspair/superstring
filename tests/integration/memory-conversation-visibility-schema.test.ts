import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import {
  BUSINESS_MIGRATION_FILES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const session = createSession(business.orm, "synthetic", { modelName: "synthetic" });
  const conversation = new ConversationEventRepository(business.db).ensureWeb(session.id);
  if (!conversation) throw new Error("missing synthetic conversation");
  const memoryId = crypto.randomUUID();
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id: memoryId,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "合成",
      summary: "summary",
      tags: "[]",
      kinds: '["semantic"]',
      body: "original body",
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  return { business, conversationId: conversation.id, memoryId };
}

describe("conversation memory visibility schema", () => {
  it("upgrades a synthetic v72 without rewriting existing data or granting visibility", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const directory = path.join(import.meta.dir, "../../migrations/versions");
      for (const name of BUSINESS_MIGRATION_FILES.slice(0, 72)) {
        db.exec(readFileSync(path.join(directory, name), "utf8"));
      }
      db.exec("PRAGMA user_version=72");
      db.exec(`INSERT INTO users(id,name,created_at) VALUES ('u','synthetic','now');
        INSERT INTO agents(id,name,system_prompt,description,additional_instructions,p5_config,model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_prompt,created_at,updated_at)
        VALUES ('a','synthetic','','','','{}','synthetic','private prompt','','','now','now');
        INSERT INTO sessions(id,user_id,agent_id,title,client_request_id,agent_config_snapshot,created_at,updated_at)
        VALUES ('s','u','a','session','request','{}','now','now');
        INSERT INTO turns(id,session_id,client_request_id,runtime_config_snapshot,created_at)
        VALUES ('t','s','request','{"frozen":true}','now');
        INSERT INTO memory_entries(id,agent_id,user_id,name,summary,tags,kinds,body,scope,scope_key,status,config_snapshot,created_at)
        VALUES ('m','a','u','name','summary','[]','[]','original body','reality_user','a','active','{"prompt":"preserve"}','now');
        INSERT INTO memory_sources(memory_id,turn_id,user_message_id,assistant_message_id,sequence_no)
        VALUES ('m','t','user-message','assistant-message',1);
        INSERT INTO knowledge_documents(id,category_id,name,original_text,import_type,created_at,updated_at)
        VALUES ('d','default','doc','original','text','now','now');
        INSERT INTO knowledge_grants(document_id,agent_id,token,created_at) VALUES ('d','a','old-grant','now');`);
      const tables = [
        "users",
        "agents",
        "sessions",
        "turns",
        "memory_entries",
        "memory_sources",
        "knowledge_documents",
        "knowledge_grants",
      ];
      const cols = new Map(
        tables.map((table) => [
          table,
          (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        ]),
      );
      const rows = (table: string) =>
        db
          .query(
            `SELECT ${cols
              .get(table)!
              .map((name) => `"${name}"`)
              .join(",")} FROM ${table} ORDER BY rowid`,
          )
          .all();
      const before = tables.map(rows);
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 75 });
      expect(tables.map(rows)).toEqual(before);
      expect(db.query("SELECT visibility FROM knowledge_documents WHERE id='d'").get()).toEqual({
        visibility: null,
      });
      expect(
        db
          .query(
            "SELECT visibility, publication_source_revision, folded_search, fold_version FROM memory_entries WHERE id='m'",
          )
          .get(),
      ).toEqual({
        visibility: null,
        publication_source_revision: null,
        folded_search: null,
        fold_version: null,
      });
      expect(db.query("SELECT * FROM memory_read_grants").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("owns mode, visibility, publication, folded projection and explicit grants in the business schema", () => {
    const h = fixture();
    try {
      const columns = (table: string) =>
        (h.business.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (column) => column.name,
        );
      expect(columns("conversations")).toEqual(
        expect.arrayContaining(["memory_read_mode", "memory_config_revision"]),
      );
      expect(columns("memory_entries")).toEqual(
        expect.arrayContaining([
          "visibility",
          "visibility_revision",
          "publication_source_revision",
          "folded_search",
          "fold_version",
        ]),
      );
      expect(columns("memory_read_grants")).toEqual(
        expect.arrayContaining(["memory_id", "agent_id", "token"]),
      );
    } finally {
      h.business.close();
    }
  });

  it("enforces mode and visibility values, nullable old fields and monotonic CAS shape", () => {
    const h = fixture();
    try {
      const db = h.business.db;
      expect(
        db
          .query("SELECT memory_read_mode, memory_config_revision FROM conversations WHERE id=?")
          .get(h.conversationId),
      ).toEqual({ memory_read_mode: "current_conversation", memory_config_revision: 1 });
      expect(
        db
          .query(
            "SELECT visibility, visibility_revision, publication_source_revision, folded_search, fold_version FROM memory_entries WHERE id=?",
          )
          .get(h.memoryId),
      ).toEqual({
        visibility: null,
        visibility_revision: 1,
        publication_source_revision: null,
        folded_search: null,
        fold_version: null,
      });
      expect(() =>
        db
          .query("UPDATE conversations SET memory_read_mode=? WHERE id=?")
          .run("all", h.conversationId),
      ).toThrow();
      expect(() =>
        db
          .query("UPDATE conversations SET memory_config_revision=0 WHERE id=?")
          .run(h.conversationId),
      ).toThrow();
      expect(() =>
        db.query("UPDATE memory_entries SET visibility='all' WHERE id=?").run(h.memoryId),
      ).toThrow();
      expect(() =>
        db.query("UPDATE memory_entries SET visibility_revision=0 WHERE id=?").run(h.memoryId),
      ).toThrow();
      expect(() =>
        db.query("UPDATE memory_entries SET fold_version=0 WHERE id=?").run(h.memoryId),
      ).toThrow();
      expect(
        db
          .query(
            "UPDATE conversations SET memory_read_mode='agent_shared',memory_config_revision=memory_config_revision+1 WHERE id=? AND memory_config_revision=?",
          )
          .run(h.conversationId, 1).changes,
      ).toBe(1);
      expect(
        db
          .query(
            "UPDATE conversations SET memory_read_mode='current_conversation',memory_config_revision=memory_config_revision+1 WHERE id=? AND memory_config_revision=?",
          )
          .run(h.conversationId, 1).changes,
      ).toBe(0);
      for (const value of ["session_private", "agent_shared", "public"]) {
        expect(
          db.query("UPDATE memory_entries SET visibility=? WHERE id=?").run(value, h.memoryId)
            .changes,
        ).toBe(1);
      }
    } finally {
      h.business.close();
    }
  });

  it("enforces explicit recipient foreign keys, unique pairs and nonempty tokens", () => {
    const h = fixture();
    try {
      const db = h.business.db;
      db.query("INSERT INTO memory_read_grants(memory_id,agent_id,token) VALUES(?,?,?)").run(
        h.memoryId,
        DEFAULT_AGENT_ID,
        "token-1",
      );
      expect(() =>
        db
          .query("INSERT INTO memory_read_grants(memory_id,agent_id,token) VALUES(?,?,?)")
          .run(h.memoryId, DEFAULT_AGENT_ID, "token-2"),
      ).toThrow();
      expect(() =>
        db
          .query("INSERT INTO memory_read_grants(memory_id,agent_id,token) VALUES(?,?,?)")
          .run(h.memoryId, "missing-agent", "token"),
      ).toThrow();
      expect(() =>
        db
          .query("INSERT INTO memory_read_grants(memory_id,agent_id,token) VALUES(?,?,?)")
          .run("missing-memory", DEFAULT_AGENT_ID, "token"),
      ).toThrow();
      db.query("DELETE FROM memory_read_grants WHERE memory_id=? AND agent_id=?").run(
        h.memoryId,
        DEFAULT_AGENT_ID,
      );
      expect(() =>
        db
          .query("INSERT INTO memory_read_grants(memory_id,agent_id,token) VALUES(?,?,?)")
          .run(h.memoryId, DEFAULT_AGENT_ID, ""),
      ).toThrow();
      const indexes = db.query("PRAGMA index_list(memory_read_grants)").all() as Array<{
        name: string;
      }>;
      expect(
        indexes.some((index) => {
          const fields = db.query(`PRAGMA index_info(${index.name})`).all() as Array<{
            name: string;
          }>;
          return fields[0]?.name === "agent_id" && fields[1]?.name === "memory_id";
        }),
      ).toBe(true);
    } finally {
      h.business.close();
    }
  });
});
