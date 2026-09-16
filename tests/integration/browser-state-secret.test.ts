import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserStateSecret } from "../../src/server/browser-state";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createRuntime } from "../../src/server/runtime";

const gateway: ModelGateway = {
  config: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen/test", timeoutSeconds: 1 },
  async listModels() {
    return [];
  },
  async loadedContextCapacity() {
    return null;
  },
  async probeModelLoaded() {
    return false;
  },
  async complete() {
    return "{}";
  },
  async *streamChat() {
    yield "";
  },
};

function temporarySecretPath(): { directory: string; secretPath: string } {
  const directory = path.join(tmpdir(), `superstring-browser-state-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return { directory, secretPath: path.join(directory, "browser-state.key") };
}

describe("browser-state fixed secret", () => {
  it("persists a stable URL-safe secret and recreates damaged files", () => {
    const { directory, secretPath } = temporarySecretPath();
    try {
      const first = browserStateSecret(secretPath);
      expect(first).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(browserStateSecret(secretPath)).toBe(first);
      writeFileSync(secretPath, "broken value\n", "ascii");
      const replacement = browserStateSecret(secretPath);
      expect(replacement).not.toBe(first);
      expect(replacement).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exposes the secret only through a no-store runtime config response", async () => {
    const runtime = createRuntime({
      businessDbPath: ":memory:",
      gateway,
      browserStateSecret: "A".repeat(40),
    });
    try {
      const response = await runtime.app.request("/browser-state/config");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        secret: "A".repeat(40),
        storage_keys: { session: "superstring-session", agent: "superstring-agent" },
      });
    } finally {
      await runtime.stop();
    }
  });
});
