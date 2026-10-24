import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BusinessMigrationSql, openBusinessDb } from "../../src/server/db/schema-gate";
import { loadStartupLayout } from "../../src/server/startup-layout";

const versionsDir = path.join(import.meta.dir, "../../migrations/versions");

// Test-owned complete ordered business-migration inventory. Deliberately not
// derived from any production list (such as schema-gate's
// BUSINESS_MIGRATION_FILES), so the checks below can catch a missing or extra
// production migration resource independently of the list under test.
const BUSINESS_MIGRATION_FILE_NAMES = [
  "0001_initial.sql",
  "0002_knowledge.sql",
  "0003_knowledge_read.sql",
  "0004_organization.sql",
  "0005_qq_transport.sql",
  "0006_qq_memory_sources.sql",
  "0007_qq_observation_text.sql",
  "0008_qq_memory_batch.sql",
  "0009_qq_transport_config.sql",
  "0010_qq_schemes.sql",
  "0011_qq_speech_log.sql",
  "0012_qq_media_notes.sql",
  "0013_qq_scheme_triggers.sql",
  "0014_qq_send_log.sql",
  "0015_qq_scheme_rhythm.sql",
  "0016_qq_context_budget.sql",
  "0017_qq_scheme_prompts.sql",
  "0018_qq_members.sql",
  "0019_qq_output_reserve.sql",
  "0020_qq_scheme_stickers.sql",
  "0021_qq_stickers.sql",
  "0022_qq_sticker_authorization.sql",
  "0023_qq_dispatch.sql",
  "0024_qq_media_purposes.sql",
  "0025_desktop_settings.sql",
  "0026_qq_media_supplement.sql",
  "0027_qq_event_addressed.sql",
  "0028_qq_immediate_lease.sql",
  "0029_qq_module_switches.sql",
  "0030_qq_sweep_verdicts.sql",
  "0031_qq_attention.sql",
  "0032_model_providers.sql",
  "0033_qq_idle_judgements.sql",
  "0034_qq_initiative_min_score.sql",
  "0035_qq_reply_split.sql",
  "0036_qq_judgement_reuse.sql",
  "0037_qq_judgement_per_speaker.sql",
  "0038_qq_judgement_model.sql",
  "0039_agent_runs.sql",
  "0040_conversation_wakes.sql",
  "0041_outbound_intents.sql",
  "0042_runtime_observability.sql",
  "0043_protected_model_results.sql",
  "0044_conversation_avatars.sql",
  "0045_qq_conversation_summaries.sql",
  "0046_qq_context_compression.sql",
  "0047_qq_context_limit_caps.sql",
  "0048_agent_tasks.sql",
  "0049_qq_output_reserve_caps.sql",
  "0050_qq_retention_days.sql",
  "0051_qq_group_agent_config.sql",
  "0052_qq_message_multimodal.sql",
  "0053_qq_group_names.sql",
  "0054_qq_initiative_batches.sql",
  "0055_qq_initiative_time_window.sql",
  "0056_outbound_stale_reason.sql",
  "0057_history_output_identity_indexes.sql",
  "0058_qq_conversation_tasks.sql",
  "0059_qq_task_limits_antispam.sql",
  "0060_qq_task_execution_snapshot.sql",
  "0061_qq_task_ready_at.sql",
  "0062_qq_media_spec_unification.sql",
  "0063_qq_media_request_identity.sql",
  "0064_qq_scheme_sticker_frequency.sql",
  "0065_qq_antispam_thresholds.sql",
  "0066_jsonb_context_source_matchers.sql",
  "0067_qq_participation_timing.sql",
  "0068_context_allocation.sql",
  "0069_query_plan_indexes.sql",
  "0070_context_source_lookup.sql",
  "0071_context_storage_metadata.sql",
  "0072_outbound_intent_metadata.sql",
];

const resources = BUSINESS_MIGRATION_FILE_NAMES.map((name) =>
  readFileSync(path.join(versionsDir, name), "utf8"),
) as unknown as BusinessMigrationSql;
const testTmpdir = realpathSync(tmpdir());
describe("explicit migration resources", () => {
  it("validates supplied SQL before creating a file-backed database", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-resource-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      for (const migrationSql of ["", "this is not SQL"]) {
        const invalid: [...BusinessMigrationSql] = [...resources];
        invalid[1] = migrationSql;
        expect(() =>
          openBusinessDb({
            path: filename,
            migrationSql: invalid,
          }),
        ).toThrow();
        expect(existsSync(filename)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not reuse a reference schema belonging to a different SQL resource", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-reference-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      openBusinessDb({ path: filename, migrationSql: resources }).close();
      const tampered: [...BusinessMigrationSql] = [...resources];
      tampered[1] = `${tampered[1]}\nCREATE TABLE extra_resource(id INTEGER);`;
      expect(() =>
        openBusinessDb({
          path: filename,
          migrationSql: tampered,
        }),
      ).toThrow("REJECT_UNKNOWN_STRUCTURE");
      const reopened = openBusinessDb({ path: filename, migrationSql: resources });
      expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 72 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects incomplete installed resources without creating userdata", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-missing-resources-"));
    try {
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("accepts a packaged layout that carries no R1 probe migration", () => {
    // The release package intentionally ships the business DDL only. Loading such a
    // layout must succeed, and it must not expose a probe resource of any kind.
    const dir = mkdtempSync(path.join(testTmpdir, "ss-packaged-layout-"));
    try {
      const versions = path.join(dir, "app/resources/migrations/versions");
      mkdirSync(versions, { recursive: true });
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
        path.join(versions, "0001_initial.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
        path.join(versions, "0002_knowledge.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
        path.join(versions, "0003_knowledge_read.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
        path.join(versions, "0004_organization.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0005_qq_transport.sql"),
        path.join(versions, "0005_qq_transport.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0006_qq_memory_sources.sql"),
        path.join(versions, "0006_qq_memory_sources.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0007_qq_observation_text.sql"),
        path.join(versions, "0007_qq_observation_text.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0008_qq_memory_batch.sql"),
        path.join(versions, "0008_qq_memory_batch.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0009_qq_transport_config.sql"),
        path.join(versions, "0009_qq_transport_config.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      for (const name of BUSINESS_MIGRATION_FILE_NAMES.slice(9)) {
        copyFileSync(path.join(versionsDir, name), path.join(versions, name));
      }
      const layout = loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: dir,
      });
      expect(layout).not.toBeNull();
      expect(layout?.businessMigrationSql.length).toBe(72);
      expect(layout?.businessMigrationSql.every((sql) => sql.trim().length > 0)).toBe(true);
      expect(layout && "probeMigrationSql" in layout).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects inherited developer database overrides in installed mode", () => {
    expect(() =>
      loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: path.resolve("synthetic-install"),
        SUPERSTRING_DB_PATH: "data/dev.sqlite",
      }),
    ).toThrow("OVERRIDE");
  });
  it("checks every packaged migration path before reading resources", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-guard-coverage-"));
    const versions = path.join(dir, "app/resources/migrations/versions");
    mkdirSync(versions, { recursive: true });
    for (const name of BUSINESS_MIGRATION_FILE_NAMES) {
      copyFileSync(path.join(versionsDir, name), path.join(versions, name));
    }
    const inspection = spyOn(fs, "lstatSync");
    try {
      const layout = loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: dir,
      });
      const calls = inspection.mock.calls.map(([filename]) => String(filename));
      const inspected = new Set(calls);
      expect(calls.filter((filename) => filename === versions)).toHaveLength(1);
      expect(layout?.businessMigrationSql.length).toBe(72);
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
      expect(inspected.has(path.join(versions, "0001_initial.sql"))).toBe(true);
      expect(
        BUSINESS_MIGRATION_FILE_NAMES.filter((name) => !inspected.has(path.join(versions, name))),
      ).toEqual([]);
    } finally {
      inspection.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects a linked migration directory before creating userdata", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-linked-resources-"));
    try {
      const migrations = path.join(dir, "app/resources/migrations");
      const target = path.join(dir, "own-migrations");
      mkdirSync(migrations, { recursive: true });
      mkdirSync(target);
      symlinkSync(target, path.join(migrations, "versions"), "junction");
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow("LAYOUT_REJECTS_LINKED_PATH");
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps the legacy entrypoint unchanged until explicit migration", () => {
    expect(loadStartupLayout({})).toBeNull();
    expect(() => loadStartupLayout({ SUPERSTRING_APP_ROOT: path.resolve("synthetic") })).toThrow(
      "INVALID_APP_MODE",
    );
  });
});
