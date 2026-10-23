import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareCaseSlot } from "./case-rename.mjs";

const manifestName = "electron-desktop-manifest.json";
function digest(file, relative) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { path: relative, bytes: fs.statSync(file).size, sha256: hash.digest("hex") };
}
function files(directory, prefix = "") {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Linked desktop file: ${relative}`);
      if (entry.isDirectory()) return files(path.join(directory, entry.name), `${relative}/`);
      if (!entry.isFile()) throw new Error(`Not a regular desktop file: ${relative}`);
      return [relative];
    })
    .sort();
}
function verify(root, records) {
  for (const record of records) {
    if (
      path.isAbsolute(record.path) ||
      record.path.split(/[\\/]/).some((p) => p === ".." || p === "")
    )
      throw new Error("Unsafe desktop manifest path");
    const file = path.join(root, record.path);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Linked desktop file: ${record.path}`);
    const actual = digest(file, record.path);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256)
      throw new Error(`Desktop file changed: ${record.path}`);
  }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Copy only owned program files; preserve previous files before replacing the stable entry. */
export function promoteElectronDesktop({ candidate, projectRoot, destination, backupDirectory }) {
  for (const value of [candidate, projectRoot, destination, backupDirectory])
    if (!path.isAbsolute(value)) throw new Error("Desktop promotion requires absolute paths");
  const root = fs.realpathSync(projectRoot);
  if (
    !inside(root, fs.realpathSync(candidate)) ||
    !inside(path.join(root, "dist"), destination) ||
    !inside(path.join(root, "artifacts/validation"), backupDirectory)
  )
    throw new Error("Desktop promotion path outside its owned area");
  if (fs.existsSync(backupDirectory)) throw new Error("Desktop backup already exists");
  const build = JSON.parse(fs.readFileSync(path.join(candidate, "build-result.json"), "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (
    build.applicationVersion !== version ||
    path.resolve(build.projectRoot) !== root ||
    !build.security.asar ||
    !build.security.fusesApplied
  )
    throw new Error("Desktop candidate identity/security mismatch");
  const appRecords = build.files.filter((record) => record.path.startsWith("app/"));
  const host = build.files.find((record) => record.path === "stage/superstring.exe");
  const icon = build.files.find((record) => record.path === "stage/superstring.ico");
  if (
    !host ||
    !icon ||
    !appRecords.some((record) => record.path === "app/resources/app.asar") ||
    !appRecords.some((record) => record.path === "app/electron.exe")
  )
    throw new Error("Desktop candidate is incomplete");
  if (
    JSON.stringify(files(path.join(candidate, "app")).map((p) => `app/${p}`)) !==
    JSON.stringify(appRecords.map((r) => r.path).sort())
  )
    throw new Error("Desktop candidate app inventory mismatch");
  verify(candidate, [...appRecords, host, icon]);
  fs.mkdirSync(destination, { recursive: true });
  const app = path.join(destination, "app");
  const manifest = path.join(destination, manifestName);
  const previousManifest = fs.existsSync(manifest) ? fs.readFileSync(manifest) : null;
  let oldRecords = [];
  if (fs.existsSync(app)) {
    if (!previousManifest) throw new Error("Existing desktop app has no owned-file manifest");
    oldRecords = JSON.parse(previousManifest.toString()).files;
    const previousApp = oldRecords.filter((r) => r.path.startsWith("app/"));
    if (
      JSON.stringify(files(app).map((p) => `app/${p}`)) !==
      JSON.stringify(previousApp.map((r) => r.path).sort())
    )
      throw new Error("Unknown files in existing desktop app");
    verify(destination, oldRecords);
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  const copied = [];
  const oldFiles = new Set(oldRecords.map((r) => r.path));
  for (const name of ["superstring.exe", manifestName])
    if (fs.existsSync(path.join(destination, name))) oldFiles.add(name);
  for (const relative of oldFiles) {
    const source = path.join(destination, relative),
      target = path.join(backupDirectory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const record = digest(source, relative);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    verify(backupDirectory, [record]);
    copied.push(record);
  }
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), ".desktop-promote-"));
  const stagedApp = path.join(temporary, "app");
  fs.cpSync(path.join(candidate, "app"), stagedApp, { recursive: true, errorOnExist: true });
  verify(temporary, appRecords);
  fs.writeFileSync(
    path.join(stagedApp, "desktop-host.json"),
    `${JSON.stringify({ schemaVersion: 1, projectRoot: root, electronExecutable: "electron.exe" }, null, 2)}\n`,
    { flag: "wx" },
  );
  fs.copyFileSync(
    path.join(candidate, icon.path),
    path.join(stagedApp, "superstring.ico"),
    fs.constants.COPYFILE_EXCL,
  );
  const outputApp = files(stagedApp).map((p) => digest(path.join(stagedApp, p), `app/${p}`));
  const appBackup = fs.existsSync(app)
    ? path.join(destination, `app.${randomUUID()}.backup`)
    : null;
  let slot,
    appMoved = false,
    manifestWritten = false;
  try {
    if (appBackup) fs.renameSync(app, appBackup);
    fs.renameSync(stagedApp, app);
    appMoved = true;
    verify(destination, outputApp);
    slot = prepareCaseSlot(destination, "superstring.exe");
    fs.copyFileSync(
      path.join(candidate, host.path),
      path.join(destination, "superstring.exe"),
      fs.constants.COPYFILE_EXCL,
    );
    const outputHost = { ...host, path: "superstring.exe" };
    verify(destination, [outputHost]);
    const outputs = [...outputApp, outputHost].sort((a, b) => a.path.localeCompare(b.path, "en"));
    const value = {
      schemaVersion: 1,
      applicationVersion: version,
      projectRoot: root,
      files: outputs,
    };
    const stagedManifest = path.join(temporary, manifestName);
    fs.writeFileSync(stagedManifest, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(stagedManifest, manifest);
    manifestWritten = true;
    const result = {
      promotedAt: new Date().toISOString(),
      candidate,
      projectRoot: root,
      destination,
      applicationVersion: version,
      input: { app: appRecords, superstringExe: host, superstringIco: icon },
      output: {
        app: outputApp,
        superstringExe: outputHost,
        manifest: digest(manifest, manifestName),
      },
      backup: { directory: backupDirectory, app: appBackup, copied },
      shortcutUnchanged: true,
      shortcutChecked: false,
      manifest: {
        path: manifest,
        schemaVersion: 1,
        files: outputs.length,
        appFiles: outputApp.length,
      },
    };
    slot.commit();
    return result;
  } catch (error) {
    const failures = [error];
    try {
      slot?.restore();
    } catch (failure) {
      failures.push(failure);
    }
    try {
      if (appMoved && fs.existsSync(app))
        fs.renameSync(app, path.join(temporary, "failed-new-app"));
      if (appBackup && fs.existsSync(appBackup)) fs.renameSync(appBackup, app);
      if (manifestWritten) {
        if (previousManifest) fs.writeFileSync(manifest, previousManifest);
        else fs.renameSync(manifest, path.join(temporary, "failed-manifest.json"));
      }
    } catch (failure) {
      failures.push(failure);
    }
    throw new AggregateError(failures, "Desktop promotion failed; recovery files retained");
  }
}
