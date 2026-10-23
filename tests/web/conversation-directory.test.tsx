import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { currentSessionId } from "../../src/web/features/conversations/directory-state";
import { ConversationIndex as ConversationList } from "../../src/web/screens/conversations/ConversationIndex";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";
import { render } from "./helpers/render-with-providers";

const web = summaryFixture("empty");
const direct = { ...summaryFixture("private"), id: "direct", channel: "onebot11" as const };
const group = {
  ...direct,
  id: "group",
  sourceId: "group-binding",
  topology: "shared" as const,
  title: "同事群",
};
beforeEach(() => {
  localStorage.clear();
  store.getState().resetForTests({
    listMessages: async () => [],
    getSessionRuntime: async () => null,
  } as unknown as SuperstringApi);
});
afterEach(cleanup);

it("one directory retains empty Web, direct and shared entries through pagination", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [web, direct], nextCursor: "page-2" })
    .mockResolvedValueOnce({ items: [group], nextCursor: null });
  store.setState({ apiClient: { ...store.getState().apiClient, listConversations: list } });
  await store.getState().loadConversations();
  render(<ConversationList />);
  expect(screen.getByRole("button", { name: "empty" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "private" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "加载更多会话" })));
  expect(list).toHaveBeenLastCalledWith({ cursor: "page-2" });
  fireEvent.click(screen.getByRole("button", { name: "同事群" }));
  expect(store.getState().currentConversationId).toBe("group");
  expect(currentSessionId(store.getState())).toBeNull();
  expect(store.getState().directoryIds).toEqual([web.id, direct.id, group.id]);
});

it("cancelled navigation does not change the selected conversation behind dirty settings", async () => {
  store.getState().rememberConversation(web);
  store.getState().rememberConversation(group);
  store.setState({
    currentConversationId: web.id,
    page: "settings",
    settingsView: "agents",
    dirty: true,
  });
  await store.getState().requestConversationNavigation(group.id);
  expect(store.getState().pendingNavigation).toMatchObject({
    kind: "page",
    page: "chat",
    conversationId: "group",
  });
  expect(store.getState().currentConversationId).toBe(web.id);
  store.getState().cancelPendingNavigation();
  expect(store.getState().currentConversationId).toBe(web.id);
  expect(store.getState().page).toBe("settings");
  expect(store.getState().dirty).toBe(true);
});

it("discard and continue commits the exact requested group only after resolving drafts", async () => {
  store.getState().rememberConversation(web);
  store.getState().rememberConversation(group);
  store.setState({
    currentConversationId: web.id,
    page: "settings",
    settingsView: "agents",
    dirty: true,
  });
  await store.getState().requestConversationNavigation(group.id);
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().page).toBe("chat");
  expect(store.getState().currentConversationId).toBe(group.id);
  expect(store.getState().pendingNavigation).toBeNull();
});

it("late Web source resolution cannot replace a newer OneBot selection", async () => {
  let resolve!: (page: { items: (typeof web)[]; nextCursor: null }) => void;
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      listConversations: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  store.getState().rememberConversation(group);
  const selecting = store.getState().selectSession("empty");
  await store.getState().selectConversation(group.id);
  resolve({ items: [web], nextCursor: null });
  await selecting;
  expect(store.getState().currentConversationId).toBe(group.id);
  expect(currentSessionId(store.getState())).toBeNull();
});

it("failed list reads preserve known entries and expose a real error", async () => {
  store.getState().rememberConversation(group);
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      listConversations: async () => {
        throw new Error("offline");
      },
    },
  });
  expect(await store.getState().loadConversations()).toBe(false);
  render(<ConversationList />);
  expect(screen.getByRole("button", { name: "同事群" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("offline");
});

it("bootstrap restores a saved canonical group beyond the first directory page", async () => {
  const { createBrowserStateStorage } = await import("../../src/web/browser-state");
  const config = {
    secret: "directory-test-secret",
    storage_keys: { session: "superstring-session" as const, agent: "superstring-agent" as const },
  };
  await createBrowserStateStorage(config).write("superstring-conversation", group.id);
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [web], nextCursor: "older" })
    .mockResolvedValueOnce({ items: [group], nextCursor: "oldest" });
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      listConversations: list,
      listAgents: async () => [],
      listModels: async () => ({ models: [] }),
      listModelProviders: async () => [],
      getBrowserStateConfig: async () => config,
    } as unknown as SuperstringApi,
  });
  await store.getState().bootstrap();
  expect(list).toHaveBeenLastCalledWith({ cursor: "older" });
  expect(store.getState().currentConversationId).toBe(group.id);
  expect(store.getState().directoryIds).toEqual([web.id, group.id]);
  expect(store.getState().directoryCursor).toBe("oldest");
  localStorage.removeItem("superstring-conversation");
});

it("a failed later directory page preserves the saved choice and exposes the restoration error", async () => {
  const { createBrowserStateStorage } = await import("../../src/web/browser-state");
  const config = {
    secret: "directory-error-test",
    storage_keys: { session: "superstring-session" as const, agent: "superstring-agent" as const },
  };
  const storage = createBrowserStateStorage(config);
  await storage.write("superstring-conversation", group.id);
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [web], nextCursor: "older" })
    .mockRejectedValueOnce(new Error("Directory unavailable"));
  store.setState({
    apiClient: {
      ...store.getState().apiClient,
      listConversations: list,
      listAgents: async () => [],
      listModels: async () => ({ models: [] }),
      listModelProviders: async () => [],
      getBrowserStateConfig: async () => config,
    } as unknown as SuperstringApi,
  });
  await store.getState().bootstrap();
  expect(store.getState().status).toBe("ready");
  expect(store.getState().currentConversationId).toBeNull();
  expect(store.getState().directoryIds).toEqual([web.id]);
  expect(store.getState().directoryError).toBe("Directory unavailable");
  expect(await storage.read("superstring-conversation")).toBe(group.id);
});

it("background refresh keeps loaded pages and a selected older item while filtering server deletions", async () => {
  const deleted = { ...web, id: "deleted", sourceId: "deleted" };
  for (const item of [web, group, deleted]) store.getState().rememberConversation(item);
  store.setState({ currentConversationId: group.id, directoryCursor: "old-cursor" });
  const incoming = [1, 2, 3].map((n) => ({ ...web, id: `new-${n}`, sourceId: `new-${n}` }));
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: incoming.slice(0, 2), nextCursor: "fresh-2" })
    .mockResolvedValueOnce({ items: [incoming[2], web], nextCursor: "fresh-3" })
    .mockResolvedValueOnce({ items: [group], nextCursor: "fresh-4" });
  store.setState({ apiClient: { ...store.getState().apiClient, listConversations: list } });
  expect(await store.getState().loadConversations("refresh-loaded")).toBe(true);
  expect(list.mock.calls).toEqual([[{}], [{ cursor: "fresh-2" }], [{ cursor: "fresh-3" }]]);
  expect(store.getState().directoryIds).toEqual([
    ...incoming.map((item) => item.id),
    web.id,
    group.id,
  ]);
  expect(store.getState().directoryIds).not.toContain("deleted");
  expect(store.getState().currentConversationId).toBe(group.id);
  expect(store.getState().directoryCursor).toBe("fresh-4");
});

it("failure while refreshing a later loaded page keeps the prior visible range with an error", async () => {
  for (const item of [web, group]) store.getState().rememberConversation(item);
  const before = store.getState().directoryIds;
  const list = vi
    .fn()
    .mockResolvedValueOnce({ items: [web], nextCursor: "next" })
    .mockRejectedValueOnce(Error("later page unavailable"));
  store.setState({ apiClient: { ...store.getState().apiClient, listConversations: list } });
  expect(await store.getState().loadConversations("refresh-loaded")).toBe(false);
  expect(store.getState().directoryIds).toEqual(before);
  expect(store.getState().directoryError).toBe("later page unavailable");
});

it("source resolution rejects old clients, stale requests and changed QQ Agent ownership", async () => {
  const summary = { ...direct, sourceId: "binding", agentId: "agent-a" };
  let finish!: (page: { items: (typeof summary)[]; nextCursor: null }) => void;
  const list = vi.fn(
    () =>
      new Promise<{ items: (typeof summary)[]; nextCursor: null }>((done) => {
        finish = done;
      }),
  );
  store.setState({
    apiClient: { ...store.getState().apiClient, listConversations: list },
    qqBindings: [{ id: "binding", agent_id: "agent-a" }] as ReturnType<
      typeof store.getState
    >["qqBindings"],
  });
  const oldClientRead = store
    .getState()
    .resolveConversationSource("onebot11", "binding", "agent-a");
  store.setState({ apiClient: { ...store.getState().apiClient } });
  finish({ items: [summary], nextCursor: null });
  expect(await oldClientRead).toBeNull();
  expect(store.getState().directoryIds).not.toContain(summary.id);

  const changedAgentRead = store
    .getState()
    .resolveConversationSource("onebot11", "binding", "agent-a");
  store.setState({
    qqBindings: [{ id: "binding", agent_id: "agent-b" }] as ReturnType<
      typeof store.getState
    >["qqBindings"],
  });
  finish({ items: [summary], nextCursor: null });
  expect(await changedAgentRead).toBeNull();
  expect(store.getState().directoryIds).not.toContain(summary.id);
});

it("resolving a source publishes only the server's exact matching summary and clears its read error", async () => {
  const correct = { ...direct, sourceId: "binding", agentId: "agent-a", lastSeq: 0 };
  const other = { ...correct, id: "wrong-agent", agentId: "agent-b" };
  const list = vi.fn().mockResolvedValue({ items: [other, correct], nextCursor: null });
  store.setState({
    apiClient: { ...store.getState().apiClient, listConversations: list },
    qqBindings: [{ id: "binding", agent_id: "agent-a" }] as ReturnType<
      typeof store.getState
    >["qqBindings"],
    directoryError: "offline",
  });
  expect(
    await store.getState().resolveConversationSource("onebot11", "binding", "agent-a"),
  ).toEqual(correct);
  expect(list).toHaveBeenCalledWith({ channel: "onebot11", sourceId: "binding" });
  expect(store.getState().directoryIds).toEqual([correct.id]);
  expect(store.getState().summaryById[other.id]).toBeUndefined();
  expect(store.getState().directoryError).toBeNull();
});

it("matches agent names in search while empty queries keep every loaded entry", () => {
  const item = {
    ...direct,
    id: "agent-conv",
    sourceId: "agent-source",
    title: "Project room",
    agentId: "agent-1",
  };
  store.setState({
    agents: [{ id: "agent-1", name: "Alpha Agent" }] as unknown as ReturnType<
      typeof store.getState
    >["agents"],
  });
  store.getState().rememberConversation(item);
  store.setState({ currentConversationId: item.id });

  render(<ConversationList />);
  const row = () => screen.getByRole("button", { name: "Project room" });

  // Empty query + channel "all" lists the entry without rebuilding haystacks.
  expect(row()).toBeTruthy();
  const search = screen.getByRole("textbox");
  fireEvent.change(search, { target: { value: "alpha agent" } });
  expect(row()).toBeTruthy();
  fireEvent.change(search, { target: { value: "missing" } });
  expect(screen.queryByRole("button", { name: "Project room" })).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  expect(row()).toBeTruthy();
});
