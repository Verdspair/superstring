import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readNapCatProvision } from "../../src/server/napcat/provision";
import { QqManagedResourceSnapshotSchema } from "../../src/shared/contracts/qq-managed";

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
  const assets: Record<string, string> = {
    "node.exe": "synthetic node runtime",
    "index.js": "synthetic entry",
    "wrapper.node": "synthetic native wrapper",
    "crypto.dll": "synthetic crypto dependency",
    "ssl.dll": "synthetic ssl dependency",
    "package.json": JSON.stringify({
      name: "qq-chat",
      version: "9.9.31-49738",
      platform: "win32",
      eleArch: "x64",
    }),
    "config.json": JSON.stringify({ buildId: "49738" }),
    "napcat/package.json": JSON.stringify({
      name: "napcat",
      version: "0.0.1",
      type: "module",
      dependencies: { express: "^5.0.0", ws: "^8.18.3" },
    }),
    "napcat/napcat.mjs": "synthetic application bundle",
    "napcat/loadNapCat.js": "synthetic loader",
    "napcat/node_modules/express/package.json": JSON.stringify({
      name: "express",
      version: "5.3.0",
    }),
    "napcat/node_modules/ws/package.json": JSON.stringify({ name: "ws", version: "8.22.0" }),
  };
  for (const [relative, contents] of Object.entries(assets)) {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  mkdirSync(path.dirname(vendorConfig), { recursive: true });
  writeFileSync(
    vendorConfig,
    JSON.stringify({ host: "127.0.0.1", port: 6099, token: privateToken }),
  );
  return {
    directory,
    descriptor,
    root,
    vendorConfig,
    node: path.join(root, "node.exe"),
    entry: path.join(root, "index.js"),
  };
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

describe("NapCat resource inspection and explicit preparation", () => {
  it("inspects an absent descriptor without creating a file or runtime configuration", async () => {
    const { descriptor, root } = setup();
    const { inspectNapCatResources } = await import("../../src/server/napcat/provision");

    const configBefore = readFileSync(path.join(root, "napcat", "config", "webui.json"));
    const snapshot = inspectNapCatResources(descriptor);

    expect(QqManagedResourceSnapshotSchema.parse(snapshot)).toEqual({
      revision: "",
      status: "missing",
      root: null,
      diagnostic_code: "runtime_not_selected",
    });
    expect(existsSync(descriptor)).toBe(false);
    expect(readFileSync(path.join(root, "napcat", "config", "webui.json"))).toEqual(configBefore);
  });

  it("prepares a complete selected runtime, seeds loopback with a generated token and keeps secrets out of the snapshot", async () => {
    const { descriptor, root, vendorConfig, node, entry } = setup();
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const before = inspectNapCatResources(descriptor);
    rmSync(vendorConfig);
    const snapshot = prepareNapCatResources(descriptor, {
      expected_revision: before.revision,
      root,
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.root).toBe(root);
    expect(snapshot.diagnostic_code).toBeNull();
    expect(snapshot.revision).not.toBe("");
    expect(JSON.stringify(snapshot)).not.toMatch(/token|secret/i);
    expect(existsSync(node)).toBe(true);
    expect(existsSync(entry)).toBe(true);
    const webui = JSON.parse(readFileSync(vendorConfig, "utf8"));
    expect(webui.host).toBe("127.0.0.1");
    expect(webui.port).toBeInteger();
    expect(webui.port).toBeGreaterThanOrEqual(1);
    expect(webui.port).toBeLessThanOrEqual(65535);
    expect(webui.token).toMatch(/^[a-f0-9]{64}$/);
    expect(webui.disableWebUI).toBe(false);
    expect(webui.enable2FA).toBe(false);
    expect(readNapCatProvision(descriptor)?.controlToken).toBe(webui.token);
    expect(snapshot.revision).toBe(inspectNapCatResources(descriptor).revision);
    expect(snapshot.revision).not.toBe(before.revision);
  });

  it("preserves existing WebUI settings, unknown fields, authentication and existing secret", async () => {
    const { descriptor, root, vendorConfig } = setup();
    const oldToken = privateToken;
    writeFileSync(
      vendorConfig,
      JSON.stringify({
        host: "127.0.0.1",
        port: 6099,
        token: oldToken,
        enable2FA: true,
        totpSecret: "synthetic-totp-secret",
        customSetting: { retained: true },
      }),
    );
    const original = readFileSync(vendorConfig, "utf8");
    const { prepareNapCatResources } = await import("../../src/server/napcat/provision");

    const snapshot = prepareNapCatResources(descriptor, { expected_revision: "", root });
    const webui = JSON.parse(readFileSync(vendorConfig, "utf8"));

    expect(webui).toEqual({
      host: "127.0.0.1",
      port: 6099,
      token: oldToken,
      enable2FA: true,
      totpSecret: "synthetic-totp-secret",
      customSetting: { retained: true },
    });
    expect(readFileSync(vendorConfig, "utf8")).toBe(original);
    expect(snapshot.status).toBe("ready");
  });

  it("changes only the upstream wildcard host on explicit preparation and retains authentication", async () => {
    const { descriptor, root, vendorConfig } = setup();
    const config = {
      host: "::",
      port: 6099,
      token: privateToken,
      enable2FA: true,
      totpSecret: "synthetic-totp-secret",
      customSetting: { retained: true },
    };
    writeFileSync(vendorConfig, JSON.stringify(config));
    writeDescriptor(descriptor, { version: 1, root });
    const descriptorBefore = readFileSync(descriptor);
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const before = inspectNapCatResources(descriptor);
    expect(before.status).toBe("invalid");
    const prepared = prepareNapCatResources(descriptor, {
      expected_revision: before.revision,
      root,
    });
    expect(prepared.status).toBe("ready");
    expect(prepared.revision).toBe(before.revision);
    expect(readFileSync(descriptor)).toEqual(descriptorBefore);
    expect(JSON.parse(readFileSync(vendorConfig, "utf8"))).toEqual({
      ...config,
      host: "127.0.0.1",
    });
    expect(readNapCatProvision(descriptor)?.controlToken).toBe(privateToken);
  });

  it("sanitizes invalid WebUI reads and never replaces an existing secret to prepare", async () => {
    const { descriptor, root, vendorConfig } = setup();
    writeDescriptor(descriptor, { version: 1, root });
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const descriptorBefore = readFileSync(descriptor);
    const revision = createHash("sha256").update(descriptorBefore).digest("hex");
    for (const invalid of [
      "{invalid",
      "null",
      JSON.stringify({
        host: "127.0.0.1",
        port: 6099,
        token: "",
      }),
    ]) {
      writeFileSync(vendorConfig, invalid);
      expect(inspectNapCatResources(descriptor)).toEqual({
        revision,
        status: "invalid",
        root,
        diagnostic_code: "runtime_resources_invalid",
      });
      const error = capturedError(() =>
        prepareNapCatResources(descriptor, {
          expected_revision: revision,
          root,
        }),
      );
      expect(error?.code).toBe("NAPCAT_RESOURCE_CONFLICT");
      expect(error?.message).not.toContain(root);
      expect(readFileSync(vendorConfig, "utf8")).toBe(invalid);
      expect(readFileSync(descriptor)).toEqual(descriptorBefore);
    }
  });

  it("uses descriptor raw-byte revision CAS and does not bump a same-root no-op", async () => {
    const { descriptor, root } = setup();
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const first = prepareNapCatResources(descriptor, { expected_revision: "", root });
    const same = prepareNapCatResources(descriptor, { expected_revision: first.revision, root });
    expect(same.revision).toBe(first.revision);

    writeDescriptor(descriptor, { version: 1, root });
    const stale = capturedError(() =>
      prepareNapCatResources(descriptor, { expected_revision: first.revision, root }),
    );

    expect(stale?.code).toBe("NAPCAT_RESOURCE_CONFLICT");
    expect(inspectNapCatResources(descriptor).revision).toBe(
      createHash("sha256").update(readFileSync(descriptor)).digest("hex"),
    );
  });

  it("rejects each missing required resource during inspection, preparation and activation", async () => {
    const { descriptor, root, vendorConfig } = setup();
    writeDescriptor(descriptor, { version: 1, root });
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const revision = inspectNapCatResources(descriptor).revision;
    const configBefore = readFileSync(vendorConfig);
    for (const missing of [
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
    ]) {
      const file = path.join(root, missing);
      const contents = readFileSync(file);
      rmSync(file);
      expect(inspectNapCatResources(descriptor).status).toBe("invalid");
      expect(
        capturedError(() =>
          prepareNapCatResources(descriptor, {
            expected_revision: revision,
            root,
          }),
        )?.code,
      ).toBe("NAPCAT_RESOURCE_UNAVAILABLE");
      expect(capturedError(() => readNapCatProvision(descriptor))?.code).toBe(
        "NAPCAT_RUNTIME_CONFIG_INVALID",
      );
      expect(readFileSync(vendorConfig)).toEqual(configBefore);
      writeFileSync(file, contents);
    }
  });

  it("leaves manifest validation to explicit preparation and activation, not status inspection", async () => {
    const { descriptor, root, vendorConfig } = setup();
    writeDescriptor(descriptor, { version: 1, root });
    const { inspectNapCatResources, prepareNapCatResources } = await import(
      "../../src/server/napcat/provision"
    );
    const revision = inspectNapCatResources(descriptor).revision;
    const configBefore = readFileSync(vendorConfig);
    for (const relative of [
      "package.json",
      "config.json",
      "napcat/package.json",
      "napcat/node_modules/express/package.json",
      "napcat/node_modules/ws/package.json",
    ]) {
      const file = path.join(root, relative);
      const contents = readFileSync(file);
      for (const invalid of ["{invalid", "null", "[]"]) {
        writeFileSync(file, invalid);
        expect(inspectNapCatResources(descriptor).status).toBe("ready");
        expect(
          capturedError(() =>
            prepareNapCatResources(descriptor, {
              expected_revision: revision,
              root,
            }),
          )?.code,
        ).toBe("NAPCAT_RESOURCE_UNAVAILABLE");
        expect(capturedError(() => readNapCatProvision(descriptor))?.code).toBe(
          "NAPCAT_RUNTIME_CONFIG_INVALID",
        );
        expect(readFileSync(vendorConfig)).toEqual(configBefore);
      }
      writeFileSync(file, contents);
    }
  });

  it("accepts another Windows x64 QQ build without requiring the research archive identity", async () => {
    const { descriptor, root } = setup();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "qq-chat",
        version: "9.9.32-50000",
        platform: "win32",
        eleArch: "x64",
      }),
    );
    writeFileSync(path.join(root, "config.json"), JSON.stringify({ buildId: "50000" }));
    const { prepareNapCatResources } = await import("../../src/server/napcat/provision");
    expect(prepareNapCatResources(descriptor, { expected_revision: "", root }).status).toBe(
      "ready",
    );
    expect(readNapCatProvision(descriptor)?.root).toBe(root);
  });

  it("rejects a stale descriptor revision before touching a newly selected runtime", async () => {
    const { descriptor, root, vendorConfig } = setup();
    writeDescriptor(descriptor, { version: 1, root });
    const descriptorBefore = readFileSync(descriptor);
    const configBefore = readFileSync(vendorConfig);
    const { prepareNapCatResources } = await import("../../src/server/napcat/provision");
    const incompleteRoot = path.join(path.dirname(root), "incomplete-napcat");

    const error = capturedError(() =>
      prepareNapCatResources(descriptor, {
        expected_revision: `stale-${createHash("sha256").update(descriptorBefore).digest("hex")}`,
        root: incompleteRoot,
      }),
    );

    expect(error?.code).toBe("NAPCAT_RESOURCE_CONFLICT");
    expect(readFileSync(descriptor)).toEqual(descriptorBefore);
    expect(readFileSync(vendorConfig)).toEqual(configBefore);
    expect(existsSync(incompleteRoot)).toBe(false);
  });

  it("does not treat a selected path with only the former four-file shape as complete", async () => {
    const { descriptor, root } = setup();
    for (const relative of [
      "crypto.dll",
      "ssl.dll",
      "package.json",
      "config.json",
      "napcat/loadNapCat.js",
      "napcat/package.json",
      "napcat/node_modules",
    ])
      rmSync(path.join(root, relative), { recursive: true });
    writeDescriptor(descriptor, { version: 1, root });
    const { inspectNapCatResources } = await import("../../src/server/napcat/provision");
    const result = inspectNapCatResources(descriptor);
    expect(result.status).toBe("invalid");
    expect(result.diagnostic_code).toBe("runtime_resources_invalid");
  });

  it("reports an invalid descriptor without rewriting it or creating a replacement", async () => {
    const { descriptor, root } = setup();
    writeDescriptor(descriptor, { version: 9, root });
    const raw = readFileSync(descriptor);
    const { inspectNapCatResources } = await import("../../src/server/napcat/provision");

    const snapshot = inspectNapCatResources(descriptor);

    expect(snapshot.status).toBe("invalid");
    expect(snapshot.root).toBeNull();
    expect(snapshot.diagnostic_code).toBe("runtime_descriptor_invalid");
    expect(snapshot.revision).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(readFileSync(descriptor)).toEqual(raw);
  });
});
