import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import {
  AVATAR_UPLOAD_MAX_BYTES,
  type ConversationAvatar,
} from "../../src/shared/contracts/conversation-avatar";
import { selectLocale } from "../../src/web/i18n";
import { ConversationAvatar as AvatarView } from "../../src/web/screens/conversations/avatar";
import {
  AVATAR_STYLES,
  defaultConversationAvatar,
} from "../../src/web/screens/conversations/avatar-designs";
import { AvatarEditor } from "../../src/web/screens/conversations/avatar-editor";
import { ConversationIdentity } from "../../src/web/screens/conversations/ConversationIdentity";
import { ConversationIndex } from "../../src/web/screens/conversations/ConversationIndex";
import { useSuperstringStore as store } from "../../src/web/store";

const conversation = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Design group",
  topology: "shared" as const,
};
const createUrl = vi.fn(() => "blob:local-avatar-preview");
const revokeUrl = vi.fn();
let pendingImages: BrowserImage[] = [];
class BrowserImage extends window.EventTarget {
  complete = false;
  naturalWidth = 0;
  referrerPolicy = "";
  crossOrigin: string | null = null;
  currentSrc = "";
  set src(value: string) {
    this.currentSrc = value;
    pendingImages.push(this);
    if (value.startsWith("data:image/svg+xml")) queueMicrotask(() => this.finish());
  }
  finish(ok = true) {
    this.complete = true;
    this.naturalWidth = ok ? 160 : 0;
    this.dispatchEvent(new Event(ok ? "load" : "error"));
  }
}
beforeEach(() => {
  selectLocale("zh-CN");
  pendingImages = [];
  vi.stubGlobal("Image", BrowserImage);
  createUrl.mockClear();
  revokeUrl.mockClear();
  const BrowserURL = URL;
  vi.stubGlobal(
    "URL",
    class extends BrowserURL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    },
  );
  store.getState().resetForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function editor(value: ConversationAvatar = null, save = vi.fn().mockResolvedValue(undefined)) {
  const closed = vi.fn();
  const rendered = render(
    <AvatarEditor
      conversationId={conversation.id}
      title={conversation.title}
      topology={conversation.topology}
      value={value}
      open
      onOpenChange={closed}
      onSave={save}
    />,
  );
  return { save, closed, ...rendered };
}

it("produces local deterministic designs which survive rename and vary by conversation", async () => {
  const first = defaultConversationAvatar(conversation);
  expect(defaultConversationAvatar({ ...conversation, title: "Renamed" })).toEqual(first);
  expect(defaultConversationAvatar({ ...conversation, id: "other-conversation" }).seed).not.toBe(
    first.seed,
  );
  const { rerender } = render(
    <AvatarView conversation={conversation} value={first} label="Preview" />,
  );
  const original = (await screen.findByRole("img", { name: "Preview" })).getAttribute("src");
  rerender(
    <AvatarView
      conversation={{ ...conversation, title: "Renamed" }}
      value={first}
      label="Preview"
    />,
  );
  expect(screen.getByRole("img", { name: "Preview" }).getAttribute("src")).toBe(original);
  for (const style of AVATAR_STYLES) {
    rerender(
      <AvatarView conversation={conversation} value={{ ...first, style }} label="Preview" />,
    );
    expect((await screen.findByRole("img", { name: "Preview" })).getAttribute("src")).toMatch(
      /^data:image\/svg\+xml/,
    );
  }
});

it("leaves the current avatar unchanged until a selected design is saved", async () => {
  const { save, closed } = editor();
  expect((screen.getByRole("button", { name: "保存头像" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "图案风格" }), {
    target: { value: "pixel-art" },
  });
  await userEvent.click(screen.getByRole("radio", { name: "选择第 2 个图案" }));
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存头像" }));
  expect(save).toHaveBeenCalledWith({
    kind: "generated",
    style: "pixel-art",
    seed: `${conversation.id}:1`,
  });
  expect(closed).toHaveBeenCalledWith(false);
});

it("shows failures, preserves the selected draft, and permits an explicit retry", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Server unavailable"))
    .mockResolvedValue(undefined);
  const { closed } = editor(null, save);
  await userEvent.click(screen.getByRole("radio", { name: "选择第 3 个图案" }));
  await userEvent.click(screen.getByRole("button", { name: "保存头像" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Server unavailable");
  expect(screen.getByRole("radio", { name: "选择第 3 个图案" }).getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(closed).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存头像" }));
  expect(save).toHaveBeenCalledTimes(2);
  expect(closed).toHaveBeenCalledWith(false);
});

it("keeps a pending save modal open and prevents repeated submission", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { closed } = editor(null, save);
  await userEvent.click(screen.getByRole("radio", { name: "选择第 2 个图案" }));
  fireEvent.click(screen.getByRole("button", { name: "保存头像" }));
  fireEvent.click(screen.getByRole("button", { name: "正在保存…" }));
  await userEvent.keyboard("{Escape}");
  expect(save).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish());
  expect(closed).toHaveBeenCalledWith(false);
});

it("refreshes the candidate gallery without silently choosing or saving a new avatar", async () => {
  const { save } = editor();
  const before = screen.getAllByRole("radio").map((item) => item.getAttribute("value"));
  fireEvent.click(screen.getByRole("button", { name: "换一组" }));
  const after = screen.getAllByRole("radio").map((item) => item.getAttribute("value"));
  expect(after).not.toEqual(before);
  expect((screen.getByRole("button", { name: "保存头像" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(save).not.toHaveBeenCalled();
});

it("previews uploaded GIF bytes locally and only sends the original file on Save", async () => {
  const { save, unmount } = editor();
  await userEvent.click(screen.getByRole("tab", { name: "上传图片" }));
  const file = new File(["GIF89a"], "animated.gif", { type: "image/gif" });
  fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [file] } });
  expect(createUrl).toHaveBeenCalledWith(file);
  expect(screen.getByText("已选择：animated.gif")).toBeTruthy();
  expect((screen.getByRole("button", { name: "保存头像" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByRole("status").textContent).toContain("正在检查图片");
  expect(save).not.toHaveBeenCalled();
  await act(async () =>
    pendingImages.find((image) => image.currentSrc === "blob:local-avatar-preview")?.finish(),
  );
  await userEvent.click(screen.getByRole("button", { name: "保存头像" }));
  expect(save).toHaveBeenCalledWith(file);
  unmount();
  expect(revokeUrl).toHaveBeenCalledWith("blob:local-avatar-preview");
});

it("rejects unsupported and oversized files before creating a preview or making a request", async () => {
  const { save } = editor();
  await userEvent.click(screen.getByRole("tab", { name: "上传图片" }));
  fireEvent.change(screen.getByLabelText("选择头像图片"), {
    target: { files: [new File(["<svg/>"], "icon.svg", { type: "image/svg+xml" })] },
  });
  expect(screen.getByRole("alert").textContent).toContain("PNG");
  const large = new File(["image"], "photo.png", { type: "image/png" });
  Object.defineProperty(large, "size", { value: AVATAR_UPLOAD_MAX_BYTES + 1 });
  fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [large] } });
  expect(screen.getByRole("alert").textContent).toContain("不超过");
  expect(createUrl).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("previews a reset and submits null only after Save", async () => {
  const { save } = editor({
    kind: "uploaded",
    url: `/v2/conversations/${conversation.id}/avatar?revision=saved`,
  });
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(screen.getByText("保存后恢复这个会话的默认头像。")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存头像" }));
  expect(save).toHaveBeenCalledWith(null);
});

it("offers an avatar editor for OneBot records without exposing web-only lifecycle actions", async () => {
  const item: ConversationSummary = {
    ...conversation,
    channel: "onebot11",
    sourceId: "binding",
    agentId: "agent",
    bindingEpoch: 1,
    participants: [],
    updatedAt: "2026-09-26T04:02:27Z",
    lastSeq: 1,
    consumedSeq: 1,
  };
  store.setState({ directoryIds: [item.id], summaryById: { [item.id]: item } });
  render(<ConversationIndex />);
  fireEvent.contextMenu(screen.getByRole("button", { name: item.title }), {
    clientX: 100,
    clientY: 100,
  });
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["更换会话头像"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "更换会话头像" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(screen.getByRole("heading", { name: "更换会话头像" })).toBeTruthy();
});

it("does not allow command navigation to escape an in-flight avatar save", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  editor(null, save);
  await userEvent.click(screen.getByRole("radio", { name: "选择第 2 个图案" }));
  fireEvent.click(screen.getByRole("button", { name: "保存头像" }));
  const navigate = vi.fn();
  document.addEventListener("keydown", navigate);
  try {
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "k", ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("keydown", navigate);
  }
  await act(async () => finish());
});

it("does not let an older conversation's save close the new conversation's editor", async () => {
  const first: ConversationSummary = {
    ...conversation,
    channel: "web",
    sourceId: "session-a",
    agentId: "agent",
    bindingEpoch: 1,
    participants: [],
    updatedAt: "2026-09-26T04:02:27Z",
    lastSeq: 1,
    consumedSeq: 1,
  };
  const second = {
    ...first,
    id: "00000000-0000-4000-8000-000000000002",
    title: "Another conversation",
    sourceId: "session-b",
  };
  let finish!: (value: ConversationAvatar) => void;
  const save = vi.fn(
    () =>
      new Promise<ConversationAvatar>((resolve) => {
        finish = resolve;
      }),
  );
  store.setState({
    directoryIds: [first.id, second.id],
    summaryById: { [first.id]: first, [second.id]: second },
    apiClient: { ...store.getState().apiClient, saveConversationAvatar: save },
  });
  const { rerender } = render(<ConversationIdentity conversation={first} />);
  await userEvent.click(screen.getByRole("button", { name: "更换「Design group」的头像" }));
  await userEvent.click(screen.getByRole("radio", { name: "选择第 2 个图案" }));
  fireEvent.click(screen.getByRole("button", { name: "保存头像" }));
  rerender(<ConversationIdentity conversation={second} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "更换「Another conversation」的头像" }));
  expect(screen.getByRole("dialog").textContent).toContain(second.title);
  await act(async () => finish({ kind: "generated", style: "shapes", seed: "saved" }));
  expect(screen.getByRole("dialog").textContent).toContain(second.title);
  expect(store.getState().summaryById[second.id].avatar).toBeUndefined();
});

it("keeps a corrupt image disabled after the browser reports a decode error", async () => {
  const { save } = editor();
  await userEvent.click(screen.getByRole("tab", { name: "上传图片" }));
  const corrupt = new File(["PNG header only"], "bad.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("选择头像图片"), { target: { files: [corrupt] } });
  await act(async () =>
    pendingImages.find((image) => image.currentSrc === "blob:local-avatar-preview")?.finish(false),
  );
  expect(screen.getByRole("alert").textContent).toContain("无法预览");
  expect((screen.getByRole("button", { name: "保存头像" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(save).not.toHaveBeenCalled();
});
