import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

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

export class NapCatProvisionError extends Error {
  readonly code = "NAPCAT_RUNTIME_CONFIG_INVALID" as const;

  constructor() {
    super("NapCat runtime configuration is invalid");
    this.name = "NapCatProvisionError";
  }
}

function regularFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink();
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

/** Reads the private profile descriptor and vendor-owned local runtime settings. */
export function readNapCatProvision(descriptorPath: string): NapCatProvision | null {
  if (!path.isAbsolute(descriptorPath)) throw new NapCatProvisionError();
  let raw: string;
  try {
    const stat = lstatSync(descriptorPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NapCatProvisionError();
    raw = readFileSync(descriptorPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof NapCatProvisionError) throw error;
    throw new NapCatProvisionError();
  }

  let descriptor: unknown;
  try {
    descriptor = JSON.parse(raw);
  } catch {
    throw new NapCatProvisionError();
  }
  const { root } = parseDescriptor(descriptor);
  const node = path.join(root, "node.exe");
  const entry = path.join(root, "index.js");
  const wrapper = path.join(root, "wrapper.node");
  const webuiConfig = path.join(root, "napcat", "config", "webui.json");
  for (const filename of [node, entry, wrapper, webuiConfig]) {
    if (!regularFile(filename)) throw new NapCatProvisionError();
  }

  let webui: unknown;
  try {
    webui = JSON.parse(readFileSync(webuiConfig, "utf8"));
  } catch {
    throw new NapCatProvisionError();
  }
  if (typeof webui !== "object" || webui === null || Array.isArray(webui)) {
    throw new NapCatProvisionError();
  }
  const config = webui as { host?: unknown; port?: unknown; token?: unknown };
  if (
    config.host !== "127.0.0.1" ||
    typeof config.port !== "number" ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== "string" ||
    config.token.trim().length === 0 ||
    /[\r\n]/.test(config.token)
  ) {
    throw new NapCatProvisionError();
  }

  return {
    root,
    launch: { command: node, args: ["index.js"], cwd: root, env: explicitEnvironment() },
    controlOrigin: `http://127.0.0.1:${config.port}`,
    controlToken: config.token,
  };
}
