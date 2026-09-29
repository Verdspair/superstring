// 执行设置页的排版与易用性用例：完整字段与开关、页内锚点、上下同源保存与非法值不写。
// permissions 夹具按 access-console 的形状本地取样，不共享实现细节。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { ApiError, api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ExecutionSettings } from "../../src/web/screens/runs/execution-settings";
import { useSuperstringStore as store } from "../../src/web/store";

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [{ resource: "mcp.echo.read", approved: false, revision: "r1", directories: [] }],
    execution: {
      research: false,
      code: false,
      modules: {
        mcp: true,
        skills: true,
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: false,
      },
      pausedTools: [],
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 7200 },
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: {
        timeoutMs: 20_000,
        maxCalls: 32,
        concurrency: 3,
        memoryBytes: 33_554_432,
        maxTransferBytes: 1_048_576,
        maxConclusionChars: 8_000,
      },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 1,
        providerConcurrency: 1,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    },
  },
  resources: [],
};

// 24 个标签共 25 个输入框：「结论字符上限」在研究档与代码档各有一个。
const NUMERIC: [string, string[]][] = [
  ["记忆整理总时限（秒）", ["3600"]],
  ["知识整理总时限（秒）", ["7200"]],
  ["同时执行的任务数", ["2"]],
  ["最长有效期（小时）", ["24"]],
  ["工作租约（秒）", ["30"]],
  ["巡检间隔（毫秒）", ["500"]],
  ["每个父运行最多子任务", ["2"]],
  ["子任务步数上限", ["6"]],
  ["子任务时限（毫秒）", ["60000"]],
  ["结论字符上限", ["4000", "8000"]],
  ["每段脚本的工具并发上限", ["3"]],
  ["墙钟上限（毫秒）", ["20000"]],
  ["工具调用次数", ["32"]],
  ["guest 内存（MiB）", ["32"]],
  ["累计传输（KiB）", ["1024"]],
  ["决策步数上限", ["16"]],
  ["只读并行上限", ["3"]],
  ["无进展终止阈值", ["3"]],
  ["跨会话唤醒并发", ["4"]],
  ["模型调用上限（整机）", ["1"]],
  ["每个服务并发上限", ["1"]],
  ["失败重试间隔（毫秒）", ["15000"]],
  ["最多尝试次数", ["3"]],
  ["投递意图有效期（秒）", ["120"]],
];
const SWITCHES: [string, "checked" | "unchecked"][] = [
  ["使用 MCP 工具", "checked"],
  ["使用本地技能", "checked"],
  ["执行工具任务", "checked"],
  ["执行记忆整理任务", "checked"],
  ["执行知识整理任务", "checked"],
  ["按需理解 QQ 图片", "checked"],
  ["QQ 表情发送", "unchecked"],
  ["研究子任务", "unchecked"],
  ["本地程序化工具调用（PTC）", "unchecked"],
];
const NAV = [
  "执行开关",
  "资料整理任务",
  "任务与有效期",
  "只读研究",
  "代码沙箱（QuickJS）",
  "主循环与并发",
  "QQ 投递",
];

async function renderSettings(fake: Partial<typeof api> = {}) {
  store.getState().resetForTests({ ...api, ...fake } as unknown as typeof api);
  render(<ExecutionSettings />);
  await act(async () => {});
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("execution settings layout and usability", () => {
  it("shows all 25 numeric fields and the 9 switches with their saved values", async () => {
    await renderSettings({ getPermissions: vi.fn().mockResolvedValue(permissions) });
    let count = 0;
    for (const [label, values] of NUMERIC) {
      const fields = screen.getAllByLabelText(label) as HTMLInputElement[];
      expect(fields.map((field) => field.value)).toEqual(values);
      for (const field of fields) {
        expect(field.disabled).toBe(false);
        count += 1;
      }
    }
    expect(count).toBe(25);
    for (const [label, state] of SWITCHES) {
      expect(screen.getByRole("checkbox", { name: label }).getAttribute("data-state")).toBe(state);
    }
  });

  it("anchors the seven section headings and only scrolls or focuses them", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    await renderSettings({ getPermissions: vi.fn().mockResolvedValue(permissions) });
    const nav = screen.getByRole("navigation", { name: "执行设置" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(NAV);
    for (const link of links) {
      link.focus();
      expect(document.activeElement).toBe(link);
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      const target = document.getElementById(href.slice(1));
      expect(target).not.toBeNull();
      fireEvent.click(link);
      expect(document.activeElement).toBe(target);
    }
    expect(scroll).toHaveBeenCalledTimes(links.length);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    // 不折叠、不隐藏：点击后 9 个开关与重复标签的两个输入框仍然在场。
    expect(screen.getAllByRole("checkbox")).toHaveLength(9);
    expect(screen.getAllByLabelText("结论字符上限")).toHaveLength(2);
  });

  it("keeps anchor targets unique when two instances render on the same page", async () => {
    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
    } as unknown as typeof api);
    render(
      <>
        <ExecutionSettings />
        <ExecutionSettings />
      </>,
    );
    await act(async () => {});
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "");
    expect(hrefs).toHaveLength(14);
    expect(new Set(hrefs).size).toBe(14);
    for (const href of hrefs) expect(document.getElementById(href.slice(1))).not.toBeNull();
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("saves the same execution payload from the top and bottom buttons and keeps the revision", async () => {
    const save = vi.fn(async ({ policy }: Parameters<typeof api.savePermissions>[0]) => ({
      revision: "pr-2",
      policy,
    }));
    await renderSettings({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      savePermissions: save,
    });
    // 顶部主按钮保留「保存设置」；底部同源按钮用「保存」，两个入口语义相同而标签不歧义。
    expect(screen.getAllByRole("button", { name: "保存设置" })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("决策步数上限"), { target: { value: "64" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [top] = save.mock.calls[0];
    expect(top.expectedRevision).toBe("pr-1");
    expect(top.policy.execution?.loop.maxSteps).toBe(64);
    // 只带 execution 白名单：未改字段与授权原样保留。
    expect(top.policy.execution?.maintenance.memoryTimeoutSeconds).toBe(3600);
    expect(top.policy.grants).toEqual(permissions.policy.grants);

    fireEvent.change(screen.getByLabelText("最多尝试次数"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => {});
    const [bottom] = save.mock.calls[1];
    expect(bottom.expectedRevision).toBe("pr-2");
    expect(bottom.policy.execution?.qq.maxAttempts).toBe(5);
    expect(bottom.policy.execution?.loop.maxSteps).toBe(64);
    expect(bottom.policy.grants).toEqual(permissions.policy.grants);
    expect(screen.getByRole("status").textContent).toContain("执行设置已保存");
  });

  it("disables both save buttons while saving and rejects repeat clicks", async () => {
    const pending = Promise.withResolvers<{
      revision: string;
      policy: PermissionsResponse["policy"];
    }>();
    const save = vi.fn(() => pending.promise);
    await renderSettings({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      savePermissions: save,
    });
    fireEvent.change(screen.getByLabelText("决策步数上限"), { target: { value: "32" } });
    const top = screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement;
    const bottom = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(top.disabled).toBe(false);
    expect(bottom.disabled).toBe(false);
    fireEvent.click(top);
    await act(async () => {});
    expect(top.disabled).toBe(true);
    expect(bottom.disabled).toBe(true);
    fireEvent.click(bottom);
    fireEvent.click(top);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ revision: "pr-2", policy: permissions.policy }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(top.disabled).toBe(true);
    expect(bottom.disabled).toBe(true);
  });

  it("refuses out-of-range values from both buttons and keeps the error above the form", async () => {
    const save = vi.fn();
    await renderSettings({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      savePermissions: save,
    });
    const read = screen.getByLabelText("只读并行上限") as HTMLInputElement;
    fireEvent.change(read, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("超出允许范围"));
    expect(save).not.toHaveBeenCalled();
    expect(read.getAttribute("aria-invalid")).toBe("true");
    expect(read.value).toBe("9");
    expect(screen.getByLabelText("决策步数上限").getAttribute("aria-invalid")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation");
    expect(
      screen.getByRole("alert").compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("fills the workspace width, pairs the cards and keeps the switches full width", async () => {
    await renderSettings({ getPermissions: vi.fn().mockResolvedValue(permissions) });
    const container = screen.getByRole("navigation").parentElement;
    expect(container?.className).toContain("w-full");
    expect(container?.className).toContain("min-w-0");
    expect(container?.className).not.toContain("max-w-");
    const switches = screen
      .getByRole("heading", { name: "执行开关" })
      .closest('[data-slot="card"]');
    const grid = switches?.parentElement;
    expect(grid?.className).toContain("xl:grid-cols-2");
    expect(switches?.className).toContain("xl:col-span-2");
    for (const title of NAV.slice(1)) {
      const card = screen.getByRole("heading", { name: title }).closest('[data-slot="card"]');
      expect(card?.parentElement).toBe(grid);
      expect(card?.className).not.toContain("xl:col-span-2");
    }
    const timing = screen.getByText(/数值在新运行、任务或领取时生效/);
    expect(
      screen.getByRole("button", { name: "保存" }).compareDocumentPosition(timing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("focuses the invalid field after the bottom save refuses an out-of-range value", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const save = vi.fn();
    await renderSettings({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      savePermissions: save,
    });
    const read = screen.getByLabelText("只读并行上限") as HTMLInputElement;
    fireEvent.change(read, { target: { value: "9" } });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(document.activeElement).toBe(read));
    expect(read.getAttribute("aria-invalid")).toBe("true");
    expect(read.value).toBe("9");
    expect(save).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenLastCalledWith({ block: "center" });
  });

  it("focuses the alert after a 409 from the bottom save and keeps the draft without a second PUT", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const save = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "PERMISSION_POLICY_CONFLICT", "权限配置已变化，请重新读取后保存"),
      );
    await renderSettings({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      savePermissions: save,
    });
    const steps = screen.getByLabelText("决策步数上限") as HTMLInputElement;
    fireEvent.change(steps, { target: { value: "64" } });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.textContent).toContain("权限配置已变化");
    expect(steps.value).toBe("64");
    expect(steps.getAttribute("aria-invalid")).toBe("false");
    expect(save).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenLastCalledWith({ block: "center" });
  });
});
