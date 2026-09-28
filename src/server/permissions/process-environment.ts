const INHERITED = new Set([
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
]);

export function processEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && INHERITED.has(name.toUpperCase())) result[name] = value;
  }
  return result;
}
