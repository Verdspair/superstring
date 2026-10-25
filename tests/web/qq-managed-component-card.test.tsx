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
  it("composes host save actions into the managed section without owning their state", () => {
    const save = vi.fn();
    renderCard(
      <QqManagedComponentCard
        status={baseStatus()}
        onToggleManaged={vi.fn()}
        footer={
          <button type="button" onClick={save}>
            Save managed preference
          </button>
        }
      />,
    );
    const heading = screen.getByRole("heading", {
      name: i18n.t("connections.managed.title"),
      level: 2,
    });
    const action = screen.getByRole("button", { name: "Save managed preference" });
    expect(heading.closest("section")?.contains(action)).toBe(true);
    fireEvent.click(action);
    expect(save).toHaveBeenCalledTimes(1);
  });

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

  it("distinguishes external ownership from local stopped component without presenting false stopped status", () => {
    const externalStatus = baseStatus({
      managedEnabled: false,
      phase: "transport_ready",
      ownership: "external",
    });

    renderCard(<QqManagedComponentCard status={externalStatus} onToggleManaged={vi.fn()} />);

    expect(screen.getByText(i18n.t("connections.managed.ownership.external"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("connections.managed.phase.stopped"))).toBeNull();
  });

  it("renders QR refresh action button in waiting_scan phase even when qrPayload is not yet loaded", () => {
    const onRefresh = vi.fn();
    const status = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      qrPayload: null,
    });

    renderCard(
      <QqManagedComponentCard status={status} onToggleManaged={vi.fn()} onRefreshQr={onRefresh} />,
    );

    const refreshBtn = screen.getByRole("button", { name: /刷新|refresh/i });
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders new network_apply badge state and diagnostic indicators correctly", () => {
    const statusApplying = baseStatus({
      managedEnabled: true,
      phase: "applying_network",
      networkApply: "pending",
      accountId: "12345678",
    });

    const { rerender } = renderCard(
      <QqManagedComponentCard status={statusApplying} onToggleManaged={vi.fn()} />,
    );

    const applyingBadge = document.querySelector("[data-phase='applying_network']");
    expect(applyingBadge).toBeTruthy();
    expect(applyingBadge?.getAttribute("role")).toBe("status");

    const statusFailed = baseStatus({
      managedEnabled: true,
      phase: "error",
      networkApply: "failed",
      diagnosticCode: "network_apply_failed",
    });

    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard status={statusFailed} onToggleManaged={vi.fn()} />
      </I18nextProvider>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.getAttribute("data-diagnostic-code")).toBe("network_apply_failed");
  });

  it("renders quick login accounts selector and triggers quick login execution", () => {
    const onSelect = vi.fn();
    const onExecute = vi.fn();
    const accounts = [
      { account_id: "12345678", display_name: "Test Bot 1" },
      { account_id: "87654321", display_name: null },
    ];

    const status = baseStatus({
      managedEnabled: true,
      phase: "waiting_scan",
      ownership: "owned",
      process: "running",
    });

    renderCard(
      <QqManagedComponentCard
        status={status}
        resources={{
          revision: "ready",
          status: "ready",
          root: "C:/runtime",
          diagnostic_code: null,
        }}
        accounts={accounts}
        selectedQuickLoginAccount="12345678"
        onToggleManaged={vi.fn()}
        onSelectQuickLoginAccount={onSelect}
        onExecuteQuickLogin={onExecute}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "87654321" } });
    expect(onSelect).toHaveBeenCalledWith("87654321");

    const quickLoginBtn = screen.getByRole("button", { name: /快速登录|quick login/i });
    expect(quickLoginBtn).toBeTruthy();
    fireEvent.click(quickLoginBtn);
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { phase: "stopped", ownership: "none", process: "stopped" },
    { phase: "waiting_scan", ownership: "owned", process: "starting" },
  ] as const)(
    "keeps quick login disabled without an owned running waiting-scan component: %j",
    (blocked) => {
      const execute = vi.fn();
      const retry = vi.fn();
      renderCard(
        <QqManagedComponentCard
          status={baseStatus({ managedEnabled: true, ...blocked })}
          resources={{
            revision: "ready",
            status: "ready",
            root: "C:/runtime",
            diagnostic_code: null,
          }}
          accounts={[{ account_id: "12345678", display_name: null }]}
          selectedQuickLoginAccount="12345678"
          onToggleManaged={vi.fn()}
          onSelectQuickLoginAccount={vi.fn()}
          onExecuteQuickLogin={execute}
          onRetry={retry}
        />,
      );
      const button = screen.getByRole("button", {
        name: i18n.t("connections.managed.quickLogin.loginButton"),
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.getByText(i18n.t("connections.managed.quickLogin.notReady"))).toBeTruthy();
      fireEvent.click(button);
      expect(execute).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      if (blocked.phase === "stopped") {
        fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.managed.retry") }));
        expect(retry).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not offer local quick login for an external instance", () => {
    renderCard(
      <QqManagedComponentCard
        status={baseStatus({ phase: "waiting_scan", ownership: "external", process: "running" })}
        accounts={[{ account_id: "12345678", display_name: null }]}
        selectedQuickLoginAccount="12345678"
        onToggleManaged={vi.fn()}
        onSelectQuickLoginAccount={vi.fn()}
        onExecuteQuickLogin={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: i18n.t("connections.managed.quickLogin.loginButton") }),
    ).toBeNull();
  });

  it("ready resources show a compact summary; explicit path settings preserve controlled edits across collapse", () => {
    const onPatch = vi.fn();
    const onUpdate = vi.fn();
    const status = baseStatus({ ownership: "owned", process: "running", phase: "transport_ready" });
    const resources = {
      revision: "ready-1",
      status: "ready" as const,
      root: "C:/runtime",
      diagnostic_code: null,
    };
    const card = (draft: string) => (
      <QqManagedComponentCard
        status={status}
        resources={resources}
        resourceDraftRoot={draft}
        onToggleManaged={vi.fn()}
        onPatchResourceDraftRoot={onPatch}
        onUpdateResourcePath={onUpdate}
      />
    );
    const { rerender } = renderCard(card("C:/runtime"));
    const configure = () =>
      screen.getByRole("button", { name: i18n.t("connections.managed.resources.configure") });
    expect(configure().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(i18n.t("connections.managed.resources.valid"))).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: i18n.t("connections.managed.resources.title") }),
    ).toBeNull();
    expect(screen.queryByText(i18n.t("connections.managed.resources.description"))).toBeNull();
    fireEvent.click(configure());
    expect(configure().getAttribute("aria-expanded")).toBe("true");
    expect(
      screen
        .getByRole("link", { name: i18n.t("connections.managed.resources.officialLink") })
        .getAttribute("href"),
    ).toBe("https://github.com/NapNeko/NapCatQQ/releases");
    fireEvent.change(
      screen.getByRole("textbox", { name: i18n.t("connections.managed.resources.title") }),
      { target: { value: "D:/changed-runtime" } },
    );
    expect(onPatch).toHaveBeenCalledWith("D:/changed-runtime");
    rerender(<I18nextProvider i18n={i18n}>{card("D:/changed-runtime")}</I18nextProvider>);
    fireEvent.click(configure());
    expect(
      screen.queryByRole("textbox", { name: i18n.t("connections.managed.resources.title") }),
    ).toBeNull();
    fireEvent.click(configure());
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("connections.managed.resources.title"),
        }) as HTMLInputElement
      ).value,
    ).toBe("D:/changed-runtime");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("connections.managed.resources.saveButton") }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("D:/changed-runtime");
  });

  it.each(["missing", "invalid"] as const)(
    "%s resources keep first-time setup open",
    (resourceStatus) => {
      renderCard(
        <QqManagedComponentCard
          status={baseStatus({ runtimeGatePassed: false })}
          resources={{
            revision: "setup-1",
            status: resourceStatus,
            root: null,
            diagnostic_code: "runtime_not_selected",
          }}
          onToggleManaged={vi.fn()}
          onUpdateResourcePath={vi.fn()}
        />,
      );
      expect(
        screen
          .getByRole("button", { name: i18n.t("connections.managed.resources.configure") })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        screen.getByRole("textbox", { name: i18n.t("connections.managed.resources.title") }),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: i18n.t("connections.managed.resources.officialLink") }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: i18n.t("hints.field.learnAbout", {
            "0": i18n.t("connections.managed.resources.title"),
          }),
        }),
      ).toBeTruthy();
    },
  );

  it("external and unknown resources cannot submit a path", () => {
    const update = vi.fn();
    const { rerender } = renderCard(
      <QqManagedComponentCard
        status={baseStatus({ ownership: "external" })}
        resources={{
          revision: "external-1",
          status: "ready",
          root: "C:/external",
          diagnostic_code: null,
        }}
        onToggleManaged={vi.fn()}
        onUpdateResourcePath={update}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("connections.managed.resources.configure") }),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("connections.managed.resources.title"),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("connections.managed.resources.saveButton") }),
    );
    expect(update).not.toHaveBeenCalled();
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard
          status={baseStatus({ runtimeGatePassed: false })}
          resourceDraftRoot="C:/draft"
          onToggleManaged={vi.fn()}
          onUpdateResourcePath={update}
        />
      </I18nextProvider>,
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: i18n.t("connections.managed.resources.title"),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("connections.managed.resources.saveButton") }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("renders runtime path input and emits onUpdateResourcePath", () => {
    const onUpdatePath = vi.fn();
    const status = baseStatus({
      managedEnabled: false,
      runtimeGatePassed: false,
    });
    const resources = {
      revision: "rev-1",
      status: "missing" as const,
      root: null,
      diagnostic_code: "runtime_not_selected" as const,
    };

    renderCard(
      <QqManagedComponentCard
        status={status}
        resources={resources}
        onToggleManaged={vi.fn()}
        onUpdateResourcePath={onUpdatePath}
      />,
    );

    const pathInput = screen.getByRole("textbox", { name: /运行时路径|runtime path/i });
    expect(pathInput).toBeTruthy();
    fireEvent.change(pathInput, { target: { value: "D:/tools/napcat/shell" } });

    const savePathBtn = screen.getByRole("button", { name: /更新路径|update path/i });
    expect(savePathBtn).toBeTruthy();
    fireEvent.click(savePathBtn);
    expect(onUpdatePath).toHaveBeenCalledWith("D:/tools/napcat/shell");
  });
  it("renders controlled resource draft root when provided and invokes onPatchResourceDraftRoot", () => {
    const onPatch = vi.fn();
    const onUpdate = vi.fn();
    const status = baseStatus({
      managedEnabled: false,
      runtimeGatePassed: false,
    });
    const resources = {
      revision: "rev-1",
      status: "missing" as const,
      root: "C:/old/path",
      diagnostic_code: "runtime_not_selected" as const,
    };

    const { rerender } = renderCard(
      <QqManagedComponentCard
        status={status}
        resources={resources}
        resourceDraftRoot="D:/draft/path"
        onToggleManaged={vi.fn()}
        onPatchResourceDraftRoot={onPatch}
        onUpdateResourcePath={onUpdate}
      />,
    );

    const pathInput = screen.getByRole("textbox", {
      name: /运行时路径|runtime path/i,
    }) as HTMLInputElement;
    expect(pathInput.value).toBe("D:/draft/path");

    fireEvent.change(pathInput, { target: { value: "E:/new/draft" } });
    expect(onPatch).toHaveBeenCalledWith("E:/new/draft");

    // Re-render with updated controlled prop
    rerender(
      <I18nextProvider i18n={i18n}>
        <QqManagedComponentCard
          status={status}
          resources={resources}
          resourceDraftRoot="E:/new/draft"
          onToggleManaged={vi.fn()}
          onPatchResourceDraftRoot={onPatch}
          onUpdateResourcePath={onUpdate}
        />
      </I18nextProvider>,
    );

    expect(
      (screen.getByRole("textbox", { name: /运行时路径|runtime path/i }) as HTMLInputElement).value,
    ).toBe("E:/new/draft");

    const savePathBtn = screen.getByRole("button", { name: /更新路径|update path/i });
    fireEvent.click(savePathBtn);
    expect(onUpdate).toHaveBeenCalledWith("E:/new/draft");
  });
});
