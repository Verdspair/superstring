import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageResponse, RuntimeConfig } from "../../src/shared/contracts";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import type { BrowserStateStorage } from "../../src/web/browser-state";
import { currentChat } from "../../src/web/features/chat/conversation-state";
import { DirectConversation } from "../../src/web/screens/conversations/DirectConversation";
import {
  CACHE_KEYS,
  loadWebChatCache,
  saveWebChatCache,
} from "../../src/web/services/page-snapshot-cache";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

type Query = {
  before_sequence_no?: number;
  after_sequence_no?: number;
  turn_id?: string;
  client_request_id?: string;
};
type Page = { items: MessageResponse[]; has_more: boolean };
const now = "2026-10-01T00:00:00.000Z";
const message = (seq: number, patch: Partial<MessageResponse> = {}): MessageResponse => ({
  id: `message-${seq}`,
  role: seq % 2 ? "user" : "assistant",
  content: `Body ${seq}`,
  status: "completed",
  error_code: null,
  sequence_no: seq,
  turn_id: `turn-${Math.ceil(seq / 2)}`,
  created_at: now,
  completed_at: now,
  ...patch,
});
const rows = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => message(start + i));
const summary = (sourceId: string): ConversationSummary => ({
  id: `conversation:${sourceId}`,
  sourceId,
  channel: "web",
  topology: "direct",
  agentId: "agent",
  title: sourceId,
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 260,
  consumedSeq: 0,
});
const run = (status: RunSnapshot["status"] = "failed"): RunSnapshot => ({
  runId: "old-run",
  specId: "conversation",
  specVersion: "1",
  owner: { kind: "web_turn", id: "old-turn" },
  status,
  startedAt: now,
  endedAt: now,
  errorCode: "CANCELLED",
  steps: [],
  lastSeq: 1,
  outputs: [],
});
function setup(
  read: (id: string, query?: Query) => Promise<Page>,
  patch: Partial<SuperstringApi> = {},
) {
  const listMessages = vi.fn(read);
  const client = {
    listMessages,
    listConversations: async ({ sourceId = "a" } = {}) => ({
      items: [summary(sourceId)],
      nextCursor: null,
    }),
    getSessionRuntime: async () => null as unknown as RuntimeConfig,
    ...patch,
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  return { client, listMessages };
}
function older() {
  return (
    store.getState() as unknown as { loadOlderMessages: () => Promise<void> }
  ).loadOlderMessages();
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses one paged API contract with a default latest100 read and no array fallback", async () => {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ items: rows(161, 260), has_more: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await api.listMessages("a");
  expect(result).toMatchObject({ items: expect.any(Array), has_more: true });
  expect(fetch.mock.calls[0]?.[0]).toBe("/sessions/a/messages");
});

it("loads latest, prepends older on demand and refreshes the loaded range without resurrecting deleted rows or losing drafts", async () => {
  let deleted = false;
  const { listMessages } = setup(async (_id, query = {}) => {
    if (query.before_sequence_no === 161) return { items: rows(61, 160), has_more: true };
    if (query.after_sequence_no === 60)
      return {
        items: rows(61, deleted ? 161 : 160).filter((item) => !deleted || item.sequence_no !== 90),
        has_more: true,
      };
    if (query.after_sequence_no === 161) return { items: rows(162, 260), has_more: false };
    return { items: rows(161, 260), has_more: true };
  });
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).messages).toHaveLength(100);
  expect(listMessages).toHaveBeenCalledWith("a", {});
  store.getState().setComposer("unsent draft");
  await older();
  expect(currentChat(store.getState()).messages).toHaveLength(200);
  expect(currentChat(store.getState()).messages[0].id).toBe("message-61");
  deleted = true;
  expect(await store.getState().refreshSessionById("a")).toBe(true);
  const chat = currentChat(store.getState());
  expect(chat.messages).toHaveLength(199);
  expect(chat.messages.some((item) => item.id === "message-90")).toBe(false);
  expect(chat.messages[0].id).toBe("message-61");
  expect(chat.composer).toBe("unsent draft");
  expect(listMessages).toHaveBeenCalledWith("a", { after_sequence_no: 60 });
  expect(listMessages).toHaveBeenCalledWith("a", { after_sequence_no: 161 });
});

it("keeps loaded older rows after send settlement rather than truncating to latest100", async () => {
  let sent = false;
  const { listMessages } = setup(async (_id, query = {}) => {
    if (query.before_sequence_no) return { items: rows(61, 160), has_more: true };
    if (query.after_sequence_no === 60) return { items: rows(61, 160), has_more: true };
    if (query.after_sequence_no === 160) return { items: rows(161, 260), has_more: sent };
    if (query.after_sequence_no === 260) return { items: rows(261, 262), has_more: false };
    return { items: rows(161, 260), has_more: true };
  });
  store.setState({
    effects: {
      ...store.getState().effects,
      requestId: () => "new-request",
      streamChatV2: async (_body, emit) => {
        sent = true;
        emit({
          type: "completed",
          runId: "new-run",
          seq: 1,
          at: now,
          outputs: [],
          messageId: "message-262",
          createdAt: now,
          completedAt: now,
        });
      },
    },
  });
  await store.getState().selectSession("a");
  await older();
  store.getState().setComposer("new question");
  await store.getState().send();
  expect(currentChat(store.getState()).messages).toHaveLength(202);
  expect(currentChat(store.getState()).messages[0].id).toBe("message-61");
  expect(currentChat(store.getState()).messages.at(-1)?.id).toBe("message-262");
  expect(listMessages).toHaveBeenCalledWith("a", { after_sequence_no: 60 });
});

it("recovers an odd boundary pending turn via a targeted pair without expanding the loaded range", async () => {
  const pending = message(260, { status: "pending", completed_at: null, turn_id: "old-turn" });
  const user = message(1, { content: "Original request", turn_id: "old-turn" });
  const { listMessages } = setup(
    async (_id, query = {}) =>
      query.turn_id
        ? { items: [user, pending], has_more: false }
        : { items: [...rows(161, 259), pending], has_more: true },
    {
      listRuns: async () => ({ runs: [run("generating")] }),
      getRunEvents: async () => ({
        events: [{ type: "started", runId: "old-run", seq: 1, at: now, requestId: "original-id" }],
      }),
    },
  );
  await store.getState().selectSession("a");
  expect(currentChat(store.getState()).request).toEqual({
    sessionId: "a",
    requestId: "original-id",
    text: "Original request",
  });
  expect(listMessages).toHaveBeenCalledWith("a", { turn_id: "old-turn" });
  expect(
    (currentChat(store.getState()) as unknown as { loadedFromSequence: number }).loadedFromSequence,
  ).toBe(161);
});

it("reconciles an old failed request by exact request identity without scanning the history gap", async () => {
  const pair = [
    message(1, { turn_id: "old-turn" }),
    message(2, { turn_id: "old-turn", status: "failed", error_code: "GENERATION_CANCELLED" }),
  ];
  const { listMessages } = setup(
    async (_id, query = {}) =>
      query.client_request_id
        ? { items: pair, has_more: false }
        : { items: rows(161, 260), has_more: !query.after_sequence_no },
    { getRunByRequest: async () => run() },
  );
  await store.getState().selectSession("a");
  const id = store.getState().currentConversationId as string;
  store.setState({
    conversationById: {
      ...store.getState().conversationById,
      [id]: {
        ...currentChat(store.getState()),
        phase: "reconciling",
        request: { sessionId: "a", text: "old question", requestId: "old-request" },
      },
    },
  });
  await store.getState().reconcileChat();
  expect(currentChat(store.getState()).outputId).toBe("message-2");
  expect(currentChat(store.getState()).failedChat?.requestId).toBe("old-request");
  expect(listMessages).toHaveBeenCalledWith("a", { client_request_id: "old-request" });
  expect(listMessages.mock.calls.some(([, query]) => query?.after_sequence_no === 0)).toBe(false);
});

it("rejects an older response after an authoritative refresh starts and deduplicates concurrent older clicks", async () => {
  let finish!: (page: Page) => void;
  const { listMessages } = setup(async (_id, query = {}) =>
    query.before_sequence_no
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { items: rows(161, 260), has_more: !query.after_sequence_no },
  );
  await store.getState().selectSession("a");
  const first = older();
  await older();
  expect(listMessages.mock.calls.filter(([, query]) => query?.before_sequence_no)).toHaveLength(1);
  await store.getState().selectSession("a");
  finish({ items: rows(61, 160), has_more: true });
  await first;
  expect(currentChat(store.getState()).messages[0].id).toBe("message-161");
});

it("keeps history and draft on an older read error, and allows explicit retry including system-only pages", async () => {
  let attempt = 0;
  setup(async (_id, query = {}) => {
    if (!query.before_sequence_no)
      return { items: rows(161, 260).map((item) => ({ ...item, role: "system" })), has_more: true };
    if (++attempt === 1) throw Error("Older page offline");
    return { items: rows(61, 160), has_more: false };
  });
  await store.getState().selectSession("a");
  store.getState().setComposer("protected draft");
  render(<DirectConversation />);
  const button = screen.getByRole("button", { name: "加载更早消息" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(currentChat(store.getState()).messages).toHaveLength(100);
  expect(currentChat(store.getState()).composer).toBe("protected draft");
  expect(currentChat(store.getState()).error).toContain("Older page offline");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
  });
  expect(screen.getByText("Body 61")).toBeTruthy();
});

it("caps legacy encrypted web preview hydration and new cache writes at latest100", async () => {
  let raw = JSON.stringify({
    sessionId: "a",
    agentId: "agent",
    loadRevision: 1,
    cachedAt: 1,
    messages: rows(1, 300).map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
      status: item.status,
      errorCode: null,
      createdAt: now,
      completedAt: now,
    })),
  });
  const storage = {
    read: async () => raw,
    write: async (_key: string, value: string) => {
      raw = value;
    },
    remove: async () => {},
  } as BrowserStateStorage;
  const preview = await loadWebChatCache(storage, "a", "agent");
  expect(preview?.messages).toHaveLength(100);
  expect(preview?.messages[0].id).toBe("message-201");
  await saveWebChatCache(storage, "a", "agent", 2, JSON.parse(raw).messages);
  expect(JSON.parse(raw).messages).toHaveLength(100);
  expect(CACHE_KEYS.CHAT_PREFIX).toBeTruthy();
});

it("rejects old API responses after the client owner changes", async () => {
  let finish!: (page: Page) => void;
  const { client } = setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const reading = store.getState().selectSession("a");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  store.setState({ apiClient: { ...client } });
  finish({ items: rows(161, 260), has_more: true });
  await reading;
  expect(currentChat(store.getState()).messages).toHaveLength(0);
});

it("preserves the first visible message anchor when older messages prepend", async () => {
  setup(async (_id, query = {}) =>
    query.before_sequence_no
      ? { items: rows(61, 160), has_more: true }
      : { items: rows(161, 260), has_more: true },
  );
  await store.getState().selectSession("a");
  render(<DirectConversation />);
  const viewport = screen.getByRole("region", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: {
      configurable: true,
      get: () => currentChat(store.getState()).messages.length * 20,
    },
    clientHeight: { configurable: true, value: 300 },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const text = this.textContent ?? "";
    const seq = Number(text.match(/Body (\d+)/)?.[1]);
    const first = Number(currentChat(store.getState()).messages[0].id.split("-")[1]);
    const top = this.tagName === "ARTICLE" ? (seq - first) * 20 - viewport.scrollTop : 0;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + 20,
      width: 800,
      height: 20,
      toJSON: () => ({}),
    };
  });
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
  });
  expect(viewport.scrollTop).toBe(2100);
  expect(screen.getByText("Body 166").closest("article")?.getBoundingClientRect().top).toBe(0);
});

it("preserves an older page loaded after a range refresh starts when that refresh commits", async () => {
  let finishRefresh!: (page: Page) => void;
  setup(async (_id, query = {}) => {
    if (query.after_sequence_no === 160)
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    if (query.before_sequence_no === 161) return { items: rows(61, 160), has_more: false };
    return { items: rows(161, 260), has_more: true };
  });
  await store.getState().selectSession("a");
  store.getState().setComposer("draft during refresh");
  render(<DirectConversation />);
  const viewport = screen.getByRole("region", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: {
      configurable: true,
      get: () => currentChat(store.getState()).messages.length * 20,
    },
    clientHeight: { configurable: true, value: 300 },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const seq = Number((this.textContent ?? "").match(/Body (\d+)/)?.[1]);
    const first = Number(currentChat(store.getState()).messages[0].id.split("-")[1]);
    const top = this.tagName === "ARTICLE" ? (seq - first) * 20 - viewport.scrollTop : 0;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 800,
      bottom: top + 20,
      width: 800,
      height: 20,
      toJSON: () => ({}),
    };
  });
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  let refreshing!: Promise<boolean>;
  act(() => {
    refreshing = store.getState().refreshSessionById("a");
  });
  await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
  });
  expect(currentChat(store.getState()).messages[0].id).toBe("message-61");
  expect(viewport.scrollTop).toBe(2100);
  await act(async () => {
    finishRefresh({
      items: rows(161, 260)
        .filter((item) => item.sequence_no !== 190)
        .map((item) =>
          item.sequence_no === 200 ? { ...item, content: "Updated Body 200" } : item,
        ),
      has_more: false,
    });
    expect(await refreshing).toBe(true);
  });
  const chat = currentChat(store.getState());
  expect(chat.messages[0].id).toBe("message-61");
  expect(chat.messages).toHaveLength(199);
  expect(new Set(chat.messages.map((item) => item.id)).size).toBe(199);
  expect(chat.messages.some((item) => item.id === "message-190")).toBe(false);
  expect(chat.messages.find((item) => item.id === "message-200")?.content).toBe("Updated Body 200");
  expect(chat.loadedFromSequence).toBe(61);
  expect(chat.hasOlderMessages).toBe(false);
  expect(chat.composer).toBe("draft during refresh");
  expect(viewport.scrollTop).toBe(2100);
  expect(screen.getByText("Body 166").closest("article")?.getBoundingClientRect().top).toBe(0);
});
