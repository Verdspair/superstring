// 存储与诊断 page (§11.1, ADR0018 P5h).
//
// Two promises are asserted: the page shows the numbers the server reports, and the parts that do
// not exist yet are stated in words rather than rendered as a zero that would read as a fact.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  render(<StorageInventory />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("Connection storage inventory", () => {
  it("shows reported inventory and retention without inventing missing runtime counters", async () => {
    await renderPage();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(/消息正文保留 14 天/)).toBeTruthy();
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
  it("cleans expired records once and rereads inventory", async () => {
    const fake = await renderPage();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "清理到期内容" })));
    expect(fake.runQqStorageCleanup).toHaveBeenCalledTimes(1);
    expect(fake.getQqStorage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("本次清理结果")).toBeTruthy();
  });
});
