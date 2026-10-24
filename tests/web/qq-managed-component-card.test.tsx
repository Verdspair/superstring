import { cleanup, fireEvent, screen } from "@testing-library/react";
import type React from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../src/web/i18n/runtime";
import {
  QqManagedComponentCard,
  type QqManagedStatus,
} from "../../src/web/screens/connections/QqManagedComponentCard";
import { render } from "./helpers/render-with-providers";

afterEach(cleanup);

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

const baseStatus = (overrides: Partial<QqManagedStatus> = {}): QqManagedStatus => ({
  managedEnabled: false,
  phase: "stopped",
  accountId: null,
  qrPayload: null,
  runtimeGatePassed: true,
  diagnosticCode: null,
  ...overrides,
});

function renderCard(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe("QqManagedComponentCard presentational unit tests", () => {
  it("maintains managed toggle independence without accepting or touching QQ business enabled field", () => {
    const onToggle = vi.fn();
    const status = baseStatus({ managedEnabled: false });

    renderCard(<QqManagedComponentCard status={status} onToggleManaged={onToggle} />);

    const toggle = screen.getByRole("checkbox");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("blocks enabling when runtimeGatePassed is false, but allows disabling if already enabled", () => {
    const onToggleBlocked = vi.fn();
    const blockedStatus = baseStatus({
      managedEnabled: false,
      runtimeGatePassed: false,
    });

    const { rerender } = renderCard(
      <QqManagedComponentCard status={blockedStatus} onToggleManaged={onToggleBlocked} />,
    );

    const toggleBlocked = screen.getByRole("checkbox");
    expect(
      toggleBlocked.hasAttribute("disabled") ||
        toggleBlocked.getAttribute("data-disabled") !== null,
    ).toBe(true);
    expect(screen.getByText(i18n.t("connections.managed.gateNotice")).getAttribute("role")).toBe(
      "status",
    );

    fireEvent.click(toggleBlocked);
    expect(onToggleBlocked).not.toHaveBeenCalled();

    const onToggleAllowed = vi.fn();
    const enabledGateFailedStatus = baseStatus({
      managedEnabled: true,
      runtimeGatePassed: false,
    });

    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard
          status={enabledGateFailedStatus}
          onToggleManaged={onToggleAllowed}
        />
      </I18nextProvider>,
    );

    const toggleAllowed = screen.getByRole("checkbox");
    expect(toggleAllowed.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggleAllowed);
    expect(onToggleAllowed).toHaveBeenCalledTimes(1);
    expect(onToggleAllowed).toHaveBeenCalledWith(false);
  });

  it("renders waiting_scan phase with a local SVG QR code matching label text and never an external img or iframe", () => {
    const status = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      qrPayload: "2ban://test-qr-payload-token-12345",
    });

    const { container } = renderCard(
      <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} />,
    );

    const qrSvg = screen.getByLabelText(/扫描二维码登录|scan the qr code/i);
    expect(qrSvg).toBeTruthy();
    expect(qrSvg.tagName.toLowerCase()).toBe("svg");

    const paths = qrSvg.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].getAttribute("d")).toBeTruthy();

    expect(container.querySelector("iframe")).toBeNull();
    const images = Array.from(container.querySelectorAll("img"));
    for (const img of images) {
      expect(img.getAttribute("src")).not.toMatch(/^https?:/i);
    }
  });

  it("distinguishes core_online from transport_ready and does not report transport connected prematurely", () => {
    const coreOnlineStatus = baseStatus({
      managedEnabled: true,
      phase: "core_online",
      accountId: "12345678",
    });

    const { rerender } = renderCard(
      <QqManagedComponentCard status={coreOnlineStatus} onToggleManaged={vi.fn()} />,
    );

    const badge = document.querySelector("[data-phase]");
    expect(badge?.getAttribute("data-phase")).toBe("core_online");
    expect(badge?.textContent).not.toMatch(/transport_ready|已就绪|connected/i);

    const readyStatus = baseStatus({
      managedEnabled: true,
      phase: "transport_ready",
      accountId: "12345678",
    });

    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={readyStatus} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );
    const readyBadge = document.querySelector("[data-phase]");
    expect(readyBadge?.getAttribute("data-phase")).toBe("transport_ready");
  });

  it("renders account number cleanly without leftover braces in both zh-CN and en locales", async () => {
    const status = baseStatus({
      managedEnabled: true,
      phase: "stopped",
      accountId: "987654321",
    });

    await i18n.changeLanguage("zh-CN");
    const { rerender } = renderCard(
      <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} />,
    );

    const zhAccountText = screen.getByText(/987654321/);
    expect(zhAccountText.textContent).toBe("当前账号：987654321");
    expect(zhAccountText.textContent).not.toContain("{");
    expect(zhAccountText.textContent).not.toContain("}");

    await i18n.changeLanguage("en");
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const enAccountText = screen.getByText(/987654321/);
    expect(enAccountText.textContent).toBe("Current Account: 987654321");
    expect(enAccountText.textContent).not.toContain("{");
    expect(enAccountText.textContent).not.toContain("}");

    await i18n.changeLanguage("zh-CN");
  });

  it("disables interactive controls during loading or saving to prevent duplicate actions", () => {
    const onToggle = vi.fn();
    const onRefresh = vi.fn();
    const status = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      qrPayload: "2ban://payload",
    });

    const { rerender } = renderCard(
      <QqManagedComponentCard
        status={status}
        loading={true}
        onToggleManaged={onToggle}
        onRefreshQr={onRefresh}
      />,
    );

    const toggle = screen.getByRole("checkbox");
    const refreshBtn = screen.getByRole("button", { name: /刷新|refresh/i });
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("data-disabled") !== null).toBe(
      true,
    );
    expect((refreshBtn as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard
          status={status}
          saving={true}
          onToggleManaged={onToggle}
          onRefreshQr={onRefresh}
        />
      </I18nextProvider>,
    );

    const toggleSaving = screen.getByRole("checkbox");
    const refreshBtnSaving = screen.getByRole("button", { name: /刷新|refresh/i });
    expect(
      toggleSaving.hasAttribute("disabled") || toggleSaving.getAttribute("data-disabled") !== null,
    ).toBe(true);
    expect((refreshBtnSaving as HTMLButtonElement).disabled).toBe(true);
  });

  it("sanitizes unknown diagnostic codes, prevents secret leakage into DOM, and displays safe fallback", () => {
    const onRetry = vi.fn();
    const secretPath = "C:/superstring/private/secret-token-leak-012345";
    const status = baseStatus({
      managedEnabled: true,
      phase: "error",
      diagnosticCode: secretPath,
    });

    const { container } = renderCard(
      <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} onRetry={onRetry} />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.getAttribute("data-diagnostic-code")).toBe("unknown");

    expect(container.innerHTML).not.toContain("secret-token-leak");
    expect(container.innerHTML).not.toContain("C:/superstring");

    expect(alert.textContent).toMatch(/托管组件发生异常|error occurred/i);

    const retryBtn = screen.getByRole("button", { name: /重试|retry/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("triggers onRefreshQr when the QR refresh button is clicked in waiting_scan state", () => {
    const onRefresh = vi.fn();
    const status = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      qrPayload: "2ban://refresh-test-payload",
    });

    renderCard(
      <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} onRefreshQr={onRefresh} />,
    );

    const refreshBtn = screen.getByRole("button", { name: /刷新|refresh/i });
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("announces asynchronous phase transitions politely without duplicating error alert or leaking secret QR payload", () => {
    const statusScan = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      qrPayload: "2ban://test-secret-qr-payload-token-12345",
    });

    const { rerender } = renderCard(
      <QqManagedComponentCard status={statusScan} onToggleManaged={vi.fn()} />,
    );

    const badgeScan = document.querySelector("[data-phase='waiting_scan']");
    expect(badgeScan).toBeTruthy();
    expect(badgeScan?.getAttribute("aria-live")).toBe("polite");
    expect(badgeScan?.getAttribute("role")).toBe("status");
    expect(badgeScan?.textContent).toMatch(/等待扫码|waiting/i);
    expect(badgeScan?.textContent).not.toContain("2ban://test-secret-qr-payload-token-12345");

    const statusConfirm = baseStatus({
      managedEnabled: true,
      phase: "waiting_confirm",
    });
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={statusConfirm} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const badgeConfirm = document.querySelector("[data-phase='waiting_confirm']");
    expect(badgeConfirm?.getAttribute("aria-live")).toBe("polite");
    expect(badgeConfirm?.getAttribute("role")).toBe("status");
    expect(badgeConfirm?.textContent).toMatch(/等待.*确认|waiting.*confirm/i);

    const statusCoreOnline = baseStatus({
      managedEnabled: true,
      phase: "core_online",
      accountId: "12345678",
    });
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={statusCoreOnline} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const badgeCoreOnline = document.querySelector("[data-phase='core_online']");
    expect(badgeCoreOnline?.getAttribute("aria-live")).toBe("polite");
    expect(badgeCoreOnline?.getAttribute("role")).toBe("status");

    const statusReady = baseStatus({
      managedEnabled: true,
      phase: "transport_ready",
      accountId: "12345678",
    });
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={statusReady} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const badgeReady = document.querySelector("[data-phase='transport_ready']");
    expect(badgeReady?.getAttribute("aria-live")).toBe("polite");
    expect(badgeReady?.getAttribute("role")).toBe("status");

    const statusError = baseStatus({
      managedEnabled: true,
      phase: "error",
      diagnosticCode: "process_crashed",
    });
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={statusError} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    const badgeError = document.querySelector("[data-phase='error']");
    expect(badgeError?.getAttribute("aria-live")).not.toBe("polite");
    expect(badgeError?.getAttribute("role")).not.toBe("status");
  });
});
