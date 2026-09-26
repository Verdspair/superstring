import { describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { loadStartupLayout } from "../../src/server/startup-layout";

const sql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);
const knowledgeSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
  "utf8",
);
const readSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
  "utf8",
);
const organizationSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
  "utf8",
);
const qqTransportSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0005_qq_transport.sql"),
  "utf8",
);
const qqMemorySourcesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0006_qq_memory_sources.sql"),
  "utf8",
);
const qqObservationTextSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0007_qq_observation_text.sql"),
  "utf8",
);
const qqMemoryBatchSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0008_qq_memory_batch.sql"),
  "utf8",
);
const qqTransportConfigSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0009_qq_transport_config.sql"),
  "utf8",
);
const qqSchemesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0010_qq_schemes.sql"),
  "utf8",
);
const qqSpeechLogSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0011_qq_speech_log.sql"),
  "utf8",
);
const qqMediaNotesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0012_qq_media_notes.sql"),
  "utf8",
);
const qqSchemeTriggersSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0013_qq_scheme_triggers.sql"),
  "utf8",
);
const qqSendLogSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0014_qq_send_log.sql"),
  "utf8",
);
const qqSchemeRhythmSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0015_qq_scheme_rhythm.sql"),
  "utf8",
);
const qqContextBudgetSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0016_qq_context_budget.sql"),
  "utf8",
);
const qqSchemePromptsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0017_qq_scheme_prompts.sql"),
  "utf8",
);
const qqMembersSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0018_qq_members.sql"),
  "utf8",
);
const qqOutputReserveSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0019_qq_output_reserve.sql"),
  "utf8",
);
const qqSchemeStickersSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0020_qq_scheme_stickers.sql"),
  "utf8",
);
const qqStickersSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0021_qq_stickers.sql"),
  "utf8",
);
const qqDispatchSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0023_qq_dispatch.sql"),
  "utf8",
);
const qqMediaPurposesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0024_qq_media_purposes.sql"),
  "utf8",
);
const desktopSettingsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0025_desktop_settings.sql"),
  "utf8",
);
const qqMediaSupplementSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0026_qq_media_supplement.sql"),
  "utf8",
);
const qqEventAddressedSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0027_qq_event_addressed.sql"),
  "utf8",
);
const qqImmediateLeaseSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0028_qq_immediate_lease.sql"),
  "utf8",
);
const qqModuleSwitchesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0029_qq_module_switches.sql"),
  "utf8",
);
const qqSweepVerdictsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0030_qq_sweep_verdicts.sql"),
  "utf8",
);
const qqAttentionSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0031_qq_attention.sql"),
  "utf8",
);
const modelProvidersSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0032_model_providers.sql"),
  "utf8",
);
const qqIdleJudgementsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0033_qq_idle_judgements.sql"),
  "utf8",
);
const qqInitiativeMinScoreSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0034_qq_initiative_min_score.sql"),
  "utf8",
);
const qqReplySplitSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0035_qq_reply_split.sql"),
  "utf8",
);
const qqJudgementReuseSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0036_qq_judgement_reuse.sql"),
  "utf8",
);
const qqJudgementPerSpeakerSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0037_qq_judgement_per_speaker.sql"),
  "utf8",
);
const qqJudgementModelSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0038_qq_judgement_model.sql"),
  "utf8",
);
const agentRunsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0039_agent_runs.sql"),
  "utf8",
);
const conversationWakesSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0040_conversation_wakes.sql"),
  "utf8",
);
const outboundIntentsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0041_outbound_intents.sql"),
  "utf8",
);
const runtimeObservabilitySql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0042_runtime_observability.sql"),
  "utf8",
);
const protectedModelResultsSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0043_protected_model_results.sql"),
  "utf8",
);
const qqStickerAuthorizationSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0022_qq_sticker_authorization.sql"),
  "utf8",
);
const resources = [
  sql,
  knowledgeSql,
  readSql,
  organizationSql,
  qqTransportSql,
  qqMemorySourcesSql,
  qqObservationTextSql,
  qqMemoryBatchSql,
  qqTransportConfigSql,
  qqSchemesSql,
  qqSpeechLogSql,
  qqMediaNotesSql,
  qqSchemeTriggersSql,
  qqSendLogSql,
  qqSchemeRhythmSql,
  qqContextBudgetSql,
  qqSchemePromptsSql,
  qqMembersSql,
  qqOutputReserveSql,
  qqSchemeStickersSql,
  qqStickersSql,
  qqStickerAuthorizationSql,
  qqDispatchSql,
  qqMediaPurposesSql,
  desktopSettingsSql,
  qqMediaSupplementSql,
  qqEventAddressedSql,
  qqImmediateLeaseSql,
  qqModuleSwitchesSql,
  qqSweepVerdictsSql,
  qqAttentionSql,
  modelProvidersSql,
  qqIdleJudgementsSql,
  qqInitiativeMinScoreSql,
  qqReplySplitSql,
  qqJudgementReuseSql,
  qqJudgementPerSpeakerSql,
  qqJudgementModelSql,
  agentRunsSql,
  conversationWakesSql,
  outboundIntentsSql,
  runtimeObservabilitySql,
  protectedModelResultsSql,
] as const;
const testTmpdir = realpathSync(tmpdir());
describe("explicit migration resources", () => {
  it("validates supplied SQL before creating a file-backed database", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-resource-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      for (const migrationSql of ["", "this is not SQL"]) {
        expect(() =>
          openBusinessDb({
            path: filename,
            migrationSql: [
              sql,
              migrationSql,
              readSql,
              organizationSql,
              qqTransportSql,
              qqMemorySourcesSql,
              qqObservationTextSql,
              qqMemoryBatchSql,
              qqTransportConfigSql,
              qqSchemesSql,
              qqSpeechLogSql,
              qqMediaNotesSql,
              qqSchemeTriggersSql,
              qqSendLogSql,
              qqSchemeRhythmSql,
              qqContextBudgetSql,
              qqSchemePromptsSql,
              qqMembersSql,
              qqOutputReserveSql,
              qqSchemeStickersSql,
              qqStickersSql,
              qqStickerAuthorizationSql,
              qqDispatchSql,
              qqMediaPurposesSql,
              desktopSettingsSql,
              qqMediaSupplementSql,
              qqEventAddressedSql,
              qqImmediateLeaseSql,
              qqModuleSwitchesSql,
              qqSweepVerdictsSql,
              qqAttentionSql,
              modelProvidersSql,
              qqIdleJudgementsSql,
              qqInitiativeMinScoreSql,
              qqReplySplitSql,
              qqJudgementReuseSql,
              qqJudgementPerSpeakerSql,
              qqJudgementModelSql,
              agentRunsSql,
              conversationWakesSql,
              outboundIntentsSql,
              runtimeObservabilitySql,
              protectedModelResultsSql,
            ],
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
      expect(() =>
        openBusinessDb({
          path: filename,
          migrationSql: [
            sql,
            `${knowledgeSql}\nCREATE TABLE extra_resource(id INTEGER);`,
            readSql,
            organizationSql,
            qqTransportSql,
            qqMemorySourcesSql,
            qqObservationTextSql,
            qqMemoryBatchSql,
            qqTransportConfigSql,
            qqSchemesSql,
            qqSpeechLogSql,
            qqMediaNotesSql,
            qqSchemeTriggersSql,
            qqSendLogSql,
            qqSchemeRhythmSql,
            qqContextBudgetSql,
            qqSchemePromptsSql,
            qqMembersSql,
            qqOutputReserveSql,
            qqSchemeStickersSql,
            qqStickersSql,
            qqStickerAuthorizationSql,
            qqDispatchSql,
            qqMediaPurposesSql,
            desktopSettingsSql,
            qqMediaSupplementSql,
            qqEventAddressedSql,
            qqImmediateLeaseSql,
            qqModuleSwitchesSql,
            qqSweepVerdictsSql,
            qqAttentionSql,
            modelProvidersSql,
            qqIdleJudgementsSql,
            qqInitiativeMinScoreSql,
            qqReplySplitSql,
            qqJudgementReuseSql,
            qqJudgementPerSpeakerSql,
            qqJudgementModelSql,
            agentRunsSql,
            conversationWakesSql,
            outboundIntentsSql,
            runtimeObservabilitySql,
            protectedModelResultsSql,
          ],
        }),
      ).toThrow("REJECT_UNKNOWN_STRUCTURE");
      const reopened = openBusinessDb({ path: filename, migrationSql: resources });
      expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
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
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0010_qq_schemes.sql"),
        path.join(versions, "0010_qq_schemes.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0011_qq_speech_log.sql"),
        path.join(versions, "0011_qq_speech_log.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0012_qq_media_notes.sql"),
        path.join(versions, "0012_qq_media_notes.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0013_qq_scheme_triggers.sql"),
        path.join(versions, "0013_qq_scheme_triggers.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0014_qq_send_log.sql"),
        path.join(versions, "0014_qq_send_log.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0015_qq_scheme_rhythm.sql"),
        path.join(versions, "0015_qq_scheme_rhythm.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0016_qq_context_budget.sql"),
        path.join(versions, "0016_qq_context_budget.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0017_qq_scheme_prompts.sql"),
        path.join(versions, "0017_qq_scheme_prompts.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0018_qq_members.sql"),
        path.join(versions, "0018_qq_members.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0019_qq_output_reserve.sql"),
        path.join(versions, "0019_qq_output_reserve.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0020_qq_scheme_stickers.sql"),
        path.join(versions, "0020_qq_scheme_stickers.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0021_qq_stickers.sql"),
        path.join(versions, "0021_qq_stickers.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0022_qq_sticker_authorization.sql"),
        path.join(versions, "0022_qq_sticker_authorization.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0023_qq_dispatch.sql"),
        path.join(versions, "0023_qq_dispatch.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0024_qq_media_purposes.sql"),
        path.join(versions, "0024_qq_media_purposes.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0025_desktop_settings.sql"),
        path.join(versions, "0025_desktop_settings.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0026_qq_media_supplement.sql"),
        path.join(versions, "0026_qq_media_supplement.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0027_qq_event_addressed.sql"),
        path.join(versions, "0027_qq_event_addressed.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0028_qq_immediate_lease.sql"),
        path.join(versions, "0028_qq_immediate_lease.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0029_qq_module_switches.sql"),
        path.join(versions, "0029_qq_module_switches.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0030_qq_sweep_verdicts.sql"),
        path.join(versions, "0030_qq_sweep_verdicts.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0031_qq_attention.sql"),
        path.join(versions, "0031_qq_attention.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0032_model_providers.sql"),
        path.join(versions, "0032_model_providers.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0033_qq_idle_judgements.sql"),
        path.join(versions, "0033_qq_idle_judgements.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0034_qq_initiative_min_score.sql"),
        path.join(versions, "0034_qq_initiative_min_score.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0035_qq_reply_split.sql"),
        path.join(versions, "0035_qq_reply_split.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0036_qq_judgement_reuse.sql"),
        path.join(versions, "0036_qq_judgement_reuse.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0037_qq_judgement_per_speaker.sql"),
        path.join(versions, "0037_qq_judgement_per_speaker.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0038_qq_judgement_model.sql"),
        path.join(versions, "0038_qq_judgement_model.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0039_agent_runs.sql"),
        path.join(versions, "0039_agent_runs.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0040_conversation_wakes.sql"),
        path.join(versions, "0040_conversation_wakes.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0041_outbound_intents.sql"),
        path.join(versions, "0041_outbound_intents.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0042_runtime_observability.sql"),
        path.join(versions, "0042_runtime_observability.sql"),
      );
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0043_protected_model_results.sql"),
        path.join(versions, "0043_protected_model_results.sql"),
      );
      const layout = loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: dir,
      });
      expect(layout).not.toBeNull();
      expect(layout?.businessMigrationSql.length).toBe(43);
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
  it("keeps the legacy entrypoint unchanged until explicit migration", () => {
    expect(loadStartupLayout({})).toBeNull();
    expect(() => loadStartupLayout({ SUPERSTRING_APP_ROOT: path.resolve("synthetic") })).toThrow(
      "INVALID_APP_MODE",
    );
  });
});
