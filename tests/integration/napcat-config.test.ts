// NapCat 托管开关文件：合成临时路径上的缺失、CAS、校验与私有写入。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileNapCatConfigStore } from "../../src/server/napcat/config";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "napcat-config-"));
  directories.push(directory);
  const file = path.join(directory, "napcat.json");
  return { directory, file, store: new FileNapCatConfigStore(file) };
}

type StoreError = Error & { code?: string };

function captureError(run: () => unknown): StoreError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as StoreError;
  }
}

describe("NapCat managed config store", () => {
  it("requires an absolute injected file path", () => {
    expect(() => new FileNapCatConfigStore("napcat.json")).toThrow();
  });

  it("reads missing config as disabled without creating a file", () => {
    const { file, store } = setup();
    expect(path.isAbsolute(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(store.read()).toEqual({ revision: "", config: { version: 1, enabled: false } });
    expect(store.replace("", { version: 1, enabled: false })).toEqual({
      revision: "",
      config: { version: 1, enabled: false },
    });
    expect(existsSync(file)).toBe(false);
  });

  it("persists only managed config with a raw SHA revision and private mode", () => {
    const { file, store } = setup();
    const saved = store.replace("", { version: 1, enabled: true });
    const raw = readFileSync(file);
    expect(JSON.parse(raw.toString("utf8"))).toEqual({ version: 1, enabled: true });
    expect(saved.revision).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(saved.config).toEqual({ version: 1, enabled: true });
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("does not rewrite an unchanged config or revision", () => {
    const { file, store } = setup();
    const saved = store.replace("", { version: 1, enabled: true });
    const beforeRaw = readFileSync(file);
    const beforeStat = statSync(file);
    const unchanged = store.replace(saved.revision, { version: 1, enabled: true });
    const afterStat = statSync(file);
    expect(unchanged).toEqual(saved);
    expect(readFileSync(file)).toEqual(beforeRaw);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("rejects a stale revision without replacing current bytes", () => {
    const { file, store } = setup();
    const first = store.replace("", { version: 1, enabled: true });
    const current = store.replace(first.revision, { version: 1, enabled: false });
    const before = readFileSync(file);
    const error = captureError(() => store.replace(first.revision, { version: 1, enabled: true }));
    expect(error?.code).toBe("NAPCAT_CONFIG_CONFLICT");
    expect(readFileSync(file)).toEqual(before);
    expect(store.read()).toEqual(current);
  });

  it("rejects empty or private-field files without exposing their contents", () => {
    const { file, store } = setup();
    const invalidFiles = [
      "",
      JSON.stringify({
        version: 1,
        enabled: true,
        qqAccount: "synthetic-account",
        endpoint: "http://synthetic.invalid",
        token: "synthetic-token",
        bootstrap: "synthetic-bootstrap",
        vendorWebUiFile: "synthetic-ui-file",
      }),
    ];
    for (const raw of invalidFiles) {
      writeFileSync(file, raw);
      const error = captureError(() => store.read());
      expect(error?.code).toBe("NAPCAT_CONFIG_INVALID");
      expect(error?.message).not.toContain(file);
      if (raw.includes("synthetic-token")) {
        expect(error?.message).not.toContain("synthetic-token");
      }
      expect(readFileSync(file, "utf8")).toBe(raw);
    }
  });

  it("reports an unreadable path without leaking its location", () => {
    const { file, store } = setup();
    mkdirSync(file);
    const error = captureError(() => store.read());
    expect(error?.code).toBe("NAPCAT_CONFIG_UNAVAILABLE");
    expect(error?.message).not.toContain(file);
  });
});
