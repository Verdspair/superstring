// QQ 数据与保留：真实计数、调度裁决与清理确认保护。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqStorageUsageResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { StorageInventory } from "../../src/web/screens/connections/storage-inventory";
import { useSuperstringStore as store } from "../../src/web/store";

const nowSeconds = Math.floor(Date.now() / 1000);

const usage: QqStorageUsageResponse = {
  observations: { messages: 12, text: 11, expired_text: 3 },
  speech: { records: 4, text: 3 },
  sends: { attempts: 7, parts: 9 },
  nicknames: { current: 2, expired: 1 },
  stickers: { collections: 2, assets: 5, enabled: 3, bytes: 2048 },
  dispatch: { candidates: 1, ready_now: 0, lease_held: false },
  media: { segments: 6, described: 4, pending: 1 },
  sweep: {
    tracked: 2,
    last_swept_at_seconds: nowSeconds - 30,
    entries: [
      {
        kind: "group",
        peer_id: "30003",
        outcome: "skipped",
        reason: "not_quiet_yet",
        observed_at_seconds: nowSeconds - 240,
        ready_at_seconds: nowSeconds + 600,
        decided_at_seconds: nowSeconds - 30,
      },
      {
        kind: "private",
        peer_id: "20002",
        outcome: "scheduled",
        reason: null,
        observed_at_seconds: nowSeconds - 900,
        ready_at_seconds: null,
        decided_at_seconds: nowSeconds - 30,
      },
    ],
  },
  retention: { days: 14 },
};
const removed = {
  observation_text: 3,
  media_notes: 0,
  speech: 1,
  sends: 2,
  nicknames: 1,
};

async function renderPage(reported: QqStorageUsageResponse = usage) {
  const fake = {
    ...api,
    getQqStorage: vi.fn().mockResolvedValue(reported),
    runQqStorageCleanup: vi.fn().mockResolvedValue(removed),
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "qq-storage" });
  const { container } = render(<StorageInventory />);
  await act(async () => {});
  return { fake, container };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Connection storage inventory", () => {
  it("shows reported inventory and retention without inventing missing runtime counters", async () => {
    const { container } = await renderPage();
    const inventory = container.firstElementChild;
    expect(inventory?.classList.contains("px-4")).toBe(true);
    expect(inventory?.className).not.toMatch(/max-w-/);
    expect(screen.getByText("12")).toBeTruthy();
    const number = new Intl.NumberFormat("zh-CN");
    for (const [title, counts] of [
      ["收到的消息", usage.observations],
      ["发言记录", usage.speech],
      ["发送", usage.sends],
      ["昵称缓存", usage.nicknames],
      ["表情素材", usage.stickers],
      ["媒体读取", usage.media],
    ] as const) {
      const group = screen.getByRole("heading", { name: title }).closest("section");
      if (!group) throw new Error(`Missing inventory section: ${title}`);
      expect(Array.from(group.querySelectorAll("dd"), (counter) => counter.textContent)).toEqual(
        Object.values(counts).map((value) => number.format(value)),
      );
    }
    expect(screen.getByText(/消息正文保留 14 天/)).toBeTruthy();
    expect(screen.getByText("旧候选队列 1 项 · 已就绪 0 项 · 空闲")).toBeTruthy();
    expect(screen.queryByText("等待唤醒")).toBeNull();
  });
  it("links each conversation to a dated scheduling verdict", async () => {
    await renderPage();
    expect(screen.getByText("群 30003")).toBeTruthy();
    expect(screen.getByText("尚未冷场")).toBeTruthy();
    expect(screen.getByText("私聊 20002")).toBeTruthy();
    expect(screen.getByText("已排队")).toBeTruthy();
  });
  it("does not represent an empty sweep as successful checking", async () => {
    await renderPage({ ...usage, sweep: { tracked: 0, last_swept_at_seconds: null, entries: [] } });
    expect(screen.getByText("暂时没有调度裁决")).toBeTruthy();
  });
  it("cancels cleanup without writing, then confirms once and rereads inventory", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "清理到期内容" }));
    const cancelled = screen.getByRole("alertdialog");
    expect(cancelled.textContent).toContain("方案、会话绑定与表情素材不会被删除");
    expect(fake.runQqStorageCleanup).not.toHaveBeenCalled();
    expect(fake.getQqStorage).toHaveBeenCalledTimes(1);
    fireEvent.click(within(cancelled).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.runQqStorageCleanup).not.toHaveBeenCalled();
    expect(fake.getQqStorage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清理到期内容" }));
    const confirmed = screen.getByRole("alertdialog");
    expect(fake.runQqStorageCleanup).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(within(confirmed).getByRole("button", { name: "清理到期内容" })),
    );
    expect(fake.runQqStorageCleanup).toHaveBeenCalledTimes(1);
    expect(fake.getQqStorage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("本次清理结果")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("本次清理结果");
    expect(Array.from(status.querySelectorAll("dd"), (counter) => counter.textContent)).toEqual(
      Object.values(removed).map(String),
    );
    expect(store.getState().qqStorageRemoved).toEqual(removed);
  });
});
