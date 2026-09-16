import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit, single-shortcut operation. Never enumerate or clean the Desktop.
// The caller must obtain approval for renaming an existing personal shortcut.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const apply = process.argv.includes("--apply");
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const command = `
$ErrorActionPreference = "Stop"
$root = ${quote(root)}
$apply = ${apply ? "$true" : "$false"}
$desktop = [Environment]::GetFolderPath("Desktop")
if (-not [IO.Directory]::Exists($desktop)) { throw "Desktop directory unavailable" }
$target = Join-Path $root "dist/desktop/superstring.exe"
$legacyTarget = Join-Path $root "artifacts/desktop/superstring.exe"
if (-not [IO.File]::Exists($target)) { throw "Build the launcher first" }
$oldName = [string][char]0x8d85 + [char]0x5f26 + ".lnk"
$old = Join-Path $desktop $oldName
$dest = Join-Path $desktop "superstring.lnk"
$oldExists = [IO.File]::Exists($old)
$destExists = [IO.File]::Exists($dest)
if ($oldExists -and $destExists) { throw "Both shortcut names exist; refusing to overwrite either" }
$targetFull = [IO.Path]::GetFullPath($target)
$legacyFull = [IO.Path]::GetFullPath($legacyTarget)
$shell = New-Object -ComObject WScript.Shell
$existing = $null
if ($oldExists) { $existing = $old } elseif ($destExists) { $existing = $dest }
$migratingFromLegacy = $false
if ($existing) {
  $link = $shell.CreateShortcut($existing)
  $current = [IO.Path]::GetFullPath($link.TargetPath)
  $isTarget = [string]::Equals($current, $targetFull, [StringComparison]::OrdinalIgnoreCase)
  $isLegacy = [string]::Equals($current, $legacyFull, [StringComparison]::OrdinalIgnoreCase)
  # Only two target spellings are acceptable: the current one (no-op) and the
  # pre-2026-09-16 artifacts/desktop spelling (migrate). Anything else is a
  # foreign shortcut and we refuse to touch it.
  if (-not $isTarget -and -not $isLegacy) { throw "Existing shortcut has a different target; no changes made" }
  $migratingFromLegacy = ($isLegacy -and -not $isTarget)
}
$backup = $null
if ($apply) {
  if ($existing) {
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss-fffffff")
    $backupDir = Join-Path $root ("artifacts/desktop/shortcut-backups/" + $stamp)
    [IO.Directory]::CreateDirectory($backupDir) | Out-Null
    $backup = Join-Path $backupDir "original.lnk"
    [IO.File]::Copy($existing, $backup, $false)
    if ((Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash) { throw "Backup verification failed; no Desktop changes made" }
    [Console]::WriteLine("Verified shortcut backup: " + $backup)
  }
  if ($oldExists) { [IO.File]::Move($old, $dest) }
  $link = $shell.CreateShortcut($dest)
  $link.TargetPath = $targetFull
  $link.WorkingDirectory = $root
  $link.IconLocation = $targetFull + ",0"
  $link.Description = "superstring"
  $link.Arguments = ""
  $link.Save()
  $check = $shell.CreateShortcut($dest)
  if (-not [string]::Equals($check.TargetPath, $targetFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Target verification failed; backup retained" }
  if ($check.Description -cne "superstring" -or $check.Arguments -ne "") { throw "Shortcut metadata verification failed; backup retained" }
  if (-not [string]::Equals($check.WorkingDirectory, $root, [StringComparison]::OrdinalIgnoreCase)) { throw "Working directory verification failed; backup retained" }
  if (-not [string]::Equals($check.IconLocation, $targetFull + ",0", [StringComparison]::OrdinalIgnoreCase)) { throw "Icon verification failed; backup retained" }
  if ([IO.File]::Exists($old)) { throw "Old shortcut still exists; no cleanup attempted" }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::WriteLine((@{applied=$apply; shortcut=$dest; target=$target; legacyTarget=$legacyTarget; migratingFromLegacy=$migratingFromLegacy; oldExists=$oldExists; backup=$backup} | ConvertTo-Json -Compress))
`;
const powershell = path.join(
  process.env.WINDIR || "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 15000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
