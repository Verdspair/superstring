import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  type MemoryScopeView,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { MemoryPageFields } from "../../src/web/features/agents/MemoryPageFields";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { MemoryScopePanel } from "../../src/web/features/memory/MemoryScopePanel";
import { QqMemoryControls } from "../../src/web/features/memory/QqMemoryControls";
import { SectionB } from "../../src/web/features/memory/SectionB";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const agentId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T00:00:00.000Z";
const key = JSON.stringify(["qq", "10001", "group", "30003", agentId]);
const binding = { id: bindingId, revision: 2, memory_batch_size: 20, paused: false, enabled: true };
const scope: MemoryScopeView = {
  scope_key: key,
  count: 1,
  active_count: 1,
  pending: 4,
  binding,
  read_scope_keys: [key],
  write_scope_key: key,
  latest_job: {
    id: "job",
    kind: "manual",
    session_id: null,
    status: "succeeded",
    result_id: memoryId,
    error_code: null,
    created_at: now,
    finished_at: now,
  },
};
const memory = {
  id: memoryId,
  name: "group apples",
  summary: "apples",
  tags: [],
  kinds: [],
  scope: "reality_user",
  scope_key: key,
  status: "active" as const,
  created_at: now,
};
function setup(overrides: Partial<typeof api> = {}) {
  const client = {
    ...api,
    listMemoryScopes: vi.fn().mockResolvedValue([
      {
        ...scope,
        scope_key: agentId,
        read_scope_keys: null,
        write_scope_key: agentId,
        binding: null,
        pending: null,
      },
      scope,
    ]),
    listMemoryEntries: vi.fn().mockResolvedValue({ total: 1, items: [memory] }),
    updateQqBinding: vi.fn().mockResolvedValue({
      ...binding,
      memory_batch_size: 30,
      pending_observations: 4,
      revision: 3,
    }),
    organiseQqMemory: vi.fn().mockResolvedValue({ status: "queued", job_id: "job", pending: 4 }),
    getPolicy: vi
      .fn()
      .mockResolvedValue({ auto_enabled: true, every_turns: 20, target_chars: 1200, version: 3 }),
    ...overrides,
  };
  store.getState().resetForTests(client);
  store.setState({
    editorAgentId: agentId,
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "long-memory",
  });
  return client;
}
beforeEach(() => {
  selectLocale("zh-CN");
  setup();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory center", () => {
  it("automatically lists memories, filters by scope and shows real read/write and job state", async () => {
    const client = setup();
    await act(async () => render(<SectionB />));
    expect(screen.getByText("group apples")).toBeTruthy();
    await act(async () =>
      fireEvent.change(screen.getByLabelText("记忆分区"), { target: { value: key } }),
    );
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(agentId, 0, 100, { scope_key: key });
    expect(screen.getByText("聊天可读取：QQ · 群 30003 · 账号 10001")).toBeTruthy();
    expect(screen.getByText("新整理结果存入：QQ · 群 30003 · 账号 10001")).toBeTruthy();
    expect(screen.getByText("待整理 4 条")).toBeTruthy();
    expect(screen.getByText(/最近整理：整理成功/)).toBeTruthy();
    expect(screen.queryByLabelText("来源会话")).toBeNull();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "apple" } });
      fireEvent.change(screen.getByLabelText("记忆状态"), { target: { value: "suppressed" } });
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "加载记忆列表" })));
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(agentId, 0, 100, {
      scope_key: key,
      search: "apple",
      status: "suppressed",
    });
  });
  it("protects a threshold draft across navigation and saves only the binding CAS fields", async () => {
    const client = setup();
    await act(async () => render(<SectionB />));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("记忆分区"), { target: { value: key } }),
    );
    fireEvent.change(screen.getByLabelText("自动整理条数"), { target: { value: "30" } });
    expect((screen.getByLabelText("记忆分区") as HTMLSelectElement).disabled).toBe(true);
    act(() => store.getState().openSettingsRoute("context"));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("long-memory");
    await act(async () => {
      await store.getState().confirmSaveAndContinue();
    });
    expect(client.updateQqBinding).toHaveBeenCalledWith(bindingId, {
      memory_batch_size: 30,
      expected_revision: 2,
    });
    expect(store.getState().qqMemoryBatchDrafts).toEqual({});
    expect(store.getState().settingsRoute).toBe("context");
  });
  it("retains invalid and conflicting drafts, and discards only on explicit request", async () => {
    const client = setup({
      updateQqBinding: vi.fn().mockRejectedValue(new Error("revision conflict")),
    });
    render(<QqMemoryControls binding={binding} pending={4} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("自动整理条数"), { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "保存条数" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("自动整理条数"), { target: { value: "30" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存条数" })));
    expect(client.updateQqBinding).toHaveBeenCalledTimes(1);
    expect(store.getState().qqMemoryBatchDrafts[bindingId].value).toBe("30");
    expect(screen.getByRole("alert").textContent).toContain("revision conflict");
    fireEvent.click(screen.getByRole("button", { name: "放弃条数修改" }));
    expect(store.getState().qqMemoryBatchDrafts).toEqual({});
  });
  it("keeps already-saved bindings saved when a later binding conflicts", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    setup({
      updateQqBinding: vi
        .fn()
        .mockResolvedValueOnce({ ...binding, revision: 3 })
        .mockRejectedValueOnce(new Error("conflict")),
    });
    store.getState().patchQqMemoryBatchDraft(bindingId, { value: "30", revision: 2 });
    store.getState().patchQqMemoryBatchDraft(other, { value: "40", revision: 5 });
    expect(await store.getState().saveQqMemoryBatchDrafts()).toBe(false);
    expect(Object.keys(store.getState().qqMemoryBatchDrafts)).toEqual([other]);
  });
  it("does not treat missing scope data as empty success and ignores unmounted responses", async () => {
    let resolve!: (value: MemoryScopeView[]) => void;
    setup({
      listMemoryScopes: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementationOnce(
          () =>
            new Promise((yes) => {
              resolve = yes;
            }),
        ),
    });
    const view = render(<MemoryScopePanel value={key} onChange={() => {}} disabled={false} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "offline");
    fireEvent.click(screen.getByRole("button", { name: "刷新分区与任务状态" }));
    view.unmount();
    await act(async () => resolve([scope]));
    expect(screen.queryByText("待整理 4 条")).toBeNull();
  });
  it("shows the web partition's real policy instead of a permanent loading line", async () => {
    setup();
    await act(async () => render(<SectionB />));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("记忆分区"), { target: { value: agentId } }),
    );
    expect(screen.getByText("网页自动整理已开启：每 20 个完整轮次触发。")).toBeTruthy();
    expect(screen.queryByText("正在读取网页整理策略…")).toBeNull();
  });
  it("shows only the selected preset without overwriting the other preset settings", async () => {
    const agent = AgentResponseSchema.parse({
      id: agentId,
      name: "test",
      description: "",
      system_prompt: "",
      additional_instructions: "",
      model_name: "synthetic",
      temperature: 0.7,
      memory_consolidation_model_name: null,
      memory_retrieval_model_name: null,
      context_compression_model_name: null,
      persona_intensity: 60,
      config_version: 1,
      created_at: now,
      updated_at: now,
    });
    const persona = PersonaResponseSchema.parse({
      id: bindingId,
      agent_id: agentId,
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: now,
      updated_at: now,
    });
    const editor = newPageEditor(agent, persona);
    editor.draft.p5_config.retrieval_mode = "standard";
    store.setState({ pageEditor: editor, qqBindingsLoaded: true });
    render(<MemoryPageFields page="long-memory" />);
    expect(screen.getByText("标准预设")).toBeTruthy();
    expect(screen.queryByText("保守预设")).toBeNull();
    const before = structuredClone(editor.draft.p5_config.retrieval_presets.standard);
    fireEvent.change(screen.getByLabelText("默认读取强度"), { target: { value: "conservative" } });
    await waitFor(() => expect(screen.getByText("保守预设")).toBeTruthy());
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_presets.standard).toEqual(before);
  });
});
