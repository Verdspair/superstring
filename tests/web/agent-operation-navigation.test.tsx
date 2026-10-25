// Agent 操作导航回归：目录里取消切换留在目录、标签页只同步落点路由、单对象删除保留多选。
// 真实 store + 仅 mock API。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";
import { A, agent, B, setupLibrary } from "./helpers/library-fixture";

const C = "66666666-6666-4666-8666-666666666666";

function namedAgent(id: string) {
  return { ...agent, id, name: id === A ? "Agent A" : id === B ? "Agent B" : "Agent C" };
}

function renderWorkspace() {
  return render(
    <>
      <AssistantWorkspace active />
      <NavigationGuard />
    </>,
    { wrapper: DesignSystemProvider },
  );
}

function cardOf(name: string) {
  const card = screen.getByText(name).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`missing card for ${name}`);
  return card;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Agent 操作导航", () => {
  it("目录内取消 Agent 切换后仍停在目录，不进入旧 Agent 工作室", async () => {
    setupLibrary();
    renderWorkspace();
    await act(async () => {});
    expect(store.getState().pageEditor?.agent.id).toBe(A);

    fireEvent.click(screen.getByRole("button", { name: "所有 Agent" }));
    expect(screen.getByRole("heading", { name: "你的 Agent" })).toBeTruthy();
    act(() => {
      store.getState().patchPageAgent("context", {
        p5_config: { ...store.getState().pageEditor!.draft.p5_config, recent_turns: 12 },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Agent B" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(false));

    expect(store.getState().editorAgentId).toBe(A);
    expect(screen.getByRole("heading", { name: "你的 Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "所有 Agent" })).toBeNull();
  });

  it("Agent 标签页切换只同步落点路由，不触发跨屏记忆草稿守卫", async () => {
    setupLibrary({
      getModelCapacity: vi.fn(async (model: string) => ({
        model,
        status: "loaded" as const,
        context_length: 128000,
      })),
    });
    store.setState({ settingsRoute: "identity", memoryCorrectionDirty: true });
    renderWorkspace();
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "人设表达" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "模型配置" }));
    await act(async () => {});

    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().settingsRoute).toBe("context");
    expect(screen.getByRole("tab", { name: "模型配置" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(store.getState().memoryCorrectionDirty).toBe(true);

    // 返回人设表达：本地标签与落点路由继续一致，仍不弹跨屏草稿确认。
    fireEvent.mouseDown(screen.getByRole("tab", { name: "人设表达" }));
    await act(async () => {});
    expect(store.getState().settingsRoute).toBe("identity");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(screen.getByRole("tab", { name: "人设表达" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("删除当前 Agent 只移除被删项，保留目录里 A/B 的多选", async () => {
    const deleteAgents = vi.fn(async (ids: string[]) => ({
      deleted_count: ids.length,
      failed_count: 0,
      results: ids.map((id) => ({ id, deleted: true, error_code: null, message: "" })),
    }));
    setupLibrary({
      getAgent: vi.fn(async (id: string) => namedAgent(id)),
      deleteAgents: deleteAgents as unknown as typeof api.deleteAgents,
    });
    store.setState({
      agents: [namedAgent(A), namedAgent(B), namedAgent(C)],
    });
    renderWorkspace();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "所有 Agent" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Agent A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Agent B" }));
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(2);

    fireEvent.click(within(cardOf("Agent C")).getByRole("button", { name: "打开工作室" }));
    await waitFor(() => expect(store.getState().pageEditor?.agent.id).toBe(C));
    expect(screen.getByRole("heading", { level: 1, name: "Agent 配置 · Agent C" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除 Agent" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await act(async () => {});

    expect(deleteAgents).toHaveBeenCalledWith([C]);
    expect(store.getState().agents.map((item) => item.id)).toEqual([A, B]);
    // 删除的是当前编辑对象：回到目录，并保留 A/B 的多选。
    expect(screen.getByRole("heading", { name: "你的 Agent" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
    expect(
      screen.getByRole("checkbox", { name: "选择 Agent A" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("checkbox", { name: "选择 Agent B" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
