import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUSINESS_MIGRATION_FILES,
  BUSINESS_SCHEMA_VERSION,
  ensureBusinessSchema,
} from "../../src/server/db/schema-gate";

const versions = path.join(import.meta.dir, "../../migrations/versions");
const sql = (name: string) => readFileSync(path.join(versions, name), "utf8");
const NOW = "2026-01-01T00:00:00.000000Z";

/** The ordered migration chain, read from the gate's own file list (single source of truth). */
const chain = (
  readFileSync(path.join(import.meta.dir, "../../src/server/db/schema-gate.ts"), "utf8").match(
    /^ {2}"(\d{4}_[a-z_]+\.sql)",$/gm,
  ) ?? []
).map((entry) => entry.trim().slice(1, -2));

const v62Index = BUSINESS_MIGRATION_FILES.indexOf("0062_qq_media_spec_unification.sql");

const ddl = (db: Database) =>
  db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all();

function seedScheme(db: Database, id: string, mediaInput: string | null) {
  db.query(
    "INSERT INTO qq_schemes (id, name, revision, created_at, updated_at, media_input) VALUES (?, ?, 1, ?, ?, ?)",
  ).run(id, `scheme ${id}`, NOW, NOW, mediaInput);
}

function seedGroupConfig(db: Database, id: string, schemeOverrides: string) {
  // One synthetic binding per config row: uq_qq_group_agent_config is (binding_id, agent_id).
  db.query(
    "INSERT INTO qq_group_agent_configs (id, binding_id, agent_id, scheme_overrides, disabled_capabilities, capability_revisions, revision, created_at, updated_at) VALUES (?, ?, 'a1', ?, '[]', '{}', 1, ?, ?)",
  ).run(id, `b-${id}`, schemeOverrides, NOW, NOW);
}

function buildV61(db: Database) {
  for (const name of chain.slice(0, v62Index)) db.exec(sql(name));
  db.exec("PRAGMA user_version = 61");
}

function seedValidFixture(db: Database) {
  // Historical media_input shapes from 0052: the native default group, a custom
  // expression-different scheme, a scheme without expression keys, and a NULL
  // media_input row, plus sparse group overrides.
  seedScheme(
    db,
    "s-default",
    '{"expression_frame_count":3,"expression_frame_max_dimension":512,"expression_max_dimension":512,"max_images":8,"mode":"native","ordinary_still_max_dimension":null,"stages":{"decision":true,"evaluation":true,"generation":true}}',
  );
  seedScheme(
    db,
    "s-custom",
    '{"expression_frame_count":5,"expression_frame_max_dimension":768,"expression_max_dimension":1024,"max_images":2,"mode":"description","ordinary_still_max_dimension":256,"stages":{"decision":true,"evaluation":false,"generation":true}}',
  );
  seedScheme(db, "s-clean", '{"max_images":2,"mode":"description"}');
  seedScheme(db, "s-null", null);
  seedGroupConfig(
    db,
    "g-sparse",
    '{"media_input":{"expression_max_dimension":512,"expression_frame_count":3,"expression_frame_max_dimension":512},"rhythm":{"media_supplement_window_minutes":30,"media_frame_count":4},"triggers":{"direct_reply":null,"chiming_in":false},"task_limits":{"mention":2},"message":{},"execution":{},"permissions":{}}',
  );
  seedGroupConfig(db, "g-none", '{"triggers":{"direct_reply":null,"chiming_in":false}}');
  seedGroupConfig(
    db,
    "g-supp-other",
    '{"rhythm":{"media_frame_count":4},"task_limits":{"mention":2}}',
  );
}

/**
 * Historical 61->62 proof only: apply the exact 0062 file in one transaction and pin
 * user_version 62. This deliberately bypasses the current gate, which would upgrade the
 * fixture to the current version and blur which migration produced the observed shape.
 */
function apply0062Direct(db: Database) {
  db.exec("BEGIN");
  try {
    db.exec(sql("0062_qq_media_spec_unification.sql"));
    db.exec("PRAGMA user_version = 62");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

describe("0062 retired media JSON keys (isolated exact migration; current gate proven separately)", () => {
  it("upgrades an exact v61 scheme set with the exact 0062 file: retirement keys dropped, every other value preserved", () => {
    const db = new Database(":memory:");
    try {
      buildV61(db);
      seedValidFixture(db);
      const schemesBefore = db
        .query("SELECT id, name, revision, created_at, updated_at FROM qq_schemes ORDER BY id")
        .all();
      const groupsBefore = db
        .query(
          "SELECT id, binding_id, agent_id, disabled_capabilities, capability_revisions, revision, created_at, updated_at FROM qq_group_agent_configs ORDER BY id",
        )
        .all();
      apply0062Direct(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
      // Identity and sibling columns are untouched by the JSON rewrite.
      expect(
        db
          .query("SELECT id, name, revision, created_at, updated_at FROM qq_schemes ORDER BY id")
          .all(),
      ).toEqual(schemesBefore);
      expect(
        db
          .query(
            "SELECT id, binding_id, agent_id, disabled_capabilities, capability_revisions, revision, created_at, updated_at FROM qq_group_agent_configs ORDER BY id",
          )
          .all(),
      ).toEqual(groupsBefore);
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-default'").get()).toEqual({
        media_input:
          '{"max_images":8,"mode":"native","ordinary_still_max_dimension":null,"stages":{"decision":true,"evaluation":true,"generation":true}}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-custom'").get()).toEqual({
        media_input:
          '{"max_images":2,"mode":"description","ordinary_still_max_dimension":256,"stages":{"decision":true,"evaluation":false,"generation":true}}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-clean'").get()).toEqual({
        media_input: '{"max_images":2,"mode":"description"}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-null'").get()).toEqual({
        media_input: null,
      });
      // The retired keys are gone from every surviving media_input object.
      for (const key of [
        "expression_max_dimension",
        "expression_frame_count",
        "expression_frame_max_dimension",
      ]) {
        expect(
          db
            .query(
              `SELECT count(*) AS n FROM qq_schemes WHERE json_type(media_input, '$."${key}"') IS NOT NULL`,
            )
            .get(),
        ).toEqual({ n: 0 });
      }
      // Group overrides: retired override keys removed, sparse siblings preserved verbatim.
      expect(
        db.query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-sparse'").get(),
      ).toEqual({
        scheme_overrides:
          '{"media_input":{},"rhythm":{"media_frame_count":4},"triggers":{"direct_reply":null,"chiming_in":false},"task_limits":{"mention":2},"message":{},"execution":{},"permissions":{}}',
      });
      expect(
        db.query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-none'").get(),
      ).toEqual({
        scheme_overrides: '{"triggers":{"direct_reply":null,"chiming_in":false}}',
      });
      expect(
        db
          .query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-supp-other'")
          .get(),
      ).toEqual({
        scheme_overrides: '{"rhythm":{"media_frame_count":4},"task_limits":{"mention":2}}',
      });
      // Re-applying the exact 0062 file is a no-op: json_remove only touches rows that
      // still carry a retired key, so the version pin and untouched rows hold.
      expect(() => apply0062Direct(db)).not.toThrow();
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-clean'").get()).toEqual({
        media_input: '{"max_images":2,"mode":"description"}',
      });
    } finally {
      db.close();
    }
  });

  it("leaves invalid raw JSON carriers untouched instead of aborting or coercing", () => {
    const db = new Database(":memory:");
    try {
      buildV61(db);
      seedScheme(db, "s-bad", "{}");
      seedGroupConfig(db, "g-bad-root", "{}");
      seedGroupConfig(db, "g-bad-media", "{}");
      // A v61 file written by a build that failed to validate its JSON, or corrupted on
      // disk, can hold malformed text the current column CHECK would refuse. The fixture
      // reproduces those rows by disabling CHECK enforcement for this write only; the
      // migration itself must skip them rather than abort the whole upgrade.
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.query("UPDATE qq_schemes SET media_input = ? WHERE id = 's-bad'").run(
        '{"expression_max_dimension":512,',
      );
      db.query(
        "UPDATE qq_group_agent_configs SET scheme_overrides = ? WHERE id = 'g-bad-root'",
      ).run("{not json");
      db.query(
        "UPDATE qq_group_agent_configs SET scheme_overrides = ? WHERE id = 'g-bad-media'",
      ).run('{"media_input":{"expression_max_dimension":1,');
      db.exec("PRAGMA ignore_check_constraints = OFF");
      apply0062Direct(db);
      expect(() => apply0062Direct(db)).not.toThrow();
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-bad'").get()).toEqual({
        media_input: '{"expression_max_dimension":512,',
      });
      expect(
        db.query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-bad-root'").get(),
      ).toEqual({ scheme_overrides: "{not json" });
      expect(
        db
          .query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-bad-media'")
          .get(),
      ).toEqual({ scheme_overrides: '{"media_input":{"expression_max_dimension":1,' });
    } finally {
      db.close();
    }
  });

  it("upgrades the same exact v61 scheme set through the current gate: retirement values preserved and the 0063 request_id column lands nullable", () => {
    const db = new Database(":memory:");
    try {
      buildV61(db);
      seedValidFixture(db);
      const schemesBefore = db
        .query("SELECT id, name, revision, created_at, updated_at FROM qq_schemes ORDER BY id")
        .all();
      const groupsBefore = db
        .query(
          "SELECT id, binding_id, agent_id, disabled_capabilities, capability_revisions, revision, created_at, updated_at FROM qq_group_agent_configs ORDER BY id",
        )
        .all();
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION,
      });
      // Identity and sibling columns are untouched by the JSON rewrite.
      expect(
        db
          .query("SELECT id, name, revision, created_at, updated_at FROM qq_schemes ORDER BY id")
          .all(),
      ).toEqual(schemesBefore);
      expect(
        db
          .query(
            "SELECT id, binding_id, agent_id, disabled_capabilities, capability_revisions, revision, created_at, updated_at FROM qq_group_agent_configs ORDER BY id",
          )
          .all(),
      ).toEqual(groupsBefore);
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-default'").get()).toEqual({
        media_input:
          '{"max_images":8,"mode":"native","ordinary_still_max_dimension":null,"stages":{"decision":true,"evaluation":true,"generation":true}}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-custom'").get()).toEqual({
        media_input:
          '{"max_images":2,"mode":"description","ordinary_still_max_dimension":256,"stages":{"decision":true,"evaluation":false,"generation":true}}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-clean'").get()).toEqual({
        media_input: '{"max_images":2,"mode":"description"}',
      });
      expect(db.query("SELECT media_input FROM qq_schemes WHERE id='s-null'").get()).toEqual({
        media_input: null,
      });
      // The retired keys are gone from every surviving media_input object.
      for (const key of [
        "expression_max_dimension",
        "expression_frame_count",
        "expression_frame_max_dimension",
      ]) {
        expect(
          db
            .query(
              `SELECT count(*) AS n FROM qq_schemes WHERE json_type(media_input, '$."${key}"') IS NOT NULL`,
            )
            .get(),
        ).toEqual({ n: 0 });
      }
      // Group overrides: retired override keys removed, sparse siblings preserved verbatim.
      expect(
        db.query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-sparse'").get(),
      ).toEqual({
        scheme_overrides:
          '{"media_input":{},"rhythm":{"media_frame_count":4},"triggers":{"direct_reply":null,"chiming_in":false},"task_limits":{"mention":2},"message":{},"execution":{},"permissions":{}}',
      });
      expect(
        db.query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-none'").get(),
      ).toEqual({
        scheme_overrides: '{"triggers":{"direct_reply":null,"chiming_in":false}}',
      });
      expect(
        db
          .query("SELECT scheme_overrides FROM qq_group_agent_configs WHERE id='g-supp-other'")
          .get(),
      ).toEqual({
        scheme_overrides: '{"rhythm":{"media_frame_count":4},"task_limits":{"mention":2}}',
      });
      // 0063 rides the same gate upgrade: the request identity column exists and is
      // nullable for old rows (it carries no NOT NULL marker, only a CHECK).
      expect(
        db
          .query(
            "SELECT count(*) AS n FROM pragma_table_info('qq_media_read_tasks') WHERE name = 'request_id' AND \"notnull\" = 0",
          )
          .get(),
      ).toEqual({ n: 1 });
      // Re-running the gate is a no-op.
      expect(() => ensureBusinessSchema(db)).not.toThrow();
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("pins one DDL fingerprint for every business migration: v62 equals v61 (JSON-only), v63 is the request-identity DDL", () => {
    expect(chain).toEqual([...BUSINESS_MIGRATION_FILES]);
    expect(BUSINESS_SCHEMA_VERSION).toBe(BUSINESS_MIGRATION_FILES.length);
    const v63Index = BUSINESS_MIGRATION_FILES.indexOf("0063_qq_media_request_identity.sql");
    const db = new Database(":memory:");
    try {
      const seen: string[] = [];
      for (const name of chain) {
        db.exec(sql(name));
        seen.push(
          createHash("sha256")
            .update(JSON.stringify(ddl(db)))
            .digest("hex"),
        );
      }
      // 0062 retires JSON keys only: the SQLite structure fingerprint must equal v61's.
      expect(seen[v62Index]).toBe(seen[v62Index - 1]);
      // 0063 adds a real column and rebuilds the detail partial unique: it must not be
      // relabelled as a JSON-only change, and its shape is pinned to the accepted value.
      expect(seen[v63Index]).not.toBe(seen[v63Index - 1]);
      expect(seen[v63Index]).toBe(
        "a5f5742618dab6d6c2785ec5d4475fc54d09f1f5f88e943d9cb68eb1b1b98179",
      );
      // Every fingerprint stays exactly as recorded in knowledge-schema.test.ts (62 old
      // values unchanged + the current-version entry measured live).
      const recorded = readFileSync(path.join(import.meta.dir, "knowledge-schema.test.ts"), "utf8");
      const block = recorded.slice(
        recorded.indexOf("const fingerprints = ["),
        recorded.indexOf("];", recorded.indexOf("const fingerprints = [")),
      );
      const recordedFps = (block.match(/"([0-9a-f]{64})"/g) ?? []).map((s) => s.slice(1, -1));
      expect(recordedFps).toHaveLength(BUSINESS_MIGRATION_FILES.length);
      for (let index = 0; index < BUSINESS_MIGRATION_FILES.length; index += 1) {
        expect(seen[index]).toBe(recordedFps[index]);
      }
    } finally {
      db.close();
    }
  });
});
