// Read-only policy building blocks. No process stopping, copying or DB access.
function parseVersion(text) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      text,
    );
  if (!match) throw Error("INVALID_VERSION");
  const prerelease = match[4]?.split(".") ?? [];
  for (const part of prerelease)
    if (/^\d+$/.test(part) && part.length > 1 && part[0] === "0") throw Error("INVALID_VERSION");
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}
export function compareVersions(a, b) {
  const left = parseVersion(a),
    right = parseVersion(b);
  for (let i = 0; i < 3; i++)
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.prerelease.length || !right.prerelease.length)
    return Math.sign(Number(!left.prerelease.length) - Number(!right.prerelease.length));
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i],
      y = right.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function checkUpgradeIdentity(current, incoming) {
  for (const manifest of [current, incoming]) {
    if (
      manifest.product !== "superstring" ||
      manifest.platform !== "win32-x64" ||
      manifest.manifestVersion !== 1 ||
      manifest.layoutVersion !== 1 ||
      // Every business schema version this build knows about, INCLUDING the current one.
      // Static by design: the installer side cannot read the migration directory, so each
      // schema bump has to be mirrored here as well as in the version check below. (`verify-upgrade-guards.mjs` derives the number from the migration directory, so a missed edit here is reported instead of silently passing.)
      ![
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
      ].includes(manifest.businessSchemaVersion)
    )
      throw Error("UNSUPPORTED_PACKAGE_IDENTITY");
  }
  if (incoming.businessSchemaVersion < current.businessSchemaVersion) {
    throw Error("DOWNGRADE_REJECTED: business schema");
  }
  if (incoming.businessSchemaVersion !== 41) throw Error("UNSUPPORTED_PACKAGE_IDENTITY");
  const order = compareVersions(incoming.version, current.version);
  if (order < 0) throw Error("DOWNGRADE_REJECTED");
  return order === 0 ? "same-version-reinstall" : "upgrade";
}
function bytes(value) {
  if (typeof value !== "bigint" || value < 0n) throw Error("INVALID_BYTE_COUNT");
  return value;
}
export function upgradeSpaceBudget({
  incomingBytes,
  currentProgramBytes,
  userDataBytes,
  reserveBytes = 256n * 1024n * 1024n,
}) {
  // Conservative additional space on the selected volume: staging + replacement,
  // old program backup + closed data backup + potential restored/migrated data copy.
  // Caller must measure a quiescent installation and account for any other volume.
  return (
    2n * bytes(incomingBytes) +
    bytes(currentProgramBytes) +
    2n * bytes(userDataBytes) +
    bytes(reserveBytes)
  );
}
export function requireAvailableSpace(available, required) {
  if (bytes(available) < bytes(required)) throw Error("INSUFFICIENT_UPGRADE_SPACE");
}
