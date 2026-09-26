import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { qqBindings, qqEvents, qqOwnerIdentities, qqSettings } from "../../src/server/db/schema";
import {
  BUSINESS_TABLE_NAMES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

const versions = path.join(import.meta.dir, "../../migrations/versions");
const sql = (name: string) => readFileSync(path.join(versions, name), "utf8");
const v1 = sql("0001_initial.sql");
const v2 = sql("0002_knowledge.sql");
const v3 = sql("0003_knowledge_read.sql");
const v4 = sql("0004_organization.sql");
const v5 = sql("0005_qq_transport.sql");
const v6 = sql("0006_qq_memory_sources.sql");
const v7 = sql("0007_qq_observation_text.sql");
const v8 = sql("0008_qq_memory_batch.sql");
const v9 = sql("0009_qq_transport_config.sql");
const v10 = sql("0010_qq_schemes.sql");
const v11 = sql("0011_qq_speech_log.sql");
const v12 = sql("0012_qq_media_notes.sql");
const v13 = sql("0013_qq_scheme_triggers.sql");
const v14 = sql("0014_qq_send_log.sql");
const v15 = sql("0015_qq_scheme_rhythm.sql");
const v16 = sql("0016_qq_context_budget.sql");
const v17 = sql("0017_qq_scheme_prompts.sql");
const v18 = sql("0018_qq_members.sql");
const v19 = sql("0019_qq_output_reserve.sql");
const v20 = sql("0020_qq_scheme_stickers.sql");
const v21 = sql("0021_qq_stickers.sql");
const v22 = sql("0022_qq_sticker_authorization.sql");
const v23 = sql("0023_qq_dispatch.sql");
const v24 = sql("0024_qq_media_purposes.sql");
const v25 = sql("0025_desktop_settings.sql");
const v26 = sql("0026_qq_media_supplement.sql");
const v27 = sql("0027_qq_event_addressed.sql");
const v28 = sql("0028_qq_immediate_lease.sql");
const v29 = sql("0029_qq_module_switches.sql");
const v30 = sql("0030_qq_sweep_verdicts.sql");
const v31 = sql("0031_qq_attention.sql");
const v32 = sql("0032_model_providers.sql");
const v33 = sql("0033_qq_idle_judgements.sql");
const v34 = sql("0034_qq_initiative_min_score.sql");
const v35 = sql("0035_qq_reply_split.sql");
const v36 = sql("0036_qq_judgement_reuse.sql");
const v37 = sql("0037_qq_judgement_per_speaker.sql");
const v38 = sql("0038_qq_judgement_model.sql");
const v39 = sql("0039_agent_runs.sql");
const v40 = sql("0040_conversation_wakes.sql");
const v41 = sql("0041_outbound_intents.sql");
const v42 = sql("0042_runtime_observability.sql");
const v43 = sql("0043_protected_model_results.sql");
const v44 = sql("0044_conversation_avatars.sql");
const v45 = sql("0045_qq_conversation_summaries.sql");
const v46 = sql("0046_qq_context_compression.sql");
const v47 = sql("0047_qq_context_limit_caps.sql");
const QQ_TABLES = ["qq_settings", "qq_owner_identities", "qq_bindings", "qq_events"] as const;
const NOW = "2026-01-01T00:00:00.000000Z";

function columns(db: Database, table: string) {
  return db
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => {
      const c = row as { name: string; type: string; notnull: number; pk: number };
      return { name: c.name, type: c.type.toUpperCase(), notnull: c.notnull, pk: c.pk };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
function indexes(db: Database, table: string) {
  return db
    .query(`PRAGMA index_list(${table})`)
    .all()
    .map((row) => {
      const i = row as { name: string; unique: number };
      return { name: i.name, unique: i.unique === 1 };
    })
    .filter((i) => !i.name.startsWith("sqlite_autoindex"))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function foreignKeys(db: Database, table: string) {
  return db
    .query(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row) => {
      const f = row as { table: string; from: string; to: string; on_delete: string };
      return { table: f.table, from: f.from, to: f.to, onDelete: f.on_delete };
    });
}
/** Independent field/type contract for the additive QQ transport tables. */
const GOLDEN: Record<string, Array<{ name: string; type: string; notnull: number; pk: number }>> = {
  qq_settings: [
    { name: "account_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "enabled", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "endpoint", type: "TEXT", notnull: 0, pk: 0 },
    { name: "id", type: "INTEGER", notnull: 1, pk: 1 },
    // 0038的QQ全局判断模型；可空，所以"跟随绑定助手的模型"与新行的状态一致。
    { name: "judgement_model_name", type: "TEXT", notnull: 0, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "token_ciphertext", type: "TEXT", notnull: 0, pk: 0 },
  ],
  qq_owner_identities: [
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "id", type: "INTEGER", notnull: 1, pk: 1 },
    { name: "peer_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  qq_bindings: [
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    // 0031's 「重要的人」: nullable so "no list" is the same state as a fresh binding, but note
    // that localeCompare sorts attention_members before attention_mode.
    { name: "attention_members", type: "TEXT", notnull: 0, pk: 0 },
    { name: "attention_mode", type: "TEXT", notnull: 0, pk: 0 },
    { name: "authority_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "conversation_kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "memory_batch_size", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "owner_identity_revision", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "paused", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "peer_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "scheme_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "share_web_memory", type: "INTEGER", notnull: 1, pk: 0 },
    // 0029's per-conversation module switches: nullable, so "follow the scheme" is expressible.
    // localeCompare order puts them after share_web_memory and before updated_at.
    { name: "trigger_chiming_in", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "trigger_direct_reply", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "trigger_follow_up", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "trigger_idle_topic", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  qq_events: [
    // `columns()` sorts with localeCompare, where "_" follows the letters it is compared against:
    // account_id < addressed < agent_id. The literal has to be in that order, not code-point order.
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "addressed", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "conversation_kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "event_key", type: "TEXT", notnull: 1, pk: 1 },
    { name: "message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "occurred_at_seconds", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "peer_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "speaker_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "speaker_kind", type: "TEXT", notnull: 1, pk: 0 },
  ],
};
const GOLDEN_INDEXES: Record<string, Array<{ name: string; unique: boolean }>> = {
  qq_bindings: [
    { name: "ix_qq_binding_agent", unique: false },
    { name: "uq_qq_binding_conversation", unique: true },
  ],
  qq_events: [{ name: "ix_qq_event_conversation", unique: false }],
};

function seedAgent(db: Database, id = "a1") {
  db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${id}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
}
/** Bindings now have to name a real scheme (enforced by a trigger), so seed one. */
function seedScheme(db: Database, id = "scheme-1", name = "synthetic scheme") {
  db.exec(
    `INSERT INTO qq_schemes (id, name, revision, created_at, updated_at)
      VALUES ('${id}', '${name}', 1, '${NOW}', '${NOW}')`,
  );
}

function insertBinding(db: Database, patch: Record<string, unknown> = {}) {
  const row = {
    id: "b1",
    account_id: "10001",
    conversation_kind: "group",
    peer_id: "20001",
    agent_id: "a1",
    scheme_id: "scheme-1",
    paused: 0,
    share_web_memory: 0,
    owner_identity_revision: null,
    revision: 1,
    authority_revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  } as Record<string, unknown>;
  const names = [
    "id",
    "account_id",
    "conversation_kind",
    "peer_id",
    "agent_id",
    "scheme_id",
    "paused",
    "share_web_memory",
    "owner_identity_revision",
    "revision",
    "authority_revision",
    "created_at",
    "updated_at",
  ];
  db.query(
    `INSERT INTO qq_bindings (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => row[name] as string | number | null));
}

describe("0005 QQ transport schema", () => {
  it("is additive: the four new tables and the seeded single row exist", () => {
    const h = openBusinessDb();
    try {
      const tables = h.db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(BUSINESS_TABLE_NAMES.slice().sort());
      for (const table of QQ_TABLES) expect(tables).toContain(table);
      expect(h.db.query("SELECT * FROM qq_settings").all()).toEqual([
        {
          id: 1,
          enabled: 0,
          account_id: null,
          endpoint: null,
          token_ciphertext: null,
          judgement_model_name: null,
          revision: 1,
        },
      ]);
      expect(h.db.query("SELECT * FROM qq_owner_identities").all()).toEqual([]);
      expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("matches the frozen column, index and foreign key contract", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
          v32,
          v33,
          v34,
          v35,
          v36,
          v37,
          v38,
          v39,
          v40,
          v41,
          v42,
          v43,
          v44,
          v45,
          v46,
          v47,
        ].join("\n"),
      );
      for (const [table, golden] of Object.entries(GOLDEN)) {
        expect(columns(db, table)).toEqual(golden);
        expect(indexes(db, table)).toEqual(GOLDEN_INDEXES[table] ?? []);
      }
      for (const table of ["qq_bindings", "qq_events"]) {
        expect(foreignKeys(db, table)).toEqual([
          { table: "agents", from: "agent_id", to: "id", onDelete: "CASCADE" },
        ]);
      }
    } finally {
      db.close();
    }
  });

  it("keeps drizzle definitions aligned with the SQL DDL", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
          // 0038 给 qq_settings 加了一列，所以这次比较需要它；下面三个用例只跑
          // 0038 没有触及的约束。
          v38,
          v39,
          v40,
          v41,
          v42,
          v43,
          v44,
          v45,
          v46,
          v47,
        ].join("\n"),
      );
      for (const table of [qqSettings, qqOwnerIdentities, qqBindings, qqEvents]) {
        const cfg = getTableConfig(table);
        const composite = new Set<string>();
        for (const pk of cfg.primaryKeys)
          for (const column of pk.columns) composite.add(column.name);
        const expected = cfg.columns
          .map((column) => ({
            name: column.name,
            type: column.getSQLType().toUpperCase(),
            notnull: (column.notNull ? 1 : 0) as number,
            pk: (column.primary || composite.has(column.name) ? 1 : 0) as number,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        expect(expected).toEqual(columns(db, cfg.name));
      }
    } finally {
      db.close();
    }
  });

  it("enforces the single-row and cross-field CHECK constraints", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
        ].join("\n"),
      );
      seedAgent(db);
      seedScheme(db);
      const rejects = (fn: () => unknown) => expect(fn).toThrow();
      rejects(() => db.exec("INSERT INTO qq_settings (id) VALUES (2)"));
      rejects(() => db.exec("UPDATE qq_settings SET enabled = 2"));
      rejects(() => db.exec("UPDATE qq_settings SET revision = 0"));
      rejects(() =>
        db.exec("INSERT INTO qq_owner_identities (id, account_id) VALUES (2, '10001')"),
      );
      rejects(() => insertBinding(db, { conversation_kind: "channel" }));
      rejects(() => insertBinding(db, { paused: 2 }));
      rejects(() => insertBinding(db, { share_web_memory: 2 }));
      // Sharing requires an owner revision and a private chat.
      rejects(() => insertBinding(db, { share_web_memory: 1 }));
      rejects(() => insertBinding(db, { share_web_memory: 1, owner_identity_revision: 1 }));
      // An owner revision without sharing is equally rejected.
      rejects(() => insertBinding(db, { owner_identity_revision: 1 }));
      rejects(() => insertBinding(db, { authority_revision: 2, revision: 1 }));
      rejects(() => insertBinding(db, { revision: 0 }));
      rejects(() => insertBinding(db, { agent_id: "missing" }));
      insertBinding(db, {
        conversation_kind: "private",
        share_web_memory: 1,
        owner_identity_revision: 3,
      });
      expect(db.query("SELECT conversation_kind, share_web_memory FROM qq_bindings").get()).toEqual(
        { conversation_kind: "private", share_web_memory: 1 },
      );
    } finally {
      db.close();
    }
  });

  it("de-duplicates one conversation and one event key", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
        ].join("\n"),
      );
      seedAgent(db);
      seedScheme(db);
      insertBinding(db);
      expect(() => insertBinding(db, { id: "b2" })).toThrow();
      insertBinding(db, { id: "b2", peer_id: "20002" });
      insertBinding(db, { id: "b3", conversation_kind: "private", peer_id: "20001" });
      expect(db.query("SELECT count(*) AS n FROM qq_bindings").get()).toEqual({ n: 3 });

      const event = (key: string, patch: Record<string, unknown> = {}) => {
        const row = {
          event_key: key,
          account_id: "10001",
          conversation_kind: "group",
          peer_id: "20001",
          agent_id: "a1",
          message_id: "-7",
          occurred_at_seconds: 100,
          speaker_kind: "member",
          speaker_id: "30001",
          recorded_at: NOW,
          ...patch,
        } as Record<string, unknown>;
        const names = Object.keys(row);
        db.query(
          `INSERT INTO qq_events (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        ).run(...names.map((name) => row[name] as string | number | null));
      };
      event("k1");
      expect(() => event("k1")).toThrow();
      event("k2", { speaker_kind: "anonymous", speaker_id: null });
      event("k3", { speaker_kind: "system", speaker_id: null });
      // Anonymous and system observations must not carry a stable member id.
      expect(() => event("k4", { speaker_kind: "anonymous" })).toThrow();
      expect(() => event("k5", { speaker_kind: "member", speaker_id: null })).toThrow();
      expect(() => event("k6", { occurred_at_seconds: -1 })).toThrow();
      expect(db.query("SELECT count(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  it("upgrades an exact v4 database additively, in both directions", () => {
    const old = new Database(":memory:");
    const fresh = openBusinessDb();
    try {
      old.exec([v1, v2, v3, v4].join("\n"));
      old.exec("PRAGMA user_version = 4");
      seedAgent(old);
      old.exec(
        `INSERT INTO memory_policies (agent_id, user_id) VALUES ('a1', 'u1');
         UPDATE knowledge_settings SET context_budget = 7777, revision = 7`,
      );
      // Snapshot only the pre-existing 26 tables, taken after every fixture write
      // and before the append, so the comparison isolates the migration itself. 0024 adds the two
      // media purposes to the shared settings row, so that one table's row SHAPE changes by
      // design; it is compared separately below, by value.
      const legacyNames = BUSINESS_TABLE_NAMES.slice(0, 26).filter(
        (table) => table !== "organization_settings",
      );
      const legacyTables = legacyNames.map((table) => old.query(`SELECT * FROM ${table}`).all());
      const sharedRow = old.query("SELECT model_name, revision FROM organization_settings").get();
      ensureBusinessSchema(old);
      expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 47 });
      expect(legacyNames.map((table) => old.query(`SELECT * FROM ${table}`).all())).toEqual(
        legacyTables,
      );
      // The shared row keeps the value it had, and the new purposes arrive unset.
      expect(
        old
          .query(
            "SELECT model_name, revision, vision_model_name, transcription_model_name FROM organization_settings",
          )
          .get(),
      ).toEqual({
        model_name: (sharedRow as { model_name: string | null }).model_name,
        revision: (sharedRow as { revision: number }).revision,
        vision_model_name: null,
        transcription_model_name: null,
      });
      // A v4 upgrade must not reseed or rewrite an existing library setting.
      expect(old.query("SELECT context_budget, revision FROM knowledge_settings").get()).toEqual({
        context_budget: 7777,
        revision: 7,
      });
      expect(old.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // Fresh and upgraded databases are byte-identical in structure.
      const ddl = (db: Database) =>
        db
          .query(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
          )
          .all();
      expect(ddl(old)).toEqual(ddl(fresh.db));
      // Re-opening an already-migrated database is a no-op.
      expect(() => ensureBusinessSchema(old)).not.toThrow();
      expect(old.query("SELECT count(*) AS n FROM qq_settings").get()).toEqual({ n: 1 });
    } finally {
      old.close();
      fresh.close();
    }
  });

  it("rolls back the whole QQ migration when the append fails on existing data", () => {
    const db = new Database(":memory:");
    try {
      db.exec([v1, v2, v3, v4].join("\n"));
      db.exec("PRAGMA user_version = 4");
      seedAgent(db);
      const before = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      const failure = `${v22}\nCREATE TABLE failure_guard (n INTEGER CHECK (n = 0)); INSERT INTO failure_guard SELECT count(*) FROM agents;`;
      expect(() =>
        ensureBusinessSchema(db, [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          failure,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
          v32,
          v33,
          v34,
          v35,
          v36,
          v37,
          v38,
          v39,
          v40,
          v41,
          v42,
          v43,
          v44,
          v45,
          v46,
          v47,
        ]),
      ).toThrow();
      expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(
        before,
      );
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(db.query("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 1 });
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 47 });
      expect(db.query("SELECT count(*) AS n FROM qq_settings").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("cascades bindings and events when their assistant is deleted", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        [
          v1,
          v2,
          v3,
          v4,
          v5,
          v6,
          v7,
          v8,
          v9,
          v10,
          v11,
          v12,
          v13,
          v14,
          v15,
          v16,
          v17,
          v18,
          v19,
          v20,
          v21,
          v22,
          v23,
          v24,
          v25,
          v26,
          v27,
          v28,
          v29,
          v30,
          v31,
        ].join("\n"),
      );
      seedAgent(db);
      seedScheme(db);
      insertBinding(db);
      db.query(
        `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
          message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
         VALUES ('k1', '10001', 'group', '20001', 'a1', '1', 10, 'member', '30001', ?)`,
      ).run(NOW);
      db.exec("DELETE FROM agents WHERE id = 'a1'");
      expect(db.query("SELECT count(*) AS n FROM qq_bindings").get()).toEqual({ n: 0 });
      expect(db.query("SELECT count(*) AS n FROM qq_events").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
