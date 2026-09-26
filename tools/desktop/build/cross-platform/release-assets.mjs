import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { writeChecksums } from "./checksums.mjs";
import { TARGETS } from "./config.mjs";
import { validateSmokeReport } from "./smoke-contract.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { release: { type: "boolean", default: false } },
});
const [input, destination, version] = positionals;
if (!input || !destination || !version)
  throw new Error("Usage: release-assets.mjs <download-dir> <output-dir> <version> [--release]");
fs.mkdirSync(destination, { recursive: true });
for (const { platform, arch } of TARGETS) {
  const source = path.join(input, `${platform}-${arch}`);
  const identity = JSON.parse(fs.readFileSync(path.join(source, "build-result.json"), "utf8"));
  if (identity.release !== values.release) throw new Error("RELEASE_MODE_MISMATCH");
  const report = JSON.parse(fs.readFileSync(path.join(source, "smoke-report.json"), "utf8"));
  validateSmokeReport(report, { platform, arch, version });
  fs.copyFileSync(
    path.join(source, "smoke-report.json"),
    path.join(destination, `smoke-${platform}-${arch}.json`),
    fs.constants.COPYFILE_EXCL,
  );
}
for (const lane of [...TARGETS.map(({ platform, arch }) => `${platform}-${arch}`), "win32-x64"]) {
  for (const name of fs.readdirSync(path.join(input, lane))) {
    if (!/\.(?:dmg|zip|AppImage|deb|exe)$/.test(name)) continue;
    fs.copyFileSync(
      path.join(input, lane, name),
      path.join(destination, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
}
writeChecksums(destination, version);
