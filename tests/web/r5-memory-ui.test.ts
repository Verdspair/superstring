import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

const NOW = "2026-09-12T00:00:00.000000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TURN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const MEMORY_ID = "55555555-5555-4555-8555-555555555555";

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(fakeClient());
  vi.restoreAllMocks();
});

describe("R5 记忆状态动作", () => {
  it("按页请求 100 条并保留未分页总数", async () => {
    const listMemoryEntries = vi.fn().mockResolvedValue({ total: 205, items: [] });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      apiClient: fakeClient({ listMemoryEntries }),
    });

    await useSuperstringStore.getState().loadMemoryPage(3);

    expect(listMemoryEntries).toHaveBeenCalledWith(AGENT_ID, 200, 100, undefined);
    expect(useSuperstringStore.getState().memoryEntryTotal).toBe(205);
    expect(useSuperstringStore.getState().feedback).toBe("共 205 条记忆，当前第 3 页。");
  });

  it("手动整理终态成功时不显示任务控制台，只报告写入结果", async () => {
    const consolidate = vi.fn().mockResolvedValue({
      id: JOB_ID,
      kind: "manual",
      session_id: SESSION_ID,
      status: "succeeded",
      result_id: MEMORY_ID,
      error_code: null,
      created_at: NOW,
      finished_at: NOW,
    });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      apiClient: fakeClient({ consolidate }),
    });

    await useSuperstringStore.getState().manualConsolidate(SESSION_ID, [TURN_ID]);

    expect(consolidate).toHaveBeenCalledOnce();
    expect(consolidate.mock.calls[0][0]).toBe(AGENT_ID);
    expect(consolidate.mock.calls[0][1]).toMatchObject({
      session_id: SESSION_ID,
      turn_ids: [TURN_ID],
    });
    expect(useSuperstringStore.getState().feedback).toBe(
      "整理完成，已写入长期记忆。可在“记忆列表与治理”中查看。",
    );
  });

  it("自动策略保存失败后重新读取服务器值", async () => {
    const updatePolicy = vi.fn().mockRejectedValue(new Error("冲突"));
    const getPolicy = vi.fn().mockResolvedValue({
      auto_enabled: false,
      every_turns: 20,
      target_chars: 300,
      version: 2,
    });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      policy: {
        auto_enabled: true,
        every_turns: 10,
        target_chars: 500,
        version: 1,
      },
      apiClient: fakeClient({ updatePolicy, getPolicy }),
    });

    await useSuperstringStore.getState().updatePolicy({
      auto_enabled: true,
      every_turns: 10,
      target_chars: 500,
    });

    expect(getPolicy).toHaveBeenCalledWith(AGENT_ID);
    expect(useSuperstringStore.getState().policy?.version).toBe(2);
    expect(useSuperstringStore.getState().feedback).toBe("保存未成功，已恢复服务器值，请重试。");
  });
});
