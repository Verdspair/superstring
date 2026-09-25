// 存储与诊断 page (§11.1, ADR0018 P5h).
//
// Two promises are asserted: the page shows the numbers the server reports, and the parts that do
// not exist yet are stated in words rather than rendered as a zero that would read as a fact.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqStorageUsageResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { QqStorageSettings } from "../../src/web/features/qq/QqStorageSettings";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const nowSeconds = Math.floor(Date.now() / 1000);

/**
 * The page ages every verdict against its own clock, while this file's anchor is fixed when the
 * module is imported — so the age of a 30-second-old verdict is "30 + however late this file got
 * rendered". In the whole-suite run that drift is at least a second (measured: "31 秒前"), and the
 * assertion itself can cross a second boundary. Derive the acceptable numbers instead of pinning
 * 30, which flaked only when the suite ran slowly.
 */
function agePattern(seconds: number): string {
  const drift = Math.max(0, Math.floor(Date.now() / 1000) - nowSeconds);
  return [drift - 1, drift, drift + 1].map((step) => seconds + step).join("|");
}
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
  render(<QqStorageSettings />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("存储与诊断", () => {
  it("按服务端给的数字显示用量，并把窗口写在同一页", async () => {
    await renderPage();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(/已过期 3/)).toBeTruthy();
    expect(screen.getByText(/占用 2 KB/)).toBeTruthy();
    expect(screen.getByText(/14 天窗口/)).toBeTruthy();
  });

  it("把待办状态报成事实：排队会话、全局链、媒体读取与等待", async () => {
    await renderPage();
    expect(screen.getByText("排队中的会话")).toBeTruthy();
    expect(screen.getByText(/其中 0 个现在可跑/)).toBeTruthy();
    expect(screen.getByText(/空闲/)).toBeTruthy();
    expect(screen.getByText(/已理解 4 条；已尝试但还没有描述 1 条/)).toBeTruthy();
  });

  it("逐个会话给出没开口的原因，并把它连到扫描时刻", async () => {
    await renderPage();
    // The conversation labels match the 群与私聊 page, so the reader can find the same room.
    expect(screen.getByText("群 30003")).toBeTruthy();
    expect(screen.getByText("私聊 20002")).toBeTruthy();
    expect(screen.getByText("还没到安静时间")).toBeTruthy();
    expect(screen.getByText("已经决定开口")).toBeTruthy();
    expect(screen.getByText(new RegExp(`最近一次扫描：(?:${agePattern(30)}) 秒前`))).toBeTruthy();
    const lines = screen.getAllByText(/最近群友消息/);
    // The quiet-window verdict names the moment the room becomes quiet enough; the scheduled one
    // has no gate to name, so it shows only the baseline and when the sweep looked.
    expect(lines[0]?.textContent).toMatch(new RegExp(`本轮裁决 (?:${agePattern(30)}) 秒前`));
    expect(lines[0]?.textContent).toContain("最快");
    expect(lines[0]?.textContent).toContain("可以再判");
    expect(lines[1]?.textContent).not.toContain("最快");
  });

  it("没有裁决记录时说明两种可能，不用空表冒充已扫描", async () => {
    await renderPage({
      ...usage,
      sweep: { tracked: 0, last_swept_at_seconds: null, entries: [] },
    });
    expect(screen.getByText(/要么还没有绑定会话，要么运行时还没有扫描过一次/)).toBeTruthy();
  });

  it("没有的东西用文字说明，不用 0 冒充", async () => {
    await renderPage();
    expect(screen.getByText(/收到的媒体缓存：本版只保存上游引用与模型描述/)).toBeTruthy();
    // The failure line had to change with P5m: an attempt and "no description yet" ARE recorded
    // now, so "尚未记录" would be false. What is still missing is the reason and the log's shape.
    expect(screen.getByText(/媒体读取失败只留下“尝试过、还没有描述”/)).toBeTruthy();
    expect(screen.getByText(/素材与集合不参与这里的清理/)).toBeTruthy();
    // P5u's own boundary, stated rather than implied: only the sweep records a verdict.
    expect(screen.getByText(/裁决记录也不参与清理/)).toBeTruthy();
    expect(screen.getByText(/直接回应与连续交谈的裁决没有单独记录/)).toBeTruthy();
  });

  it("清理只调一次，并报告删掉了什么、随后刷新用量", async () => {
    const fake = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期内容" }));
    await act(async () => {});
    expect(fake.runQqStorageCleanup).toHaveBeenCalledTimes(1);
    const line = await screen.findByText(/上次清理：/);
    expect(line.textContent).toContain("正文 3");
    // A cleanup that showed stale numbers would describe a state that no longer exists.
    expect(
      (fake.getQqStorage as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });
});
