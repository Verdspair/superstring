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
    appearance: path.join(privateRoot, "state", "desktop-appearance.json"),
    logsDir: path.join(development ? privateRoot : root, "logs"),
    backupsDir: path.join(development ? privateRoot : root, "backups"),
    webDir: development ? path.join(root, "dist", "web") : path.join(resourceRoot, "web"),
    businessMigration: path.join(resourceRoot, "migrations", "versions", "0001_initial.sql"),
    // Product layouts carry only the business migration resource.
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
