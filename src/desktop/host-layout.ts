import path from "node:path";

export type HostMode = "development-legacy" | "managed-profile" | "installed";

/**
 * Explicit launch shape for the backend process the Electron host owns. It is computed
 * from absolute roots the caller already holds: this module never probes the filesystem,
 * so existence and canonical-form checks stay with the process that touches real data.
 */
export interface HostLayout {
  mode: HostMode;
  profileRoot: string;
  /** Development only: the checkout whose existing local/ and artifacts/state stay put. */
  projectRoot?: string;
  executable: string;
  args: string[];
  cwd: string;
  resourceRoot: string;
  /** Installed only: the business root the backend receives as SUPERSTRING_APP_ROOT. */
  appRoot?: string;
  /** Installed only: the APP_MODE the backend receives; other modes inject their own. */
  envMode?: "installed";
}

export interface DevelopmentHostLayoutInput {
  mode: "development-legacy";
  projectRoot: string;
  /** Host preferences only; defaults under the development state directory. */
  profileRoot?: string;
  /** Overrides the project's installed Bun. Never resolved from PATH. */
  bunExecutable?: string;
}

export interface ManagedHostLayoutInput {
  mode: "managed-profile";
  profileRoot: string;
  resourceRoot: string;
  /** Compiled sidecar; resources live in the given resourceRoot beside it. */
  executable: string;
}

export interface InstalledHostLayoutInput {
  mode: "installed";
  /** Selected installation root: app/ and userdata/ live beneath it. */
  installRoot: string;
  /** Host preferences only; defaults under the installation's own state directory. */
  hostProfileRoot?: string;
}

export type HostLayoutInput =
  | DevelopmentHostLayoutInput
  | ManagedHostLayoutInput
  | InstalledHostLayoutInput;

/** The npm distribution names its installed binary bun.exe on every platform. */
function projectBun(projectRoot: string): string {
  return path.join(projectRoot, "node_modules", "bun", "bin", "bun.exe");
}

function assertAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`DESKTOP_HOST_LAYOUT_${name}_MUST_BE_ABSOLUTE`);
  const normalized = path.normalize(value);
  if (normalized === path.parse(normalized).root) {
    throw new Error(`DESKTOP_HOST_LAYOUT_${name}_CANNOT_BE_DRIVE_ROOT`);
  }
  return normalized;
}

export function resolveHostLayout(input: HostLayoutInput): HostLayout {
  if (input.mode === "development-legacy") {
    const projectRoot = assertAbsolute("PROJECT_ROOT", input.projectRoot);
    const executable = input.bunExecutable
      ? assertAbsolute("BUN_EXECUTABLE", input.bunExecutable)
      : projectBun(projectRoot);
    return {
      mode: input.mode,
      profileRoot: input.profileRoot
        ? assertAbsolute("PROFILE_ROOT", input.profileRoot)
        : path.join(projectRoot, "artifacts", "state", "electron-host"),
      projectRoot,
      executable,
      args: ["run", path.join("src", "server", "index.ts")],
      cwd: projectRoot,
      resourceRoot: projectRoot,
    };
  }
  if (input.mode === "installed") {
    const installRoot = assertAbsolute("INSTALL_ROOT", input.installRoot);
    return {
      mode: input.mode,
      appRoot: installRoot,
      envMode: "installed",
      profileRoot: input.hostProfileRoot
        ? assertAbsolute("HOST_PROFILE_ROOT", input.hostProfileRoot)
        : path.join(installRoot, "userdata", "state", "electron-host"),
      executable: path.join(installRoot, "app", "superstring-server.exe"),
      args: [],
      cwd: installRoot,
      resourceRoot: path.join(installRoot, "app", "resources"),
    };
  }
  const profileRoot = assertAbsolute("PROFILE_ROOT", input.profileRoot);
  return {
    mode: input.mode,
    profileRoot,
    executable: assertAbsolute("EXECUTABLE", input.executable),
    args: [],
    cwd: profileRoot,
    resourceRoot: assertAbsolute("RESOURCE_ROOT", input.resourceRoot),
  };
}
