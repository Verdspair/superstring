import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqManagedEventView } from "../../src/shared/contracts/qq-managed-events";
import { i18n } from "../../src/web/i18n/runtime";
import { QqManagedMessageStream } from "../../src/web/screens/connections/QqManagedMessageStream";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

function renderStream(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

const sampleEvents: QqManagedEventView[] = [
  {
    sequence: 1,
    expires_at: "2026-10-25T12:00:00.000Z",
    conversation_binding: "bound",
    message_preview: "Hello world from group chat",
    preview_state: "available",
    event: {
      kind: "message",
      account_id: "10001",
      occurred_at_seconds: 1729826400,
      observed_at: "2026-10-25T03:00:00.000Z",
      message_id: "msg-001",
      message_type: "group",
      sub_type: "normal",
      peer_id: "98765432",
      sender_id: "11223344",
      segments: {
        text: 1,
        mention: 0,
        reply: 0,
        face: 0,
        image: 0,
        record: 0,
        video: 0,
        file: 0,
        unsupported: 0,
      },
    },
  },
  {
    sequence: 2,
    expires_at: "2026-10-25T12:00:00.000Z",
    conversation_binding: "unbound",
    message_preview: null,
    preview_state: "not_message",
    event: {
      kind: "notice",
      account_id: "10001",
      occurred_at_seconds: 1729826405,
      observed_at: "2026-10-25T03:00:05.000Z",
      notice_type: "group_ban",
      sub_type: "ban",
      user_id: "11223344",
      group_id: "98765432",
      operator_id: "99887766",
      target_id: null,
      message_id: null,
    },
  },
  {
    sequence: 3,
    expires_at: "2026-10-25T12:00:00.000Z",
    conversation_binding: "unbound",
    message_preview: null,
    preview_state: "not_message",
    event: {
      kind: "request",
      account_id: "10001",
      occurred_at_seconds: 1729826410,
      observed_at: "2026-10-25T03:00:10.000Z",
      request_type: "friend",
      sub_type: null,
      user_id: "55667788",
      group_id: null,
    },
  },
  {
    sequence: 4,
    expires_at: "2026-10-25T12:00:00.000Z",
    conversation_binding: "unbound",
    message_preview: null,
    preview_state: "not_message",
    event: {
      kind: "meta_event",
      account_id: "10001",
      occurred_at_seconds: 1729826415,
      observed_at: "2026-10-25T03:00:15.000Z",
      meta_event_type: "heartbeat",
      sub_type: null,
      heartbeat: {
        good: true,
        online: true,
        interval_ms: 5000,
      },
    },
  },
];

describe("QqManagedMessageStream presentational unit tests", () => {
  it("keeps stream actions visible and named alongside the section heading", async () => {
    const onRefresh = vi.fn();
    const onClear = vi.fn();
    renderStream(
      <QqManagedMessageStream
        events={sampleEvents}
        connected={true}
        onRefresh={onRefresh}
        onClear={onClear}
      />,
    );

    expect(
      screen.getByRole("heading", { name: i18n.t("connections.stream.title"), level: 2 }),
    ).toBeTruthy();
    const refresh = screen.getByRole("button", { name: i18n.t("connections.stream.refresh") });
    const clear = screen.getByRole("button", { name: i18n.t("connections.stream.clear") });
    expect(refresh.textContent).toContain(i18n.t("connections.stream.refresh"));
    expect(clear.textContent).toContain(i18n.t("connections.stream.clear"));
    await userEvent.click(refresh);
    await userEvent.click(clear);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: i18n.t("connections.stream.pauseFollow") }),
    );
    expect(
      screen.getByRole("button", { name: i18n.t("connections.stream.resumeFollow") }),
    ).toBeTruthy();
  });

  it("renders dense CLI-style event stream rows with proper badges and summaries", () => {
    renderStream(<QqManagedMessageStream events={sampleEvents} connected={true} />);

    expect(screen.getByText(/Hello world from group chat/)).toBeTruthy();
    expect(screen.getByText(/group_ban/)).toBeTruthy();
    expect(screen.getByText(/friend/)).toBeTruthy();
    expect(screen.getByText(/heartbeat 5000ms/)).toBeTruthy();

    const rows = document.querySelectorAll("[data-stream-row]");
    expect(rows.length).toBe(4);
  });

  it("filters events by Radix category tabs while preserving unselected items in memory", async () => {
    const user = userEvent.setup();
    renderStream(<QqManagedMessageStream events={sampleEvents} connected={true} />);

    // Switch to notice tab via authentic user pointer interaction
    const noticeTab = screen.getByRole("tab", { name: /通知|notice/i });
    await user.click(noticeTab);

    expect(screen.queryByText(/Hello world from group chat/)).toBeNull();
    expect(screen.getByText(/group_ban/)).toBeTruthy();
    expect(screen.queryByText(/heartbeat 5000ms/)).toBeNull();

    // Switch back to all tab
    const allTab = screen.getByRole("tab", { name: /全部|all/i });
    await user.click(allTab);
    expect(screen.getByText(/Hello world from group chat/)).toBeTruthy();
    expect(screen.getByText(/group_ban/)).toBeTruthy();
    expect(screen.getByText(/heartbeat 5000ms/)).toBeTruthy();
  });

  it("supports keyboard selection to open detail modal and closes cleanly on close button", () => {
    renderStream(<QqManagedMessageStream events={sampleEvents} connected={true} />);

    const row = document.querySelector("[data-stream-row='1']");
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/"sequence": 1/)).toBeTruthy();

    const closeBtn = screen.getByTestId("detail-close-btn");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("automatically closes detail modal when selected event is invalidated or removed from source", () => {
    const { rerender } = renderStream(
      <QqManagedMessageStream events={sampleEvents} connected={true} />,
    );

    const row = document.querySelector("[data-stream-row='1']");
    fireEvent.click(row!);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Source is updated: event sequence 1 is evicted or cleared
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedMessageStream events={sampleEvents.slice(1)} connected={true} />
      </I18nextProvider>,
    );

    // Dialog must immediately close because selectedEvent derives from current events
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes detail modal when component becomes inactive", () => {
    const { rerender } = renderStream(
      <QqManagedMessageStream events={sampleEvents} connected={true} active={true} />,
    );

    const row = document.querySelector("[data-stream-row='2']");
    fireEvent.click(row!);
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Inactive lifecycle (e.g. navigation away)
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedMessageStream events={sampleEvents} connected={true} active={false} />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("triggers onClear callback when clear action is clicked", () => {
    const onClear = vi.fn();
    renderStream(
      <QqManagedMessageStream events={sampleEvents} connected={true} onClear={onClear} />,
    );

    const clearBtn = screen.getByRole("button", { name: /清空|clear/i });
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("respects scroll follow: manual scroll-up pauses follow and new events do not steal scroll position", () => {
    const { rerender, container } = renderStream(
      <QqManagedMessageStream events={sampleEvents} connected={true} />,
    );

    const scrollContainer = container.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeTruthy();

    // Simulate scrolling up
    Object.defineProperty(scrollContainer, "scrollTop", { value: 10, writable: true });
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 500, writable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 200, writable: true });
    fireEvent.scroll(scrollContainer!);

    // 5 new events arrive while follow is paused
    const newEvents: QqManagedEventView[] = [5, 6, 7, 8, 9].map((seq) => ({
      sequence: seq,
      expires_at: "2026-10-25T12:00:00.000Z",
      conversation_binding: "bound" as const,
      message_preview: `Incoming message ${seq}`,
      preview_state: "available" as const,
      event: {
        kind: "message" as const,
        account_id: "10001",
        occurred_at_seconds: 1729826420 + seq,
        observed_at: "2026-10-25T03:00:25.000Z",
        message_id: `msg-00${seq}`,
        message_type: "group" as const,
        sub_type: "normal",
        peer_id: "98765432",
        sender_id: "11223344",
        segments: {
          text: 1,
          mention: 0,
          reply: 0,
          face: 0,
          image: 0,
          record: 0,
          video: 0,
          file: 0,
          unsupported: 0,
        },
      },
    }));

    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedMessageStream events={[...sampleEvents, ...newEvents]} connected={true} />
      </I18nextProvider>,
    );

    // Unread count indicator appears with actual count 5
    const banner = screen.getByText(/新事件|new event/i);
    expect(banner).toBeTruthy();
    expect(banner.textContent).toMatch(/5 条新事件|5 new events/);

    // Strict negative template assertions: must NEVER display un-interpolated template literals
    expect(banner.textContent).not.toContain("{count}");
    expect(banner.textContent).not.toContain("{{count}}");

    // Click banner to resume follow and clear indicator
    fireEvent.click(banner);
    expect(screen.queryByText(/新事件|new event/i)).toBeNull();
  });

  it("renders empty state placeholder when event list is empty", () => {
    renderStream(<QqManagedMessageStream events={[]} connected={true} />);
    expect(screen.getByText(/暂无协议事件|no protocol events/i)).toBeTruthy();
  });
});

it("programmatic event detail closes to its exact source row", async () => {
  renderStream(<QqManagedMessageStream events={sampleEvents} connected />);
  const row = document.querySelector<HTMLButtonElement>('[data-stream-row="1"]');
  if (!row) throw new Error("missing event row");
  await userEvent.click(row);
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByTestId("detail-close-btn"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(row));
});

it("inactive hidden event owner cannot receive a close return focus", async () => {
  const { rerender } = renderStream(
    <div>
      <QqManagedMessageStream events={sampleEvents} connected active />
    </div>,
  );
  const row = document.querySelector<HTMLButtonElement>('[data-stream-row="1"]');
  if (!row) throw new Error("missing event row");
  await userEvent.click(row);
  const focus = vi.spyOn(row, "focus");
  rerender(
    <I18nextProvider i18n={i18n}>
      <div hidden>
        <QqManagedMessageStream events={sampleEvents} connected active={false} />
      </div>
    </I18nextProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).not.toBe(row));
  expect(document.querySelector('[data-stream-row="1"]')).toBe(row);
  expect(row.closest("[hidden]")).toBeTruthy();
  expect(focus).not.toHaveBeenCalled();
});
