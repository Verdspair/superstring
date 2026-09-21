import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { businessTables } from "../../src/server/db/schema";
import {
  BUSINESS_TABLE_NAMES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

const v1 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);
const v2 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
  "utf8",
);
const v3 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
  "utf8",
);
const v4 = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
  "utf8",
);
const ddl = (db: Database) =>
  db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all();

// Independent field/type contract. ? means nullable; all other fields are NOT NULL.
const golden: Record<string, string> = {
  organization_settings: "id:I model_name:T? revision:I",
  agent_knowledge_read_settings:
    "agent_id:T enabled:I context_budget:I? scope:T document_ids:T revision:I",
  knowledge_settings: "id:I auto_enabled:I model_name:T? context_budget:I revision:I",
  knowledge_categories: "id:T name:T revision:I",
  knowledge_documents:
    "id:T category_id:T name:T original_text:T import_type:T content_mode:T content_version:I revision:I created_at:T updated_at:T",
  knowledge_grants: "document_id:T agent_id:T token:T created_at:T",
  knowledge_chunks:
    "id:T document_id:T content_version:I ordinal:I start_offset:I end_offset:I body:T",
  knowledge_drafts:
    "id:T document_id:T content_version:I summary:T tags:T body:T sources:T model_name:T created_at:T",
  knowledge_jobs:
    "id:T document_id:T content_version:I settings_revision:I status:T token:T? lease_expires_at:T? error_code:T? created_at:T finished_at:T?",
  turn_knowledge_snapshots: "turn_id:T agent_id:T settings_revision:I items:T created_at:T",
};

function seedParents(db: Database) {
  db.exec(`INSERT INTO users VALUES ('u', 'synthetic', 'now');
    INSERT INTO agents (id, name, system_prompt, description, additional_instructions, p5_config, model_name, memory_consolidation_prompt, memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('a', 'synthetic', '', '', '', '{}', 'fake', '', '', '', 'now', 'now');
    INSERT INTO sessions (id, user_id, agent_id, title, client_request_id, agent_config_snapshot, created_at, updated_at)
    VALUES ('s', 'u', 'a', 'synthetic', 'r', '{}', 'now', 'now');
    INSERT INTO turns (id, session_id, client_request_id, runtime_config_snapshot, created_at)
    VALUES ('t', 's', 'r', '{}', 'now');
    INSERT INTO memory_entries (id, agent_id, user_id, name, summary, tags, kinds, body, scope, scope_key, config_snapshot, created_at)
    VALUES ('m', 'a', 'u', 'synthetic', '', '[]', '[]', '旧记忆', 'reality_user', 'u', '{}', 'now');`);
}
function document(db: Database, id = "d") {
  db.query(
    "INSERT INTO knowledge_documents (id, category_id, name, original_text, import_type, created_at, updated_at) VALUES (?, 'default', '资料', CAST(? AS TEXT), 'md', 'now', 'now')",
  ).run(id, Buffer.from("\uFEFF# 原文\r\n  中文𠮷\t42.5\n", "utf8"));
}

describe("frozen schema defaults and product initialization", () => {
  // Independent snapshots: v1 matches published v0.2.0-alpha; v2-v4 are the
  // accepted pre-ADR0016 development schemas. Do not regenerate on DDL edits.
  const fingerprints = [
    "74ee87ebedcbf813987cc7ea8685cada577968fee81df056bce11f47a37504cd",
    "4510c41acfd9d1deca2e859ffa9695c1cc959d2f16a71935cbb4320367b7004c",
    "58957fceb3959d7a3e7bab2deffed0f349314d9826f301ce4064e1b17a633de7",
    "0a3f0f3efc537fdb3af5efcd94bdfe3775fb7f8f430fb8f6c71ca906f4756677",
  ];
  for (const version of [1, 2, 3, 4]) {
    it(`opens frozen v${version}, preserves old values, and only seeds new library settings`, () => {
      const db = new Database(":memory:");
      try {
        for (const sql of [v1, v2, v3, v4].slice(0, version)) db.exec(sql);
        expect(
          createHash("sha256")
            .update(JSON.stringify(ddl(db)))
            .digest("hex"),
        ).toBe(fingerprints[version - 1]);
        db.exec(`PRAGMA user_version = ${version}`);
        seedParents(db);
        db.exec("INSERT INTO memory_policies (agent_id, user_id) VALUES ('a', 'u')");
        expect(db.query("SELECT target_chars FROM memory_policies").get()).toEqual({
          target_chars: 300,
        });
        ensureBusinessSchema(db);
        expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
        expect(db.query("SELECT target_chars FROM memory_policies").get()).toEqual({
          target_chars: 300,
        });
        expect(db.query("SELECT context_budget FROM knowledge_settings").get()).toEqual({
          context_budget: version === 1 ? 16384 : 4096,
        });
        db.exec("UPDATE knowledge_settings SET context_budget = 7777, revision = 7");
        ensureBusinessSchema(db);
        expect(db.query("SELECT context_budget, revision FROM knowledge_settings").get()).toEqual({
          context_budget: 7777,
          revision: 7,
        });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    });
  }
});

describe("knowledge schema v2 migration", () => {
  it("upgrades exact v1 without changing legacy data; fresh and upgraded DDL match", () => {
    const old = new Database(":memory:");
    const fresh = openBusinessDb();
    try {
      old.exec(v1);
      old.exec("PRAGMA user_version = 1");
      seedParents(old);
      const legacy = BUSINESS_TABLE_NAMES.slice(0, 16).map((table) =>
        old.query(`SELECT * FROM ${table}`).all(),
      );
      ensureBusinessSchema(old);
      expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(ddl(old)).toEqual(ddl(fresh.db));
      expect(
        BUSINESS_TABLE_NAMES.slice(0, 16).map((table) => old.query(`SELECT * FROM ${table}`).all()),
      ).toEqual(legacy);
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
      old.exec(
        "UPDATE knowledge_categories SET name = '用户改名'; UPDATE knowledge_settings SET auto_enabled = 0;",
      );
      ensureBusinessSchema(old);
      expect(old.query("SELECT name FROM knowledge_categories").all()).toEqual([
        { name: "用户改名" },
      ]);
      expect(old.query("SELECT auto_enabled FROM knowledge_settings").get()).toEqual({
        auto_enabled: 0,
      });
    } finally {
      old.close();
      fresh.close();
    }
  });

  it("rolls back all v2 DDL, seeds and version when an upgrade fails on existing data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(v1);
      db.exec("PRAGMA user_version = 1");
      seedParents(db);
      const before = ddl(db);
      // Valid against the empty reference, but fails on this populated v1 fixture.
      const failure = `${v2}\nCREATE TABLE failure_guard (n INTEGER CHECK (n = 0)); INSERT INTO failure_guard SELECT count(*) FROM users;`;
      expect(() => ensureBusinessSchema(db, [v1, failure, v3, v4])).toThrow();
      expect(ddl(db)).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(db.query("SELECT body FROM memory_entries").get()).toEqual({ body: "旧记忆" });
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    } finally {
      db.close();
    }
  });

  it("rejects corrupt v1 before creating any knowledge objects", () => {
    const db = new Database(":memory:");
    try {
      db.exec(v1);
      db.exec("PRAGMA user_version = 1; DROP INDEX ix_memory_owner_status;");
      const before = ddl(db);
      expect(() => ensureBusinessSchema(db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
      expect(ddl(db)).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects v2 structural tampering and future versions", () => {
    const h = openBusinessDb();
    try {
      h.db.exec("DROP INDEX ix_knowledge_grants_agent;");
      expect(() => ensureBusinessSchema(h.db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
      h.db.exec("PRAGMA user_version = 5;");
      expect(() => ensureBusinessSchema(h.db)).toThrow("REJECT_UNKNOWN_VERSION");
    } finally {
      h.close();
    }
  });

  it("seeds exactly one category and default-on settings, never grants", () => {
    const h = openBusinessDb();
    try {
      expect(h.db.query("SELECT * FROM knowledge_categories").all()).toEqual([
        { id: "default", name: "资料", revision: 1 },
      ]);
      expect(h.db.query("SELECT * FROM knowledge_settings").all()).toEqual([
        { id: 1, auto_enabled: 1, model_name: null, context_budget: 16384, revision: 1 },
      ]);
      expect(h.db.query("SELECT * FROM knowledge_grants").all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  for (const [name, spec] of Object.entries(golden)) {
    it(`${name}: independent columns plus ORM key/index/FK contract`, () => {
      const h = openBusinessDb();
      try {
        const columns = h.db.query(`PRAGMA table_info(${name})`).all() as {
          name: string;
          type: string;
          notnull: number;
        }[];
        expect(
          columns
            .map((c) => `${c.name}:${c.type === "INTEGER" ? "I" : "T"}${c.notnull ? "" : "?"}`)
            .join(" "),
        ).toBe(spec);
        const table = Object.values(businessTables).find((t) => getTableConfig(t).name === name);
        if (!table) throw new Error(`Missing ORM table ${name}`);
        const config = getTableConfig(table);
        const actualIndexes = h.db.query(`PRAGMA index_list(${name})`).all() as {
          name: string;
          unique: number;
          origin: string;
        }[];
        const expectedIndexes = [
          ...config.indexes.map((i) => ({
            name: i.config.name,
            unique: Number(i.config.unique),
            columns: i.config.columns.map((c) => ("name" in c ? c.name : "")),
          })),
          ...config.uniqueConstraints.map((i) => ({
            name: i.name,
            unique: 1,
            columns: i.columns.map((c) => c.name),
          })),
        ];
        expect(actualIndexes.filter((i) => i.origin !== "pk").length).toBe(expectedIndexes.length);
        for (const i of expectedIndexes) {
          expect(actualIndexes.some((a) => a.name === i.name && a.unique === i.unique)).toBe(true);
          const indexColumns = h.db.query(`PRAGMA index_info(${i.name})`).all() as {
            name: string;
          }[];
          expect(indexColumns.map((c) => c.name)).toEqual(i.columns);
        }
        const fks = h.db.query(`PRAGMA foreign_key_list(${name})`).all() as {
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }[];
        expect(fks.length).toBe(config.foreignKeys.length);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          expect(
            fks.some(
              (f) =>
                f.table === getTableConfig(ref.foreignTable).name &&
                f.from === ref.columns[0].name &&
                f.to === ref.foreignColumns[0].name &&
                f.on_delete.toLowerCase() === (fk.onDelete ?? "no action"),
            ),
          ).toBe(true);
        }
      } finally {
        h.close();
      }
    });
  }

  it("preserves exact original text, restricts category deletion and does not inherit grants", () => {
    const h = openBusinessDb();
    try {
      seedParents(h.db);
      document(h.db);
      h.db.exec("INSERT INTO knowledge_grants VALUES ('d', 'a', 'grant-1', 'now');");
      document(h.db, "d2");
      expect(
        h.db.query("SELECT original_text FROM knowledge_documents WHERE id = 'd'").get(),
      ).toEqual({ original_text: "\uFEFF# 原文\r\n  中文𠮷\t42.5\n" });
      expect(h.db.query("SELECT document_id FROM knowledge_grants").all()).toEqual([
        { document_id: "d" },
      ]);
      expect(() => h.db.exec("DELETE FROM knowledge_categories WHERE id = 'default'")).toThrow();
      h.db.exec(
        "INSERT INTO knowledge_categories VALUES ('other', 'Other', 1); UPDATE knowledge_documents SET category_id = 'other' WHERE id = 'd';",
      );
      expect(
        h.db.query("SELECT token FROM knowledge_grants WHERE document_id = 'd'").get(),
      ).toEqual({ token: "grant-1" });
      expect(() =>
        h.db.exec("INSERT INTO knowledge_grants VALUES ('d', 'a', 'duplicate', 'now')"),
      ).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_documents SET content_mode = 'script'")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_settings SET auto_enabled = 2")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_settings SET context_budget = 0")).toThrow();
    } finally {
      h.close();
    }
  });

  it("document deletion cascades derivatives and grants but preserves request evidence", () => {
    const h = openBusinessDb();
    try {
      seedParents(h.db);
      document(h.db);
      h.db.exec(`INSERT INTO knowledge_grants VALUES ('d', 'a', 'grant-1', 'now');
        INSERT INTO knowledge_chunks VALUES ('c', 'd', 1, 0, 0, 2, '原文');
        INSERT INTO knowledge_drafts VALUES ('draft', 'd', 1, '', '[]', '整理稿', '[]', 'fake', 'now');
        INSERT INTO knowledge_jobs (id, document_id, content_version, settings_revision, created_at) VALUES ('j', 'd', 1, 1, 'now');
        INSERT INTO turn_knowledge_snapshots VALUES ('t', 'a', 1, '[{"document_id":"d","grant_token":"grant-1"}]', 'now');`);
      expect(() => h.db.exec("UPDATE knowledge_chunks SET end_offset = start_offset")).toThrow();
      expect(() => h.db.exec("UPDATE knowledge_jobs SET status = 'partial'")).toThrow();
      h.db.exec("DELETE FROM knowledge_documents WHERE id = 'd';");
      for (const table of [
        "knowledge_grants",
        "knowledge_chunks",
        "knowledge_drafts",
        "knowledge_jobs",
      ]) {
        expect(h.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(h.db.query("SELECT * FROM turn_knowledge_snapshots").all().length).toBe(1);
      h.db.exec("DELETE FROM turns WHERE id = 't';");
      expect(h.db.query("SELECT * FROM turn_knowledge_snapshots").all()).toEqual([]);
    } finally {
      h.close();
    }
  });
});
