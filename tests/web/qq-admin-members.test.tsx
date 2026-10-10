import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOneBotAccountId } from "../../src/shared/contracts/onebot-identity";
import { QQ_ATTENTION_MEMBER_LIMIT } from "../../src/shared/contracts/qq";
import { selectLocale } from "../../src/web/i18n";
import { AdminMembersEditor } from "../../src/web/screens/connections/admin-members-editor";

describe("AdminMembersEditor pure UI component", () => {
  beforeEach(async () => {
    await selectLocale("zh-CN");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state indicator when value is empty", () => {
    render(<AdminMembersEditor value="" onChange={vi.fn()} />);
    expect(screen.getByText("暂未添加管理员")).toBeTruthy();
    expect(screen.queryByTestId("admin-badges-container")).toBeNull();
  });

  it("renders badges for each valid canonical member", () => {
    render(<AdminMembersEditor value="10001 10002 10003" onChange={vi.fn()} />);
    expect(screen.getByTestId("admin-badge-10001")).toBeTruthy();
    expect(screen.getByTestId("admin-badge-10002")).toBeTruthy();
    expect(screen.getByTestId("admin-badge-10003")).toBeTruthy();
    expect(screen.getByText("3", { selector: "span" })).toBeTruthy();
  });

  it("normalizes leading zeros and canonically merges duplicates in presentation", () => {
    render(<AdminMembersEditor value="010001 10001 10002" onChange={vi.fn()} />);
    // 010001 and 10001 normalize to the same canonical ID 10001
    expect(screen.getByTestId("admin-badge-10001")).toBeTruthy();
    expect(screen.getByTestId("admin-badge-10002")).toBeTruthy();
    expect(screen.getByText("2", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/已自动去重/)).toBeTruthy();
  });

  it("does not report duplicates when invalid tokens exist without actual duplicate values", () => {
    render(<AdminMembersEditor value="10001 abc" onChange={vi.fn()} />);
    expect(screen.getByTestId("admin-badge-10001")).toBeTruthy();
    expect(screen.getByTestId("admin-badge-abc")).toBeTruthy();
    expect(screen.queryByText(/已自动去重/)).toBeNull();
  });

  it("removes a canonical member and all its leading-zero raw tokens", async () => {
    const onChange = vi.fn();
    render(<AdminMembersEditor value="010001 10001 10002" onChange={onChange} />);

    const deleteBtn = screen.getByRole("button", { name: "删除管理员 10001" });
    await userEvent.click(deleteBtn);

    expect(onChange).toHaveBeenCalledWith("10002");
  });

  it("removes an invalid token independently", async () => {
    const onChange = vi.fn();
    render(<AdminMembersEditor value="10001 abc 10002" onChange={onChange} />);

    const deleteBtn = screen.getByRole("button", { name: "删除管理员 abc" });
    await userEvent.click(deleteBtn);

    expect(onChange).toHaveBeenCalledWith("10001 10002");
  });

  it("clears all members when clear button is clicked", async () => {
    const onChange = vi.fn();
    render(<AdminMembersEditor value="10001 10002" onChange={onChange} />);

    const clearBtn = screen.getByRole("button", { name: /清空/ });
    await userEvent.click(clearBtn);

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("identifies invalid OneBot account IDs without silently swallowing them", () => {
    render(<AdminMembersEditor value="10001 abc -99 0" onChange={vi.fn()} />);

    expect(screen.getByTestId("admin-badge-abc")).toBeTruthy();
    expect(screen.getByTestId("admin-badge--99")).toBeTruthy();
    expect(screen.getByTestId("admin-badge-0")).toBeTruthy();

    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((el) => el.textContent?.includes("包含格式无效的账号"))).toBe(true);
  });

  it("canonical normalization follows OneBot identity contract directly", () => {
    expect(normalizeOneBotAccountId("010001")).toBe("10001");
    expect(normalizeOneBotAccountId("0")).toBeNull();
    expect(normalizeOneBotAccountId("-123")).toBeNull();
    expect(normalizeOneBotAccountId("abc")).toBeNull();
  });

  it("shows over limit alert when canonical members exceed QQ_ATTENTION_MEMBER_LIMIT", () => {
    const manyMembers = Array.from({ length: QQ_ATTENTION_MEMBER_LIMIT + 1 }, (_, i) =>
      String(10000 + i),
    ).join(" ");
    render(<AdminMembersEditor value={manyMembers} onChange={vi.fn()} />);

    const alerts = screen.getAllByRole("alert");
    expect(alerts.some((el) => el.textContent?.includes("已超出数量上限"))).toBe(true);
  });

  it("respects disabled state by disabling delete and clear buttons", () => {
    render(<AdminMembersEditor value="10001 10002" disabled onChange={vi.fn()} />);

    const deleteBtn = screen.getByRole("button", { name: "删除管理员 10001" });
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /清空/ })).toBeNull();
  });
});
