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
    paths.webDir,
    paths.businessMigration,
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
  const businessMigrationSql = readFileSync(paths.businessMigration, "utf8");
  if (!businessMigrationSql.trim()) throw new Error("EMPTY_MIGRATION_RESOURCE");
  if (env.SUPERSTRING_SERVE_WEB === "1") readFileSync(path.join(paths.webDir, "index.html"));
  return { paths, businessMigrationSql };
}
