import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionPolicySchema } from "../../src/shared/contracts/permissions";
import type { ToolDirectoryEntry } from "../../src/shared/contracts/tool-directory";
import { api } from "../../src/web/api";
import { selectLocale, translate } from "../../src/web/i18n";
import { ToolDirectoryPanel } from "../../src/web/screens/connections/tool-directory-panel";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const tool = (
  name: string,
  globalEnabled = true,
  resource: string | null = null,
): ToolDirectoryEntry => ({
  name,
  description: "A registered read tool",
  parameters: { type: "object" },
  capability: "read",
  effect: "read",
  sandboxCallable: true,
  invocation: "action" as const,
  scope: name.startsWith("media.") ? "qq-conversation" : "conversation",
  origin: "system",
  globalEnabled,
  functionId: "memory-query",
  resource,
  revision: "v1",
  approvalRequired: false,
  directories: [],
});
afterEach(cleanup);
beforeEach(() => selectLocale("zh-CN"));
function setup(tools: ToolDirectoryEntry[]) {
  const save = vi.fn();
  store.getState().resetForTests({
    ...api,
    getToolDirectory: vi.fn().mockResolvedValue({ tools }),
    getPermissions: vi.fn().mockResolvedValue({
      revision: "v1",
      policy: { version: 1, grants: [], execution: ExecutionPolicySchema.parse({}) },
      resources: [],
    }),
    savePermissions: save,
  });
  render(<ToolDirectoryPanel />);
  return save;
}

// 行身份以目录自己挂在行容器上的 data 属性为准，不再依赖表格单元格。
const rowOf = (name: string) => {
  const text = screen.getByText(name);
  const wrapper = text.closest<HTMLElement>("[data-tool-name]");
  if (!wrapper) throw new Error(`missing tool row for ${name}`);
  return wrapper;
};
const renderedOrder = () =>
  Array.from(document.querySelectorAll("[data-tool-name]")).map((node) =>
    node.getAttribute("data-tool-name"),
  );

it("lists system tools without an MCP connection and keeps missing grants distinct from global disable", async () => {
  setup([tool("memory.query"), tool("web.fetch", true, "web"), tool("media.describe", false)]);
  await screen.findByText("memory.query");
  const web = rowOf("web.fetch");
  const media = rowOf("media.describe");
  expect(web.getAttribute("data-global-enabled")).toBe("true");
  expect(media.getAttribute("data-global-enabled")).toBe("false");
  expect(web.textContent).toContain("未授权");
  expect(media.textContent).toContain("全局已关闭");
  // 置灰的全局关闭行仍保留操作，不因灰显失效。
  expect(within(media).getByRole("button", { name: "查看详情" }).hasAttribute("disabled")).toBe(
    false,
  );
});

it("orders enabled tools before disabled ones and keeps every authorisation summary", async () => {
  setup([tool("media.describe", false), tool("web.fetch", true, "web"), tool("memory.query")]);
  await screen.findByText("memory.query");
  expect(renderedOrder()).toEqual(["web.fetch", "memory.query", "media.describe"]);
  expect(rowOf("web.fetch").textContent).toContain("未授权");
  expect(rowOf("memory.query").textContent).toContain("受功能配置与会话范围约束");
});

it("filters by human label, technical id and resource id without dropping the other rows", async () => {
  setup([tool("memory.query"), tool("web.fetch", true, "web")]);
  await screen.findByText("memory.query");
  const search = screen.getByRole("textbox", { name: "搜索工具名称、用途或来源" });
  fireEvent.change(search, { target: { value: "检索记忆" } });
  expect(screen.getByText("memory.query")).toBeTruthy();
  expect(screen.queryByText("web.fetch")).toBeNull();
  fireEvent.change(search, { target: { value: "memory.query" } });
  expect(screen.getByText("memory.query")).toBeTruthy();
  expect(screen.queryByText("web.fetch")).toBeNull();
  fireEvent.change(search, { target: { value: "web.fetch" } });
  expect(screen.getByText("web.fetch")).toBeTruthy();
  expect(screen.queryByText("memory.query")).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByText("memory.query")).toBeTruthy();
  expect(screen.getByText("web.fetch")).toBeTruthy();
});

it.each(["zh-CN", "en"] as const)(
  "%s keeps the full search name, short placeholder and origin filtering with accessible help",
  async (locale) => {
    selectLocale(locale);
    const save = setup([
      tool("memory.query"),
      {
        ...tool("external.lookup", true, "lookup-resource"),
        origin: "mcp",
        description: "External reference lookup",
      },
    ]);
    await screen.findByText("memory.query");
    const search = screen.getByRole("textbox", { name: translate("connections.tools.search") });
    expect(search.getAttribute("placeholder")).toBe(
      translate("connections.tools.searchPlaceholder"),
    );
    const description = document.getElementById(search.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(translate("connections.tools.directorySearchHelp"));
    const help = screen.getByRole("button", {
      name: translate("hints.field.learnAbout", translate("connections.tools.searchPlaceholder")),
    });
    help.focus();
    await userEvent.keyboard("{Enter}");
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      translate("connections.tools.directorySearchHelp"),
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(help);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      translate("connections.tools.directorySearchHelp"),
    );
    await userEvent.keyboard("{Escape}");
    fireEvent.change(search, { target: { value: "lookup-resource" } });
    expect(screen.getByText("external.lookup")).toBeTruthy();
    expect(screen.queryByText("memory.query")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    const origin = screen.getByRole("combobox", { name: translate("connections.tools.origin") });
    await userEvent.selectOptions(origin, "system");
    expect(screen.getByText("memory.query")).toBeTruthy();
    expect(screen.queryByText("external.lookup")).toBeNull();
    await userEvent.selectOptions(origin, "mcp");
    expect(screen.getByText("external.lookup")).toBeTruthy();
    expect(screen.queryByText("memory.query")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  },
);

it("shows literal input rules without definition edits or deletions", async () => {
  const save = setup([tool("memory.query")]);
  await screen.findByText("memory.query");
  fireEvent.click(within(rowOf("memory.query")).getByRole("button", { name: "查看详情" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain('"type": "object"');
  expect(dialog.textContent).toContain("不能删除或修改定义");
  expect(within(dialog).queryByRole("button", { name: /删除|编辑定义/ })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("opens an exact component requested by the shared navigation action", async () => {
  setup([tool("memory.query")]);
  store.setState({ componentTarget: { kind: "tool", id: "memory.query" } });
  expect((await screen.findByRole("dialog")).textContent).toContain("memory.query");
});

it("keeps rows collapsed by default and reveals the description only through the trigger", async () => {
  setup([tool("memory.query", true, "web")]);
  await screen.findByText("memory.query");
  const row = rowOf("memory.query");
  const trigger = within(row).getByRole("button", { name: /memory\.query/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(row.querySelector("[data-slot=collapsible-content]")?.textContent ?? "").toBe("");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(row.querySelector("[data-slot=collapsible-content]")?.textContent).toContain(
    "检索已授权记忆条目",
  );
});

it("keeps grant actions reachable from every row that owns a resource", async () => {
  setup([tool("memory.query"), tool("web.fetch", true, "web")]);
  await screen.findByText("memory.query");
  expect(within(rowOf("memory.query")).queryByRole("button", { name: "管理授权" })).toBeNull();
  fireEvent.click(within(rowOf("web.fetch")).getByRole("button", { name: "管理授权" }));
  expect(await screen.findByRole("heading", { name: "web" })).toBeTruthy();
});

it("shows QQ host submission scope and schema without a fake resource grant", async () => {
  const terminal: ToolDirectoryEntry = {
    ...tool("reply.text"),
    effect: "write",
    sandboxCallable: false,
    invocation: "host-terminal",
    scope: "qq-conversation",
    functionId: "qq-reply",
    parameters: { type: "object", properties: { outputs: { type: "array" } } },
  };
  const save = setup([terminal, { ...terminal, name: "reply.sticker", globalEnabled: false }]);
  await screen.findByText("reply.text");
  const row = rowOf("reply.text");
  expect(row.textContent).toContain("QQ 会话");
  expect(row.textContent).toContain("宿主提交");
  expect(row.textContent).toContain("目录不代表当前可发送");
  expect(within(row).queryByRole("button", { name: "管理授权" })).toBeNull();
  expect(rowOf("reply.sticker").textContent).toContain("全局已关闭");
  fireEvent.click(within(row).getByRole("button", { name: "查看详情" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain('"outputs"');
  expect(dialog.textContent).toContain("不支持");
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "前往功能配置" }));
  expect(store.getState().settingsRoute).toBe("qq-app-schemes");
});
