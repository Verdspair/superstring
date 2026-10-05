import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderQqMessageFacts } from "../../src/server/services/qq-message-renderer";
import type { QqMessageSettings } from "../../src/shared/contracts/qq-message";
import { QQ_MESSAGE_SETTINGS_DEFAULT } from "../../src/shared/contracts/qq-message";
import { selectLocale, translate } from "../../src/web/i18n";
import {
  QQ_MESSAGE_PREVIEW_FOCUS,
  QQ_MESSAGE_PREVIEW_MESSAGES,
  QQ_MESSAGE_PREVIEW_NOW_SECONDS,
  QqMessagePreview,
  renderQqMessagePreview,
} from "../../src/web/screens/connections/qq-message-preview";

const hybrid: QqMessageSettings = {
  ...QQ_MESSAGE_SETTINGS_DEFAULT,
  time_display: "hybrid",
};

afterEach(cleanup);

const previewText = () =>
  document.querySelector("[data-qq-message-preview] pre")?.textContent ?? "";

describe("QqMessagePreview renderer parity", () => {
  it("renders verbatim what the server renderer produces for the same fixed input", () => {
    const expected = renderQqMessageFacts({
      messages: QQ_MESSAGE_PREVIEW_MESSAGES,
      focus: QQ_MESSAGE_PREVIEW_FOCUS,
      settings: hybrid,
      nowSeconds: QQ_MESSAGE_PREVIEW_NOW_SECONDS,
    });
    expect(renderQqMessagePreview(hybrid)).toBe(expected);
    selectLocale("zh-CN");
    render(<QqMessagePreview settings={hybrid} />);
    expect(previewText()).toBe(expected);
  });

  it("hybrid: latest per speaker (assistant included) plus the non-latest focus message are full; the rest relative", () => {
    const output = renderQqMessagePreview(hybrid);
    const times = new Map(
      output
        .split("\n")
        .filter((line) => line.startsWith("msg="))
        .map((line) => {
          const view = JSON.parse(line.slice(4)) as { id: string; time: string };
          return [view.id, view.time] as const;
        }),
    );
    // 同一 QQ（10001）旧消息是 response focus 目标：非最新但完整。
    expect(times.get("preview-a-old")).toBe("2026-10-01 23:55:00");
    // 每位发言者最新一条：完整。
    expect(times.get("preview-a-new")).toBe("2026-10-01 23:59:00");
    expect(times.get("preview-b-new")).toBe("2026-10-01 23:59:30");
    // 助手旧消息相对、助手最新完整。
    expect(times.get("preview-s-old")).toBe("2分钟前");
    expect(times.get("preview-s-new")).toBe("2026-10-01 23:59:45");
    // 另一 QQ 的非最新消息：相对时长。
    expect(times.get("preview-b-old")).toBe("4分钟前");
    // 头部按冻结 now 渲染。
    expect(output).toContain("QQ消息事实（now=2026-10-02 00:00:00，timezone=Asia/Shanghai）");
  });

  it("full mode renders every message as full wall-clock time", () => {
    const output = renderQqMessagePreview({ ...hybrid, time_display: "full" });
    for (const line of output.split("\n").filter((l) => l.startsWith("msg="))) {
      const view = JSON.parse(line.slice(4)) as { time: string };
      expect(view.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    expect(output).toContain("2026-10-01 23:55:00");
  });

  it("full_relative mode renders every message as full time plus relative duration", () => {
    const output = renderQqMessagePreview({ ...hybrid, time_display: "full_relative" });
    const times = new Map(
      output
        .split("\n")
        .filter((line) => line.startsWith("msg="))
        .map((line) => {
          const view = JSON.parse(line.slice(4)) as { id: string; time: string };
          return [view.id, view.time] as const;
        }),
    );
    expect(times.get("preview-a-old")).toBe("2026-10-01 23:55:00（5分钟前）");
    expect(times.get("preview-s-old")).toBe("2026-10-01 23:58:00（2分钟前）");
    expect(times.get("preview-b-new")).toBe("2026-10-01 23:59:30（30秒前）");
  });

  it("the same instant renders a different day header under a different IANA zone (cross-day follows the zone)", () => {
    // Asia/Shanghai：now 落在 10-02 00:00（已跨日）。
    expect(renderQqMessagePreview(hybrid)).toContain(
      "now=2026-10-02 00:00:00，timezone=Asia/Shanghai",
    );
    // UTC：同一 now 仍是 10-01 16:00——跨日边界随所选时区移动，而不是写死。
    const utc = renderQqMessagePreview({ ...hybrid, timezone: "UTC" });
    expect(utc).toContain("now=2026-10-01 16:00:00，timezone=UTC");
    expect(utc).toContain("2026-10-01 15:55:00");
  });
});

describe("QqMessagePreview component behaviour", () => {
  it("is read-only: no input, textarea, select or button inside the sample block", () => {
    selectLocale("zh-CN");
    render(<QqMessagePreview settings={hybrid} />);
    const block = document.querySelector("[data-qq-message-preview]") as HTMLElement;
    expect(block.querySelector("input, textarea, select, button, [contenteditable]")).toBeNull();
  });

  it("the caption states the sample is synthetic, not a real chat", () => {
    selectLocale("zh-CN");
    render(<QqMessagePreview settings={hybrid} />);
    const block = document.querySelector("[data-qq-message-preview]") as HTMLElement;
    expect(block.textContent).toContain(translate("schemes.studio.messagePreviewCaption"));
    expect(block.textContent).toContain("合成示例，不是真实聊天记录");
  });

  it("with invalid settings (null) it shows the placeholder instead of a forged preview", () => {
    selectLocale("zh-CN");
    render(<QqMessagePreview settings={null} />);
    expect(document.querySelector("[data-qq-message-preview] pre")).toBeNull();
    expect(screen.getByText(translate("schemes.studio.messagePreviewUnavailable"))).toBeTruthy();
  });
});
