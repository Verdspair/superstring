// Explicit media requests keep separate identities while ordinary reads retain their uniqueness.
//
// 只测迁移与约束本身：v62 旧库（含普通行）升级后历史行逐列不动；新库上普通 detail
// 去重不变、显式 request 不同＝新行、显式身份键唯一、baseline/request 组合与空白
// request 被 CHECK 拒绝；旧元组（62 长度）迁移资源在 v62 库上必须结构拒绝。
// 夹具只走合成库。
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureBusinessSchema } from "../../src/server/db/schema-gate";

const versions = path.join(import.meta.dir, "../../migrations/versions");
const sql = (name: string) => readFileSync(path.join(versions, name), "utf8");
const NOW = "2026-01-01T00:00:00.000000Z";
const EXPIRES = "2099-01-01T00:00:00.000000Z";

/** The ordered migration chain, read from the gate's own file list (single source of truth). */
const chain = (
  readFileSync(path.join(import.meta.dir, "../../src/server/db/schema-gate.ts"), "utf8").match(
    /^ {2}"(\d{4}_[a-z_]+\.sql)",$/gm,
  ) ?? []
).map((entry) => entry.trim().slice(1, -2));

const ddl = (db: Database) =>
  db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all();

function seedCarrier(db: Database, id: string) {
  db.exec(`INSERT OR IGNORE INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  db.exec(
    `INSERT OR IGNORE INTO agents (id, name, system_prompt, description, additional_instructions, p5_config, model_name, memory_consolidation_prompt, memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
      VALUES ('a1', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`,
  );
  db.exec(
    `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id, message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
      VALUES ('ev-${id}', '10001', 'group', '20001', 'a1', 'm-${id}', 1000, 'member', '30001', '${NOW}')`,
  );
  db.exec(
    `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref, attempts, expires_at, recorded_at, updated_at)
      VALUES ('${id}', 'ev-${id}', 0, 'image', 'ref-${id}', 0, '${EXPIRES}', '${NOW}', '${NOW}')`,
  );
}

/** One ordinary (request NULL) baseline task row, exactly the 0052 legacy shape. */
/** v62-shape row (pre-0063): no request_id column exists yet at seed time. */
function seedOrdinaryTask(db: Database, id: string, overrides: Record<string, string | null> = {}) {
  const columns = {
    id,
    media_note_id: "mn1",
    identity_key: null,
    purpose: "baseline",
    question_key: null,
  };
  const merged = { ...columns, ...overrides };
  db.query(
    `INSERT INTO qq_media_read_tasks (id, media_note_id, asset_source_id, account_id, conversation_kind, peer_id, agent_id, identity_key, purpose, question_key, model_name, policy, attempts, status, last_attempt_at, note, revision, expires_at, recorded_at)
      VALUES (?, ?, NULL, '10001', 'group', '20001', 'a1', ?, ?, ?, NULL, 'legacy', 2, 'failed', NULL, NULL, 1, '${EXPIRES}', '${NOW}')`,
  ).run(merged.id, merged.media_note_id, merged.identity_key, merged.purpose, merged.question_key);
}

const INSERT_TASK = `INSERT INTO qq_media_read_tasks
  (id, media_note_id, asset_source_id, account_id, conversation_kind, peer_id, agent_id, identity_key, purpose, question_key, model_name, policy, attempts, status, last_attempt_at, note, request_id, revision, expires_at, recorded_at)
  VALUES (?, 'mn1', NULL, '10001', 'group', '20001', 'a1', ?, ?, ?, NULL, 'legacy', 0, 'pending', NULL, NULL, ?, 1, '${EXPIRES}', '${NOW}')`;

function freshCurrent(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of chain) db.exec(sql(name));
  db.exec(`PRAGMA user_version = ${chain.length}`);
  seedCarrier(db, "mn1");
  return db;
}

describe("0063 media request identity", () => {
  it("upgrades an exact v62 database with old ordinary rows: every column preserved", () => {
    const db = new Database(":memory:");
    try {
      for (const name of chain.slice(0, 62)) db.exec(sql(name));
      db.exec("PRAGMA user_version = 62");
      seedCarrier(db, "mn1");
      seedCarrier(db, "mn2");
      seedOrdinaryTask(db, "t-old-baseline");
      seedOrdinaryTask(db, "t-old-detail", {
        purpose: "detail",
        question_key: "q1",
        identity_key: "h-old-detail",
      });
      const before = db
        .query(
          "SELECT id, media_note_id, identity_key, purpose, question_key, attempts, status, note, revision, expires_at, recorded_at FROM qq_media_read_tasks ORDER BY id",
        )
        .all();
      const columnsBefore = db.query("PRAGMA table_info(qq_media_read_tasks)").all();
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 66 });
      // Physical tail column exists; every old column keeps its position and definition.
      const columnsAfter = db.query("PRAGMA table_info(qq_media_read_tasks)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      expect(columnsAfter.map((c) => c.name)).toEqual([
        ...columnsBefore.map((c) => (c as { name: string }).name),
        "request_id",
      ]);
      // Old rows are byte-equivalent in every pre-existing column (request_id reads NULL).
      expect(
        db
          .query(
            "SELECT id, media_note_id, identity_key, purpose, question_key, attempts, status, note, request_id, revision, expires_at, recorded_at FROM qq_media_read_tasks ORDER BY id",
          )
          .all(),
      ).toEqual(
        (before as Array<Record<string, unknown>>).map((row) => ({ ...row, request_id: null })),
      );
      // The narrowed detail unique index keeps its old name with the request-ordinary predicate.
      const detail = db
        .query(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_qq_media_read_task_detail'",
        )
        .get() as { sql: string };
      expect(detail.sql).toContain("(media_note_id, question_key)");
      expect(detail.sql).toContain("question_key IS NOT NULL AND request_id IS NULL");
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // Re-running the gate is a no-op.
      expect(() => ensureBusinessSchema(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("keeps old dedup semantics for ordinary rows and admits distinct explicit requests", () => {
    const db = freshCurrent();
    try {
      const st = db.prepare(INSERT_TASK);
      // Ordinary baseline + ordinary detail behave exactly as before.
      st.run("t-b1", null, "baseline", null, null);
      expect(() => st.run("t-b2", null, "baseline", null, null)).toThrow(/UNIQUE/);
      st.run("t-d1", "h1", "detail", "q", null);
      expect(() => st.run("t-d2", "h2", "detail", "q", null)).toThrow(/UNIQUE/);
      // Two explicit requests on the same carrier + question: both admitted.
      st.run("t-x1", "h3", "detail", "q", "req-a");
      st.run("t-x2", "h4", "detail", "q", "req-b");
      // The same explicit identity content (same 8-tuple hash) stays one row.
      expect(() => st.run("t-x3", "h3", "detail", "q2", "req-a")).toThrow(/UNIQUE/);
      expect(
        db
          .query(
            "SELECT id, purpose, question_key, request_id FROM qq_media_read_tasks WHERE request_id IS NOT NULL ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "t-x1", purpose: "detail", question_key: "q", request_id: "req-a" },
        { id: "t-x2", purpose: "detail", question_key: "q", request_id: "req-b" },
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects request_id on baseline rows and empty/blank request values via CHECK", () => {
    const db = freshCurrent();
    try {
      const st = db.prepare(INSERT_TASK);
      expect(() => st.run("t-br", null, "baseline", null, "req-a")).toThrow(
        /CHECK constraint failed: qq_media_read_tasks_request_id|CHECK constraint failed/,
      );
      expect(() => st.run("t-empty", "h5", "detail", "q", "")).toThrow(/CHECK constraint failed/);
      expect(() => st.run("t-blank", "h6", "detail", "q", "   ")).toThrow(
        /CHECK constraint failed/,
      );
      expect(db.query("SELECT count(*) AS n FROM qq_media_read_tasks").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("rejects a modified old 62-length migration chain with exact rollback", () => {
    const db = new Database(":memory:");
    try {
      for (const name of chain.slice(0, 62)) db.exec(sql(name));
      db.exec("PRAGMA user_version = 62");
      seedCarrier(db, "mn1");
      db.query(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, asset_source_id, account_id, conversation_kind, peer_id, agent_id, identity_key, purpose, question_key, model_name, policy, attempts, status, last_attempt_at, note, revision, expires_at, recorded_at)
          VALUES ('t-old-baseline', 'mn1', NULL, '10001', 'group', '20001', 'a1', NULL, 'baseline', NULL, NULL, 'legacy', 2, 'failed', NULL, NULL, 1, '${EXPIRES}', '${NOW}')`,
      ).run();
      const before = ddl(db);
      // Old-tuple resources: 62 entries + a tampered 63rd. The gate must reject the
      // tampered tail by structure, not accept a shorter/wrong chain.
      const failure = `${sql(chain[62])}\nCREATE TABLE failure_guard (n INTEGER CHECK (n = 0)); INSERT INTO failure_guard SELECT count(*) FROM users;`;
      expect(() =>
        ensureBusinessSchema(db, [
          ...chain.slice(0, 62).map((name) => sql(name)),
          failure,
        ] as unknown as Parameters<typeof ensureBusinessSchema>[1]),
      ).toThrow();
      expect(ddl(db)).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
      // The real 66-length chain upgrades the same database cleanly.
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 66 });
      expect(
        db.query("SELECT request_id FROM qq_media_read_tasks WHERE id='t-old-baseline'").get(),
      ).toEqual({ request_id: null });
    } finally {
      db.close();
    }
  });
});
