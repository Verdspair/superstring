import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type QqManagedResourceSnapshot,
  type UpdateQqManagedResourcesRequest,
  UpdateQqManagedResourcesRequestSchema,
} from "../../shared/contracts/qq-managed";

export interface NapCatProvision {
  readonly root: string;
  readonly launch: {
    readonly command: string;
    readonly args: string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
  };
  readonly controlOrigin: string;
  readonly controlToken: string;
}

export type NapCatProvisionErrorCode =
  | "NAPCAT_RUNTIME_CONFIG_INVALID"
  | "NAPCAT_RESOURCE_CONFLICT"
  | "NAPCAT_RESOURCE_UNAVAILABLE";

export class NapCatProvisionError extends Error {
  readonly code: NapCatProvisionErrorCode;

  constructor(code: NapCatProvisionErrorCode = "NAPCAT_RUNTIME_CONFIG_INVALID") {
    super(
      code === "NAPCAT_RESOURCE_CONFLICT"
        ? "NapCat runtime resources changed or conflict with the selected configuration"
        : code === "NAPCAT_RESOURCE_UNAVAILABLE"
          ? "NapCat runtime resources are incomplete or unavailable"
          : "NapCat runtime configuration is invalid",
    );
    this.name = "NapCatProvisionError";
    this.code = code;
  }
}

const webuiRelativePath = path.join("napcat", "config", "webui.json");
const runtimeFiles = [
  "node.exe",
  "index.js",
  "wrapper.node",
  "crypto.dll",
  "ssl.dll",
  "package.json",
  "config.json",
  "napcat/napcat.mjs",
  "napcat/loadNapCat.js",
  "napcat/package.json",
  "napcat/node_modules/express/package.json",
  "napcat/node_modules/ws/package.json",
] as const;

function regularFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function directory(filename: string): boolean {
  try {
    const stat = lstatSync(filename);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function explicitEnvironment(): Record<string, string> {
  const names =
    process.platform === "win32"
      ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      : ["PATH", "HOME", "TMPDIR"];
  const env: Record<string, string> = {
    NAPCAT_DISABLE_MULTI_PROCESS: "1",
    NAPCAT_DISABLE_PIPE: "1",
    NAPCAT_DISABLE_FFMPEG_DOWNLOAD: "1",
  };
  const keys = Object.keys(process.env);
  for (const name of names) {
    const key = keys.find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    const value = key ? process.env[key] : undefined;
    if (key && value !== undefined) env[key] = value;
  }
  return env;
}

function parseDescriptor(value: unknown): { root: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("version" in value) ||
    !("root" in value) ||
    value.version !== 1 ||
    typeof value.root !== "string" ||
    !path.isAbsolute(value.root)
  ) {
    throw new NapCatProvisionError();
  }
  const root = path.normalize(value.root);
  if (root === path.parse(root).root) throw new NapCatProvisionError();
  return { root };
}

function descriptorRevision(raw: Buffer | null): string {
  return raw ? createHash("sha256").update(raw).digest("hex") : "";
}

function readDescriptor(descriptorPath: string): { raw: Buffer | null; root: string | null } {
  if (!path.isAbsolute(descriptorPath)) throw new NapCatProvisionError();
  let raw: Buffer;
  try {
    const stat = lstatSync(descriptorPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NapCatProvisionError();
    raw = readFileSync(descriptorPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { raw: null, root: null };
    }
    if (error instanceof NapCatProvisionError) throw error;
    throw new NapCatProvisionError();
  }
  try {
    return { raw, root: parseDescriptor(JSON.parse(raw.toString("utf8"))).root };
  } catch {
    return { raw, root: null };
  }
}

function readJsonFile(filename: string): unknown {
  try {
    return JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function webuiConfig(root: string): Record<string, unknown> | null {
  const filename = path.join(root, webuiRelativePath);
  if (!regularFile(filename)) return null;
  const value = objectRecord(readJsonFile(filename));
  if (!value) return null;
  if (
    value.host !== "127.0.0.1" ||
    typeof value.port !== "number" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.token !== "string" ||
    value.token.trim().length === 0 ||
    /[\r\n]/.test(value.token)
  ) {
    return null;
  }
  return value;
}

function hasBasicRuntimeFiles(root: string): boolean {
  if (!directory(root)) return false;
  for (const relative of runtimeFiles) {
    if (!regularFile(path.join(root, relative))) return false;
  }
  return webuiConfig(root) !== null;
}

function snapshot(
  revision: string,
  status: QqManagedResourceSnapshot["status"],
  root: string | null,
  diagnostic_code: QqManagedResourceSnapshot["diagnostic_code"],
): QqManagedResourceSnapshot {
  return { revision, status, root, diagnostic_code };
}

/** Reads only the descriptor and named runtime/config metadata; it never prepares files. */
export function inspectNapCatResources(descriptorPath: string): QqManagedResourceSnapshot {
  let descriptor: { raw: Buffer | null; root: string | null };
  try {
    descriptor = readDescriptor(descriptorPath);
  } catch {
    return snapshot("", "invalid", null, "runtime_descriptor_invalid");
  }
  const revision = descriptorRevision(descriptor.raw);
  if (descriptor.raw === null) {
    return snapshot(revision, "missing", null, "runtime_not_selected");
  }
  if (!descriptor.root) {
    return snapshot(revision, "invalid", null, "runtime_descriptor_invalid");
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    return snapshot(revision, "invalid", descriptor.root, "runtime_platform_unsupported");
  }
  try {
    if (hasBasicRuntimeFiles(descriptor.root)) {
      return snapshot(revision, "ready", descriptor.root, null);
    }
  } catch {
    // Status reads report invalid resources without exposing paths or configuration contents.
  }
  return snapshot(revision, "invalid", descriptor.root, "runtime_resources_invalid");
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Manifest structure is checked only on explicit preparation or activation, not status polling.
function validateRuntimeBundle(root: string): void {
  if (!directory(root)) throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  for (const relative of runtimeFiles) {
    if (!regularFile(path.join(root, relative))) {
      throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
    }
  }
  const packageInfo = objectRecord(readJsonFile(path.join(root, "package.json")));
  const versionConfig = objectRecord(readJsonFile(path.join(root, "config.json")));
  const napcatPackage = objectRecord(readJsonFile(path.join(root, "napcat", "package.json")));
  const expressPackage = objectRecord(
    readJsonFile(path.join(root, "napcat", "node_modules", "express", "package.json")),
  );
  const wsPackage = objectRecord(
    readJsonFile(path.join(root, "napcat", "node_modules", "ws", "package.json")),
  );
  const dependencies = objectRecord(napcatPackage?.dependencies);
  if (
    packageInfo?.name !== "qq-chat" ||
    packageInfo.platform !== "win32" ||
    packageInfo.eleArch !== "x64" ||
    !nonemptyString(packageInfo.version) ||
    !versionConfig ||
    napcatPackage?.name !== "napcat" ||
    napcatPackage.type !== "module" ||
    !dependencies ||
    !nonemptyString(dependencies.express) ||
    !nonemptyString(dependencies.ws) ||
    expressPackage?.name !== "express" ||
    !nonemptyString(expressPackage.version) ||
    wsPackage?.name !== "ws" ||
    !nonemptyString(wsPackage.version)
  ) {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
}

function writeAtomic(filename: string, data: string | Buffer): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    renameSync(temporary, filename);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the storage error stable and do not expose local paths.
    }
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
}

function validateWebuiForPreparation(root: string): Record<string, unknown> | null {
  const filename = path.join(root, webuiRelativePath);
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
    }
    const config = objectRecord(readJsonFile(filename));
    if (
      !config ||
      (config.host !== "127.0.0.1" && config.host !== "::") ||
      typeof config.port !== "number" ||
      !Number.isSafeInteger(config.port) ||
      config.port < 1 ||
      config.port > 65535 ||
      typeof config.token !== "string" ||
      config.token.trim().length === 0 ||
      /[\r\n]/.test(config.token)
    ) {
      throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
    }
    return config;
  } catch (error) {
    if (error instanceof NapCatProvisionError) {
      throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      directory(path.dirname(path.dirname(filename)))
    ) {
      return null;
    }
    throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
  }
}

function seedWebui(root: string): void {
  const configDirectory = path.join(root, "napcat", "config");
  const napcatDirectory = path.dirname(configDirectory);
  if (!directory(napcatDirectory)) throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  try {
    mkdirSync(configDirectory, { recursive: true });
  } catch {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  if (!directory(configDirectory)) throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  const config = {
    host: "127.0.0.1",
    port: 6099,
    token: randomBytes(32).toString("hex"),
    disableWebUI: false,
    enable2FA: false,
  };
  writeAtomic(path.join(configDirectory, "webui.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function saveDescriptor(descriptorPath: string, root: string): Buffer {
  try {
    mkdirSync(path.dirname(descriptorPath), { recursive: true });
  } catch {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  const encoded = Buffer.from(`${JSON.stringify({ version: 1, root }, null, 2)}\n`);
  writeAtomic(descriptorPath, encoded);
  return encoded;
}

/** Explicitly prepares a selected extracted runtime and CAS-registers its private descriptor. */
export function prepareNapCatResources(
  descriptorPath: string,
  request: UpdateQqManagedResourcesRequest,
): QqManagedResourceSnapshot {
  const parsed = UpdateQqManagedResourcesRequestSchema.safeParse(request);
  if (!parsed.success || !path.isAbsolute(descriptorPath)) {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  let current: { raw: Buffer | null; root: string | null };
  try {
    current = readDescriptor(descriptorPath);
  } catch {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  const revision = descriptorRevision(current.raw);
  if (revision !== parsed.data.expected_revision) {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    return snapshot(
      revision,
      "invalid",
      path.normalize(parsed.data.root),
      "runtime_platform_unsupported",
    );
  }
  const root = path.normalize(parsed.data.root);
  if (root === path.parse(root).root || !directory(root)) {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  validateRuntimeBundle(root);
  const webui = validateWebuiForPreparation(root);
  const sameRoot = current.root === root;
  if (!webui) {
    seedWebui(root);
  } else if (webui.host === "::") {
    writeAtomic(
      path.join(root, webuiRelativePath),
      `${JSON.stringify({ ...webui, host: "127.0.0.1" }, null, 2)}\n`,
    );
  }
  if (sameRoot) return inspectNapCatResources(descriptorPath);

  const currentAfterPreparation = readDescriptor(descriptorPath);
  if (descriptorRevision(currentAfterPreparation.raw) !== parsed.data.expected_revision) {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_CONFLICT");
  }
  saveDescriptor(descriptorPath, root);
  return inspectNapCatResources(descriptorPath);
}

/** Reads the private profile descriptor and vendor-owned local runtime settings. */
export function readNapCatProvision(descriptorPath: string): NapCatProvision | null {
  let descriptor: { raw: Buffer | null; root: string | null };
  try {
    descriptor = readDescriptor(descriptorPath);
  } catch {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  if (!descriptor.raw) return null;
  if (!descriptor.root) throw new NapCatProvisionError();
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new NapCatProvisionError("NAPCAT_RESOURCE_UNAVAILABLE");
  }
  let config: Record<string, unknown> | null;
  try {
    validateRuntimeBundle(descriptor.root);
    config = webuiConfig(descriptor.root);
  } catch {
    throw new NapCatProvisionError();
  }
  if (!config) throw new NapCatProvisionError();
  const node = path.join(descriptor.root, "node.exe");
  return {
    root: descriptor.root,
    launch: { command: node, args: ["index.js"], cwd: descriptor.root, env: explicitEnvironment() },
    controlOrigin: `http://127.0.0.1:${config.port as number}`,
    controlToken: config.token as string,
  };
}
