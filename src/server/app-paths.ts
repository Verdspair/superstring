import { existsSync } from "node:fs";
import path from "node:path";

export interface AppPathOptions {
  mode: "development" | "installed";
  /** Explicit absolute project/install root; never inferred from cwd or user profile. */
  root: string;
}

/** Pure path calculation. Does not create directories or inspect user data. */
export function resolveAppPaths(options: AppPathOptions) {
  if (options.mode !== "development" && options.mode !== "installed") {
    throw new Error("INVALID_APP_MODE");
  }
  if (!options.root || !path.isAbsolute(options.root)) {
    throw new Error("APP_ROOT_MUST_BE_ABSOLUTE");
  }
  const root = path.normalize(options.root);
  if (root === path.parse(root).root) throw new Error("APP_ROOT_CANNOT_BE_DRIVE_ROOT");
  const development = options.mode === "development";
  const privateRoot = path.join(root, development ? "local" : "userdata");
  const resourceRoot = development ? root : path.join(root, "app", "resources");
  return {
    mode: options.mode,
    root,
    privateRoot,
    dataDir: path.join(privateRoot, "data"),
    configDir: path.join(privateRoot, "config"),
    stateDir: path.join(privateRoot, "state"),
    database: path.join(privateRoot, "data", "superstring.sqlite"),
    browserStateKey: path.join(privateRoot, "state", "browser-state.key"),
    qqTransportKey: path.join(privateRoot, "state", "qq-transport.key"),
    appearance: path.join(privateRoot, "state", "desktop-appearance.json"),
    // User-imported sticker copies live in their own feature namespace rather than beside the
    // database: §10 keeps material governance independent of the media cache, and grouping by
    // feature keeps a future split of the QQ feature to one path.
    qqStickersDir: path.join(privateRoot, "qq", "stickers"),
    logsDir: path.join(development ? privateRoot : root, "logs"),
    backupsDir: path.join(development ? privateRoot : root, "backups"),
    webDir: development ? path.join(root, "dist", "web") : path.join(resourceRoot, "web"),
    businessMigration: path.join(resourceRoot, "migrations", "versions", "0001_initial.sql"),
    knowledgeMigration: path.join(resourceRoot, "migrations", "versions", "0002_knowledge.sql"),
    knowledgeReadMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0003_knowledge_read.sql",
    ),
    organizationMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0004_organization.sql",
    ),
    qqTransportMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0005_qq_transport.sql",
    ),
    qqMemorySourcesMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0006_qq_memory_sources.sql",
    ),
    qqObservationTextMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0007_qq_observation_text.sql",
    ),
    qqMemoryBatchMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0008_qq_memory_batch.sql",
    ),
    qqTransportConfigMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0009_qq_transport_config.sql",
    ),
    qqSchemesMigration: path.join(resourceRoot, "migrations", "versions", "0010_qq_schemes.sql"),
    qqSpeechLogMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0011_qq_speech_log.sql",
    ),
    qqMediaNotesMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0012_qq_media_notes.sql",
    ),
    qqSchemeTriggersMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0013_qq_scheme_triggers.sql",
    ),
    qqSendLogMigration: path.join(resourceRoot, "migrations", "versions", "0014_qq_send_log.sql"),
    qqSchemeRhythmMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0015_qq_scheme_rhythm.sql",
    ),
    qqContextBudgetMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0016_qq_context_budget.sql",
    ),
    qqSchemePromptsMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0017_qq_scheme_prompts.sql",
    ),
    qqMembersMigration: path.join(resourceRoot, "migrations", "versions", "0018_qq_members.sql"),
    qqOutputReserveMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0019_qq_output_reserve.sql",
    ),
    qqSchemeStickersMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0020_qq_scheme_stickers.sql",
    ),
    qqStickersMigration: path.join(resourceRoot, "migrations", "versions", "0021_qq_stickers.sql"),
    qqStickerAuthorizationMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0022_qq_sticker_authorization.sql",
    ),
    qqDispatchMigration: path.join(resourceRoot, "migrations", "versions", "0023_qq_dispatch.sql"),
    qqMediaPurposesMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0024_qq_media_purposes.sql",
    ),
    desktopSettingsMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0025_desktop_settings.sql",
    ),
    qqMediaSupplementMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0026_qq_media_supplement.sql",
    ),
    qqEventAddressedMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0027_qq_event_addressed.sql",
    ),
    qqImmediateLeaseMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0028_qq_immediate_lease.sql",
    ),
    qqModuleSwitchesMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0029_qq_module_switches.sql",
    ),
    qqSweepVerdictsMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0030_qq_sweep_verdicts.sql",
    ),
    qqAttentionMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0031_qq_attention.sql",
    ),
    modelProvidersMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0032_model_providers.sql",
    ),
    qqIdleJudgementsMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0033_qq_idle_judgements.sql",
    ),
    qqInitiativeMinScoreMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0034_qq_initiative_min_score.sql",
    ),
    qqReplySplitMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0035_qq_reply_split.sql",
    ),
    qqJudgementReuseMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0036_qq_judgement_reuse.sql",
    ),
    qqJudgementPerSpeakerMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0037_qq_judgement_per_speaker.sql",
    ),
    qqJudgementModelMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0038_qq_judgement_model.sql",
    ),
    agentRunsMigration: path.join(resourceRoot, "migrations", "versions", "0039_agent_runs.sql"),
    conversationWakesMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0040_conversation_wakes.sql",
    ),
    outboundIntentsMigration: path.join(
      resourceRoot,
      "migrations",
      "versions",
      "0041_outbound_intents.sql",
    ),
    // Product layouts carry the ordered business resources, never the R1 probe.
  } as const;
}

/** Read-only transition gate. Installation never probes a developer project. */
export function assertNoLegacyDevelopmentState(
  paths: ReturnType<typeof resolveAppPaths>,
  exists: (filename: string) => boolean = existsSync,
): void {
  if (paths.mode !== "development") return;
  const legacy = ["data", path.join("artifacts", "state")];
  if (legacy.some((relative) => exists(path.join(paths.root, relative)))) {
    throw new Error(
      "LEGACY_DEVELOPMENT_STATE_REQUIRES_REVIEW: migrate or explicitly resolve old data/state before enabling the new layout",
    );
  }
}
