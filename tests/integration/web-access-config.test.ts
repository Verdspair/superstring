// 联网配置存储：读写/缺失/损坏/端点校验与并发修订。文件写在临时目录。

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileWebAccessConfigStore,
  MAX_SEARXNG_ENDPOINT_CHARS,
  normalizeWebAccessConfig,
} from "../../src/server/web-access/config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "web-access-config-"));
  dirs.push(dir);
  const file = path.join(dir, "web-access.json");
  return { file, store: new FileWebAccessConfigStore(file) };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("联网配置存储", () => {
  it("缺失＝默认空配置，revision 为空", () => {
    const { store } = setup();
    expect(store.read()).toEqual({ revision: "", config: { version: 1 } });
  });

  it("读写往返：保存去尾斜杠，revision 随内容变化", () => {
    const { file, store } = setup();
    const saved = store.replace("", {
      version: 1,
      searxngEndpoint: "http://192.168.1.5:8888/",
    });
    expect(saved.config).toEqual({ version: 1, searxngEndpoint: "http://192.168.1.5:8888" });
    expect(saved.revision).not.toBe("");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      searxngEndpoint: "http://192.168.1.5:8888",
    });
    const reread = store.read();
    expect(reread.revision).toBe(saved.revision);
    const updated = store.replace(reread.revision, { version: 1 });
    expect(updated.config).toEqual({ version: 1 });
    expect(updated.revision).not.toBe(saved.revision);
  });

  it("允许 loopback 与私网端点（用户配置的可信实例）", () => {
    const { store } = setup();
    const first = store.replace("", { version: 1, searxngEndpoint: "http://127.0.0.1:8888" });
    expect(first.config.searxngEndpoint).toBe("http://127.0.0.1:8888");
    const second = store.replace(first.revision, {
      version: 1,
      searxngEndpoint: "http://10.0.0.9:7777/searx",
    });
    expect(second.config.searxngEndpoint).toBe("http://10.0.0.9:7777/searx");
    const third = store.replace(second.revision, {
      version: 1,
      searxngEndpoint: "http://localhost:8888///",
    });
    expect(third.config.searxngEndpoint).toBe("http://localhost:8888");
  });

  it("端点校验：仅 http/https、长度有界、空白视为未配置", () => {
    const { store } = setup();
    for (const endpoint of [
      "ftp://example.com",
      "not a url",
      "http://",
      "javascript:alert(1)",
      `http://example.com/${"x".repeat(MAX_SEARXNG_ENDPOINT_CHARS)}`,
    ]) {
      expect(codeOf(() => store.replace("", { version: 1, searxngEndpoint: endpoint }))).toBe(
        "WEB_CONFIG_INVALID",
      );
    }
    const blank = store.replace("", { version: 1, searxngEndpoint: "   " });
    expect(blank.config).toEqual({ version: 1 });
    expect(
      normalizeWebAccessConfig({ version: 1, searxngEndpoint: "https://a.example/b/" }),
    ).toEqual({ version: 1, searxngEndpoint: "https://a.example/b" });
  });

  it("损坏文件带码拒绝，不改写原文件", () => {
    const { file, store } = setup();
    for (const content of [
      "not json",
      '{"version":2}',
      '{"version":1,"searxngEndpoint":"http://a.example","extra":true}',
      "[]",
    ]) {
      writeFileSync(file, content);
      expect(codeOf(() => store.read())).toBe("WEB_CONFIG_INVALID");
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  it("内容合法但不可读（路径是目录）归为 WEB_CONFIG_UNAVAILABLE", () => {
    const { file, store } = setup();
    mkdirSync(file);
    expect(codeOf(() => store.read())).toBe("WEB_CONFIG_UNAVAILABLE");
  });

  it("用过期 revision 保存被拒", () => {
    const { store } = setup();
    const saved = store.replace("", { version: 1, searxngEndpoint: "http://127.0.0.1:8888" });
    expect(codeOf(() => store.replace("stale", { version: 1 }))).toBe("WEB_CONFIG_CONFLICT");
    expect(codeOf(() => store.replace(saved.revision, { version: 1 }))).toBe(undefined);
  });
});
