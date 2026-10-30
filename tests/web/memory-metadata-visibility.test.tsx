import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryAccessMetadata,
  MemoryManagementEntry,
  MemoryVisibilityResponse,
} from "../../src/shared/contracts/memory";
import { ApiError, api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, memory, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const mockMetadataNull: MemoryAccessMetadata = {
  visibility: null,
  visibility_revision: 1,
  recipient_agent_ids: [],
  origins: [
    { channel: "web", conversation_id: null },
    { channel: "onebot11", conversation_id: "22222222-2222-4222-8222-222222222222" },
  ],
  origin_complete: false,
  source_validity: "unknown",
  runtime_eligibility: "unknown",
  raw_preview: "unknown",
};

const mockMetadataPrivate: MemoryAccessMetadata = {
  ...mockMetadataNull,
  visibility: "session_private",
  visibility_revision: 1,
  origin_complete: true,
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
  setupLibrary({
    getMemoryAccessMetadata: vi.fn().mockImplementation(async (_agentId, memoryId) => {
      if (memoryId === "mem-private") return mockMetadataPrivate;
      return mockMetadataNull;
    }),
    saveMemoryVisibility: vi.fn().mockImplementation(async (_agentId, _memoryId, body) => ({
      visibility: body.visibility,
      visibility_revision: body.expected_revision + 1,
      recipient_agent_ids: [...body.recipient_agent_ids],
    })),
  });

  store.setState({
    settingsRoute: "long-memory",
    agents: [agent, { ...agent, id: B, name: "Agent B" }],
    memoryEntries: [{ ...memory } satisfies MemoryManagementEntry],
    memoryEntryDetail: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectLocale("zh-CN");
});

const clickTab = async (name: string) => {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
};

describe("memory metadata and visibility management UI", () => {
  it("keeps inventory controls in one padded content group while filters still reach the original reader", async () => {
    render(<MemoryLibrary active />);
    await screen.findByRole("button", { name: "Memory one" });
    const view = screen.getByRole("combobox", { name: "条目归属" });
    const visibility = screen.getByRole("combobox", { name: "来源与共享" });
    const origin = screen.getByRole("combobox", { name: "来源会话" });
    const principal = screen.getByRole("combobox", { name: "核验读取资格的会话" });
    const content = view.closest(".settings-content-padding");
    expect(content).toBeTruthy();
    for (const control of [visibility, origin, principal])
      expect(control.closest(".settings-content-padding")).toBe(content);
    fireEvent.change(view, { target: { value: "received" } });
    await waitFor(() =>
      expect(store.getState().apiClient.listMemoryEntries).toHaveBeenLastCalledWith(
        A,
        0,
        100,
        expect.objectContaining({ view: "received" }),
        expect.any(AbortSignal),
      ),
    );
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
  });

  it("displays historical null as 历史未分类 and performs no N+1 list fetch or unneeded PUT", async () => {
    render(<MemoryLibrary active={true} />);

    // Open entry detail Sheet from visible list
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));

    // Switch to '来源与共享' tab
    await clickTab("来源与共享");

    // Verify metadata was loaded exactly once for this entry
    expect(store.getState().apiClient.getMemoryAccessMetadata).toHaveBeenCalledTimes(1);
    expect(store.getState().apiClient.getMemoryAccessMetadata).toHaveBeenCalledWith(
      A,
      memory.id,
      expect.any(AbortSignal),
      undefined,
    );

    // Shows 历史未分类
    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    expect(select).toHaveProperty("value", "unclassified");

    // Save button is disabled (no dirty changes)
    const saveBtn = screen.getByRole("button", { name: "保存共享设置" });
    expect(saveBtn).toHaveProperty("disabled", true);

    // Save was NOT called
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
  });

  it("transitions to session_private with empty recipient list after confirmation in MemoryDetail", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "session_private" } });

    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // Click save opens confirmation dialog inside MemoryDetail
    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /即将更新此条记忆的可见性为「当前会话私有」，接收助手共 0 个。确认执行？/,
      ),
    ).toBeTruthy();

    // Confirm execution
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(A, memory.id, {
        expected_revision: 1,
        visibility: "session_private",
        recipient_agent_ids: [],
      });
    });

    expect(store.getState().memoryVisibilityDirty).toBe(false);
  });

  it("transitions to agent_shared with owner agent only", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "agent_shared" } });

    // Save and confirm
    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(A, memory.id, {
        expected_revision: 1,
        visibility: "agent_shared",
        recipient_agent_ids: [A],
      });
    });
  });

  it("transitions to public requiring non-empty recipient list", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "public" } });

    // When public, save button is disabled until at least one recipient is checked
    const saveBtn = screen.getByRole("button", { name: "保存共享设置" });
    expect(saveBtn).toHaveProperty("disabled", true);

    // Check Agent B
    const checkboxB = screen.getByRole("checkbox", { name: "Agent B" });
    fireEvent.click(checkboxB);

    expect(saveBtn).toHaveProperty("disabled", false);

    // Click save
    fireEvent.click(saveBtn);
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /即将更新此条记忆的可见性为「公共记忆」，接收助手共 1 个。确认执行？/,
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(A, memory.id, {
        expected_revision: 1,
        visibility: "public",
        recipient_agent_ids: [B],
      });
    });
  });

  it("confirmation cancellation does not issue PUT and preserves draft", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "session_private" } });

    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));
    const dialog = await screen.findByRole("alertdialog");

    // Click cancel
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    // Zero PUT
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
    expect(store.getState().memoryVisibilityDirty).toBe(true);
  });

  it("preserves dirty visibility draft on 409 MEMORY_STATE_CONFLICT", async () => {
    vi.mocked(store.getState().apiClient.saveMemoryVisibility).mockRejectedValueOnce(
      new ApiError(409, "MEMORY_STATE_CONFLICT", "记忆授权已变化，请重新加载"),
    );

    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "session_private" } });

    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    // Error is displayed in alert
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(store.getState().memoryVisibilityError).toContain("MEMORY_STATE_CONFLICT");

    // Draft is strictly preserved dirty
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().memoryVisibilityDraft?.visibility).toBe("session_private");
  });

  it("saveMemoryCorrection blocks when visibility draft is dirty to prevent ID replacement race", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));

    // 1. Edit visibility draft in 'access' tab
    await clickTab("来源与共享");
    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "agent_shared" } });
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // 2. Edit correction draft in 'edit' tab
    await clickTab("纠正");
    const nameInput = await screen.findByLabelText("名称");
    fireEvent.change(nameInput, { target: { value: "Updated Memory Name" } });
    expect(store.getState().memoryCorrectionDirty).toBe(true);

    // 3. Attempt to save correction while visibility is dirty
    const ok = await store.getState().saveMemoryCorrection();

    // Must be blocked!
    expect(ok).toBe(false);
    expect(store.getState().error).toMatch(/存在未保存的共享设置修改/);

    // Visibility draft and correction draft remain intact
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });

  it("discards late metadata read response when switching entry", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    const pending = deferred<MemoryAccessMetadata>();
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockReturnValue(pending.promise);

    const readPromise = store.getState().loadMemoryAccessMetadata(memory.id);

    // User switches to entry-2
    act(() => {
      store.setState({
        memoryEntryDetail: {
          ...memory,
          id: "entry-2",
        },
        memoryMetadata: null,
      });
    });

    pending.resolve(mockMetadataPrivate);
    const res = await readPromise;
    expect(res).toBe(false);

    // Entry 2 metadata must not be overwritten by late Entry 1 response
    expect(store.getState().memoryMetadata).toBeNull();
  });

  it("cancelled metadata read promise explicitly settles to false immediately when superseded", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    const pending1 = deferred<MemoryAccessMetadata>();
    const pending2 = deferred<MemoryAccessMetadata>();

    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata)
      .mockReturnValueOnce(pending1.promise)
      .mockReturnValueOnce(pending2.promise);

    // Start read 1
    const p1 = store.getState().loadMemoryAccessMetadata(memory.id);

    // An explicit refresh replaces transport; an ordinary matching read shares it.
    const p2 = store.getState().loadMemoryAccessMetadata(memory.id, { force: true });

    // p1 must immediately resolve to false without waiting for pending1 to resolve!
    const res1 = await p1;
    expect(res1).toBe(false);

    // Resolve pending2
    pending2.resolve(mockMetadataPrivate);
    const res2 = await p2;
    expect(res2).toBe(true);
    expect(store.getState().memoryMetadata?.visibility).toBe("session_private");
  });

  it("dirtyGETvsCAS does not sneakily push CAS revision or recipient baseline when dirty", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    // 1. Initial load has revision 1
    const ok1 = await store.getState().loadMemoryAccessMetadata(memory.id);
    expect(ok1).toBe(true);
    expect(store.getState().memoryMetadataBaseline?.revision).toBe(1);

    // 2. User edits draft to session_private (now dirty)
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().memoryMetadataBaseline?.revision).toBe(1);

    // 3. A background GET comes back with newer server revision 2
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValueOnce({
      ...mockMetadataNull,
      visibility: "public",
      visibility_revision: 2,
      recipient_agent_ids: [B],
    });

    const ok2 = await store.getState().loadMemoryAccessMetadata(memory.id);
    expect(ok2).toBe(true);

    // Remote metadata shows rev 2
    expect(store.getState().memoryMetadata?.visibility_revision).toBe(2);

    // BUT baseline revision must NOT sneakily be pushed! It remains 1 so CAS is preserved!
    expect(store.getState().memoryMetadataBaseline?.revision).toBe(1);
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().memoryVisibilityDraft?.visibility).toBe("session_private");

    // Saving now sends expected_revision: 1
    await store.getState().saveMemoryVisibility();
    expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(
      A,
      memory.id,
      expect.objectContaining({ expected_revision: 1 }),
    );
  });

  it("explicit refresh in UI advances revision to allow recovery after conflict", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    // Initial load rev 1
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });

    // Server has advanced to rev 2
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValue({
      ...mockMetadataNull,
      visibility: "agent_shared",
      visibility_revision: 2,
      recipient_agent_ids: [A],
    });

    // Calling with advanceRevisionIfDirty (triggered by Refresh/Retry button in UI)
    const ok = await store
      .getState()
      .loadMemoryAccessMetadata(memory.id, { advanceRevisionIfDirty: true });
    expect(ok).toBe(true);

    // Baseline revision is now advanced to 2, while user's draft is preserved
    expect(store.getState().memoryMetadataBaseline?.revision).toBe(2);
    expect(store.getState().memoryVisibilityDraft?.visibility).toBe("session_private");
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // Subsequent save uses rev 2!
    await store.getState().saveMemoryVisibility();
    expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(
      A,
      memory.id,
      expect.objectContaining({ expected_revision: 2 }),
    );
  });

  it("API change check prevents save to mismatched API and clears saving flag without permanent busy", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });

    // Simulate API client instance change
    const originalApi = store.getState().apiClient;
    const newApi = { ...originalApi };
    store.setState({ apiClient: newApi });

    // Save should immediately reject because baseline.api !== apiClient
    const ok = await store.getState().saveMemoryVisibility();
    expect(ok).toBe(false);
    expect(originalApi.saveMemoryVisibility).not.toHaveBeenCalled();
    expect(store.getState().memoryVisibilitySaving).toBe(false);

    // Now test API change during in-flight PUT
    store.setState({ apiClient: originalApi });
    // Reset baseline.api to originalApi
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });

    const pendingPut = deferred<MemoryVisibilityResponse>();
    vi.mocked(originalApi.saveMemoryVisibility).mockReturnValueOnce(pendingPut.promise);

    const savePromise = store.getState().saveMemoryVisibility();
    expect(store.getState().memoryVisibilitySaving).toBe(true);

    // Swap API while PUT is in flight
    store.setState({ apiClient: newApi });
    pendingPut.resolve({
      visibility: "session_private",
      visibility_revision: 2,
      recipient_agent_ids: [],
    });

    const res = await savePromise;
    expect(res).toBe(false);
    // Saving flag MUST be reset, not stuck permanently busy!
    expect(store.getState().memoryVisibilitySaving).toBe(false);
  });

  it("closing detail with both correction and visibility dirty prompts discard and cleanly clears both", async () => {
    render(<MemoryLibrary active={true} />);

    // Open from list
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));

    // Edit correction
    await clickTab("纠正");
    const nameInput = await screen.findByLabelText("名称");
    fireEvent.change(nameInput, { target: { value: "New Name" } });

    // Edit visibility
    await clickTab("来源与共享");
    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "agent_shared" } });

    expect(store.getState().memoryCorrectionDirty).toBe(true);
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // Close sheet triggers discard dialog
    fireEvent.click(screen.getByRole("button", { name: /^关闭$/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/放弃未保存的记忆纠正/)).toBeTruthy();

    // Confirm discard
    fireEvent.click(within(dialog).getByRole("button", { name: /^确认$/ }));

    // Both drafts are discarded and detail is cleared!
    expect(store.getState().memoryCorrectionDirty).toBe(false);
    expect(store.getState().memoryVisibilityDirty).toBe(false);
    expect(store.getState().memoryEntryDetail).toBeNull();
    expect(store.getState().memoryMetadata).toBeNull();
  });

  it("navigation confirmSaveAndContinue refuses to silently publish dirty visibility draft", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    store.setState({
      pendingNavigation: { kind: "page", page: "chat", settingsView: "workspace" },
      navigationConfirmOpen: true,
    });

    // User clicks "保存并继续"
    await store.getState().confirmSaveAndContinue();

    // Must NOT publish without explicit confirmation!
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
    expect(store.getState().navigationConfirmMessage).toMatch(/记忆共享设置需要单独确认发布/);
    expect(store.getState().memoryVisibilityDirty).toBe(true);
  });

  it("navigation confirmDiscardAndContinue cleanly discards dirty visibility draft", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    store.setState({
      pendingNavigation: { kind: "page", page: "chat", settingsView: "workspace" },
      navigationConfirmOpen: true,
    });

    await store.getState().confirmDiscardAndContinue();

    expect(store.getState().memoryVisibilityDirty).toBe(false);
    expect(store.getState().memoryVisibilityDraft).toBeNull();
  });

  it("displays not_evaluated and unknown origin honestly without claiming verified", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    expect(await screen.findByText("来源未能确定")).toBeTruthy();
    expect(screen.getByText("来源链不完整")).toBeTruthy();
    expect(screen.getByText("未评估")).toBeTruthy();
  });

  it("verifies api.saveMemoryVisibility sends wire payload and strict response", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      capturedInit = init;
      const res: MemoryVisibilityResponse = {
        visibility: "public",
        visibility_revision: 2,
        recipient_agent_ids: [B],
      };
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const res = await api.saveMemoryVisibility(A, memory.id, {
        expected_revision: 1,
        visibility: "public",
        recipient_agent_ids: [B],
      });

      if (typeof capturedInit?.body !== "string") {
        throw new Error("Expected string body in RequestInit");
      }
      const body = JSON.parse(capturedInit.body);
      expect(body).toEqual({
        expected_revision: 1,
        visibility: "public",
        recipient_agent_ids: [B],
      });
      expect(res).toEqual({
        visibility: "public",
        visibility_revision: 2,
        recipient_agent_ids: [B],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disables visibility controls and shows originUnknown when baseline is not confirmed or initial GET fails", async () => {
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockRejectedValueOnce(
      new Error("Network Error"),
    );

    render(<MemoryLibrary active={true} />);

    // Open from list
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    // Because GET failed, baseline is null -> NativeSelect is disabled and value is unknown
    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    expect(select).toHaveProperty("disabled", true);
    expect(select).toHaveProperty("value", "unknown");

    // Shows "未知" option
    expect(screen.getByText("未知")).toBeTruthy();

    // Origin status shows unknown, NOT incomplete
    expect(screen.getByText("来源未能确定")).toBeTruthy();

    // Save and discard buttons are disabled
    expect(screen.getByRole("button", { name: "保存共享设置" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "放弃共享修改" })).toHaveProperty("disabled", true);

    // Clicking retry button successfully loads metadata and enables controls
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValueOnce(
      mockMetadataNull,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(select).toHaveProperty("disabled", false);
    });
    expect(select).toHaveProperty("value", "unclassified");
    expect(within(select).getByRole("option", { name: "历史未分类" })).toBeTruthy();
  });

  it("closes confirm dialog and cancels PUT if entry, API, or draft changes before confirmation", async () => {
    render(<MemoryLibrary active={true} />);

    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");

    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "session_private" } });

    // Open confirm dialog
    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();

    // Simulate entry switch while confirm dialog was open
    act(() => {
      store.setState({
        editorAgentId: B, // changed agent
      });
    });

    // Dialog must automatically close!
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    // Zero PUT issued
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
  });

  it("requestAgentNavigation halts when visibility draft is dirty, preserving draft until explicit discard or save", async () => {
    store.setState({
      editorAgentId: A,
      memoryEntryDetail: memory,
    });
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.getState().patchMemoryVisibilityDraft({ visibility: "session_private" });
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // 1. Navigation to Agent B is intercepted because visibility draft is dirty
    const landed = await store.getState().requestAgentNavigation(B);
    expect(landed).toBe(false);

    // Editor remains Agent A, draft is preserved, pendingNavigation is set
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().memoryVisibilityDraft?.visibility).toBe("session_private");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "agent",
      id: B,
    });
    expect(store.getState().navigationConfirmOpen).toBe(true);

    // Path 1: Save via navigation confirm is refused (requires explicit confirmation in detail)
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
    expect(store.getState().navigationConfirmMessage).toMatch(/记忆共享设置需要单独确认发布/);
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().memoryVisibilityDirty).toBe(true);

    // Path 2: Cancel navigation keeps draft and stays on Agent A
    store.getState().cancelPendingNavigation();
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().pendingNavigation).toBeNull();

    // Path 3: Request navigation again and discard -> cleanly clears visibility draft and lands on Agent B
    const landed2 = await store.getState().requestAgentNavigation(B);
    expect(landed2).toBe(false);

    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().memoryVisibilityDirty).toBe(false);
    expect(store.getState().memoryVisibilityDraft).toBeNull();
    expect(store.getState().editorAgentId).toBe(B);
  });
  it("revalidates a clean saved public basis explicitly without dirtying readers, and preserves errors on lost strong proof", async () => {
    const saved = { ...mockMetadataNull, visibility: "public" as const, recipient_agent_ids: [B] };
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValue(saved);
    render(<MemoryLibrary active />);
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");
    const revalidate = await screen.findByRole("button", { name: "重新验证发布依据" });
    expect(store.getState().memoryVisibilityDirty).toBe(false);
    fireEvent.click(revalidate);
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/重新验证会检查当前可读来源/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
    fireEvent.click(revalidate);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }),
    );
    await waitFor(() =>
      expect(store.getState().apiClient.saveMemoryVisibility).toHaveBeenCalledWith(A, memory.id, {
        expected_revision: 1,
        visibility: "public",
        recipient_agent_ids: [B],
        revalidate_publication: true,
      }),
    );
    expect(store.getState().memoryVisibilityDirty).toBe(false);
    vi.mocked(store.getState().apiClient.saveMemoryVisibility).mockRejectedValueOnce(
      new ApiError(409, "MEMORY_SOURCE_INVALID", "原文到期，无法重新验证"),
    );
    fireEvent.click(revalidate);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }),
    );
    expect(await screen.findByText(/原文到期，无法重新验证/)).toBeTruthy();
    expect(store.getState().memoryMetadataBaseline?.recipient_agent_ids).toEqual([B]);
  });
  it("uses the original save/discard/cancel guard before revalidating dirty shared settings", async () => {
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValue({
      ...mockMetadataNull,
      visibility: "public",
      recipient_agent_ids: [B],
    });
    render(<MemoryLibrary active />);
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await clickTab("来源与共享");
    fireEvent.change(await screen.findByRole("combobox", { name: "来源与共享" }), {
      target: { value: "session_private" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新验证发布依据" }));
    const guard = await screen.findByRole("alertdialog");
    expect(within(guard).getByText(/共享设置尚未保存/)).toBeTruthy();
    fireEvent.click(within(guard).getByRole("button", { name: "取消" }));
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新验证发布依据" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃共享修改" }),
    );
    expect(store.getState().memoryVisibilityDirty).toBe(false);
    expect(store.getState().apiClient.saveMemoryVisibility).not.toHaveBeenCalled();
  });

  it("does not commit or send clean revalidation for a mismatched saved API/entry and preserves unrelated correction draft", async () => {
    const current = store.getState().apiClient;
    store.setState({
      memoryEntryDetail: memory,
      memoryReadSelection: { entry: memory, conversationId: null },
    });
    await store.getState().loadMemoryAccessMetadata(memory.id);
    store.setState({
      memoryMetadataBaseline: {
        agentId: A,
        memoryId: memory.id,
        api: current,
        visibility: "public",
        revision: 1,
        recipient_agent_ids: [B],
      },
      memoryVisibilityDraft: { visibility: "public", recipient_agent_ids: [B] },
      memoryVisibilityDirty: false,
      memoryCorrectionDraft: {
        expected_revision: "a".repeat(64),
        name: "draft",
        summary: "draft",
        tags: [],
        body: "unrelated correction",
      },
      memoryCorrectionDirty: true,
    });
    expect(await store.getState().saveMemoryVisibility({ revalidatePublication: true })).toBe(true);
    expect(store.getState().memoryCorrectionDraft?.body).toBe("unrelated correction");
    const replacement = { ...current, saveMemoryVisibility: vi.fn() };
    store.setState({ apiClient: replacement });
    expect(await store.getState().saveMemoryVisibility({ revalidatePublication: true })).toBe(
      false,
    );
    expect(replacement.saveMemoryVisibility).not.toHaveBeenCalled();
  });

  it("advances saved list/selection publication fields and clears old source addresses after successful basis update only", async () => {
    const initial = {
      ...mockMetadataNull,
      visibility: "public" as const,
      recipient_agent_ids: [B],
    };
    const updated = { ...initial, visibility_revision: 2 };
    vi.mocked(store.getState().apiClient.getMemoryAccessMetadata).mockResolvedValue(updated);
    store.setState({
      memoryEntries: [{ ...memory, ...initial }],
      memoryEntryDetail: memory,
      memoryReadSelection: { entry: { ...memory, ...initial }, conversationId: null },
      memoryMetadata: initial,
      memoryMetadataBaseline: {
        agentId: A,
        memoryId: memory.id,
        api: store.getState().apiClient,
        visibility: "public",
        revision: 1,
        recipient_agent_ids: [B],
      },
      memoryVisibilityDraft: { visibility: "public", recipient_agent_ids: [B] },
      memoryVisibilityDirty: false,
      memorySourcePosition: { sourceKey: "old-token", revision: "old", offset: 4096 },
    });
    expect(await store.getState().saveMemoryVisibility({ revalidatePublication: true })).toBe(true);
    expect(store.getState().memoryEntries[0]).toMatchObject({
      visibility: "public",
      visibility_revision: 2,
      recipient_agent_ids: [B],
    });
    expect(store.getState().memoryReadSelection?.entry).toMatchObject({
      visibility: "public",
      visibility_revision: 2,
      recipient_agent_ids: [B],
    });
    expect(store.getState().memorySourcePosition).toBeNull();
    expect(store.getState().memorySourcePreview).toBeNull();
    expect(store.getState().memoryReadable).toBeNull();
    expect(store.getState().apiClient.getMemoryAccessMetadata).not.toHaveBeenCalled();
    expect(store.getState().memoryMetadataBaseline?.revision).toBe(2);
  });

  it("shares matching active metadata reads and aborts only when their last consumer leaves", async () => {
    store.setState({ memoryEntryDetail: memory });
    const pending = deferred<MemoryAccessMetadata>();
    const read = vi.mocked(store.getState().apiClient.getMemoryAccessMetadata);
    read.mockReturnValue(pending.promise);
    const firstOwner = {};
    const secondOwner = {};
    const first = store.getState().acquireMemoryMetadataRead(firstOwner, memory.id);
    const second = store.getState().acquireMemoryMetadataRead(secondOwner, memory.id);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const signal = read.mock.calls[0]![2]!;
    store.getState().releaseMemoryMetadataRead(firstOwner);
    expect(signal.aborted).toBe(false);
    store.getState().releaseMemoryMetadataRead(secondOwner);
    expect(signal.aborted).toBe(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    pending.resolve(mockMetadataPrivate);
    await act(async () => {});
    expect(store.getState().memoryMetadata).toBeNull();
    expect(store.getState().memoryMetadataLoading).toBe(false);
    read.mockResolvedValue(mockMetadataPrivate);
    await expect(store.getState().acquireMemoryMetadataRead(firstOwner, memory.id)).resolves.toBe(
      true,
    );
    store.getState().releaseMemoryMetadataRead(firstOwner);
    await expect(store.getState().acquireMemoryMetadataRead(secondOwner, memory.id)).resolves.toBe(
      true,
    );
    expect(read).toHaveBeenCalledTimes(3);
    store.getState().releaseMemoryMetadataRead(secondOwner);
  });

  it("refreshes publication metadata once for an active consumer while preserving the committed PUT baseline", async () => {
    const read = vi.mocked(store.getState().apiClient.getMemoryAccessMetadata);
    read.mockResolvedValue(mockMetadataPrivate);
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listMemorySources: vi.fn().mockResolvedValue({
          memory_id: memory.id,
          entry_revision: "entry",
          source_validity: "valid",
          raw_preview: "unknown",
          checked_sources: 0,
          total: 0,
          nextOffset: null,
          items: [],
        }),
      },
    });
    render(<MemoryLibrary active />);
    fireEvent.click(await screen.findByRole("button", { name: "Memory one" }));
    await waitFor(() => expect(store.getState().memoryMetadataBaseline?.revision).toBe(1));
    await clickTab("来源与共享");
    const select = await screen.findByRole("combobox", { name: "来源与共享" });
    fireEvent.change(select, { target: { value: "agent_shared" } });
    const pending = deferred<MemoryAccessMetadata>();
    read.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "保存共享设置" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(store.getState().memoryMetadataBaseline).toMatchObject({
      memoryId: memory.id,
      revision: 2,
      visibility: "agent_shared",
      recipient_agent_ids: [A],
    });
    expect(read.mock.calls[1]![2]!.aborted).toBe(false);
    await clickTab("来源");
    expect(read.mock.calls[1]![2]!.aborted).toBe(false);
    await act(async () => {
      pending.resolve({
        ...mockMetadataPrivate,
        visibility: "agent_shared",
        visibility_revision: 2,
        recipient_agent_ids: [A],
      });
    });
    await waitFor(() => expect(store.getState().memoryMetadataLoading).toBe(false));
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.getState().memoryVisibilityDirty).toBe(false);
  });
});
