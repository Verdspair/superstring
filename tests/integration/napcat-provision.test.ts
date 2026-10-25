import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readNapCatProvision } from "../../src/server/napcat/provision";

const directories: string[] = [];
const privateToken = "synthetic-control-secret";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "napcat-provision-"));
  directories.push(directory);
  const descriptor = path.join(directory, "profile", "config", "napcat-runtime.json");
  const root = path.join(directory, "vendor", "napcat");
  const vendorConfig = path.join(root, "napcat", "config", "webui.json");
  const node = path.join(root, "node.exe");
  const entry = path.join(root, "index.js");
  const wrapper = path.join(root, "wrapper.node");
  for (const filename of [node, entry, wrapper]) {
    const parent = path.dirname(filename);
    mkdirSync(parent, { recursive: true });
    writeFileSync(filename, "synthetic fixture");
  }
  mkdirSync(path.dirname(vendorConfig), { recursive: true });
  writeFileSync(
    vendorConfig,
    JSON.stringify({ host: "127.0.0.1", port: 6099, token: privateToken }),
  );
  return { directory, descriptor, root, vendorConfig, node, entry };
}

function writeDescriptor(file: string, value: unknown) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

type ProvisionError = Error & { code?: string };
function capturedError(run: () => unknown): ProvisionError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as ProvisionError;
  }
}

describe("NapCat runtime provisioning descriptor", () => {
  it("treats an absent descriptor as unconfigured without creating profile files", () => {
    const { descriptor } = setup();
    expect(readNapCatProvision(descriptor)).toBeNull();
    expect(existsSync(path.dirname(descriptor))).toBe(false);
  });

  it("rejects malformed, unsupported, relative, or incomplete descriptors with a redacted stable error", () => {
    const { descriptor, root } = setup();
    const invalidValues = [
      "{ invalid",
      JSON.stringify({ version: 2, root }),
      JSON.stringify({ version: 1, root: "relative/vendor" }),
      JSON.stringify({ version: 1, root: path.join(root, "missing") }),
    ];
    for (const value of invalidValues) {
      mkdirSync(path.dirname(descriptor), { recursive: true });
      writeFileSync(descriptor, value);
      const error = capturedError(() => readNapCatProvision(descriptor));
      expect(error?.code).toBe("NAPCAT_RUNTIME_CONFIG_INVALID");
      expect(error?.message).not.toContain(descriptor);
      expect(error?.message).not.toContain(root);
      expect(error?.message).not.toContain(privateToken);
    }
  });

  it("resolves launch and loopback control settings from the vendor root without rewriting vendor config", () => {
    const { descriptor, root, vendorConfig, node } = setup();
    const before = readFileSync(vendorConfig, "utf8");
    writeDescriptor(descriptor, { version: 1, root });

    const provision = readNapCatProvision(descriptor);

    expect(provision).toEqual({
      root,
      launch: {
        command: node,
        args: ["index.js"],
        cwd: root,
        env: expect.any(Object),
      },
      controlOrigin: "http://127.0.0.1:6099",
      controlToken: privateToken,
    });
    expect(path.isAbsolute(provision!.launch.command)).toBe(true);
    expect(path.isAbsolute(provision!.launch.cwd)).toBe(true);
    expect(provision!.launch.args).toEqual(["index.js"]);
    expect(provision!.launch.env).toMatchObject({
      NAPCAT_DISABLE_MULTI_PROCESS: "1",
      NAPCAT_DISABLE_PIPE: "1",
      NAPCAT_DISABLE_FFMPEG_DOWNLOAD: "1",
    });
    expect(Object.keys(provision!.launch.env)).not.toContain("Path");
    expect(JSON.stringify(provision!.launch.env)).not.toContain(privateToken);
    expect(provision!.launch.args).not.toContain(privateToken);
    expect(JSON.stringify(provision!.launch)).not.toContain(privateToken);
    expect(readFileSync(vendorConfig, "utf8")).toBe(before);
  });

  it("rejects a vendor WebUI config that exposes a non-loopback host or invalid token", () => {
    const { descriptor, root, vendorConfig } = setup();
    writeDescriptor(descriptor, { version: 1, root });
    for (const config of [
      { host: "0.0.0.0", port: 6099, token: privateToken },
      { host: "127.0.0.1", port: 6099, token: "bad\nsecret" },
      { host: "127.0.0.1", port: 0, token: privateToken },
    ]) {
      writeFileSync(vendorConfig, JSON.stringify(config));
      const error = capturedError(() => readNapCatProvision(descriptor));
      expect(error?.code).toBe("NAPCAT_RUNTIME_CONFIG_INVALID");
      expect(error?.message).not.toContain(root);
      expect(error?.message).not.toContain(privateToken);
    }
  });
});
