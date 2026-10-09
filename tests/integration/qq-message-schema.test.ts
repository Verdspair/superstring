// 0052 schema tests: QQ message facts, conversation relations and the image
// dual-mode persistence (plan T02).
//
// Coverage:
//  - the expiring fact tables exist beside the permanent qq_events dedup identity
//  - the golden column contract for every table/column 0052 adds or appends
//  - foreign keys really fire (PRAGMA foreign_keys = ON): missing parents rejected
//  - strict JSON shapes: malformed parts / settings rejected by CHECK
//  - duplicate identities rejected; media assets dedupe per scope + content hash
//  - the 51→52 upgrade preserves legacy evidence: old scheme switches untouched,
//    old member nickname stays a `legacy` fact, old media notes import as legacy
//    read tasks with model/expiry/attempts intact (failures are not zeroed)
//  - an unknown future version (current + 1) is still rejected

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUSINESS_MIGRATION_FILES,
  BUSINESS_SCHEMA_VERSION,
  ensureBusinessSchema,
} from "../../src/server/db/schema-gate";
import { cloneBusinessDb } from "../harness/business-db";

const NOW = "2026-01-01T00:00:00.000000Z";
const EXPIRES = "2026-01-15T00:00:00.000000Z";
const VERSIONS_DIR = path.join(import.meta.dir, "../../migrations/versions");

function seedAgent(db: Database, id = "a1") {
  db.exec(`INSERT INTO users VALUES ('u1', 'synthetic', '${NOW}')`);
  db.exec(`INSERT INTO agents (id, name, system_prompt, description, additional_instructions,
      p5_config, model_name, memory_consolidation_prompt,
      memory_consolidation_additional_instructions, memory_retrieval_prompt, updated_at, created_at)
    VALUES ('${id}', 'synthetic', '', '', '', '{}', 'fake', '', '', '', '${NOW}', '${NOW}')`);
}

function seedEvent(db: Database, key = "k1", agentId = "a1") {
  db.query(
    `INSERT INTO qq_events (event_key, account_id, conversation_kind, peer_id, agent_id,
      message_id, occurred_at_seconds, speaker_kind, speaker_id, recorded_at)
     VALUES (?, '10001', 'group', '20001', ?, '-1', 10, 'member', '30001', ?)`,
  ).run(key, agentId, NOW);
}

describe("0052 message facts and media persistence", () => {
  it("separate expiring facts from permanent identity", () => {
    const h = cloneBusinessDb();
    try {
      const fields = h.db.query("PRAGMA table_info(qq_message_facts)").all() as { name: string }[];
      expect(fields.map((f) => f.name)).toContain("group_card");
      expect(fields.map((f) => f.name)).toContain("group_card_source");
      expect(fields.map((f) => f.name)).toContain("personal_nickname");
      expect(fields.map((f) => f.name)).toContain("personal_nickname_source");
      expect(fields.map((f) => f.name)).toContain("expires_at");
      expect(
        h.db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_media_read_tasks'")
          .get(),
      ).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the golden column contract for the new tables and appended columns", () => {
    const h = cloneBusinessDb();
    try {
      const columns = (table: string) =>
        (h.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      // Appended member columns sit at the end (SQLite can only append a column).
      expect(columns("qq_members").slice(-3)).toEqual([
        "group_card",
        "personal_nickname",
        "name_state",
      ]);
      // Appended scheme groups sit at the end, after 0049's reserve columns;
      // 0054 appends the three initiative-batch rhythm columns and 0055 the three
      // time-window columns after them.
      expect(columns("qq_schemes").slice(-8)).toEqual([
        "message_settings",
        "media_input",
        "initiative_batch_target_count",
        "initiative_batch_jitter_count",
        "initiative_queue_on_busy",
        "initiative_time_window_enabled",
        "initiative_time_target_seconds",
        "initiative_time_jitter_seconds",
      ]);
      expect(columns("qq_message_facts")).toEqual([
        "event_key",
        "group_card",
        "group_card_source",
        "personal_nickname",
        "personal_nickname_source",
        "legacy_display_name",
        "name_state",
        "parts",
        "reply_to_message_id",
        "revision",
        "expires_at",
        "recorded_at",
      ]);
      expect(columns("qq_outbound_message_facts")).toEqual([
        "intent_id",
        "account_id",
        "agent_id",
        "group_card",
        "personal_nickname",
        "legacy_display_name",
        "parts",
        "revision",
        "expires_at",
      ]);
      expect(columns("qq_media_assets")).toEqual([
        "id",
        "account_id",
        "conversation_kind",
        "peer_id",
        "agent_id",
        "content_sha256",
        "bytes",
        "mime_type",
        "width",
        "height",
        "revision",
        "expires_at",
        "recorded_at",
      ]);
      expect(columns("qq_media_asset_sources")).toEqual([
        "id",
        "asset_id",
        "media_note_id",
        "expires_at",
        "recorded_at",
      ]);
      expect(columns("qq_media_variants")).toEqual([
        "id",
        "asset_id",
        "policy",
        "bytes",
        "mime_type",
        "width",
        "height",
        "frame_count",
        "frames",
        "recorded_at",
      ]);
      expect(columns("qq_media_classifications")).toEqual([
        "id",
        "asset_id",
        "category",
        "evidence",
        "model_name",
        "policy",
        "recorded_at",
      ]);
      expect(columns("qq_media_read_tasks")).toEqual([
        "id",
        "media_note_id",
        "asset_source_id",
        "account_id",
        "conversation_kind",
        "peer_id",
        "agent_id",
        "identity_key",
        "purpose",
        "question_key",
        "model_name",
        "policy",
        "attempts",
        "status",
        "last_attempt_at",
        "note",
        "revision",
        "expires_at",
        "recorded_at",
      ]);
    } finally {
      h.close();
    }
  });

  it("enforces foreign keys, JSON shapes and duplicate identities", () => {
    const h = cloneBusinessDb();
    try {
      seedAgent(h.db);
      seedEvent(h.db);
      const rejects = (sql: string, ...params: (string | number | null)[]) =>
        expect(() => h.db.query(sql).run(...params)).toThrow();
      // A fact for an event that was never observed cannot exist.
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
         VALUES ('missing', 'known', '[]', 1, ?, ?)`,
        EXPIRES,
        NOW,
      );
      // A fact must carry JSON parts, not free text.
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
         VALUES ('k1', 'known', 'not json', 1, ?, ?)`,
        EXPIRES,
        NOW,
      );
      // ... and the permanent identity is unique.
      h.db
        .query(
          `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
           VALUES ('k1', 'known', '[]', 1, ?, ?)`,
        )
        .run(EXPIRES, NOW);
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
         VALUES ('k1', 'known', '[]', 1, ?, ?)`,
        EXPIRES,
        NOW,
      );
      // An unknown name state is not a display name.
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
         VALUES ('k2', 'invented', '[]', 1, ?, ?)`,
        EXPIRES,
        NOW,
      );
      // F4：姓名来源只接受 'wire'/'local'/NULL，不收别的值（历史未知用 NULL，不发明来源）。
      seedEvent(h.db, "k-src");
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at,
          group_card, group_card_source) VALUES ('k-src', 'known', '[]', 1, ?, ?, '某名', 'guessed')`,
        EXPIRES,
        NOW,
      );
      rejects(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at,
          personal_nickname, personal_nickname_source)
         VALUES ('k-src', 'known', '[]', 1, ?, ?, '某名', 'wire ',
          )`,
        EXPIRES,
        NOW,
      );
      // Outbound facts hang off real intents only.
      rejects(
        `INSERT INTO qq_outbound_message_facts (intent_id, account_id, agent_id, parts, revision, expires_at)
         VALUES ('no-such-intent', '10001', 'a1', '[]', 1, ?)`,
        EXPIRES,
      );
      // Scheme JSON groups are strict objects.
      rejects(
        `INSERT INTO qq_schemes (id, name, revision, created_at, updated_at, message_settings)
         VALUES ('s-bad', '坏组', 1, ?, ?, 'not json')`,
        NOW,
        NOW,
      );
      rejects(
        `INSERT INTO qq_schemes (id, name, revision, created_at, updated_at, media_input)
         VALUES ('s-bad2', '坏组', 1, ?, ?, '[1,2]')`,
        NOW,
        NOW,
      );
      // A member name state cannot be invented either.
      rejects(
        `INSERT INTO qq_members (account_id, conversation_kind, peer_id, user_id, nickname,
          first_seen_at_seconds, last_seen_at_seconds, expires_at, name_state)
         VALUES ('10001', 'group', '20001', '39999', '某人', 0, 10, ?, 'future')`,
        EXPIRES,
      );
      // Media asset parents must exist, and the read-task budget is per task.
      rejects(
        `INSERT INTO qq_media_assets (id, account_id, conversation_kind, peer_id, agent_id,
          content_sha256, bytes, mime_type, revision, expires_at, recorded_at)
         VALUES ('ma1', '10001', 'group', '20001', 'ghost', '${"a".repeat(64)}', x'00', 'image/png', 1, ?, ?)`,
        EXPIRES,
        NOW,
      );
      seedEvent(h.db, "k-m1");
      h.db
        .query(
          `INSERT INTO qq_media_assets (id, account_id, conversation_kind, peer_id, agent_id,
            content_sha256, bytes, mime_type, revision, expires_at, recorded_at)
           VALUES ('ma1', '10001', 'group', '20001', 'a1', '${"a".repeat(64)}', x'00', 'image/png', 1, ?, ?)`,
        )
        .run(EXPIRES, NOW);
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt1', 'no-such-note', 'detail', 'q', 'p1', 0, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      h.db
        .query(
          `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
            attempts, expires_at, recorded_at, updated_at)
           VALUES ('mn1', 'k-m1', 0, 'image', 'ref', 0, ?, ?, ?)`,
        )
        .run(EXPIRES, NOW, NOW);
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt1', 'mn1', 'detail', 'q', 'p1', 3, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      // A detail task always names its question; a baseline never does.
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt1', 'mn1', 'baseline', 'q', 'p1', 0, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      // A succeeded task without a note would be an unattributed reading.
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, note, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt1', 'mn1', 'detail', 'q', 'p1', 1, 'succeeded', NULL, 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      // UNIQUE 对 NULL 互异：baseline（question_key 恒 NULL）的任务身份只能靠 partial unique
      // index 兜住，否则同一个 media_note_id 可以插任意多条 baseline 行。
      const insertTask = (id: string, purpose: string, questionKey: string | null) =>
        h.db
          .query(
            `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
              attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
             VALUES (?, 'mn1', ?, ?, 'p1', 0, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
          )
          .run(id, purpose, questionKey, EXPIRES, NOW);
      insertTask("rt-base1", "baseline", null);
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt-base2', 'mn1', 'baseline', NULL, 'p1', 0, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      // detail 的身份仍是 (media_note_id, purpose, question_key)：同 key 重复被拒，不同 key 各自一行。
      insertTask("rt-d1", "detail", "q1");
      rejects(
        `INSERT INTO qq_media_read_tasks (id, media_note_id, purpose, question_key, policy,
          attempts, status, revision, expires_at, recorded_at,
          account_id, conversation_kind, peer_id, agent_id)
         VALUES ('rt-d2', 'mn1', 'detail', 'q1', 'p1', 0, 'pending', 1, ?, ?,
         '10001', 'group', '20001', 'a1')`,
        EXPIRES,
        NOW,
      );
      insertTask("rt-d3", "detail", "q2");
      expect(h.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("dedupes media assets per scope and content hash, not globally", () => {
    const h = cloneBusinessDb();
    try {
      seedAgent(h.db);
      const sha = "b".repeat(64);
      const insert = (id: string, peer: string) =>
        h.db
          .query(
            `INSERT INTO qq_media_assets (id, account_id, conversation_kind, peer_id, agent_id,
              content_sha256, bytes, mime_type, revision, expires_at, recorded_at)
             VALUES (?, '10001', 'group', ?, 'a1', ?, x'00', 'image/png', 1, ?, ?)`,
          )
          .run(id, peer, sha, EXPIRES, NOW);
      insert("ma-a", "20001");
      // Same bytes in another conversation are a separate scoped row, not a hit.
      insert("ma-b", "20002");
      // Same scope + same bytes is one cache entry.
      expect(() => insert("ma-c", "20001")).toThrow();
      expect(
        (h.db.query("SELECT count(*) AS n FROM qq_media_assets").get() as { n: number }).n,
      ).toBe(2);
    } finally {
      h.close();
    }
  });

  it("upgrades a populated v51 database without touching legacy evidence", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      // Build the exact v51 schema from the frozen migration files, then stamp it.
      for (const name of BUSINESS_MIGRATION_FILES.slice(0, 51)) {
        db.exec(readFileSync(path.join(VERSIONS_DIR, name), "utf8"));
      }
      db.exec("PRAGMA user_version = 51");
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 51 });
      seedAgent(db);
      // An old scheme with real user changes: the upgrade must not rewrite a switch.
      db.query(
        `INSERT INTO qq_schemes (id, name, revision, created_at, updated_at,
          trigger_direct_reply, trigger_idle_topic, media_frame_count)
         VALUES ('s1', '旧方案', 1, ?, ?, 1, 1, 7)`,
      ).run(NOW, NOW);
      // An old member whose single nickname is real legacy evidence.
      db.query(
        `INSERT INTO qq_members (account_id, conversation_kind, peer_id, user_id, nickname,
          first_seen_at_seconds, last_seen_at_seconds, expires_at)
         VALUES ('10001', 'group', '20001', '30001', '老名字', 0, 10, ?)`,
      ).run(EXPIRES);
      // Old media readings: one success (note + model + attempts), one failure (attempts
      // used up, no note), one untouched row (no note, no attempts).
      seedEvent(db, "k-ok");
      seedEvent(db, "k-fail");
      seedEvent(db, "k-quiet");
      db.query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          note, note_model, attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-ok', 'k-ok', 0, 'image', 'ref', '旧描述', '旧模型', 1, ?, ?, ?)`,
      ).run(EXPIRES, NOW, NOW);
      db.query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-fail', 'k-fail', 0, 'image', 'ref', 2, ?, ?, ?)`,
      ).run(EXPIRES, NOW, NOW);
      db.query(
        `INSERT INTO qq_media_notes (id, event_key, segment_index, segment_kind, source_ref,
          attempts, expires_at, recorded_at, updated_at)
         VALUES ('mn-quiet', 'k-quiet', 0, 'image', 'ref', 0, ?, ?, ?)`,
      ).run(EXPIRES, NOW, NOW);
      const before = db.query("SELECT * FROM qq_schemes").all() as Record<string, unknown>[];
      const beforeNotes = db.query("SELECT * FROM qq_media_notes").all();

      ensureBusinessSchema(db);

      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION,
      });
      // Old switches and old custom values survive byte for byte.
      const after = db.prepare("SELECT * FROM qq_schemes").all() as Record<string, unknown>[];
      for (const key of Object.keys(before[0])) {
        expect(after[0][key]).toEqual(before[0][key]);
      }
      // The new groups arrive as the approved defaults: native mode, untouched modules.
      expect(JSON.parse(after[0].media_input as string)).toMatchObject({ mode: "native" });
      expect(JSON.parse(after[0].message_settings as string)).toMatchObject({
        reply_mode: "one_then_on_demand",
        time_display: "hybrid",
      });
      // The old nickname stays one real legacy fact; no invented second name.
      expect(
        db.query("SELECT group_card, personal_nickname, name_state FROM qq_members").get(),
      ).toEqual({ group_card: null, personal_nickname: null, name_state: "legacy" });
      // F4: a fresh-52 fact row keeps unknown provenance at NULL — the upgrade invents no
      // wire/local sources, and the new CHECK accepts that (NULL is the historical value).
      seedEvent(db, "k-f4");
      db.query(
        `INSERT INTO qq_message_facts (event_key, name_state, parts, revision, expires_at, recorded_at)
         VALUES ('k-f4', 'known', '[]', 1, ?, ?)`,
      ).run(EXPIRES, NOW);
      expect(
        db
          .query(
            "SELECT group_card_source, personal_nickname_source FROM qq_message_facts WHERE event_key='k-f4'",
          )
          .get(),
      ).toEqual({ group_card_source: null, personal_nickname_source: null });
      // Legacy readings import as baseline tasks: model, window and attempts preserved,
      // failures not zeroed. The untouched row gets nothing (nothing to preserve).
      expect(
        db
          .query(
            `SELECT media_note_id, purpose, question_key, model_name, policy, attempts, status,
              note, revision, expires_at FROM qq_media_read_tasks ORDER BY media_note_id`,
          )
          .all(),
      ).toEqual([
        {
          media_note_id: "mn-fail",
          purpose: "baseline",
          question_key: null,
          model_name: null,
          policy: "legacy",
          attempts: 2,
          status: "failed",
          note: null,
          revision: 1,
          expires_at: EXPIRES,
        },
        {
          media_note_id: "mn-ok",
          purpose: "baseline",
          question_key: null,
          model_name: "旧模型",
          policy: "legacy",
          attempts: 1,
          status: "succeeded",
          note: "旧描述",
          revision: 1,
          expires_at: EXPIRES,
        },
      ]);
      expect(db.query("SELECT * FROM qq_media_notes").all()).toEqual(beforeNotes);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // Re-running the gate on the migrated database is a no-op.
      expect(() => ensureBusinessSchema(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("still rejects an unknown future version", () => {
    const h = cloneBusinessDb();
    try {
      h.db.exec("PRAGMA user_version = 57");
      expect(() => ensureBusinessSchema(h.db)).toThrow("REJECT_UNKNOWN_VERSION");
    } finally {
      h.close();
    }
  });
});
