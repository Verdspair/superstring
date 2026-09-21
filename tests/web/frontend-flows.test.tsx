import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

const NOW = "2026-09-17T12:00:00.000Z";
const client = (patch: Partial<SuperstringApi> = {}) => patch as SuperstringApi;
beforeEach(() => useSuperstringStore.getState().resetForTests(client()));
afterEach(cleanup);

describe("流程与状态边界", () => {
  it("侧栏不因消息流或输入框改变重渲染，仍响应会话更新", () => {
    const renderCount = vi.fn();
    render(
      <Profiler id="sidebar" onRender={renderCount}>
        <Sidebar />
      </Profiler>,
    );
    const initial = renderCount.mock.calls.length;
    act(() => useSuperstringStore.setState({ messages: [], composer: "输入" }));
    expect(renderCount).toHaveBeenCalledTimes(initial);
    act(() =>
      useSuperstringStore.setState({
        sessions: [
          {
            id: "session",
            title: "新标题",
            agent_id: "agent",
            mode: "chat",
            config_version: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "新标题" })).toBeTruthy();
    expect(renderCount.mock.calls.length).toBeGreaterThan(initial);
  });
  it("stream依赖可注入；发送只执行一次，结束刷新并释放sending", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const stream = vi.fn(async (_body, onEvent) => {
      expect(useSuperstringStore.getState().sending).toBe(true);
      expect(useSuperstringStore.getState().messages).toHaveLength(2);
      await useSuperstringStore.getState().send();
      onEvent({ event: "delta", request_id: "r", text: "回答" });
      onEvent({
        event: "done",
        request_id: "r",
        message_id: "real",
        created_at: NOW,
        completed_at: NOW,
      });
    });
    useSuperstringStore.getState().resetForTests(client(), {
      streamChat: stream,
      requestId: () => "r",
      now: () => NOW,
    });
    const oldRefresh = useSuperstringStore.getState().refreshSession;
    useSuperstringStore.setState({
      composer: " 问题 ",
      currentSessionId: "s",
      refreshSession: refresh,
    });
    try {
      await useSuperstringStore.getState().send();
      expect(stream).toHaveBeenCalledTimes(1);
      expect(stream.mock.calls[0][0]).toEqual({
        session_id: "s",
        message: "问题",
        client_request_id: "r",
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(useSuperstringStore.getState()).toMatchObject({
        sending: false,
        composer: "",
      });
      expect(useSuperstringStore.getState().messages[1]).toMatchObject({
        id: "real",
        content: "回答",
        status: "completed",
      });
    } finally {
      useSuperstringStore.setState({ refreshSession: oldRefresh });
    }
  });
  it("传输失败不自动重试，不丢失部分输出并释放sending", async () => {
    const stream = vi.fn(async (_body, onEvent) => {
      onEvent({ event: "delta", request_id: "r", text: "部分" });
      throw new Error("断开");
    });
    useSuperstringStore.getState().resetForTests(client(), {
      streamChat: stream,
      requestId: () => "r",
      now: () => NOW,
    });
    useSuperstringStore.setState({ composer: "问题", currentSessionId: "s" });
    await useSuperstringStore.getState().send();
    expect(stream).toHaveBeenCalledOnce();
    expect(useSuperstringStore.getState()).toMatchObject({
      sending: false,
      error: "断开",
    });
    expect(useSuperstringStore.getState().messages[1]).toMatchObject({
      content: "部分",
      status: "failed",
    });
  });
  it("记忆永久删除未确认不得请求；成功不自动刷新列表", async () => {
    const govern = vi.fn().mockResolvedValue(undefined);
    const listMemoryEntries = vi.fn();
    useSuperstringStore.getState().resetForTests(client({ govern, listMemoryEntries }));
    useSuperstringStore.setState({ editorAgentId: "agent" });
    expect(
      await useSuperstringStore.getState().governMemories("agent", ["entry"], "purge", false),
    ).toBe(false);
    expect(govern).not.toHaveBeenCalled();
    expect(
      await useSuperstringStore.getState().governMemories("agent", ["entry"], "purge", true),
    ).toBe(true);
    expect(govern).toHaveBeenCalledWith("agent", {
      memory_ids: ["entry"],
      action: "purge",
      confirm_permanent: true,
    });
    expect(listMemoryEntries).not.toHaveBeenCalled();
  });
  it("记忆合并保留请求ID生成方式与失败反馈", async () => {
    const merge = vi.fn().mockRejectedValue(new Error("失败"));
    useSuperstringStore.getState().resetForTests(client({ merge }), { requestId: () => "a-b-c" });
    useSuperstringStore.setState({ editorAgentId: "agent" });
    expect(await useSuperstringStore.getState().mergeMemories("agent", ["entry"])).toBe(false);
    expect(merge).toHaveBeenCalledWith("agent", {
      request_key: "abc",
      memory_ids: ["entry"],
    });
    expect(useSuperstringStore.getState().feedback).toBe("操作未完成：失败");
  });
});
