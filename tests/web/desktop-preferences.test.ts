import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_STORAGE_KEY,
  INTERFACE_SIZE_STORAGE_KEY,
  TEXT_SIZE_STORAGE_KEY,
} from "../../src/shared/appearance";
import {
  CLOSE_ANIMATION_STORAGE_KEY,
  DESKTOP_PREFERENCE_KEYS,
  type DesktopPreferenceSnapshot,
  isCloseAnimationEnabled,
} from "../../src/shared/desktop-preferences";
import {
  selectFont,
  selectInterfaceSize,
  selectMode,
  selectTextSize,
  selectTheme,
} from "../../src/web/appearance";
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
    expect(save.mock.calls).toEqual([[{ "superstring-appearance": "rose" }]]);
    expect(localStorage.getItem("unrelated-token")).toBe("never sent");
  });

  it("restores, tombstones and adopts the font across the nine-key whitelist", async () => {
    // The font rides the same bridge: the whitelist grew by the font, both size axes and
    // the close fold, and nothing else may join it.
    expect(DESKTOP_PREFERENCE_KEYS).toEqual([
      "superstring-appearance",
      "superstring-appearance-mode",
      FONT_STORAGE_KEY,
      TEXT_SIZE_STORAGE_KEY,
      INTERFACE_SIZE_STORAGE_KEY,
      "superstring-locale",
      "superstring-session",
      "superstring-agent",
      CLOSE_ANIMATION_STORAGE_KEY,
    ]);
    localStorage.setItem(FONT_STORAGE_KEY, "cute");
    const adopt = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "en" }),
      save: adopt,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("cute");
    expect(adopt.mock.calls).toEqual([[{ [FONT_STORAGE_KEY]: "cute" }]]);

    // A desktop tombstone clears an older browser choice instead of re-saving it.
    const tombstone = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "en", [FONT_STORAGE_KEY]: null }),
      save: tombstone,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    expect(tombstone).not.toHaveBeenCalled();

    // The saved desktop value wins over the browser value and is never echoed back.
    const canonical = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "en", [FONT_STORAGE_KEY]: "elegant" }),
      save: canonical,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("elegant");
    expect(canonical).not.toHaveBeenCalled();
  });

  it("keeps the close fold enabled unless the stored value is exactly off", async () => {
    expect(isCloseAnimationEnabled(undefined)).toBe(true);
    expect(isCloseAnimationEnabled(null)).toBe(true);
    expect(isCloseAnimationEnabled("on")).toBe(true);
    expect(isCloseAnimationEnabled("off")).toBe(false);
    expect(isCloseAnimationEnabled("true")).toBe(true);

    // A browser-only choice is adopted once, so an existing profile keeps its stored rule.
    localStorage.setItem(CLOSE_ANIMATION_STORAGE_KEY, "off");
    const adopt = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save: adopt,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(adopt.mock.calls).toEqual([[{ [CLOSE_ANIMATION_STORAGE_KEY]: "off" }]]);

    // A desktop tombstone clears the older browser choice instead of re-saving it.
    const tombstone = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ [CLOSE_ANIMATION_STORAGE_KEY]: null }),
      save: tombstone,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY)).toBeNull();
    expect(tombstone).not.toHaveBeenCalled();

    // The saved desktop value wins over the browser value and is never echoed back.
    const canonical = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ [CLOSE_ANIMATION_STORAGE_KEY]: "on" }),
      save: canonical,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY)).toBe("on");
    expect(canonical).not.toHaveBeenCalled();
  });

  it("adopts, tombstones and keeps both size axes inside the desktop whitelist", async () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "large");
    localStorage.setItem(INTERFACE_SIZE_STORAGE_KEY, "compact");
    localStorage.setItem("unrelated-token", "never sent");
    const adopt = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "zh-CN" }),
      save: adopt,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    // Cold adoption carries every missing known key in one snapshot write.
    expect(adopt.mock.calls).toEqual([
      [{ [TEXT_SIZE_STORAGE_KEY]: "large", [INTERFACE_SIZE_STORAGE_KEY]: "compact" }],
    ]);
    expect(localStorage.getItem("unrelated-token")).toBe("never sent");

    // A desktop tombstone clears an older browser size choice instead of re-saving it.
    const tombstone = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({ "superstring-locale": "zh-CN", [TEXT_SIZE_STORAGE_KEY]: null }),
      save: tombstone,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBeNull();
    expect(tombstone.mock.calls).toEqual([[{ [INTERFACE_SIZE_STORAGE_KEY]: "compact" }]]);

    // The saved desktop size wins over the browser value and is never echoed back.
    const canonical = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({
        "superstring-locale": "zh-CN",
        [INTERFACE_SIZE_STORAGE_KEY]: "comfortable",
      }),
      save: canonical,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(localStorage.getItem(INTERFACE_SIZE_STORAGE_KEY)).toBe("comfortable");
    expect(canonical).not.toHaveBeenCalled();
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
    selectFont("elegant");
    selectTextSize("large");
    selectInterfaceSize("compact");
    selectLocale("en");
    const config = {
      secret: "abcdefghijklmnopqrstuvwxyzABCDEFGH1234567890-_",
      storage_keys: { session: "superstring-session", agent: "superstring-agent" } as const,
    };
    const storage = createBrowserStateStorage(config);
    await storage.write(config.storage_keys.session, "session-uuid");
    await storage.write(config.storage_keys.agent, "agent-uuid");
    // Mutations stay one single-key snapshot per user action.
    expect(save.mock.calls.every(([snapshot]) => Object.keys(snapshot ?? {}).length === 1)).toBe(
      true,
    );
    const calls = Object.assign(
      {},
      ...save.mock.calls.map(([snapshot]) => snapshot as Record<string, string | null>),
    );
    expect(calls["superstring-appearance"]).toBe("jade");
    expect(calls["superstring-appearance-mode"]).toBe("dark");
    expect(calls[FONT_STORAGE_KEY]).toBe("elegant");
    expect(calls[TEXT_SIZE_STORAGE_KEY]).toBe("large");
    expect(calls[INTERFACE_SIZE_STORAGE_KEY]).toBe("compact");
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
    expect(save).toHaveBeenCalledTimes(8);
  });

  it("adopts every missing known key in one batched snapshot save", async () => {
    const localValues = {
      "superstring-appearance": "jade",
      "superstring-appearance-mode": "dark",
      [FONT_STORAGE_KEY]: "cute",
      [TEXT_SIZE_STORAGE_KEY]: "large",
      [INTERFACE_SIZE_STORAGE_KEY]: "compact",
      "superstring-session": "session-ciphertext",
      "superstring-agent": "agent-ciphertext",
      [CLOSE_ANIMATION_STORAGE_KEY]: "off",
    };
    for (const [key, value] of Object.entries(localValues)) localStorage.setItem(key, value);
    localStorage.setItem("unrelated-token", "never sent");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toEqual(localValues);
    expect(localStorage.getItem("unrelated-token")).toBe("never sent");
  });

  it("never writes when the desktop store already owns every known key", async () => {
    const stored = Object.fromEntries(
      DESKTOP_PREFERENCE_KEYS.map((key) => [key, key === "superstring-locale" ? "en" : null]),
    ) as DesktopPreferenceSnapshot;
    for (const key of DESKTOP_PREFERENCE_KEYS) localStorage.setItem(key, "browser-value");
    const save = vi.fn().mockResolvedValue(undefined);
    window.superstringPreferences = {
      load: async () => stored,
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("superstring-locale")).toBe("en");
  });

  it("keeps adopted local values usable when the batched save fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(FONT_STORAGE_KEY, "cute");
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "large");
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    window.superstringPreferences = {
      load: async () => ({}),
      save,
      bootstrapFailed: vi.fn().mockResolvedValue(undefined),
    };
    await restoreDesktopPreferences();
    expect(save).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([["DESKTOP_PREFERENCES_WRITE_FAILED"]]);
    expect(localStorage.getItem(FONT_STORAGE_KEY)).toBe("cute");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
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
