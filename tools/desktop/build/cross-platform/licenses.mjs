import fs from "node:fs";
import path from "node:path";
import { fileRecord } from "../../../installer/package-files.mjs";

// The scanner owns dependency traversal and license detection. This projection
// keeps distributable notices free of absolute CI paths and npm publisher data.
export function publicLicenseInventory(packages, rootPackage, readNotice = fs.readFileSync) {
  const entries = Object.entries(packages)
    .filter(([name]) => name !== `${rootPackage.name}@${rootPackage.version}`)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, info]) => {
      if (!info.licenseText?.trim() || !info.licenses || info.licenses === "UNKNOWN") {
        throw new Error(`Production dependency needs a complete license notice: ${name}`);
      }
      return [
        name,
        {
          licenses: info.licenses,
          ...(info.repository ? { repository: info.repository } : {}),
          ...(info.copyright ? { copyright: info.copyright } : {}),
          licenseText: info.licenseText,
          ...(info.noticeFile ? { noticeText: readNotice(info.noticeFile, "utf8") } : {}),
        },
      ];
    });
  const inventory = Object.fromEntries(entries);
  for (const name of Object.keys(rootPackage.dependencies ?? {})) {
    if (!entries.some(([identity]) => identity.startsWith(`${name}@`))) {
      throw new Error(`Production license scan omitted a direct dependency: ${name}`);
    }
  }
  return inventory;
}

export async function writeProductionNotices(root, service) {
  const { init } = await import("license-checker-rseidelsohn");
  const packages = await new Promise((resolve, reject) => {
    init(
      {
        start: root,
        production: true,
        customFormat: { licenseText: "", copyright: "" },
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const inventory = publicLicenseInventory(packages, manifest);
  const outputs = {
    "superstring-LICENSE.txt": fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
    "production-dependencies.json": `${JSON.stringify(inventory, null, 2)}\n`,
    "production-dependencies.txt": Object.entries(inventory)
      .map(
        ([name, info]) =>
          `${name}\n${"=".repeat(name.length)}\nLicense: ${[info.licenses].flat().join("; ")}\n${info.repository ? `Source: ${info.repository}\n` : ""}\n${info.licenseText}\n${info.noticeText ? `\nNOTICE\n${info.noticeText}\n` : ""}`,
      )
      .join("\n\n"),
  };
  return Object.entries(outputs).map(([name, content]) => {
    const relative = `resources/licenses/${name}`;
    const filename = path.join(service, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, { flag: "wx" });
    return fileRecord(filename, relative);
  });
}
