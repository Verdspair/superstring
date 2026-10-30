// QQ 会话移除（真实 store + 假 API）：DELETE 204 精确剪除、409 保行保弹窗、旧 ack 不剪除；
// 目录菜单对 QQ 私聊/群共用一个移除入口与既有确认弹窗，Web 分支不变。
//
// 断言只用 i18n 稳定键（qq.conversation.remove*）与 store 状态，不做样式类或文案快照。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { QqBindingResponse, QqConversationListItem } from "../../src/shared/contracts/qq";
import { QqBindingResponseSchema } from "../../src/shared/contracts/qq";
import { api, type SuperstringApi } from "../../src/web/api";
import { emptyWebConversation } from "../../src/web/features/chat/conversation-state";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationIndex } from "../../src/web/screens/conversations/ConversationIndex";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCHEME = "22222222-2222-4222-8222-222222222222";
const TARGET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const bindingOf = (
  id: string,
  kind: "group" | "private",
  peer: string,
  revision = 5,
): QqBindingResponse =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind,
    peer_id: peer,
    agent_id: AGENT,
    scheme_id: SCHEME,
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision,
    authority_revision: revision,
    attention: { mode: "off", members: [] },
    task_limits: { mention_task_limit: null, ordinary_task_limit: null },
    input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
  });

const conversationRow = (
  id: string,
  sourceId: string,
  title: string,
  topology: "direct" | "shared" = "direct",
  agentId = AGENT,
): ConversationSummary => ({
  id,
  channel: "onebot11",
  topology,
  sourceId,
  agentId,
  bindingEpoch: 1,
  title,
  participants: [],
  updatedAt: NOW,
  lastSeq: 0,
  consumedSeq: 0,
});

const webRow = (id: string, sourceId: string, title: string): ConversationSummary => ({
  id,
  channel: "web",
  topology: "direct",
  sourceId,
  agentId: AGENT,
  bindingEpoch: 1,
  title,
  participants: [],
  updatedAt: NOW,
  lastSeq: 0,
  consumedSeq: 0,
});

function reset(overrides: Partial<SuperstringApi> = {}) {
  const fake = {
    ...api,
    getQqSettings: async () => ({
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: "ws://localhost:3000", has_token: true },
      revision: 3,
    }),
    getQqStatus: async () => ({ connection: null }),
    listQqConversations: async () => ({ items: [], nextCursor: null }),
    listQqBindings: async () => [],
    listQqSchemes: async () => [],
    getQqSchemeUsage: async (id: string) => ({ scheme_id: id, bindings: 0 }),
    ...overrides,
  } as unknown as SuperstringApi;
  store.getState().resetForTests(fake);
  return fake;
}

/** 目录：目标 QQ 私聊 + 另一 QQ 群 + 一行 Web；目标会话可作为当前选中。 */
function seedDirectory(
  target: QqBindingResponse,
  other: QqBindingResponse,
  current: string | null,
) {
  const web = webRow("web-1", "session-a", "网页会话");
  const privateRow = conversationRow("qq-private", target.id, "私聊 40004");
  const groupRow = conversationRow("qq-group", other.id, "同事群", "shared");
  const observed: QqConversationListItem[] = [
    {
      account_id: target.account_id,
      kind: target.kind,
      peer_id: target.peer_id,
      messages: 12,
      last_at_seconds: 1,
      binding_id: target.id,
    },
    {
      account_id: other.account_id,
      kind: other.kind,
      peer_id: other.peer_id,
      messages: 4,
      last_at_seconds: 1,
      binding_id: other.id,
    },
  ];
  store.setState({
    summaryById: Object.fromEntries([web, privateRow, groupRow].map((row) => [row.id, row])),
    directoryIds: [web.id, privateRow.id, groupRow.id],
    currentConversationId: current,
    conversationById: {
      [privateRow.id]: emptyWebConversation(target.id),
      [groupRow.id]: emptyWebConversation(other.id),
    },
    qqBindings: [target, other],
    qqBindingsLoaded: true,
    qqSettings: {
      enabled: false,
      account_id: "10001",
      judgement_model_name: null,
      transport: { endpoint: "ws://localhost:3000", has_token: true },
      revision: 3,
    },
    qqConnection: { phase: "ready", reason: "Connected fixture" },
    qqConversations: observed,
  });
  return { web, privateRow, groupRow };
}

const openMenu = (title: string) => {
  fireEvent.contextMenu(screen.getByRole("button", { name: title }), {
    clientX: 120,
    clientY: 120,
  });
  return screen.getAllByRole("menuitem");
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("DELETE 204 后精确剪除该绑定的全部纪元、保留 Web 与其他绑定行，当前选中落在被剪会话时清空", async () => {
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  const remove = vi.fn().mockResolvedValue(undefined);
  reset({ deleteQqBinding: remove });
  const { privateRow, groupRow } = seedDirectory(target, other, "qq-private");
  // 同一绑定换过 Agent 的旧纪元：sourceId 相同、id 与 agentId 不同，也必须一并剪除。
  const oldEpoch: ConversationSummary = {
    ...conversationRow("qq-private-epoch0", target.id, "私聊 40004", "direct", OLD_AGENT),
    bindingEpoch: 2,
  };
  store.setState((state) => ({
    summaryById: { ...state.summaryById, [oldEpoch.id]: oldEpoch },
    directoryIds: [...state.directoryIds, oldEpoch.id],
  }));
  const before = store.getState().directoryIds;

  expect(await store.getState().removeQqConversation(TARGET, 5)).toBe(true);
  expect(remove).toHaveBeenCalledWith(TARGET, 5);

  const after = store.getState();
  const removed = [privateRow.id, oldEpoch.id];
  expect(after.directoryIds).toEqual(before.filter((id) => !removed.includes(id)));
  expect(after.summaryById[privateRow.id]).toBeUndefined();
  expect(after.summaryById[oldEpoch.id]).toBeUndefined();
  // Web 与其他绑定行原样保留。
  expect(after.summaryById["web-1"]).toBeDefined();
  expect(after.summaryById[groupRow.id]).toBeDefined();
  expect(after.qqBindings.map((row) => row.id)).toEqual([OTHER]);
  // 被剪的是当前选中：只清空，不擅自改选别的会话。
  expect(after.currentConversationId).toBeNull();
  expect(after.conversationById[privateRow.id]).toBeUndefined();
  expect(after.conversationById[groupRow.id]).toBeDefined();
  // 对端观察行回归未绑定；成功路径写锁已结算。
  expect(after.qqConversations.every((row) => row.binding_id !== TARGET)).toBe(true);
  expect(after.qqAccessSaving).toBe(false);
});

it("409 冲突：动作失败、绑定与会话保留、错误在既有弹窗内可见，弹窗保持可取消", async () => {
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  const remove = vi.fn().mockRejectedValue(new Error("绑定已被其他窗口修改（409）"));
  reset({ deleteQqBinding: remove });
  const { privateRow } = seedDirectory(target, other, null);

  render(<ConversationIndex />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "私聊 40004" }), {
    clientX: 10,
    clientY: 10,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("移除QQ会话");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "移除会话" }));
  });
  expect(remove).toHaveBeenCalledWith(TARGET, 5);
  // 失败：行与绑定都还在，弹窗仍在原地并显示错误。
  expect(store.getState().qqBindings.map((row) => row.id)).toEqual([TARGET, OTHER]);
  expect(store.getState().summaryById[privateRow.id]).toBeDefined();
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(screen.getByRole("alertdialog").textContent).toContain("409");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("重置后旧 API 的迟到 ack 不剪除新状态里的绑定与会话", async () => {
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  reset({ deleteQqBinding: vi.fn(() => gate.then(() => undefined)) });
  seedDirectory(target, other, "qq-private");
  const stale = store.getState().removeQqConversation(TARGET, 5);

  // 重置到从未收到这次删除的新 API，并把同一份目录原样放回新状态。
  reset();
  seedDirectory(target, other, "qq-private");
  release();

  expect(await stale).toBe(false);
  await act(async () => {});
  expect(store.getState().qqBindings.map((row) => row.id)).toEqual([TARGET, OTHER]);
  expect(store.getState().summaryById["qq-private"]).toBeDefined();
  expect(store.getState().directoryIds).toContain("qq-private");
});

it("QQ 私聊与群行共用同一个移除菜单与既有确认弹窗，解绑影响文案不变；Web 分支不变", async () => {
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  reset();
  seedDirectory(target, other, null);
  render(<ConversationIndex />);

  // 私聊行：移除入口 + 解绑语义（不删 Agent/方案/平台记录）。
  const privateItems = openMenu("私聊 40004");
  expect(privateItems.map((el) => el.textContent)).toContain("移除会话");
  fireEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("移除QQ会话");
  expect(dialog.textContent).toContain("不会删除Agent、方案或QQ平台聊天记录");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();

  // 群行：同一入口与同一弹窗标题。
  const groupItems = openMenu("同事群");
  expect(groupItems.map((el) => el.textContent)).toContain("移除会话");
  fireEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
  expect((await screen.findByRole("alertdialog")).textContent).toContain("移除QQ会话");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  // Web 行保留既有删除分支，不混入 QQ 移除文案。
  const webItems = openMenu("网页会话");
  expect(webItems.map((el) => el.textContent)).toContain("删除会话");
  expect(webItems.map((el) => el.textContent)).not.toContain("移除会话");
});

it.each(["private", "group"] as const)(
  "QQ %s unbind cancellation restores exact source and never switches the selected Web row",
  async (kind) => {
    const remove = vi.fn();
    reset({ deleteQqBinding: remove });
    const target = bindingOf(TARGET, "private", "40004");
    const other = bindingOf(OTHER, "group", "30003");
    const { web, privateRow, groupRow } = seedDirectory(target, other, "web-1");
    render(<ConversationIndex />);
    const item = kind === "private" ? privateRow : groupRow;
    const trigger = screen.getByRole("button", {
      name: i18n.t("workspace.conversation_actions", { "0": item.title }),
    });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(store.getState().currentConversationId).toBe(web.id);
    expect(remove).not.toHaveBeenCalled();
    expect(store.getState().qqBindings).toHaveLength(2);
  },
);

it.each(["private", "group"] as const)(
  "successful same-owner QQ %s unbind keeps the original header destination",
  async (kind) => {
    const gate = Promise.withResolvers<void>();
    const remove = vi.fn().mockReturnValue(gate.promise);
    reset({ deleteQqBinding: remove });
    const target = bindingOf(TARGET, "private", "40004");
    const other = bindingOf(OTHER, "group", "30003");
    const { web, privateRow, groupRow } = seedDirectory(target, other, "web-1");
    render(<ConversationIndex />);
    const item = kind === "private" ? privateRow : groupRow;
    const header = screen.getByRole("heading", { name: "对话", hidden: true });
    const focus = vi.spyOn(header, "focus");
    await userEvent.click(
      screen.getByRole("button", {
        name: i18n.t("workspace.conversation_actions", { "0": item.title }),
      }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "移除会话" }));
    await act(async () => gate.resolve());
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(header);
    expect(store.getState().summaryById[item.id]).toBeUndefined();
    expect(store.getState().currentConversationId).toBe(web.id);
    expect(remove).toHaveBeenCalledWith(kind === "private" ? TARGET : OTHER, 5);
  },
);

it("old QQ unbind false completion cannot focus a replacement API directory header", async () => {
  const gate = Promise.withResolvers<void>();
  reset({ deleteQqBinding: vi.fn().mockReturnValue(gate.promise) });
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  const { privateRow } = seedDirectory(target, other, "web-1");
  render(<ConversationIndex />);
  const focus = vi.spyOn(screen.getByRole("heading", { name: "对话", hidden: true }), "focus");
  await userEvent.click(
    screen.getByRole("button", {
      name: i18n.t("workspace.conversation_actions", { "0": privateRow.title }),
    }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "移除会话" }),
  );
  await act(async () =>
    store.setState({
      apiClient: { ...store.getState().apiClient },
      summaryById: {},
      directoryIds: [],
    }),
  );
  await act(async () => gate.resolve());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(focus).not.toHaveBeenCalled();
});

it("external QQ summary disappearance with its binding still present does not count as this pending unbind success", async () => {
  const gate = Promise.withResolvers<void>();
  reset({ deleteQqBinding: vi.fn().mockReturnValue(gate.promise) });
  const target = bindingOf(TARGET, "private", "40004");
  const other = bindingOf(OTHER, "group", "30003");
  const { privateRow } = seedDirectory(target, other, "web-1");
  render(<ConversationIndex />);
  const focus = vi.spyOn(screen.getByRole("heading", { name: "对话", hidden: true }), "focus");
  await userEvent.click(
    screen.getByRole("button", {
      name: i18n.t("workspace.conversation_actions", { "0": privateRow.title }),
    }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "移除会话" }));
  await userEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "移除会话" }),
  );
  await act(async () =>
    store.setState((state) => ({
      summaryById: Object.fromEntries(
        Object.entries(state.summaryById).filter(([id]) => id !== privateRow.id),
      ),
      directoryIds: state.directoryIds.filter((id) => id !== privateRow.id),
    })),
  );
  await act(async () => gate.resolve());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(focus).not.toHaveBeenCalled();
});
