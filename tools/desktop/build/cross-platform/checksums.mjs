import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedArtifacts } from "./config.mjs";

export function distributables(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => /\.(?:dmg|zip|AppImage|deb|exe)$/.test(name))
    .sort();
}

export function writeChecksums(directory, version) {
  const names = distributables(directory);
  if (version) {
    const expected = expectedArtifacts(version).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(
        `Release asset set mismatch: expected ${expected.join(", ")}; got ${names.join(", ")}`,
      );
    }
  }
  const lines = names.map((name) => {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`Artifact must be a regular file: ${name}`);
    return `${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${name}`;
  });
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: checksums.mjs <artifact-directory> [expected-version]");
  writeChecksums(path.resolve(directory), version);
}
