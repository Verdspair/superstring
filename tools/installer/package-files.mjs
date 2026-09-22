import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Shared whitelist assembly for release artifacts. Only explicitly listed inputs
// are copied: no local/ user data, no node_modules, no keys, no logs.
export function collectPackageFiles(root, appDirectory) {
  const resources = path.join(appDirectory, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const files = [];
  function copyFile(source, relative) {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Release input must be a regular file: ${source}`);
    const destination = path.join(resources, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    files.push({
      path: `app/resources/${relative.replaceAll("\\", "/")}`,
      sha256: createHash("sha256").update(fs.readFileSync(destination)).digest("hex"),
    });
  }
  function copyTree(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (fs.lstatSync(filename).isSymbolicLink())
        throw new Error(`Release input must not be a link: ${filename}`);
      if (entry.isDirectory()) copyTree(filename, path.join(relative, entry.name));
      else copyFile(filename, path.join(relative, entry.name));
    }
  }
  copyTree(path.join(root, "dist/web"), "web");
  // Business DDL only. The R1 probe migration is a development/verification
  // surface: it ships in the development tree and in tests, never in a release.
  for (const migration of [
    "versions/0001_initial.sql",
    "versions/0002_knowledge.sql",
    "versions/0003_knowledge_read.sql",
    "versions/0004_organization.sql",
  ]) {
    copyFile(path.join(root, "migrations", migration), path.join("migrations", migration));
  }
  const noticesRoot = path.join(root, "tools/installer/licenses");
  const noticeIndex = JSON.parse(
    fs.readFileSync(path.join(noticesRoot, "notice-sources.json"), "utf8"),
  );
  for (const notice of noticeIndex.components) {
    if (!/^[a-zA-Z0-9.-]+\.txt$/.test(notice.file)) throw new Error("Invalid license filename");
    const source = path.join(noticesRoot, notice.file);
    if (createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== notice.sha256) {
      throw new Error(`License content changed: ${notice.file}`);
    }
    copyFile(source, path.join("licenses", notice.file));
  }
  copyFile(
    path.join(noticesRoot, "notice-sources.json"),
    path.join("licenses", "notice-sources.json"),
  );
  return files;
}

export function recordProgram(appDirectory, files) {
  const server = path.join(appDirectory, "superstring-server.exe");
  files.push({
    path: "app/superstring-server.exe",
    sha256: createHash("sha256").update(fs.readFileSync(server)).digest("hex"),
  });
  return server;
}

export function fileRecord(filename, relative) {
  return {
    path: relative,
    sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
  };
}

export function readPackageVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Invalid package version: ${version}`);
  return version;
}
