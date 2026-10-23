export interface DesktopPromoteOptions {
  candidate: string;
  projectRoot: string;
  destination: string;
  backupDirectory: string;
}
export interface DesktopFileDigest {
  path: string;
  bytes: number;
  sha256: string;
}
export interface DesktopPromoteResult {
  promotedAt: string;
  candidate: string;
  projectRoot: string;
  destination: string;
  applicationVersion: string;
  input: {
    app: DesktopFileDigest[];
    superstringExe: DesktopFileDigest;
    superstringIco: DesktopFileDigest;
  };
  output: {
    app: DesktopFileDigest[];
    superstringExe: DesktopFileDigest;
    manifest: DesktopFileDigest;
  };
  backup: { directory: string; app: string | null; copied: DesktopFileDigest[] };
  shortcutUnchanged: true;
  shortcutChecked: false;
  manifest: { path: string; schemaVersion: 1; files: number; appFiles: number };
}
export function promoteElectronDesktop(options: DesktopPromoteOptions): DesktopPromoteResult;
