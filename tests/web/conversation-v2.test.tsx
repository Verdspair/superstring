import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageResponse, RuntimeConfig } from "../../src/shared/contracts";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import type { ChatV2Event } from "../../src/shared/contracts/chat-v2";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import { ApiError, type SuperstringApi, streamChatV2 } from "../../src/web/api";
import { DirectConversation as ChatPage } from "../../src/web/screens/conversations/DirectConversation";
import { currentChat } from "../../src/web/features/chat/conversation-state";
import type { RuntimeEffects } from "../../src/web/state/types";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-09-26T00:00:00Z";
const summary = (sourceId = "a"): ConversationSummary => ({
  id: `conversation:${sourceId}`,
  sourceId,
  channel: "web",
  topology: "direct",
  agentId: "agent",
  title: sourceId,
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 0,
  consumedSeq: 0,
});
const message = (id: string, text: string): MessageResponse => ({
  id,
  turn_id: "turn",
  role: "assistant",
  content: text,
  status: "completed",
  error_code: null,
  sequence_no: 2,
  created_at: now,
  completed_at: now,
});
const snapshot = (status: RunSnapshot["status"]): RunSnapshot => ({
  runId: "run",
  specId: "conversation",
  specVersion: "1",
  owner: { kind: "web_turn", id: "turn" },
  status,
  startedAt: now,
  endedAt: status === "completed" ? now : null,
  errorCode: null,
  steps: [],
  lastSeq: 3,
  outputs: [],
});
const delta = (seq: number, text: string, runId = "run"): ChatV2Event => ({
  type: "output_delta",
  runId,
  seq,
  at: now,
  outputId: "reply",
  text,
});
const completed: ChatV2Event = {
  type: "completed",
  runId: "run",
  seq: 3,
  at: now,
  outputs: [],
  messageId: "reply",
  createdAt: now,
  completedAt: now,
};
function setup(patch: Partial<SuperstringApi> = {}, effect: Partial<RuntimeEffects> = {}) {
  let request = 0;
  const client = {
    listConversations: vi.fn(async ({ sourceId }: { sourceId?: string } = {}) => ({
      items: [summary(sourceId)],
      nextCursor: null,
    })),
    listMessages: vi.fn(async () => [] as MessageResponse[]),
    getSessionRuntime: vi.fn(async () => null as unknown as RuntimeConfig),
    listSessions: vi.fn(async () => []),
    getRunByRequest: vi.fn(async () => snapshot("completed")),
    ...patch,
  } as unknown as SuperstringApi;
  store
    .getState()
    .resetForTests(client, { requestId: () => `request-${++request}`, now: () => now, ...effect });
  return client;
}
async function compose(id = "a", text = "question") {
  await store.getState().selectSession(id);
  store.getState().setComposer(text);
}
beforeEach(() => setup());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses canonical source lookup and keeps two live conversations and their drafts independent", async () => {
  const emit: Record<string, (event: ChatV2Event) => void> = {},
    finish: Record<string, () => void> = {};
  const client = setup(
    {},
    {
      streamChatV2: (body, onEvent) => {
        emit[body.session_id] = onEvent;
        return new Promise((resolve) => {
          finish[body.session_id] = resolve;
        });
      },
    },
  );
  await compose("a");
  const a = store.getState().send();
  await waitFor(() => expect(emit.a).toBeTypeOf("function"));
  await compose("b", "B question");
  const b = store.getState().send();
  await waitFor(() => expect(emit.b).toBeTypeOf("function"));
  emit.a(delta(1, "A text", "run-a"));
  emit.b(delta(1, "B text", "run-b"));
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("B text");
  expect(store.getState().conversationById["conversation:a"].messages.at(-1)?.content).toBe(
    "A text",
  );
  expect(client.listConversations).toHaveBeenCalledWith({ channel: "web", sourceId: "a" });
  store.getState().setComposer("B draft");
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).composer).toBe("");
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("A text");
  finish.a();
  finish.b();
  await Promise.all([a, b]);
  await store.getState().selectSession("b");
  expect(currentChat(store.getState()).composer).toBe("B draft");
});

it("buffers out-of-order sequences, deduplicates deltas and waits for authoritative messages", async () => {
  let emit!: (event: ChatV2Event) => void,
    finish!: () => void,
    settle!: (messages: MessageResponse[]) => void;
  const listMessages = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockImplementationOnce(
      () =>
        new Promise<MessageResponse[]>((resolve) => {
          settle = resolve;
        }),
    );
  setup(
    { listMessages },
    {
      streamChatV2: (_body, onEvent) => {
        emit = onEvent;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );
  await compose();
  const sending = store.getState().send();
  await waitFor(() => expect(emit).toBeTypeOf("function"));
  emit(delta(2, "B"));
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("");
  emit(delta(1, "A"));
  emit(delta(1, "A"));
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("AB");
  emit(completed);
  finish();
  await waitFor(() => expect(settle).toBeTypeOf("function"));
  expect(currentChat(store.getState()).phase).toBe("settling");
  store.getState().setComposer("next");
  await store.getState().send();
  expect(currentChat(store.getState()).composer).toBe("next");
  settle([message("reply", "authoritative")]);
  await sending;
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("authoritative");
  expect(currentChat(store.getState()).phase).toBe("idle");
});

it("EOF before the first frame is not success and reconciles by request without another POST", async () => {
  const stream = vi.fn(async () => {}),
    lookup = vi.fn(async () => snapshot("generating"));
  setup({ getRunByRequest: lookup }, { streamChatV2: stream });
  await compose();
  await store.getState().send();
  expect(stream).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledWith("a", "request-1");
  expect(currentChat(store.getState()).phase).toBe("reconciling");
  render(<ChatPage />);
  expect(screen.getByRole("button", { name: "核对服务端结果" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "生成中" }) as HTMLButtonElement).disabled).toBe(true);
  lookup.mockResolvedValueOnce(snapshot("completed"));
  await act(() => store.getState().reconcileChat());
  expect(currentChat(store.getState()).phase).toBe("idle");
  expect(stream).toHaveBeenCalledOnce();
});

it("an unsuccessful result lookup keeps outcome unknown; authoritative failure permits explicit retry only", async () => {
  const stream = vi.fn(async (_body, onEvent) => {
    onEvent(delta(1, "partial"));
    throw Error("wire");
  });
  const lookup = vi
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "absent"));
  setup({ getRunByRequest: lookup }, { streamChatV2: stream });
  await compose();
  await store.getState().send();
  expect(currentChat(store.getState()).phase).toBe("reconciling");
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("partial");
  await store.getState().retryChat();
  expect(stream).toHaveBeenCalledOnce();
  await store.getState().reconcileChat();
  expect(currentChat(store.getState()).phase).toBe("failed");
  expect(currentChat(store.getState()).failedChat?.requestId).toBe("request-1");
});

it("legacy completed replay is a persisted message, with no fabricated run", async () => {
  const reply = message("legacy", "persisted");
  setup(
    { listMessages: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([reply]) },
    {
      streamChatV2: async (body, emit) => {
        emit({
          type: "replay",
          conversationId: "conversation:a",
          sessionId: "a",
          requestId: body.client_request_id,
          message: { id: "legacy", text: "persisted", createdAt: now, completedAt: now },
        });
      },
    },
  );
  await compose();
  await store.getState().send();
  expect(currentChat(store.getState()).runId).toBeNull();
  expect(store.getState().runById).toEqual({});
  expect(currentChat(store.getState()).messages[0].id).toBe("legacy");
});

it("an IME Enter does not submit, while an ordinary Enter does", async () => {
  const originalSend = store.getState().send;
  const send = vi.fn(async () => {});
  store.setState({ send });
  render(<ChatPage />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
  expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(send).toHaveBeenCalledOnce();
  store.setState({ send: originalSend });
});

it("v2 SSE parses split UTF-8, CRLF, comments and multiline data through the strict schema", async () => {
  const bytes = new TextEncoder().encode(
    `: heartbeat\r\nevent: output_delta\r\ndata: ${JSON.stringify(delta(1, "你好")).slice(0, -1)},\r\ndata: "conversationId":"conversation:a"}\r\n\r\n`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
        ),
    ),
  );
  const emit = vi.fn();
  await streamChatV2({ session_id: "a", message: "q", client_request_id: "r" }, emit);
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    ...delta(1, "你好"),
    conversationId: "conversation:a",
  });
});
it("v2 invalid event does not become a successful response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('data: {"type":"completed"}\n\n')),
  );
  await expect(
    streamChatV2({ session_id: "a", message: "q", client_request_id: "r" }, vi.fn()),
  ).rejects.toThrow();
});

const pendingMessage: MessageResponse = {
  ...message("reply", "partial"),
  status: "pending",
  completed_at: null,
};
const userMessage: MessageResponse = {
  ...message("user", "persisted question"),
  role: "user",
  sequence_no: 1,
};
it("reload discovers a pending turn's active run and request without POST or browser prompt storage", async () => {
  const stream = vi.fn(async () => {}),
    listRuns = vi.fn(async () => ({ runs: [snapshot("generating")] }));
  setup(
    {
      listMessages: async () => [userMessage, pendingMessage],
      listRuns,
      getRunEvents: async () => ({
        events: [
          { type: "started", runId: "run", seq: 1, at: now, requestId: "persisted-request" },
        ],
      }),
    },
    { streamChatV2: stream },
  );
  await store.getState().selectSession("a");
  expect(listRuns).toHaveBeenCalledWith("web_turn", "turn");
  expect(currentChat(store.getState())).toMatchObject({
    phase: "reconciling",
    runId: "run",
    outputId: "reply",
    request: { sessionId: "a", requestId: "persisted-request", text: "persisted question" },
  });
  store.getState().setComposer("new draft");
  await store.getState().send();
  expect(stream).not.toHaveBeenCalled();
  await store.getState().reconcileChat();
  expect(currentChat(store.getState()).phase).toBe("idle");
  expect(stream).not.toHaveBeenCalled();
});
it("reload of a pending row with a terminal run reads the committed message", async () => {
  const listMessages = vi
    .fn()
    .mockResolvedValueOnce([userMessage, pendingMessage])
    .mockResolvedValueOnce([userMessage, message("reply", "committed")]);
  setup({
    listMessages,
    listRuns: async () => ({ runs: [snapshot("completed")] }),
    getRunEvents: async () => ({
      events: [{ type: "started", runId: "run", seq: 1, at: now, requestId: "persisted-request" }],
    }),
  });
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).phase).toBe("idle");
  expect(currentChat(store.getState()).messages.at(-1)?.content).toBe("committed");
});
it("legacy pending rows without run history remain readable without fabricated runs", async () => {
  setup({
    listMessages: async () => [userMessage, pendingMessage],
    listRuns: async () => ({ runs: [] }),
  });
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).phase).toBe("idle");
  expect(currentChat(store.getState()).messages.at(-1)?.status).toBe("pending");
  expect(store.getState().runById).toEqual({});
});
it("failed pending-run lookup stays unresolved and the check action retries only reads", async () => {
  const listRuns = vi
    .fn()
    .mockRejectedValueOnce(Error("lookup unavailable"))
    .mockResolvedValueOnce({ runs: [snapshot("completed")] });
  setup({
    listMessages: async () => [userMessage, pendingMessage],
    listRuns,
    getRunEvents: async () => ({ events: [] }),
  });
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).phase).toBe("reconciling");
  expect(currentChat(store.getState()).request).toBeNull();
  await store.getState().reconcileChat();
  expect(currentChat(store.getState()).phase).toBe("idle");
  expect(listRuns).toHaveBeenCalledTimes(2);
});
it("a late sidebar refresh cannot recreate a session deleted while another chat completes", async () => {
  let finishList!: (items: Awaited<ReturnType<SuperstringApi["listConversations"]>>) => void;
  const sessions = ["a", "b"].map((id) => ({
    id,
    title: id,
    agent_id: "agent",
    mode: "chat" as const,
    config_version: 1,
    created_at: now,
    updated_at: now,
  }));
  const listConversations = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<SuperstringApi["listConversations"]>>>((resolve) => {
        finishList = resolve;
      }),
  );
  setup(
    { listConversations, deleteSession: async () => {} },
    {
      streamChatV2: async (body, emit) => {
        emit({
          type: "replay",
          conversationId: "conversation:a",
          sessionId: "a",
          requestId: body.client_request_id,
          message: { id: "reply", text: "reply", createdAt: now, completedAt: now },
        });
      },
    },
  );
  for (const session of sessions) store.getState().rememberConversation(summary(session.id));
  await compose();
  const send = store.getState().send();
  await waitFor(() => expect(finishList).toBeTypeOf("function"));
  await store.getState().deleteSessionById("b");
  finishList({ items: sessions.map((item) => summary(item.id)), nextCursor: null });
  await send;
  expect(
    store.getState().directoryIds.map((id) => store.getState().summaryById[id].sourceId),
  ).toEqual(["a"]);
});

it("read-only recovery settles a completed message when the earlier run lookup failed", async () => {
  const stream = vi.fn(async () => {});
  const listMessages = vi
    .fn()
    .mockResolvedValueOnce([userMessage, pendingMessage])
    .mockResolvedValueOnce([userMessage, message("reply", "finished while disconnected")]);
  setup(
    { listMessages, listRuns: vi.fn().mockRejectedValueOnce(Error("lookup unavailable")) },
    { streamChatV2: stream },
  );
  await store.getState().selectSession("a");
  expect(currentChat(store.getState())).toMatchObject({ phase: "reconciling", request: null });
  await store.getState().reconcileChat();
  expect(currentChat(store.getState())).toMatchObject({ phase: "idle", error: null, feedback: "" });
  expect(currentChat(store.getState()).messages.at(-1)).toMatchObject({
    status: "completed",
    content: "finished while disconnected",
  });
  expect(stream).not.toHaveBeenCalled();
});
