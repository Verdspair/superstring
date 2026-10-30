import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { api } from "../../src/web/api";
import { MemoryDetail, MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, memory, S, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

function received() {
  const client = setupLibrary();
  const entry = {
    ...memory,
    owner_agent_id: B,
    visibility: "public" as const,
    recipient_agent_ids: [A],
  };
  const page = {
    id: entry.id,
    owner_agent_id: B,
    reader_agent_id: A,
    conversation_id: S,
    name: entry.name,
    summary: entry.summary,
    tags: [],
    content_origin: "derived" as const,
    revision: "qualified",
    text: "RECEIVED_DERIVED 🦄",
    offset: 0,
    total: 18,
    nextOffset: null,
  };
  const api = {
    ...store.getState().apiClient,
    readMemoryEntry: vi.fn<typeof client.readMemoryEntry>().mockResolvedValue(page),
    getConversationMemoryReadMode: vi
      .fn()
      .mockResolvedValue({ conversation_id: S, mode: "agent_shared", revision: 2 }),
    listMemorySources: vi.fn().mockResolvedValue({
      memory_id: entry.id,
      entry_revision: "entry",
      source_validity: "valid",
      raw_preview: "available",
      checked_sources: 1,
      total: 1,
      nextOffset: null,
      items: [
        {
          source_key: "key",
          channel: "web",
          state: "available",
          reason: null,
          conversation_id: S,
          revision: "raw",
          expires_at: null,
          participant: "user",
          occurred_at: "now",
        },
      ],
    }),
    previewMemorySource: vi.fn().mockResolvedValue({
      memory_id: entry.id,
      source_key: "key",
      conversation_id: S,
      revision: "raw",
      expires_at: null,
      content_origin: "original",
      corrected: false,
      text: "RAW_ONLY",
      offset: 0,
      total: 8,
      nextOffset: null,
    }),
  };
  store.setState({
    apiClient: api,
    memoryEntries: [entry],
    memoryEntryDetail: null,
    memoryReadSelection: { entry, conversationId: null },
    summaryById: {
      [S]: {
        id: S,
        channel: "web",
        topology: "direct",
        sourceId: S,
        agentId: A,
        title: "Chosen conversation",
        participants: [],
        bindingEpoch: 1,
        lastSeq: 0,
        consumedSeq: 0,
        updatedAt: "2026-10-28T00:00:00.000Z",
      },
    },
  });
  return { client, api, entry, page };
}
afterEach(() => {
  cleanup();
  store.getState().cancelMemoryDetailRead();
  store.getState().cancelMemoryManagementRead();
  vi.useRealTimers();
});
describe("received readonly memory preview", () => {
  it("opens without an implicit body read, then reads as recipient and returns from original to list without owner switch", async () => {
    const f = received();
    render(<MemoryDetail />);
    expect(await screen.findByText(/请明确选择当前助手/)).toBeTruthy();
    expect(f.api.readMemoryEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "纠正" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "核验读取资格的会话" }), {
      target: { value: S },
    });
    expect(await screen.findByText("RECEIVED_DERIVED 🦄")).toBeTruthy();
    expect(f.api.readMemoryEntry).toHaveBeenCalledWith(
      A,
      memory.id,
      S,
      0,
      undefined,
      expect.any(AbortSignal),
    );
    const sourcesTab = screen.getByRole("tab", { name: "来源" });
    fireEvent.mouseDown(sourcesTab, { button: 0, ctrlKey: false });
    fireEvent.mouseUp(sourcesTab, { button: 0, ctrlKey: false });
    fireEvent.click(sourcesTab);
    await waitFor(() => expect(sourcesTab.getAttribute("aria-selected")).toBe("true"));
    await waitFor(() =>
      expect(f.api.listMemorySources).toHaveBeenCalledWith(
        A,
        memory.id,
        S,
        0,
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "查看原文" }));
    expect(await screen.findByText("RAW_ONLY")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回来源" }));
    expect(screen.queryByText("RAW_ONLY")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回记忆列表" }));
    expect(store.getState().memoryReadSelection).toBeNull();
    expect(store.getState().editorAgentId).toBe(A);
  });
  it("aborts switched canonical reads and ignores a late adapter response", async () => {
    const f = received();
    let finish!: (value: typeof f.page) => void;
    f.api.readMemoryEntry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    store.setState({ memoryReadSelection: { entry: f.entry, conversationId: S } });
    const pending = store.getState().loadMemoryReadable();
    await waitFor(() => expect(f.api.readMemoryEntry).toHaveBeenCalledTimes(1));
    const signal = f.api.readMemoryEntry.mock.calls[0]![5] as AbortSignal;
    await store.getState().selectMemoryReadConversation("");
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish(f.page);
      await pending;
    });
    expect(store.getState().memoryReadable).toBeNull();
    expect(store.getState().memoryReadLoading).toBe(false);
  });
  it("redacts a loaded raw page at its retention cap and does not send stale tokens to a replacement API", async () => {
    const f = received();
    store.setState({ memoryReadSelection: { entry: f.entry, conversationId: S } });
    f.api.previewMemorySource.mockResolvedValueOnce({
      memory_id: f.entry.id,
      source_key: "key",
      conversation_id: S,
      revision: "raw",
      expires_at: new Date(Date.now() + 1000).toISOString(),
      content_origin: "original",
      corrected: false,
      text: "EXPIRING_RAW",
      offset: 0,
      total: 12,
      nextOffset: null,
    });
    await store.getState().loadMemorySourcePreview("key", "raw");
    expect(store.getState().memorySourcePreview?.text).toBe("EXPIRING_RAW");
    store.getState().cancelMemoryDetailRead();
    expect(store.getState().memorySourcePreview).toBeNull();
    let finish!: (value: {
      conversation_id: string;
      mode: "agent_shared";
      revision: number;
    }) => void;
    f.api.getConversationMemoryReadMode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.getState().loadMemorySourcePreview("key", "raw");
    await waitFor(() => expect(f.api.getConversationMemoryReadMode).toHaveBeenCalledTimes(2));
    const replacement = { ...f.api, previewMemorySource: vi.fn() };
    store.setState({ apiClient: replacement });
    await act(async () => {
      finish({ conversation_id: S, mode: "agent_shared", revision: 2 });
      await pending;
    });
    expect(replacement.previewMemorySource).not.toHaveBeenCalled();
    expect(store.getState().memorySourcePreview).toBeNull();
  });

  it("expires visible raw plaintext through the shared source expiry owner", async () => {
    const f = received();
    store.setState({ memoryReadSelection: { entry: f.entry, conversationId: S } });
    const cap = new Date(Date.now() + 1000).toISOString();
    f.api.previewMemorySource.mockResolvedValueOnce({
      memory_id: f.entry.id,
      source_key: "key",
      conversation_id: S,
      revision: "raw",
      expires_at: cap,
      content_origin: "original",
      corrected: false,
      text: "EXPIRING_RAW",
      offset: 0,
      total: 12,
      nextOffset: null,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const read = store.getState().loadMemorySourcePreview("key", "raw");
    await vi.advanceTimersByTimeAsync(0);
    await read;
    expect(store.getState().memorySourcePreview?.text).toBe("EXPIRING_RAW");
    await vi.advanceTimersByTimeAsync(1001);
    expect(store.getState().memorySourcePreview).toBeNull();
    expect(store.getState().memoryReadError).toContain("到期");
  });

  it("advances the owner selected identity with an immutable correction before reading replacement sources", async () => {
    const client = setupLibrary();
    store.setState({
      memoryEntries: [memory],
      memoryEntryDetail: memory,
      memoryReadSelection: { entry: memory, conversationId: null },
    });
    await store.getState().loadMemoryContent();
    const original = store.getState().memoryContent!;
    const replacement = "88888888-8888-4888-8888-888888888888";
    vi.mocked(client.correctMemory).mockResolvedValueOnce({
      ...original,
      content: { ...original.content, id: replacement },
      corrected: true,
    });
    store.getState().patchMemoryCorrection({ body: "new corrected fact" });
    expect(await store.getState().saveMemoryCorrection()).toBe(true);
    expect(store.getState().memoryEntryDetail?.id).toBe(replacement);
    expect(store.getState().memoryReadSelection?.entry.id).toBe(replacement);
    const listSources = vi.fn().mockResolvedValue({
      memory_id: replacement,
      entry_revision: "replacement",
      source_validity: "valid",
      raw_preview: "unknown",
      checked_sources: 0,
      total: 0,
      nextOffset: null,
      items: [],
    });
    store.setState({
      apiClient: { ...store.getState().apiClient, listMemorySources: listSources },
    });
    await store.getState().loadMemorySources();
    expect(listSources).toHaveBeenCalledWith(A, replacement, undefined, 0, expect.any(AbortSignal));
  });

  it("preserves only the raw address and offset across suspension, then revalidates that exact page", async () => {
    const f = received();
    store.setState({ memoryReadSelection: { entry: f.entry, conversationId: S } });
    f.api.previewMemorySource.mockResolvedValueOnce({
      memory_id: f.entry.id,
      source_key: "key",
      conversation_id: S,
      revision: "raw",
      expires_at: null,
      content_origin: "original",
      corrected: false,
      text: "PAGE_TWO",
      offset: 4096,
      total: 4104,
      nextOffset: null,
    });
    await store.getState().loadMemorySourcePreview("key", "raw", 4096);
    store.getState().cancelMemoryDetailRead();
    expect(store.getState().memorySourcePreview).toBeNull();
    expect(store.getState().memorySourcePosition).toEqual({
      sourceKey: "key",
      revision: "raw",
      offset: 4096,
    });
    await store.getState().resumeMemorySources();
    expect(f.api.previewMemorySource).toHaveBeenLastCalledWith(
      A,
      memory.id,
      "key",
      "raw",
      S,
      4096,
      expect.any(AbortSignal),
    );
  });

  it("resolves the main-list explicit history principal while preserving the independent origin filter and original Agent", async () => {
    const root = "99999999-9999-4999-8999-999999999991",
      active = "99999999-9999-4999-8999-999999999992";
    const client = setupLibrary({
      getConversationMemoryReadMode: vi
        .fn()
        .mockResolvedValue({ conversation_id: active, mode: "current_conversation", revision: 1 }),
      saveConversationMemoryReadMode: vi.fn(),
    });
    store.setState({
      summaryById: {
        [root]: {
          id: root,
          channel: "onebot11",
          topology: "shared",
          sourceId: B,
          agentId: A,
          title: "QQ history with two epochs",
          participants: [],
          bindingEpoch: 2,
          lastSeq: 2,
          consumedSeq: 0,
          updatedAt: "2026-10-28T00:00:00.000Z",
        },
      },
    });
    render(<MemoryLibrary active />);
    await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(1));
    expect(client.getConversationMemoryReadMode).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "核验读取资格的会话" }), {
      target: { value: root },
    });
    await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(2));
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(
      A,
      0,
      100,
      expect.objectContaining({ conversation_id: active }),
      expect.any(AbortSignal),
    );
    expect(client.getConversationMemoryReadMode).toHaveBeenCalledWith(
      root,
      expect.any(AbortSignal),
    );
    await store
      .getState()
      .loadMemoryManagement(
        2,
        { conversation_id: root, origin_conversation_id: root },
        { metadata: true },
      );
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(
      A,
      100,
      100,
      { conversation_id: active, origin_conversation_id: root },
      expect.any(AbortSignal),
    );
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().currentConversationId).toBeNull();
    expect(store.getState().memoryReadModeBaseline).toBeNull();
    expect(client.saveConversationMemoryReadMode).not.toHaveBeenCalled();
  });

  it("does not list a principal with no active canonical or belonging to another Agent, and never selects a default", async () => {
    const client = setupLibrary({
      getConversationMemoryReadMode: vi
        .fn()
        .mockRejectedValue(new Error("Current conversation unavailable")),
    });
    const root = "99999999-9999-4999-8999-999999999993";
    expect(
      await store
        .getState()
        .loadMemoryManagement(1, { conversation_id: root }, { metadata: false }),
    ).toBe(false);
    expect(client.listMemoryEntries).not.toHaveBeenCalled();
    expect(store.getState().memoryManagementError).toContain("Current conversation unavailable");
    store.setState({
      summaryById: {
        [root]: {
          id: root,
          channel: "onebot11",
          topology: "shared",
          sourceId: B,
          agentId: B,
          title: "Other Agent",
          participants: [],
          bindingEpoch: 2,
          lastSeq: 1,
          consumedSeq: 0,
          updatedAt: "now",
        },
      },
    });
    vi.mocked(client.getConversationMemoryReadMode).mockClear();
    expect(
      await store
        .getState()
        .loadMemoryManagement(1, { conversation_id: root }, { metadata: false }),
    ).toBe(false);
    expect(client.getConversationMemoryReadMode).not.toHaveBeenCalled();
    expect(client.listMemoryEntries).not.toHaveBeenCalled();
    expect(
      await store
        .getState()
        .loadMemoryManagement(1, { origin_conversation_id: root }, { metadata: false }),
    ).toBe(true);
    expect(client.getConversationMemoryReadMode).not.toHaveBeenCalled();
    expect(client.listMemoryEntries).toHaveBeenCalledWith(
      A,
      0,
      100,
      { origin_conversation_id: root },
      expect.any(AbortSignal),
    );
  });

  it("aborts principal resolution when selection changes and ignores an adapter that resolves after abort", async () => {
    const root = "99999999-9999-4999-8999-999999999994",
      active = "99999999-9999-4999-8999-999999999995";
    let finish!: (value: {
      conversation_id: string;
      mode: "current_conversation";
      revision: number;
    }) => void;
    const resolve = vi
      .fn<typeof api.getConversationMemoryReadMode>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      )
      .mockResolvedValue({ conversation_id: active, mode: "current_conversation", revision: 1 });
    const client = setupLibrary({ getConversationMemoryReadMode: resolve });
    const previous = store
      .getState()
      .loadMemoryManagement(1, { conversation_id: root }, { metadata: false });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    const signal = resolve.mock.calls[0]![1]!;
    const current = store
      .getState()
      .loadMemoryManagement(1, { search: "new selection" }, { metadata: false });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish({ conversation_id: active, mode: "current_conversation", revision: 1 });
      await previous;
      await current;
    });
    expect(client.listMemoryEntries).toHaveBeenCalledTimes(1);
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(
      A,
      0,
      100,
      { search: "new selection" },
      expect.any(AbortSignal),
    );
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("never combines an old explicit principal with a replacement API after asynchronous resolution", async () => {
    const root = "99999999-9999-4999-8999-999999999996",
      active = "99999999-9999-4999-8999-999999999997";
    let finish!: (value: {
      conversation_id: string;
      mode: "current_conversation";
      revision: number;
    }) => void;
    const resolve = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const client = setupLibrary({ getConversationMemoryReadMode: resolve });
    const pending = store
      .getState()
      .loadMemoryManagement(1, { conversation_id: root }, { metadata: false });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    const replacement = {
      ...client,
      listMemoryEntries: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    store.setState({ apiClient: replacement });
    await act(async () => {
      finish({ conversation_id: active, mode: "current_conversation", revision: 1 });
      await pending;
    });
    expect(client.listMemoryEntries).not.toHaveBeenCalled();
    expect(replacement.listMemoryEntries).not.toHaveBeenCalled();
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("settles a cancelled principal read without issuing policy or list requests even if its resolver ignores abort", async () => {
    let finish!: (value: {
      conversation_id: string;
      mode: "current_conversation";
      revision: number;
    }) => void;
    const resolver = vi.fn<typeof api.getConversationMemoryReadMode>().mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const client = setupLibrary({ getConversationMemoryReadMode: resolver });
    const filters = { conversation_id: S, origin_conversation_id: B };
    const pending = store.getState().loadMemoryManagement(1, filters, { metadata: true });
    await waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    filters.conversation_id = B;
    store.getState().cancelMemoryManagementRead();
    expect(resolver.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => {
      finish({ conversation_id: S, mode: "current_conversation", revision: 1 });
      await pending;
    });
    expect(resolver).toHaveBeenCalledWith(S, expect.any(AbortSignal));
    expect(client.getPolicy).not.toHaveBeenCalled();
    expect(client.listMemoryEntries).not.toHaveBeenCalled();
    expect(store.getState().memoryManagementLoading).toBe(false);
  });
  it("keeps an owned original source page and offset through a management refresh without metadata self-cancelling it", async () => {
    const f = received();
    const owned = { ...memory, owner_agent_id: A };
    store.setState({
      memoryEntries: [owned],
      memoryEntryDetail: owned,
      memoryReadSelection: { entry: owned, conversationId: null },
    });
    let finish!: (value: Awaited<ReturnType<typeof f.api.previewMemorySource>>) => void;
    f.api.previewMemorySource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = store.getState().loadMemorySourcePreview("key", "raw", 4096);
    await waitFor(() => expect(f.api.previewMemorySource).toHaveBeenCalledTimes(1));
    const signal = f.api.previewMemorySource.mock.calls[0]![6]!;
    const management = store
      .getState()
      .loadMemoryManagement(1, {}, { metadata: false, preserveDetail: true });
    await management;
    const getMemoryAccessMetadata = vi.fn().mockResolvedValue({
      owner_agent_id: A,
      visibility: "session_private",
      visibility_revision: 1,
      recipient_agent_ids: [],
      origins: [],
      origin_complete: true,
      source_validity: "valid",
      runtime_eligibility: "unknown",
      raw_preview: "unknown",
    });
    f.api.getMemoryAccessMetadata = getMemoryAccessMetadata;
    await store.getState().loadMemoryAccessMetadata(memory.id);
    expect(signal.aborted).toBe(false);
    finish({
      memory_id: memory.id,
      source_key: "key",
      conversation_id: S,
      revision: "raw",
      expires_at: null,
      content_origin: "original",
      corrected: false,
      text: "OWNED_PAGE_TWO",
      offset: 4096,
      total: 4110,
      nextOffset: null,
    });
    await reading;
    expect(store.getState().memorySourcePreview?.text).toBe("OWNED_PAGE_TWO");
    expect(store.getState().memoryEntryDetail?.id).toBe(memory.id);
    store.getState().cancelMemoryDetailRead();
    expect(store.getState().memorySourcePreview).toBeNull();
    expect(store.getState().memorySourcePosition?.offset).toBe(4096);
    await store.getState().resumeMemorySources();
    expect(f.api.previewMemorySource).toHaveBeenLastCalledWith(
      A,
      memory.id,
      "key",
      "raw",
      undefined,
      4096,
      expect.any(AbortSignal),
    );
  });

  it("redacts a revoked owned raw reference during restore and never revives its previous page", async () => {
    const f = received();
    const owned = { ...memory, owner_agent_id: A };
    store.setState({
      memoryEntries: [owned],
      memoryEntryDetail: owned,
      memoryReadSelection: { entry: owned, conversationId: null },
    });
    await store.getState().loadMemorySourcePreview("key", "raw", 0);
    expect(store.getState().memorySourcePreview?.text).toBe("RAW_ONLY");
    store.getState().cancelMemoryDetailRead();
    f.api.previewMemorySource.mockRejectedValueOnce(new Error("source authorization revoked"));
    await store.getState().resumeMemorySources();
    expect(store.getState().memorySourcePreview).toBeNull();
    expect(store.getState().memorySourcePosition).toBeNull();
    expect(store.getState().memoryReadError).toContain("source authorization revoked");
    expect(store.getState().memoryEntryDetail?.body).toBe("");
  });

  it("does not reuse a saved raw locator in a replacement API during automatic restore", async () => {
    const f = received();
    store.setState({ memoryReadSelection: { entry: f.entry, conversationId: S } });
    await store.getState().loadMemorySourcePreview("key", "raw", 0);
    store.getState().cancelMemoryDetailRead();
    const previewMemorySource = vi.fn(),
      listMemorySources = vi.fn().mockResolvedValue({
        memory_id: memory.id,
        entry_revision: "new",
        source_validity: "unknown",
        raw_preview: "unknown",
        checked_sources: 0,
        total: 0,
        nextOffset: null,
        items: [],
      });
    store.setState({ apiClient: { ...f.api, previewMemorySource, listMemorySources } });
    await store.getState().resumeMemorySources();
    expect(previewMemorySource).not.toHaveBeenCalled();
    expect(listMemorySources).toHaveBeenCalledTimes(1);
    expect(store.getState().memorySourcePosition).toBeNull();
    expect(store.getState().memorySourcePreview).toBeNull();
  });
});

it("restores the received list opener after explicit qualification and source-tab inspection", async () => {
  const f = received();
  f.api.listMemoryEntries = vi.fn().mockResolvedValue({ items: [f.entry], total: 1 });
  store.setState({ memoryReadSelection: null });
  render(<MemoryLibrary active />);
  const opener = await screen.findByRole("button", { name: f.entry.name });
  await userEvent.click(opener);
  expect(f.api.readMemoryEntry).not.toHaveBeenCalled();
  await userEvent.selectOptions(
    screen
      .getAllByRole("combobox", { name: "核验读取资格的会话" })
      .find((element) => element.closest('[role="dialog"]'))!,
    S,
  );
  await waitFor(() => expect(f.api.readMemoryEntry).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("tab", { name: "来源" }));
  await waitFor(() => expect(f.api.listMemorySources).toHaveBeenCalledTimes(1));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(opener.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(store.getState().editorAgentId).toBe(A);
  expect(f.api.readMemoryEntry).toHaveBeenCalledWith(
    A,
    memory.id,
    S,
    0,
    undefined,
    expect.any(AbortSignal),
  );
  expect(f.api.listMemorySources).toHaveBeenCalledWith(A, memory.id, S, 0, expect.any(AbortSignal));
});
