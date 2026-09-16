import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserStateStorage, loadBrowserStateStorage } from "../../src/web/browser-state";

const config = {
  secret: "abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890-_",
  storage_keys: { session: "superstring-session" as const, agent: "superstring-agent" as const },
};

describe("Gradio-compatible BrowserState storage", () => {
  beforeEach(() => localStorage.clear());

  it("uses randomized encrypted storage without exposing the UUID", async () => {
    const storage = createBrowserStateStorage(config);
    const id = "33333333-3333-4333-8333-333333333333";
    await storage.write(config.storage_keys.session, id);
    const first = localStorage.getItem(config.storage_keys.session);
    await storage.write(config.storage_keys.session, id);
    const second = localStorage.getItem(config.storage_keys.session);

    expect(first).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(first).not.toContain(id);
    expect(second).not.toBe(first);
    expect(await storage.read(config.storage_keys.session)).toBe(id);
  });

  it("returns null for plaintext, damaged ciphertext, wrong secret and storage errors", async () => {
    const storage = createBrowserStateStorage(config);
    localStorage.setItem(config.storage_keys.session, "33333333-3333-4333-8333-333333333333");
    expect(await storage.read(config.storage_keys.session)).toBeNull();
    localStorage.setItem(config.storage_keys.session, "not:ciphertext:format");
    expect(await storage.read(config.storage_keys.session)).toBeNull();

    await storage.write(config.storage_keys.session, "value");
    const wrong = createBrowserStateStorage({ ...config, secret: "Z".repeat(40) });
    expect(await wrong.read(config.storage_keys.session)).toBeNull();

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await storage.read(config.storage_keys.session)).toBeNull();
    getItem.mockRestore();
  });

  it("treats config loading failure as non-fatal", async () => {
    expect(
      await loadBrowserStateStorage(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  it("matches the original falsy behavior and does not remove stale storage on null", async () => {
    const storage = createBrowserStateStorage(config);
    await storage.write(config.storage_keys.agent, "agent-id");
    const saved = localStorage.getItem(config.storage_keys.agent);
    await storage.write(config.storage_keys.agent, null);
    expect(localStorage.getItem(config.storage_keys.agent)).toBe(saved);
  });
});
