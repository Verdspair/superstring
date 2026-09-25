import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoLegacyDevelopmentState, resolveAppPaths } from "./app-paths";

/** Opt-in during development transition. Installed entrypoints must opt in explicitly. */
export function loadStartupLayout(env: Record<string, string | undefined>) {
  const mode = env.SUPERSTRING_APP_MODE;
  if (!mode && !env.SUPERSTRING_APP_ROOT) return null;
  if (mode !== "development" && mode !== "installed") throw new Error("INVALID_APP_MODE");
  const paths = resolveAppPaths({ mode, root: env.SUPERSTRING_APP_ROOT ?? "" });
  if (env.SUPERSTRING_DB_PATH?.trim()) throw new Error("LAYOUT_REJECTS_DATABASE_OVERRIDE");
  // Reject junction/symlink escape through existing path components, including root ancestors.
  for (const target of [
    paths.root,
    paths.database,
    paths.browserStateKey,
    paths.appearance,
    paths.logsDir,
    paths.backupsDir,
    paths.qqStickersDir,
    paths.webDir,
    paths.businessMigration,
    paths.knowledgeMigration,
    paths.knowledgeReadMigration,
    paths.organizationMigration,
    paths.qqTransportMigration,
    paths.qqMemorySourcesMigration,
    paths.qqObservationTextMigration,
    paths.qqMemoryBatchMigration,
    paths.qqTransportConfigMigration,
    paths.qqSchemesMigration,
    paths.qqSpeechLogMigration,
    paths.qqMediaNotesMigration,
    paths.qqSchemeTriggersMigration,
    paths.qqSendLogMigration,
    paths.qqSchemeRhythmMigration,
    paths.qqContextBudgetMigration,
    paths.qqSchemePromptsMigration,
    paths.qqMembersMigration,
    paths.qqOutputReserveMigration,
    paths.qqStickersMigration,
  ]) {
    let current = path.parse(target).root;
    for (const component of path.relative(current, target).split(path.sep)) {
      current = path.join(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("LAYOUT_REJECTS_LINKED_PATH");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
  assertNoLegacyDevelopmentState(paths);
  // Read every required resource before callers mkdir/open any user database.
  // The business DDL is the ONLY migration a packaged layout carries: the R1 probe
  // migration is a development/verification surface with no release role, so it is
  // absent from the package and must never be a startup requirement again.
  const businessMigrationSql = [
    readFileSync(paths.businessMigration, "utf8"),
    readFileSync(paths.knowledgeMigration, "utf8"),
    readFileSync(paths.knowledgeReadMigration, "utf8"),
    readFileSync(paths.organizationMigration, "utf8"),
    readFileSync(paths.qqTransportMigration, "utf8"),
    readFileSync(paths.qqMemorySourcesMigration, "utf8"),
    readFileSync(paths.qqObservationTextMigration, "utf8"),
    readFileSync(paths.qqMemoryBatchMigration, "utf8"),
    readFileSync(paths.qqTransportConfigMigration, "utf8"),
    readFileSync(paths.qqSchemesMigration, "utf8"),
    readFileSync(paths.qqSpeechLogMigration, "utf8"),
    readFileSync(paths.qqMediaNotesMigration, "utf8"),
    readFileSync(paths.qqSchemeTriggersMigration, "utf8"),
    readFileSync(paths.qqSendLogMigration, "utf8"),
    readFileSync(paths.qqSchemeRhythmMigration, "utf8"),
    readFileSync(paths.qqContextBudgetMigration, "utf8"),
    readFileSync(paths.qqSchemePromptsMigration, "utf8"),
    readFileSync(paths.qqMembersMigration, "utf8"),
    readFileSync(paths.qqOutputReserveMigration, "utf8"),
    readFileSync(paths.qqSchemeStickersMigration, "utf8"),
    readFileSync(paths.qqStickersMigration, "utf8"),
    readFileSync(paths.qqStickerAuthorizationMigration, "utf8"),
    readFileSync(paths.qqDispatchMigration, "utf8"),
    readFileSync(paths.qqMediaPurposesMigration, "utf8"),
    readFileSync(paths.desktopSettingsMigration, "utf8"),
    readFileSync(paths.qqMediaSupplementMigration, "utf8"),
    readFileSync(paths.qqEventAddressedMigration, "utf8"),
    readFileSync(paths.qqImmediateLeaseMigration, "utf8"),
    readFileSync(paths.qqModuleSwitchesMigration, "utf8"),
    readFileSync(paths.qqSweepVerdictsMigration, "utf8"),
    readFileSync(paths.qqAttentionMigration, "utf8"),
    readFileSync(paths.modelProvidersMigration, "utf8"),
    readFileSync(paths.qqIdleJudgementsMigration, "utf8"),
    readFileSync(paths.qqInitiativeMinScoreMigration, "utf8"),
    readFileSync(paths.qqReplySplitMigration, "utf8"),
    readFileSync(paths.qqJudgementReuseMigration, "utf8"),
    readFileSync(paths.qqJudgementPerSpeakerMigration, "utf8"),
    readFileSync(paths.qqJudgementModelMigration, "utf8"),
    readFileSync(paths.agentRunsMigration, "utf8"),
    readFileSync(paths.conversationWakesMigration, "utf8"),
    readFileSync(paths.outboundIntentsMigration, "utf8"),
  ] as const;
  if (businessMigrationSql.some((sql) => !sql.trim())) throw new Error("EMPTY_MIGRATION_RESOURCE");
  if (env.SUPERSTRING_SERVE_WEB === "1") readFileSync(path.join(paths.webDir, "index.html"));
  return { paths, businessMigrationSql };
}
