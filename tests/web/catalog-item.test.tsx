import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogItem } from "../../src/web/components/catalog-item";

// 共享收起行的回归：摘要与操作常驻，明细默认收起；操作区在触发区之外，置灰行仍可展开与操作。
afterEach(cleanup);

const action = (label: string, onClick = vi.fn()) => (
  <button type="button" onClick={onClick}>
    {label}
  </button>
);

describe("catalog item primitive", () => {
  it("keeps the detail closed by default and names the trigger after the summary", () => {
    render(
      <CatalogItem summary={<span>搜索服务</span>} actions={action("配置")}>
        <p>详细说明</p>
      </CatalogItem>,
    );
    const trigger = screen.getByRole("button", { name: "搜索服务" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(screen.queryByText("详细说明")).toBeNull();
  });

  it("reveals the detail on demand and hides it again", async () => {
    render(
      <CatalogItem summary={<span>搜索服务</span>}>
        <p>详细说明</p>
      </CatalogItem>,
    );
    const trigger = screen.getByRole("button", { name: "搜索服务" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("详细说明")).toBeTruthy();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByText("详细说明")).toBeNull());
  });

  it("expands rows independently so several details can stay open", async () => {
    render(
      <>
        <CatalogItem summary={<span>服务甲</span>}>
          <p>甲明细</p>
        </CatalogItem>
        <CatalogItem summary={<span>服务乙</span>}>
          <p>乙明细</p>
        </CatalogItem>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "服务甲" }));
    expect(screen.getByText("甲明细")).toBeTruthy();
    expect(screen.queryByText("乙明细")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "服务乙" }));
    expect(screen.getByText("甲明细")).toBeTruthy();
    expect(screen.getByText("乙明细")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "服务甲" }));
    await waitFor(() => expect(screen.queryByText("甲明细")).toBeNull());
    expect(screen.getByText("乙明细")).toBeTruthy();
  });

  it("keeps actions outside the trigger so using an action never folds the row", () => {
    const onAction = vi.fn();
    render(
      <CatalogItem summary={<span>搜索服务</span>} actions={action("配置", onAction)}>
        <p>详细说明</p>
      </CatalogItem>,
    );
    const trigger = screen.getByRole("button", { name: "搜索服务" });
    const configure = screen.getByRole("button", { name: "配置" });
    expect(trigger.contains(configure)).toBe(false);
    fireEvent.click(configure);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("详细说明")).toBeNull();
  });

  it("keeps a muted row expandable with its actions still operable", () => {
    const onAction = vi.fn();
    render(
      <CatalogItem muted summary={<span>已停用服务</span>} actions={action("配置", onAction)}>
        <p>停用说明</p>
      </CatalogItem>,
    );
    const configure = screen.getByRole("button", { name: "配置" });
    expect(configure.hasAttribute("disabled")).toBe(false);
    fireEvent.click(configure);
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "已停用服务" }));
    expect(screen.getByText("停用说明")).toBeTruthy();
  });

  it("supports a caller-controlled open state for revealed search matches", () => {
    const onOpenChange = vi.fn();
    render(
      <CatalogItem open onOpenChange={onOpenChange} summary={<span>命中服务</span>}>
        <p>命中说明</p>
      </CatalogItem>,
    );
    const trigger = screen.getByRole("button", { name: "命中服务" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("命中说明")).toBeTruthy();
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 受控状态下由调用方决定是否收起；搜索命中揭示的明细不应被自身点击抹掉。
    expect(screen.getByText("命中说明")).toBeTruthy();
  });
});
