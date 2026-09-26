import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BindingMemoryControls } from "../../src/web/screens/library/BindingMemoryControls";
import { useSuperstringStore as store } from "../../src/web/store";
import { B, binding, setupLibrary } from "./helpers/library-fixture";

beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("binding memory tasks", () => {
  it("shows the real pending count and CAS batch size draft", async () => {
    const client = setupLibrary();
    render(<BindingMemoryControls binding={binding} pending={4} onChanged={() => {}} />);
    expect(screen.getByText("再积累 16 条自动整理")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("自动整理批次（留空关闭）"), {
      target: { value: "30" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存批次" })));
    expect(client.updateQqBinding).toHaveBeenCalledWith(B, {
      memory_batch_size: 30,
      expected_revision: 2,
    });
  });
  it.each([
    ["nothing_to_organise", "当前没有待整理内容"],
    ["switch_off", "接入已关闭，无法整理"],
    ["paused", "此会话已暂停"],
    ["busy", "助手已有整理任务"],
    ["agent_disabled", "助手已停用"],
  ] as const)("renders %s as a verdict, not success", async (status, label) => {
    setupLibrary({
      organiseQqMemory: vi.fn().mockResolvedValue({ status, job_id: null, pending: 4 }),
    });
    render(<BindingMemoryControls binding={binding} onChanged={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "立即整理" })));
    expect(screen.getByRole("status").textContent).toContain(label);
  });
  it("retains failed batch drafts and clears only by explicit discard", async () => {
    setupLibrary({ updateQqBinding: vi.fn().mockRejectedValue(new Error("conflict")) });
    render(<BindingMemoryControls binding={binding} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("自动整理批次（留空关闭）"), {
      target: { value: "30" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存批次" })));
    expect(store.getState().qqMemoryBatchDrafts[B]?.value).toBe("30");
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(store.getState().qqMemoryBatchDrafts[B]).toBeUndefined();
  });
});
