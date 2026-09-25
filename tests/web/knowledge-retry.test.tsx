import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { ChatPage } from "../../src/web/features/chat/ChatPage";
import { selectLocale } from "../../src/web/i18n";
import type { RuntimeEffects } from "../../src/web/state/types";
import { summaryFixture, fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";

const session = "22222222-2222-4222-8222-222222222222";
let stream: ReturnType<typeof vi.fn<RuntimeEffects["streamChatV2"]>>;
function reset() {
  stream = vi.fn<RuntimeEffects["streamChatV2"]>();
  let id = 0;
  useSuperstringStore.getState().resetForTests(
    {
      listSessions: async () => [{ id: session }],
      listMessages: async () => [],
      getSessionRuntime: async () => null,
    } as unknown as SuperstringApi,
    { streamChatV2: stream, requestId: () => `request-${++id}` },
  );
  useSuperstringStore.setState({
    currentSessionId: session,
    status: "ready",
    composer: "原始问题",
  });
}
const replay: RuntimeEffects["streamChatV2"] = async (body, emit) => {
  emit({
    type: "replay",
    conversationId: `test:${body.session_id}`,
    sessionId: body.session_id,
    requestId: body.client_request_id,
    message: {
      id: "reply",
      text: "reply",
      createdAt: "2026-09-26T00:00:00Z",
      completedAt: "2026-09-26T00:00:00Z",
    },
  });
};
const conflict: RuntimeEffects["streamChatV2"] = async (_body, onEvent) => {
  onEvent({
    type: "failed",
    runId: `run-${_body.client_request_id}`,
    seq: 1,
    at: "2026-09-26T00:00:00Z",
    code: "KNOWLEDGE_ACCESS_CHANGED",
  });
};
beforeEach(() => {
  selectLocale("zh-CN");
  reset();
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("knowledge access retry", () => {
  it("ordinary retry preserves the earlier request id and text", async () => {
    stream.mockRejectedValueOnce(new Error("network"));
    await useSuperstringStore.getState().send();
    useSuperstringStore.setState({ composer: "另一个草稿" });
    stream.mockResolvedValueOnce();
    await useSuperstringStore.getState().retryChat();
    expect(stream.mock.calls[0]?.[0]).toEqual(stream.mock.calls[1]?.[0]);
    expect(useSuperstringStore.getState().composer).toBe("另一个草稿");
  });
  it("shows only cancel and explicit new-request resend, with no automatic resend", async () => {
    stream.mockImplementationOnce(conflict);
    render(<ChatPage />);
    const send = screen.getByRole("button", { name: "发送" });
    expect(send.getAttribute("aria-label")).toBe("发送");
    await userEvent.click(send);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelectorAll("button")).toHaveLength(2);
    expect(stream).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("explicit confirmation sends the earlier text with a fresh id and preserves composer", async () => {
    stream.mockImplementationOnce(conflict).mockImplementationOnce(replay);
    render(<ChatPage />);
    await useSuperstringStore.getState().send();
    useSuperstringStore.setState({ composer: "后续草稿" });
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "按最新权限重新发送" }));
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(stream.mock.calls[0]?.[0].client_request_id).toBe("request-1");
    expect(stream.mock.calls[1]?.[0].client_request_id).toBe("request-2");
    expect(stream.mock.calls[1]?.[0].message).toBe("原始问题");
    expect(useSuperstringStore.getState().composer).toBe("后续草稿");
    expect(useSuperstringStore.getState().feedback).toContain("新请求");
  });
  it("handles HTTP conflict the same as SSE conflict", async () => {
    stream.mockRejectedValueOnce(new ApiError(409, "KNOWLEDGE_ACCESS_CHANGED", "资料已撤权"));
    await useSuperstringStore.getState().send();
    expect(useSuperstringStore.getState().knowledgeResend?.requestId).toBe("request-1");
  });
  it("cannot send a stale dialog to a different session", async () => {
    stream.mockImplementationOnce(conflict);
    await useSuperstringStore.getState().send();
    await useSuperstringStore.getState().selectSession("other");
    await useSuperstringStore.getState().resendKnowledgeChat();
    await useSuperstringStore.getState().retryChat();
    expect(useSuperstringStore.getState().knowledgeResend).toBeNull();
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate confirmation while a resend is in flight", async () => {
    let done!: () => void;
    stream.mockImplementationOnce(conflict).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    await useSuperstringStore.getState().send();
    const running = useSuperstringStore.getState().resendKnowledgeChat();
    await useSuperstringStore.getState().resendKnowledgeChat();
    expect(stream).toHaveBeenCalledTimes(2);
    done();
    await running;
  });
  it("uses English labels and never translates the user's message", async () => {
    selectLocale("en");
    stream.mockImplementationOnce(conflict);
    render(<ChatPage />);
    await useSuperstringStore.getState().send();
    expect(await screen.findByRole("button", { name: "Resend with current access" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(stream.mock.calls[0]?.[0].message).toBe("原始问题");
  });
  it("keeps the stream error visible after refreshing persisted messages", async () => {
    stream.mockImplementationOnce(conflict);
    await useSuperstringStore.getState().send();
    expect(useSuperstringStore.getState().error).toBe("KNOWLEDGE_ACCESS_CHANGED");
    expect(useSuperstringStore.getState().failedChat?.requestId).toBe("request-1");
  });
  it("does not reselect the old session when its list refresh arrives late", async () => {
    let resolveList!: (value: Awaited<ReturnType<SuperstringApi["listConversations"]>>) => void;
    const listConversations = vi.fn(({ sourceId }: { sourceId?: string } = {}) =>
      sourceId
        ? Promise.resolve({ items: [summaryFixture(sourceId)], nextCursor: null })
        : new Promise<Awaited<ReturnType<SuperstringApi["listConversations"]>>>((resolve) => {
            resolveList = resolve;
          }),
    );
    useSuperstringStore.setState({
      apiClient: { ...useSuperstringStore.getState().apiClient, listConversations },
    });
    stream.mockImplementationOnce(replay);
    const sending = useSuperstringStore.getState().send();
    await waitFor(() => expect(listConversations).toHaveBeenCalledOnce());
    await useSuperstringStore.getState().selectSession("other");
    resolveList({ items: [], nextCursor: null });
    await sending;
    expect(useSuperstringStore.getState().currentSessionId).toBe("other");
    expect(useSuperstringStore.getState().sending).toBe(false);
    expect(useSuperstringStore.getState().failedChat).toBeNull();
    expect(useSuperstringStore.getState().knowledgeResend).toBeNull();
  });
  it("does not let late stream events leak into the newly selected session", async () => {
    let done!: () => void;
    let event!: Parameters<RuntimeEffects["streamChatV2"]>[1];
    stream.mockImplementationOnce((_body, onEvent) => {
      event = onEvent;
      return new Promise<void>((resolve) => {
        done = resolve;
      });
    });
    const sending = useSuperstringStore.getState().send();
    await useSuperstringStore.getState().selectSession("other");
    event({
      type: "failed",
      runId: "run-request-1",
      seq: 1,
      at: "2026-09-26T00:00:00Z",
      code: "KNOWLEDGE_ACCESS_CHANGED",
    });
    done();
    await sending;
    expect(useSuperstringStore.getState().knowledgeResend).toBeNull();
    expect(useSuperstringStore.getState().error).not.toBe("old conflict");
    expect(useSuperstringStore.getState().messages).toEqual([]);
  });
});
