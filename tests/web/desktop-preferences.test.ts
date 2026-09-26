import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPreferenceSnapshot } from "../../src/shared/desktop-preferences";
import { selectMode, selectTheme } from "../../src/web/appearance";
import { bootstrapWebApplication } from "../../src/web/bootstrap";
import { createBrowserStateStorage } from "../../src/web/browser-state";
import {
  persistDesktopPreference,
  restoreDesktopPreferences,
} from "../../src/web/desktop-preferences";
import { selectLocale } from "../../src/web/i18n";

beforeEach(() => {
  localStorage.clear();
  delete window.superstringPreferences;
});
afterEach(() => {
  delete window.superstringPreferences;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("desktop preference bootstrap and mutations", () => {
  it("finishes preference restoration before evaluating the application", async () => {
    let resolve!: (value: DesktopPreferenceSnapshot) => void;
    window.superstringPreferences = {
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
      save: vi.fn().mockResolvedValue(undefined),
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    const evaluated: Array<string | null> = [];
    const render = vi.fn(async () => {
      evaluated.push(localStorage.getItem("superstring-locale"));
    });
    const boot = bootstrapWebApplication(render);
    expect(render).not.toHaveBeenCalled();
    resolve({ "superstring-locale": "en", "superstring-appearance": "jade" });
    await boot;
    expect(evaluated).toEqual(["en"]);
    expect(localStorage.getItem("superstring-appearance")).toBe("jade");
  });

  it("restores canonical values, removes tombstones and adopts only previously unsaved known keys", async () => {
    localStorage.setItem("superstring-locale", "zh-CN");
    localStorage.setItem("superstring-agent", "old ciphertext");
    localStorage.setItem("superstring-appearance", "rose");
    localStorage.setItem("unrelated-token", "never sent");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "en", "superstring-agent": null }),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem("superstring-locale")).toBe("en");
    expect(localStorage.getItem("superstring-agent")).toBeNull();
    expect(save.mock.calls).toEqual([["superstring-appearance", "rose"]]);
    expect(localStorage.getItem("unrelated-token")).toBe("never sent");
  });

  it("forwards appearance, locale and encrypted IDs without sending plaintext IDs or their key", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    selectTheme("jade");
    selectMode("dark");
    selectLocale("en");
    const config = {
      secret: "abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890-_",
      storage_keys: { session: "superstring-session", agent: "superstring-agent" } as const,
    };
    const storage = createBrowserStateStorage(config);
    await storage.write(config.storage_keys.session, "session-uuid");
    await storage.write(config.storage_keys.agent, "agent-uuid");
    const calls = Object.fromEntries(save.mock.calls);
    expect(calls["superstring-appearance"]).toBe("jade");
    expect(calls["superstring-appearance-mode"]).toBe("dark");
    expect(calls["superstring-locale"]).toBe("en");
    for (const key of Object.values(config.storage_keys)) {
      expect(calls[key]).toBe(localStorage.getItem(key));
      expect(calls[key]).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    }
    expect(JSON.stringify(save.mock.calls)).not.toContain("session-uuid");
    expect(JSON.stringify(save.mock.calls)).not.toContain("agent-uuid");
    expect(JSON.stringify(save.mock.calls)).not.toContain(config.secret);
    expect(await storage.read(config.storage_keys.session)).toBe("session-uuid");
    await storage.write(config.storage_keys.agent, null);
    expect(save).toHaveBeenCalledTimes(5);
  });

  it("keeps normal web launches unchanged and never forwards unrelated keys", async () => {
    localStorage.setItem("superstring-locale", "en");
    const render = vi.fn().mockResolvedValue(undefined);
    await bootstrapWebApplication(render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("superstring-locale")).toBe("en");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await persistDesktopPreference("arbitrary-secret", "value");
    expect(save).not.toHaveBeenCalled();
  });

  it("reports failed desktop restoration to native UI without evaluating App or exposing the error", async () => {
    localStorage.setItem("superstring-locale", "en");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bootstrapFailed = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: vi.fn().mockRejectedValue(new Error("sensitive-path")),
      save: vi.fn().mockRejectedValue(new Error("sensitive-value")),
      bootstrapFailed,
    };
    const render = vi.fn().mockResolvedValue(undefined);
    await bootstrapWebApplication(render);
    await persistDesktopPreference("superstring-agent", "ciphertext");
    expect(render).not.toHaveBeenCalled();
    expect(bootstrapFailed.mock.calls).toEqual([[]]);
    expect(localStorage.getItem("superstring-locale")).toBe("en");
    expect(warn.mock.calls).toEqual([["DESKTOP_PREFERENCES_WRITE_FAILED"]]);
  });

  it("also reports failed App imports, while ordinary browser import failures still propagate", async () => {
    const failure = new Error("private-module-error");
    const render = vi.fn().mockRejectedValue(failure);
    const bootstrapFailed = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save: vi.fn().mockResolvedValue(undefined),
      bootstrapFailed,
    };
    await bootstrapWebApplication(render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(bootstrapFailed.mock.calls).toEqual([[]]);
    delete window.superstringPreferences;
    await expect(bootstrapWebApplication(render)).rejects.toBe(failure);
  });
});
