/**
 * Options for the Windows Electron desktop candidate builder. Every path is explicit:
 * the builder never probes for a project root, a runtime or a sidecar.
 */
export interface DesktopElectronBuildOptions {
  /** Absolute development tree the candidate is allowed to name in desktop-host.json. */
  projectRoot: string;
  /** Absolute isolated candidate directory; it must be empty. */
  out: string;
  /** "development-legacy" (default) names the existing dev layout, "managed-profile" a synthetic one. */
  layout?: "development-legacy" | "managed-profile";
  /** Absolute compiled sidecar root, when one exists; never searched for. */
  serviceRoot?: string;
  /** Stage the pinned Electron runtime into `<out>/app`; defaults to true. */
  runtime?: boolean;
  /** C# compiler override; defaults to the .NET Framework 4.8 csc.exe under %WINDIR%. */
  csc?: string;
  /** Zig executable for the window-proc bridge DLL: --zig or SUPERSTRING_ZIG_EXE, never PATH. */
  zig?: string;
  /** Override the compiled host source set (contract tests use synthetic sources). */
  hostSources?: string[];
}

export interface DesktopElectronBuildResult {
  builtAt: string;
  applicationVersion: string;
  electron: string;
  platform: NodeJS.Platform;
  arch: string;
  layout: NonNullable<DesktopElectronBuildOptions["layout"]>;
  projectRoot: string;
  serviceRoot: string | null;
  output: string;
  hostConfig: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  runtimeFiles: number;
  security: {
    asar: true;
    fusesApplied: boolean;
    fuseWire: import("@electron/fuses").FuseConfig<import("@electron/fuses").FuseState> | null;
  };
  limits: string[];
}

/**
 * Assembles `<out>/app` (pinned runtime + resources/app.asar package) and `<out>/stage`
 * (desktop-host.json + the headless C# host) without touching dist/, the release tree
 * or any real data path. Candidate promotion is separate and requires explicit
 * acceptance of the staged build.
 */
export function buildElectronDesktop(
  options: DesktopElectronBuildOptions,
): Promise<DesktopElectronBuildResult>;

export function stageStartupAppearance(packageDirectory: string): void;
