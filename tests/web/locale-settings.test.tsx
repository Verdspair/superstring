// Presentation-specific cases moved to fresh-product-workspaces.test.tsx.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";

import {
  formatMessage,
  LOCALE_STORAGE_KEY,
  msg,
  readLocale,
  selectLocale,
  translateNotice,
} from "../../src/web/i18n";
import { english } from "../../src/web/i18n/en";
import { registerError } from "../../src/web/i18n/errors";
import { fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";

beforeEach(() => {
  selectLocale("zh-CN");
  useSuperstringStore.getState().resetForTests({} as SuperstringApi);
  useSuperstringStore.setState({
    status: "ready",
    bootstrap: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("locale catalog and preferences", () => {
  it("keeps concise safety, scope and fallback explanations translated", () => {
    const notes = [
      "外观修改立即生效并自动保存。",
      "仅影响当前助手；切页保留草稿，按页保存，下一新轮生效。",
      "停用并保存后，新会话不可选；已有会话不受影响。",
      "默认 100 批；达到上限仍未读完会报错，不跳过剩余记忆。",
      "仅从已授权资料中选择；未选则不读取，不回退全部。",
      "目标与硬上限控制摘要生成；读取上限控制本轮用量，留空继承硬上限。超额时临时再压缩，不截断或覆盖已存摘要。",
      "按 UTF-8 字节和消息开销估算，非模型精确 token 数。",
    ] as const;
    selectLocale("en");
    for (const note of notes) {
      expect(translateNotice(msg(note))).not.toBe(note);
      expect(translateNotice(msg(note))).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it("every English entry preserves interpolation placeholders", () => {
    for (const [key, value] of Object.entries(english)) {
      expect(value.trim(), key).not.toBe("");
      expect([...value.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(), key).toEqual(
        [...key.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(),
      );
    }
  });
  it("defaults invalid persisted values to Chinese", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "invalid");
    expect(readLocale()).toBe("zh-CN");
  });

  it("translates stored notices after changing language but preserves user parameters", () => {
    const text = msg("已创建助手「{0}」，可继续配置记忆、上下文与人设。", "中文助手");
    selectLocale("en");
    expect(translateNotice(text)).toContain("Assistant “中文助手” created");
    expect(formatMessage("en", "消息 {0}", "{0} 中文")).toBe("Message {0} 中文");
  });
  it("maps known API errors and preserves unknown diagnostics", () => {
    const known = registerError("MODEL_NOT_LOADED", "模型未加载");
    const unknown = registerError("NEW_ERROR", "原始诊断");
    const nested = msg("保存失败：{0}", known);
    selectLocale("en");
    expect(translateNotice(nested)).toBe("Save failed: Model not loaded [MODEL_NOT_LOADED]");
    expect(translateNotice(unknown)).toBe("[NEW_ERROR] 原始诊断");
  });
});

describe("general settings and status bar", () => {
  it("guards navigation into general settings with unsaved assistant changes", () => {
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      dirty: true,
    });
    useSuperstringStore.getState().requestPageNavigation("settings", "general");
    expect(useSuperstringStore.getState().settingsView).toBe("agents");
    expect(useSuperstringStore.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "settings",
      settingsView: "general",
    });
  });
});

describe("section identities", () => {
  it("new assistants cannot enter knowledge before creation", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().requestSectionNavigation("knowledge");
    expect(useSuperstringStore.getState().activeSection).toBe("A");
  });
});
