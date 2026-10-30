import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { MemoryDetail, MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, memory, memoryContent, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const originalLoadMemoryContent = store.getState().loadMemoryContent;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  store.setState({ loadMemoryContent: originalLoadMemoryContent });
});
it("retains a memory detail but does not display or read it while its panel is inactive", async () => {
  setupLibrary();
  const load = vi.spyOn(store.getState(), "loadMemoryContent").mockResolvedValue(undefined);
  store.setState({ memoryEntryDetail: memory, memoryContent });
  const view = render(<MemoryDetail active={false} />);
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<MemoryDetail active />);
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(<MemoryDetail active={false} />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.getState().memoryEntryDetail).toEqual({ ...memory, body: "" });
  expect(load).toHaveBeenCalledTimes(1);
});

it("keeps the owned sheet and current tab through hidden management restore and revalidates content once", async () => {
  let hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  const client = setupLibrary();
  render(<MemoryLibrary active />);
  await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(1));
  await act(async () => store.getState().loadMemoryEntryDetail(memory.id));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(client.getMemoryContent).toHaveBeenCalledTimes(1));
  expect(store.getState().memoryContent?.content.body).toBe(memoryContent.content.body);
  act(() => {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(store.getState().memoryContent).toBeNull();
  expect(store.getState().memoryEntryDetail?.id).toBe(memory.id);
  expect(store.getState().memoryEntryDetail?.body).toBe("");
  act(() => {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  });
  await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(client.getMemoryContent).toHaveBeenCalledTimes(2));
  expect(store.getState().memoryEntryDetail?.id).toBe(memory.id);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "正文" }).getAttribute("aria-selected")).toBe("true");
  expect(store.getState().memoryContent?.content.body).toBe(memoryContent.content.body);
  expect(client.correctMemory).not.toHaveBeenCalled();
});

it("preserves a dirty correction across hidden resume without cancelling it or replacing its baseline", async () => {
  let hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  const client = setupLibrary();
  store.setState({ memoryEntryDetail: memory });
  render(<MemoryDetail active />);
  await waitFor(() => expect(store.getState().memoryCorrectionDraft).not.toBeNull());
  act(() => store.getState().patchMemoryCorrection({ body: "local correction draft" }));
  const draft = store.getState().memoryCorrectionDraft;
  act(() => {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  });
  act(() => {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  });
  await act(async () => {});
  expect(store.getState().memoryCorrectionDraft).toBe(draft);
  expect(store.getState().memoryCorrectionDirty).toBe(true);
  expect(client.getMemoryContent).toHaveBeenCalledTimes(1);
  expect(client.correctMemory).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("does not revive old owner plaintext after failed foreground revalidation", async () => {
  let hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  const client = setupLibrary();
  store.setState({ memoryEntryDetail: memory });
  render(<MemoryDetail active />);
  await waitFor(() => expect(store.getState().memoryContent).not.toBeNull());
  vi.mocked(client.getMemoryContent).mockRejectedValueOnce(new Error("ownership revoked"));
  act(() => {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  });
  act(() => {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  });
  await waitFor(() => expect(store.getState().memoryReadError).toContain("ownership revoked"));
  expect(store.getState().memoryContent).toBeNull();
  expect(store.getState().memoryCorrectionDraft).toBeNull();
  expect(screen.queryByText(memoryContent.content.body!)).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("retains the owned sources tab and raw offset after hidden resume without closing the sheet", async () => {
  let hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  const previewMemorySource = vi.fn<SuperstringApi["previewMemorySource"]>(
    async (_a, _m, _key, _revision, _conversation, offset) => ({
      memory_id: memory.id,
      source_key: "source",
      conversation_id: "source-conversation",
      revision: "raw",
      expires_at: null,
      content_origin: "original" as const,
      corrected: false,
      text: "SOURCE_PAGE_2",
      offset: offset ?? 0,
      total: 5000,
      nextOffset: null,
    }),
  );
  const client = setupLibrary({
    previewMemorySource,
    listMemorySources: vi.fn<SuperstringApi["listMemorySources"]>(async () => ({
      memory_id: memory.id,
      entry_revision: "r",
      source_validity: "valid",
      raw_preview: "available",
      checked_sources: 0,
      total: 0,
      nextOffset: null,
      items: [],
    })),
  });
  render(<MemoryLibrary active />);
  await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(1));
  await act(async () => store.getState().loadMemoryEntryDetail(memory.id));
  const sources = screen.getByRole("tab", { name: "来源" });
  fireEvent.mouseDown(sources, { button: 0, ctrlKey: false });
  fireEvent.mouseUp(sources, { button: 0, ctrlKey: false });
  fireEvent.click(sources);
  await waitFor(() => expect(sources.getAttribute("aria-selected")).toBe("true"));
  await act(async () => store.getState().loadMemorySourcePreview("source", "raw", 4096));
  expect(store.getState().memorySourcePreview?.offset).toBe(4096);
  act(() => {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(store.getState().memorySourcePreview).toBeNull();
  act(() => {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  });
  await waitFor(() => expect(previewMemorySource).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(store.getState().memorySourcePreview?.offset).toBe(4096));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "来源" }).getAttribute("aria-selected")).toBe("true");
  expect(client.listMemoryEntries).toHaveBeenCalledTimes(2);
});

it("restores the actual async owned detail opener after tab inspection and Escape", async () => {
  let resolve!: (value: typeof memory) => void;
  const client = setupLibrary({
    getMemoryEntry: vi.fn<SuperstringApi["getMemoryEntry"]>(
      () =>
        new Promise<Awaited<ReturnType<SuperstringApi["getMemoryEntry"]>>>((done) => {
          resolve = done;
        }),
    ),
  });
  render(<MemoryLibrary active />);
  const opener = await screen.findByRole("button", { name: memory.name });
  await userEvent.click(opener);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => resolve(memory));
  await waitFor(() => expect(store.getState().memoryContent).not.toBeNull());
  await userEvent.click(screen.getByRole("tab", { name: "配置快照" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(opener.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(client.getMemoryEntry).toHaveBeenCalledTimes(1);
  expect(client.getMemoryContent).toHaveBeenCalledTimes(1);
  expect(client.correctMemory).not.toHaveBeenCalled();
});

it("keeps the dirty memory confirmation focus inside the detail until an explicit discard closes it", async () => {
  const client = setupLibrary();
  render(<MemoryLibrary active />);
  const opener = await screen.findByRole("button", { name: memory.name });
  await userEvent.click(opener);
  await waitFor(() => expect(store.getState().memoryCorrectionDraft).not.toBeNull());
  act(() => store.getState().patchMemoryCorrection({ body: "dirty local correction" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
  expect(store.getState().memoryCorrectionDirty).toBe(true);
  expect(store.getState().memoryEntryDetail?.id).toBe(memory.id);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(store.getState().memoryCorrectionDraft?.body).toBe("dirty local correction");
  expect(document.activeElement).not.toBe(opener);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
  const buttons = Array.from(
    screen.getByRole("alertdialog").querySelectorAll<HTMLButtonElement>("button"),
  );
  const discard = buttons.find((button) => button.textContent?.trim() === "确认");
  if (!discard) throw new Error("discard confirmation missing");
  await userEvent.click(discard);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(client.correctMemory).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("loads replacement metadata once after a mounted immutable correction without retaining old publication fields", async () => {
  const replacementId = "88888888-8888-4888-8888-888888888888";
  const oldEntry = {
    ...memory,
    visibility: "public" as const,
    visibility_revision: 7,
    recipient_agent_ids: [B],
  };
  const oldMetadata: Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>> = {
    visibility: "public",
    visibility_revision: 7,
    recipient_agent_ids: [B],
    origins: memory.origins,
    origin_complete: true,
    source_validity: "valid",
    runtime_eligibility: "unknown",
    raw_preview: "unknown",
  };
  const newMetadata = {
    ...oldMetadata,
    visibility: "session_private" as const,
    visibility_revision: 1,
    recipient_agent_ids: [],
  };
  const replacementContent = {
    ...memoryContent,
    content: {
      ...memoryContent.content,
      id: replacementId,
      name: "Corrected memory",
      body: "Corrected fact",
      revision: "b".repeat(64),
    },
    corrected: true,
  };
  const correction = deferred<Awaited<ReturnType<SuperstringApi["correctMemory"]>>>();
  const metadata = deferred<Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>>>();
  const replacementReads: AbortSignal[] = [];
  const client = setupLibrary({
    listMemoryEntries: vi.fn().mockResolvedValue({ items: [oldEntry], total: 1 }),
    getMemoryEntry: vi.fn().mockResolvedValue(oldEntry),
    getMemoryContent: vi.fn<SuperstringApi["getMemoryContent"]>(async (_agentId, id) =>
      id === replacementId ? replacementContent : memoryContent,
    ),
    correctMemory: vi.fn<SuperstringApi["correctMemory"]>(() => correction.promise),
    getMemoryAccessMetadata: vi.fn<SuperstringApi["getMemoryAccessMetadata"]>(
      async (_agentId, id, signal) => {
        if (id !== replacementId) return oldMetadata;
        if (!signal) throw new Error("metadata transport must carry a cancellation signal");
        replacementReads.push(signal);
        return metadata.promise;
      },
    ),
  });
  render(<MemoryLibrary active />);
  try {
    await userEvent.click(await screen.findByRole("button", { name: memory.name }));
    await waitFor(() => expect(store.getState().memoryMetadataBaseline?.revision).toBe(7));
    await userEvent.click(screen.getByRole("tab", { name: "纠正" }));
    const body = await screen.findByLabelText("记忆正文");
    await userEvent.clear(body);
    await userEvent.type(body, "Corrected fact");
    await userEvent.click(screen.getByRole("button", { name: "保存纠正" }));
    await waitFor(() => expect(client.correctMemory).toHaveBeenCalledTimes(1));
    await act(async () => correction.resolve(replacementContent));
    await waitFor(() => expect(store.getState().memoryEntryDetail?.id).toBe(replacementId));
    await waitFor(() => expect(replacementReads.length).toBeGreaterThan(0));
    await act(async () => {});

    expect.soft(replacementReads).toHaveLength(1);
    expect.soft(replacementReads.every((signal) => !signal.aborted)).toBe(true);
    expect.soft(store.getState().memoryMetadata).toBeNull();
    expect.soft(store.getState().memoryMetadataBaseline).toBeNull();
    expect.soft(store.getState().memoryVisibilityDraft).toBeNull();
    expect.soft(store.getState().memoryReadSelection?.entry.recipient_agent_ids).not.toContain(B);
    expect.soft(store.getState().memoryReadSelection?.entry.visibility).not.toBe("public");
    await userEvent.click(screen.getByRole("tab", { name: "来源与共享" }));
    const visibility = screen.getByRole("combobox", { name: "来源与共享" });
    expect(visibility).toHaveProperty("disabled", true);

    await act(async () => metadata.resolve(newMetadata));
    await waitFor(() => expect(visibility).toHaveProperty("disabled", false));
    expect(store.getState().memoryMetadataBaseline).toMatchObject({
      agentId: A,
      memoryId: replacementId,
      revision: 1,
      visibility: "session_private",
      recipient_agent_ids: [],
    });
    expect(store.getState().memoryCorrectionDirty).toBe(false);
    expect(client.correctMemory).toHaveBeenCalledWith(
      A,
      memory.id,
      expect.objectContaining({
        body: "Corrected fact",
        expected_revision: memoryContent.content.revision,
      }),
    );
    expect(replacementReads).toHaveLength(1);
  } finally {
    correction.resolve(replacementContent);
    metadata.resolve(newMetadata);
  }
});

it("keeps deferred metadata alive when a mounted owner switches from content to sources", async () => {
  const value: Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>> = {
    visibility: "session_private",
    visibility_revision: 1,
    recipient_agent_ids: [],
    origins: memory.origins,
    origin_complete: true,
    source_validity: "valid",
    runtime_eligibility: "unknown",
    raw_preview: "unknown",
  };
  const metadata = deferred<typeof value>();
  let signal: AbortSignal | undefined;
  const client = setupLibrary({
    getMemoryAccessMetadata: vi.fn<SuperstringApi["getMemoryAccessMetadata"]>(
      (_agentId, _id, currentSignal) => {
        signal = currentSignal;
        return metadata.promise;
      },
    ),
    listMemorySources: vi.fn<SuperstringApi["listMemorySources"]>(async () => ({
      memory_id: memory.id,
      entry_revision: "entry",
      source_validity: "valid",
      raw_preview: "unknown",
      checked_sources: 0,
      total: 0,
      nextOffset: null,
      items: [],
    })),
  });
  render(<MemoryLibrary active />);
  try {
    await userEvent.click(await screen.findByRole("button", { name: memory.name }));
    await waitFor(() => expect(client.getMemoryAccessMetadata).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.getState().memoryContent).not.toBeNull());
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await userEvent.click(screen.getByRole("tab", { name: "来源" }));
    await waitFor(() => expect(client.listMemorySources).toHaveBeenCalledTimes(1));
    expect.soft(signal?.aborted).toBe(false);
    expect.soft(client.getMemoryAccessMetadata).toHaveBeenCalledTimes(1);

    await act(async () => metadata.resolve(value));
    await waitFor(() => expect(store.getState().memoryMetadataBaseline?.memoryId).toBe(memory.id));
    expect(store.getState().memoryMetadata).toEqual(value);
    expect(store.getState().memoryMetadataLoading).toBe(false);
    expect(client.getMemoryAccessMetadata).toHaveBeenCalledTimes(1);
    expect(store.getState().memorySources?.memory_id).toBe(memory.id);
  } finally {
    metadata.resolve(value);
  }
});

it.each(["inactive", "hidden"] as const)(
  "does not automatically read metadata for a correction that completes while its mounted panel is %s",
  async (suspension) => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const replacementId = "99999999-9999-4999-8999-999999999999";
    const replacement = {
      ...memoryContent,
      content: { ...memoryContent.content, id: replacementId, body: "Corrected while inactive" },
      corrected: true,
    };
    const value: Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>> = {
      visibility: "session_private",
      visibility_revision: 1,
      recipient_agent_ids: [],
      origins: memory.origins,
      origin_complete: true,
      source_validity: "valid",
      runtime_eligibility: "unknown",
      raw_preview: "unknown",
    };
    const correction = deferred<typeof replacement>();
    const client = setupLibrary({
      correctMemory: vi.fn<SuperstringApi["correctMemory"]>(() => correction.promise),
      getMemoryContent: vi.fn<SuperstringApi["getMemoryContent"]>(async (_agent, id) =>
        id === replacementId ? replacement : memoryContent,
      ),
      getMemoryAccessMetadata: vi.fn<SuperstringApi["getMemoryAccessMetadata"]>(async () => value),
    });
    store.setState({
      memoryEntryDetail: memory,
      memoryReadSelection: { entry: memory, conversationId: null },
    });
    const view = render(<MemoryDetail active />);
    await waitFor(() => expect(store.getState().memoryMetadataBaseline).not.toBeNull());
    await waitFor(() => expect(store.getState().memoryCorrectionDraft).not.toBeNull());
    act(() => store.getState().patchMemoryCorrection({ body: "Corrected while inactive" }));
    let saving!: Promise<boolean>;
    act(() => {
      saving = store.getState().saveMemoryCorrection();
    });
    await waitFor(() => expect(client.correctMemory).toHaveBeenCalledTimes(1));
    if (suspension === "inactive") view.rerender(<MemoryDetail active={false} />);
    else
      act(() => {
        hidden = true;
        fireEvent(document, new Event("visibilitychange"));
      });
    await act(async () => correction.resolve(replacement));
    await expect(saving).resolves.toBe(true);
    expect(store.getState().memoryEntryDetail?.id).toBe(replacementId);
    expect(store.getState().memoryMetadataBaseline).toBeNull();
    expect(client.getMemoryAccessMetadata).toHaveBeenCalledTimes(1);
    if (suspension === "inactive") view.rerender(<MemoryDetail active />);
    else
      act(() => {
        hidden = false;
        fireEvent(document, new Event("visibilitychange"));
      });
    await waitFor(() =>
      expect(store.getState().memoryMetadataBaseline?.memoryId).toBe(replacementId),
    );
    expect(client.getMemoryAccessMetadata).toHaveBeenCalledTimes(2);
  },
);
