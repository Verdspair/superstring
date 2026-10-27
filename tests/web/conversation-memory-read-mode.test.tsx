import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import { ApiError, api } from "../../src/web/api";
import { conversationModeDirty } from "../../src/web/features/conversations/directory-state";
import { selectLocale } from "../../src/web/i18n";
import { ConversationIdentity } from "../../src/web/screens/conversations/ConversationIdentity";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const convId1 = "11111111-1111-4111-8111-111111111111";
const convId2 = "22222222-2222-4222-8222-222222222222";
const convIdQq = "33333333-3333-4333-8333-333333333333";
const qqBindingId = "44444444-4444-4444-8444-444444444444";
const now = "2026-10-27T00:00:00.000Z";

const convWeb1: ConversationSummary = {
  id: convId1,
  channel: "web",
  topology: "direct",
  sourceId: "session-web-1",
  agentId: A,
  bindingEpoch: 1,
  title: "Web Session 1",
  participants: [{ id: "user", label: "User", role: "user" }],
  updatedAt: now,
  lastSeq: 1,
  consumedSeq: 1,
};

const convWeb2: ConversationSummary = {
  id: convId2,
  channel: "web",
  topology: "direct",
  sourceId: "session-web-2",
  agentId: A,
  bindingEpoch: 1,
  title: "Web Session 2",
  participants: [{ id: "user", label: "User", role: "user" }],
  updatedAt: now,
  lastSeq: 1,
  consumedSeq: 1,
};

const convQq: ConversationSummary = {
  id: convIdQq,
  channel: "onebot11",
  topology: "shared",
  sourceId: qqBindingId,
  agentId: A,
  bindingEpoch: 2,
  title: "QQ Group Chat",
  qqGroup: { number: "123456", originalName: "Test Group", customName: null },
  participants: [{ id: "user", label: "User", role: "user" }],
  updatedAt: now,
  lastSeq: 2,
  consumedSeq: 2,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  selectLocale("zh-CN");
  const serverModes = new Map<
    string,
    { mode: "current_conversation" | "agent_shared"; revision: number }
  >([
    [convId1, { mode: "current_conversation", revision: 1 }],
    [convId2, { mode: "agent_shared", revision: 1 }],
    [convIdQq, { mode: "agent_shared", revision: 3 }],
  ]);

  store.getState().resetForTests({
    ...api,
    listConversations: vi.fn().mockImplementation(async (filter) => {
      const all = [convWeb1, convWeb2, convQq];
      const items = all.filter(
        (c) =>
          (!filter?.channel || c.channel === filter.channel) &&
          (!filter?.sourceId || c.sourceId === filter.sourceId),
      );
      return { items, nextCursor: null };
    }),
    getConversationEvents: vi.fn().mockResolvedValue({ items: [], nextSeq: 1, hasMore: false }),
    getConversationMemoryReadMode: vi.fn().mockImplementation(async (id: string) => {
      const entry = serverModes.get(id);
      return entry ? { ...entry } : { mode: "current_conversation", revision: 1 };
    }),
    saveConversationMemoryReadMode: vi.fn().mockImplementation(async (id, body) => {
      const updated = { mode: body.mode, revision: body.expected_revision + 1 };
      serverModes.set(id, updated);
      return { ...updated };
    }),
  });

  store.setState({
    page: "chat",
    conversationView: "messages",
    conversationScope: "current",
    agents: [agent],
    summaryById: {
      [convId1]: convWeb1,
      [convId2]: convWeb2,
      [convIdQq]: convQq,
    },
    directoryIds: [convId1, convId2, convIdQq],
    sessionConversationIds: {
      [convWeb1.sourceId]: convId1,
      [convWeb2.sourceId]: convId2,
    },
    currentConversationId: convId1,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("conversation memory read mode UI and store integration", () => {
  it("executes default GET on mount with zero implicit PUT and displays discoverable header pill", async () => {
    render(<ConversationIdentity conversation={convWeb1} />);

    // Header pill is immediately visible with current mode
    const pill = await screen.findByRole("button", { name: "记忆读取模式" });
    expect(within(pill).getByText("记忆读取:")).toBeTruthy();
    expect(within(pill).getByText("当前会话私有")).toBeTruthy();

    // Verified: GET was executed, but save was NOT called (zero implicit PUT)
    expect(store.getState().apiClient.getConversationMemoryReadMode).toHaveBeenCalledWith(
      convId1,
      expect.any(AbortSignal),
    );
    expect(store.getState().apiClient.saveConversationMemoryReadMode).not.toHaveBeenCalled();
  });

  it("keeps two Web sessions of the same Agent completely independent in mode and revision", async () => {
    // Session 1: mode is current_conversation rev 1
    const { rerender } = render(<ConversationIdentity conversation={convWeb1} />);
    const pill1 = await screen.findByRole("button", { name: "记忆读取模式" });
    expect(within(pill1).getByText("当前会话私有")).toBeTruthy();
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId1,
      mode: "current_conversation",
      revision: 1,
    });

    // Switch to Session 2 of the same agent: mode is agent_shared rev 1
    act(() => {
      store.setState({ currentConversationId: convId2 });
    });
    rerender(<ConversationIdentity conversation={convWeb2} />);
    const pill2 = await screen.findByRole("button", { name: "记忆读取模式" });
    expect(within(pill2).getByText("同助手共享")).toBeTruthy();
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId2,
      mode: "agent_shared",
      revision: 1,
    });
  });

  it("uses canonical conversation.id for QQ conversations, strictly not the binding sourceId", async () => {
    render(<ConversationIdentity conversation={convQq} />);

    await screen.findByRole("button", { name: "记忆读取模式" });

    // Must call API with canonical convIdQq, never the bindingId
    expect(store.getState().apiClient.getConversationMemoryReadMode).toHaveBeenCalledWith(
      convIdQq,
      expect.any(AbortSignal),
    );
    expect(store.getState().apiClient.getConversationMemoryReadMode).not.toHaveBeenCalledWith(
      qqBindingId,
      expect.anything(),
    );
  });

  it("treats unedited mode as no-op without false dirty flag or unnecessary save", async () => {
    render(<ConversationIdentity conversation={convWeb1} />);

    // Open sheet
    fireEvent.click(await screen.findByRole("button", { name: "记忆读取模式" }));

    // Unchanged mode: dirty is false
    expect(conversationModeDirty(store.getState())).toBe(false);
    const saveBtn = screen.getByRole("button", { name: "保存模式" });
    expect(saveBtn).toHaveProperty("disabled", true);

    // Explicit call to save returns true without network PUT
    expect(await store.getState().saveConversationMemoryReadMode(convId1)).toBe(true);
    expect(store.getState().apiClient.saveConversationMemoryReadMode).not.toHaveBeenCalled();
  });

  it("preserves dirty draft on 409 conflict and refreshes latest revision while keeping pending draft mode", async () => {
    const conflictError = new ApiError(
      409,
      "CONFIG_VERSION_CONFLICT",
      "会话记忆读取模式已变化，请刷新后重试",
    );
    vi.mocked(store.getState().apiClient.saveConversationMemoryReadMode).mockRejectedValueOnce(
      conflictError,
    );

    render(<ConversationIdentity conversation={convWeb1} />);

    // Open sheet
    fireEvent.click(await screen.findByRole("button", { name: "记忆读取模式" }));

    // Change mode to agent_shared
    const select = await screen.findByRole("combobox", { name: "选择模式" });
    fireEvent.change(select, { target: { value: "agent_shared" } });

    expect(conversationModeDirty(store.getState())).toBe(true);
    const saveBtn = screen.getByRole("button", { name: "保存模式" });
    expect(saveBtn).toHaveProperty("disabled", false);

    // Save fails with 409
    fireEvent.click(saveBtn);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/会话记忆读取模式已变化/)).toBeTruthy();

    // Draft is strictly preserved
    expect(store.getState().memoryReadModeDraft).toBe("agent_shared");
    expect(conversationModeDirty(store.getState())).toBe(true);

    // Backend updated to rev 2
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockResolvedValueOnce({
      mode: "current_conversation",
      revision: 2,
    });

    // User clicks refresh button
    fireEvent.click(screen.getByRole("button", { name: "刷新最新版本" }));

    await screen.findByText("版本 2");

    // Baseline updated to rev 2, but pending draft remains agent_shared
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId1,
      mode: "current_conversation",
      revision: 2,
    });
    expect(store.getState().memoryReadModeDraft).toBe("agent_shared");
    expect(conversationModeDirty(store.getState())).toBe(true);

    // Retry save succeeds with updated expected_revision: 2
    fireEvent.click(screen.getByRole("button", { name: "保存模式" }));
    await screen.findByText("版本 3");

    expect(store.getState().apiClient.saveConversationMemoryReadMode).toHaveBeenCalledWith(
      convId1,
      { mode: "agent_shared", expected_revision: 2 },
    );
    expect(conversationModeDirty(store.getState())).toBe(false);
  });

  it("discards late read response after switching conversation without overwriting current baseline or draft", async () => {
    const pending = deferred<{ mode: "current_conversation"; revision: 1 }>();
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockReturnValue(
      pending.promise,
    );

    // Load convId1 in flight
    const readPromise = store.getState().loadConversationMemoryReadMode(convId1, { force: true });

    // Switch to convId2
    act(() => {
      store.setState({
        currentConversationId: convId2,
        memoryReadModeBaseline: {
          id: convId2,
          mode: "agent_shared",
          revision: 5,
          api: store.getState().apiClient,
        },
        memoryReadModeDraft: "agent_shared",
      });
    });

    // ConvId1 read resolves late
    act(() => {
      pending.resolve({ mode: "current_conversation", revision: 1 });
    });
    await readPromise;

    // ConvId2 state must not be overwritten
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId2,
      mode: "agent_shared",
      revision: 5,
    });
    expect(store.getState().memoryReadModeDraft).toBe("agent_shared");
  });

  it("integrates with navigation guard: prompts on dirty mode, supports cancel, save, and discard", async () => {
    function Host() {
      const currentId = store((s) => s.currentConversationId);
      const conv = store((s) => (currentId ? (s.summaryById[currentId] ?? null) : null));
      return <ConversationIdentity conversation={conv} />;
    }

    render(<Host />);
    await screen.findByRole("button", { name: "记忆读取模式" });

    // 1. Edit mode draft on convWeb1
    act(() => {
      store.getState().patchConversationMemoryReadModeDraft("agent_shared");
    });
    expect(conversationModeDirty(store.getState())).toBe(true);

    // 2. Request navigation to convWeb2: intercepted by hasUnsavedDrafts
    await act(async () => {
      await store.getState().requestConversationNavigation(convId2);
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).not.toBeNull();
    expect(store.getState().currentConversationId).toBe(convId1); // stays on convId1!

    // 3. User cancels navigation
    act(() => {
      store.getState().cancelPendingNavigation();
    });
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().currentConversationId).toBe(convId1);
    expect(conversationModeDirty(store.getState())).toBe(true); // draft preserved!

    // 4. Request navigation again and confirm save
    await act(async () => {
      await store.getState().requestConversationNavigation(convId2);
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);

    await act(async () => {
      await store.getState().confirmSaveAndContinue();
    });
    // Verified: saved convId1 mode with CAS, then landed on convId2
    expect(store.getState().apiClient.saveConversationMemoryReadMode).toHaveBeenCalledWith(
      convId1,
      { mode: "agent_shared", expected_revision: 1 },
    );
    expect(store.getState().currentConversationId).toBe(convId2);

    // Host automatically re-renders with convWeb2, triggers loadMode(convId2)
    await waitFor(() =>
      expect(store.getState().memoryReadModeBaseline).toMatchObject({
        id: convId2,
        mode: "agent_shared",
        revision: 1,
      }),
    );

    // 5. On convId2, edit mode draft and test confirmDiscardAndContinue
    act(() => {
      store.getState().patchConversationMemoryReadModeDraft("current_conversation");
    });
    expect(conversationModeDirty(store.getState())).toBe(true);

    await act(async () => {
      await store.getState().requestConversationNavigation(convId1);
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);

    await act(async () => {
      await store.getState().confirmDiscardAndContinue();
    });
    // Verified: discarded draft cleanly and landed back on convId1
    expect(conversationModeDirty(store.getState())).toBe(false);
    expect(store.getState().currentConversationId).toBe(convId1);

    await waitFor(() =>
      expect(store.getState().memoryReadModeBaseline).toMatchObject({
        id: convId1,
        mode: "agent_shared",
        revision: 2,
      }),
    );
  });

  it("renders English localization cleanly with accurate limitation notices", async () => {
    selectLocale("en");

    render(<ConversationIdentity conversation={convWeb1} />);

    // Discoverable pill in header
    const pill = await screen.findByRole("button", { name: "Memory read mode" });
    expect(within(pill).getByText("Memory read:")).toBeTruthy();
    expect(within(pill).getByText("Current conversation only")).toBeTruthy();

    // Open sheet
    fireEvent.click(pill);

    expect(await screen.findByText("Conversation memory read mode")).toBeTruthy();
    expect(
      screen.getByText(
        "Strictly reads memories extracted from the current conversation only, ensuring full session isolation.",
      ),
    ).toBeTruthy();

    const select = screen.getByRole("combobox", { name: "Select mode" });
    fireEvent.change(select, { target: { value: "agent_shared" } });

    expect(
      screen.getByText(
        "Reads current conversation memories unioned with memories explicitly shared or publicly granted to this assistant; public classification does not grant access to raw private chat text.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeTruthy();
  });

  it("cancelling mode read settles promise with false and aborts in-flight request without hanging", async () => {
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockImplementation(
      () =>
        new Promise(() => {
          // never resolves on its own
        }),
    );

    // Start loading read
    const loadPromise = store.getState().loadConversationMemoryReadMode(convId1, { force: true });
    const signal = vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mock
      .calls[0]?.[1];
    if (!signal) throw new Error("Expected AbortSignal in second argument");
    expect(signal.aborted).toBe(false);

    // Cancel mode read (simulating unmount cleanup or conversation switch)
    store.getState().cancelConversationMemoryReadMode();

    expect(signal.aborted).toBe(true);
    // The promise MUST settle with false rather than hanging forever!
    const result = await loadPromise;
    expect(result).toBe(false);
  });

  it("disables mode selector and save in details sheet when mode load fails, and enables retry", async () => {
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockRejectedValueOnce(
      new Error("Network failed to load read mode"),
    );

    render(<ConversationIdentity conversation={convWeb1} />);

    // Header pill displays error retry state rather than guessing private
    const pill = await screen.findByRole("button", { name: "记忆读取模式" });
    expect(within(pill).getByText("读取失败，点击重试")).toBeTruthy();

    // Open details sheet
    fireEvent.click(pill);

    // Mode selector must be disabled and display unknown mode
    const select = screen.getByRole("combobox", { name: "选择模式" });
    expect(select).toHaveProperty("disabled", true);
    expect(screen.getByText("未确认模式")).toBeTruthy();
    expect(
      screen.getByText("当前会话的记忆读取模式尚未从服务端确认，请等待读取完成或在失败时重试。"),
    ).toBeTruthy();

    // Save and discard buttons are disabled
    expect(screen.getByRole("button", { name: "保存模式" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "放弃修改" })).toHaveProperty("disabled", true);

    // Error alert is displayed with refresh button
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Network failed to load read mode")).toBeTruthy();

    // Click retry with successful load
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockResolvedValueOnce({
      mode: "agent_shared",
      revision: 2,
    });
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "刷新最新版本" }),
    );

    await screen.findByText("版本 2");
    expect(select).toHaveProperty("disabled", false);
    expect(select).toHaveProperty("value", "agent_shared");
  });

  it("preserves dirty draft across unmount and remount, but clean mode follows server on refresh", async () => {
    const { unmount } = render(<ConversationIdentity conversation={convWeb1} />);
    await screen.findByRole("button", { name: "记忆读取模式" });

    // Make dirty edit
    act(() => {
      store.getState().patchConversationMemoryReadModeDraft("agent_shared");
    });
    expect(conversationModeDirty(store.getState())).toBe(true);

    // Simulate tab switch (DirectConversation active=false unmounts ConversationIdentity)
    unmount();

    // Re-mount on same conversation
    render(<ConversationIdentity conversation={convWeb1} />);

    // Dirty draft MUST be preserved!
    expect(store.getState().memoryReadModeDraft).toBe("agent_shared");
    expect(conversationModeDirty(store.getState())).toBe(true);

    // Discard dirty draft back to clean
    act(() => {
      store.getState().discardConversationMemoryReadMode();
    });
    expect(conversationModeDirty(store.getState())).toBe(false);

    // Remote changes to agent_shared on server
    vi.mocked(store.getState().apiClient.getConversationMemoryReadMode).mockResolvedValueOnce({
      mode: "agent_shared",
      revision: 4,
    });

    // Refresh when clean: must follow server rather than holding stale draft!
    await act(async () => {
      await store.getState().refreshConversationMemoryReadMode(convId1);
    });

    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId1,
      mode: "agent_shared",
      revision: 4,
    });
    expect(store.getState().memoryReadModeDraft).toBe("agent_shared");
    expect(conversationModeDirty(store.getState())).toBe(false); // Clean! Followed server without fake dirty!
  });

  it("automatically re-fetches baseline on the same conversation when apiClient is replaced", async () => {
    // 1. Initial render with default apiClient (resolves to current_conversation rev 1)
    const { rerender } = render(<ConversationIdentity conversation={convWeb1} />);
    const pill = await screen.findByRole("button", { name: "记忆读取模式" });
    expect(within(pill).getByText("当前会话私有")).toBeTruthy();
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId1,
      mode: "current_conversation",
      revision: 1,
    });

    // 2. Prepare new apiClient B that returns agent_shared rev 9 for convId1
    const newApiClient = {
      ...api,
      getConversationMemoryReadMode: vi.fn().mockResolvedValue({
        mode: "agent_shared" as const,
        revision: 9,
      }),
    };

    // 3. Replace apiClient in store and rerender (same conversation, but new apiClient identity)
    act(() => {
      store.setState({ apiClient: newApiClient });
    });
    rerender(<ConversationIdentity conversation={convWeb1} />);

    // 4. Identity's useEffect must automatically fire with newApiClient and update baseline
    await waitFor(() =>
      expect(newApiClient.getConversationMemoryReadMode).toHaveBeenCalledWith(
        convId1,
        expect.any(AbortSignal),
      ),
    );
    await screen.findByText("同助手共享");
    expect(store.getState().memoryReadModeBaseline).toMatchObject({
      id: convId1,
      mode: "agent_shared",
      revision: 9,
      api: newApiClient,
    });
  });
});
