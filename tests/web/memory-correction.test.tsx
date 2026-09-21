import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryContentResponse, MemoryEntryResponse } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { MemoryCorrection } from "../../src/web/features/memory/MemoryCorrection";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const agent = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const detail: MemoryEntryResponse = {
  id,
  name: "旧记忆",
  summary: "摘要",
  tags: [],
  kinds: ["semantic"],
  body: "旧正文",
  status: "active",
  scope: "reality_user",
  scope_key: agent,
  created_at: "2026-09-19T00:00:00Z",
  config_snapshot: {},
};
const content: MemoryContentResponse = {
  content: {
    id,
    source_type: "memory",
    content_origin: "derived",
    name: "旧记忆",
    summary: "摘要",
    tags: [],
    body: "旧正文",
    revision: "a".repeat(64),
    sources: [],
    validity: "valid",
  },
  status: "active",
  corrected: false,
  retired: false,
  source_messages: [],
};

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    getMemoryContent: vi.fn().mockResolvedValue(content),
    correctMemory: vi.fn().mockResolvedValue({
      ...content,
      content: {
        ...content.content,
        id: "33333333-3333-4333-8333-333333333333",
        body: "新正文",
        revision: "b".repeat(64),
      },
      corrected: true,
    }),
  });
  store.setState({
    page: "settings",
    settingsView: "agents",
    activeSection: "B",
    editorAgentId: agent,
    memoryEntryDetail: detail,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function edit() {
  await store.getState().loadMemoryContent();
  store.getState().patchMemoryCorrection({ body: "新正文" });
}

describe("memory correction UI and navigation", () => {
  it("does not mix memory dirtiness with unsaved assistant settings", async () => {
    store.setState({ dirty: true });
    await edit();
    expect(await store.getState().saveMemoryCorrection()).toBe(true);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().memoryCorrectionDirty).toBe(false);
    expect(store.getState().memoryEntryDetail?.body).toBe("新正文");
  });
  it("preserves draft on conflict and keeps navigation open", async () => {
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        correctMemory: vi.fn().mockRejectedValue(new Error("conflict")),
      },
    });
    await edit();
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().memoryCorrectionDraft?.body).toBe("新正文");
    expect(store.getState().memoryCorrectionDirty).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
  it("saves then navigates, or explicitly discards without sending", async () => {
    await edit();
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("chat");
    expect(store.getState().memoryCorrectionDraft).toBeNull();
    store.setState({ page: "settings", settingsView: "agents", memoryEntryDetail: detail });
    await edit();
    const save = vi.spyOn(store.getState().apiClient, "correctMemory").mockClear();
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().memoryCorrectionDraft).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it("cannot clear a dirty detail or replace it with another selection", async () => {
    await edit();
    store.getState().clearMemoryDetail();
    await store.getState().loadMemoryEntryDetail("other");
    expect(store.getState().memoryEntryDetail?.id).toBe(id);
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
  it("discards only the correction without fetching clean assistant settings", async () => {
    const fetch = vi.spyOn(store.getState().apiClient, "getAgent");
    await edit();
    store.getState().requestSectionNavigation("C");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().activeSection).toBe("C");
    expect(store.getState().memoryCorrectionDraft).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a late detail response after correction editing has begun", async () => {
    let done!: (value: MemoryEntryResponse) => void;
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getMemoryEntry: vi.fn(
          () =>
            new Promise<MemoryEntryResponse>((resolve) => {
              done = resolve;
            }),
        ),
      },
    });
    const pending = store.getState().loadMemoryEntryDetail("other");
    await edit();
    done({ ...detail, id: "other" });
    await pending;
    expect(store.getState().memoryEntryDetail?.id).toBe(id);
    expect(store.getState().memoryCorrectionDraft?.body).toBe("新正文");
  });
  it("blocks governance and reload at the action boundary while a correction is dirty", async () => {
    const govern = vi.spyOn(store.getState().apiClient, "govern");
    const merge = vi.spyOn(store.getState().apiClient, "merge");
    const reload = vi.spyOn(store.getState().apiClient, "getPolicy");
    await edit();
    expect(await store.getState().governMemories(agent, [id], "purge", true)).toBe(false);
    expect(await store.getState().mergeMemories(agent, [id])).toBe(false);
    await store.getState().reloadMemory();
    expect(govern).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
  it("renders editable content and English UI without translating user text", async () => {
    render(<MemoryCorrection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看来源与纠正内容" }));
    });
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "新正文" } });
    expect(store.getState().memoryCorrectionDirty).toBe(true);
    act(() => {
      selectLocale("en");
    });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeTruthy();
    expect(screen.getByDisplayValue("新正文")).toBeTruthy();
  });
  it("disables navigation and edits until a save finishes", async () => {
    let done!: (value: MemoryContentResponse) => void;
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        correctMemory: vi.fn(
          () =>
            new Promise<MemoryContentResponse>((resolve) => {
              done = resolve;
            }),
        ),
      },
    });
    await edit();
    const pending = store.getState().saveMemoryCorrection();
    store.getState().openChat();
    store.getState().patchMemoryCorrection({ body: "changed during request" });
    expect(store.getState().page).toBe("settings");
    expect(store.getState().memoryCorrectionDraft?.body).toBe("新正文");
    done(content);
    await pending;
    expect(store.getState().memoryCorrectionSaving).toBe(false);
  });
});
