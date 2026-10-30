import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSettingsResponse, QqStatusResponse } from "../../src/shared/contracts/qq";
import type {
  QqManagedAccounts,
  QqManagedConfigSnapshot,
  QqManagedQr,
  QqManagedResourceSnapshot,
  QqManagedStatus,
} from "../../src/shared/contracts/qq-managed";
import { api } from "../../src/web/api";
import { qqDraftChanges } from "../../src/web/features/qq/draft-state";
import { selectLocale, translate } from "../../src/web/i18n";
import { QqConnectionTab } from "../../src/web/screens/connections/qq-app-management";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const mockQqSettings: QqSettingsResponse = {
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://127.0.0.1:3001", has_token: true },
  revision: 5,
};

const mockQqConnection: QqStatusResponse["connection"] = {
  phase: "ready",
  reason: null,
};

const mockManagedConfig: QqManagedConfigSnapshot = {
  revision: "rev-managed-alpha-001",
  config: {
    version: 1,
    enabled: false,
  },
};

const mockManagedStatus: QqManagedStatus = {
  process: "unavailable",
  apply: "blocked",
  unavailable_reason: "native_validation_required",
};

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    getQqSettings: async () => mockQqSettings,
    getQqStatus: async () => ({ connection: mockQqConnection }),
    getQqManagedConfig: async () => mockManagedConfig,
    getQqManagedStatus: async () => mockManagedStatus,
    updateQqManagedConfig: async () => ({
      ...mockManagedConfig,
      revision: "rev-managed-beta-002",
      config: { version: 1, enabled: true },
    }),
  });
  store.setState({
    qqSettings: mockQqSettings,
    qqConnection: mockQqConnection,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QQ Managed Component settings and actions lifecycle", () => {
  it("isolates loadQqManaged from qqConnection and records managed status separately without fake QR", async () => {
    const getStatus = vi.fn(async () => mockManagedStatus);
    const getConfig = vi.fn(async () => mockManagedConfig);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedStatus: getStatus,
        getQqManagedConfig: getConfig,
      },
      qqConnection: mockQqConnection,
    });

    await store.getState().loadQqManaged();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledTimes(1);

    const s = store.getState();
    expect(s.qqManagedStatus).toEqual(mockManagedStatus);
    expect(s.qqManagedStatus?.apply).toBe("blocked");
    if (s.qqManagedStatus?.apply === "blocked") {
      expect(s.qqManagedStatus.unavailable_reason).toBe("native_validation_required");
    }
    expect(s.qqConnection).toEqual(mockQqConnection);
  });

  it("deduplicates in-flight load requests without issuing redundant API calls", async () => {
    let resolveConfig: (val: QqManagedConfigSnapshot) => void = () => {};
    const deferredConfig = new Promise<QqManagedConfigSnapshot>((res) => {
      resolveConfig = res;
    });

    const getConfig = vi.fn(() => deferredConfig);
    const getStatus = vi.fn(async () => mockManagedStatus);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedConfig: getConfig,
        getQqManagedStatus: getStatus,
      },
    });

    const actionStore = store.getState();
    const firstCall = actionStore.loadQqManaged();
    const secondCall = actionStore.loadQqManaged();

    expect(getConfig).toHaveBeenCalledTimes(1);

    resolveConfig(mockManagedConfig);
    await Promise.all([firstCall, secondCall]);

    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it("discards late arrivals from stale API identity or outdated read token", async () => {
    let resolveSlow: (val: QqManagedConfigSnapshot) => void = () => {};
    const slowPromise = new Promise<QqManagedConfigSnapshot>((res) => {
      resolveSlow = res;
    });

    const initialApi = {
      ...store.getState().apiClient,
      getQqManagedConfig: vi.fn(() => slowPromise),
      getQqManagedStatus: vi.fn(async () => mockManagedStatus),
    };

    store.setState({ apiClient: initialApi });
    const inFlight = store.getState().loadQqManaged();

    const freshApi = {
      ...store.getState().apiClient,
      getQqManagedConfig: vi.fn(async () => ({
        revision: "rev-switched-999",
        config: { version: 1 as const, enabled: false },
      })),
      getQqManagedStatus: vi.fn(async () => mockManagedStatus),
    };
    store.setState({ apiClient: freshApi });

    resolveSlow(mockManagedConfig);
    await inFlight;

    expect(store.getState().qqManagedConfig).toBeNull();
  });

  it("saves managed expected_revision independently without modifying qq_settings number revision, and advances base on success even if status call fails", async () => {
    const updateManaged = vi.fn(
      async (body: { config: { version: 1; enabled: boolean }; expected_revision: string }) => ({
        revision: "rev-managed-advanced-002",
        config: body.config,
      }),
    );
    const getManagedStatusFailing = vi.fn(async () => {
      throw new Error("status fetch failed after save");
    });
    const updateQqSettings = vi.fn();

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqManagedConfig: updateManaged,
        getQqManagedStatus: getManagedStatusFailing,
        updateQqSettings,
      },
      qqSettings: mockQqSettings,
      qqInputs: {
        ...store.getState().qqInputs,
        managed: {
          source: mockManagedConfig,
          enabled: true,
        },
      },
    });

    const ok = await store.getState().saveQqManagedConfig();
    expect(ok).toBe(true);

    expect(updateManaged).toHaveBeenCalledWith({
      expected_revision: "rev-managed-alpha-001",
      config: { version: 1, enabled: true },
    });
    expect(updateQqSettings).not.toHaveBeenCalled();

    const s = store.getState();
    expect(s.qqSettings?.revision).toBe(5);
    expect(s.qqInputs.managed).toBeNull();
    expect(s.qqManagedConfig?.revision).toBe("rev-managed-advanced-002");
    expect(s.qqManagedConfig?.config.enabled).toBe(true);
  });

  it("retains dirty draft on CAS 409 conflict, and refresh reconciles baseline while keeping dirty input", async () => {
    const conflictError = Object.assign(new Error("托管组件配置已变化，请重新读取后保存"), {
      status: 409,
      code: "NAPCAT_CONFIG_CONFLICT",
    });

    const updateManaged = vi.fn(async () => {
      throw conflictError;
    });

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqManagedConfig: updateManaged,
      },
      qqInputs: {
        ...store.getState().qqInputs,
        managed: {
          source: mockManagedConfig,
          enabled: true,
        },
      },
    });

    const ok = await store.getState().saveQqManagedConfig();
    expect(ok).toBe(false);

    let s = store.getState();
    expect(s.qqInputs.managed).not.toBeNull();
    expect(s.qqInputs.managed?.enabled).toBe(true);
    expect(s.qqInputs.managed?.source.revision).toBe("rev-managed-alpha-001");

    const externalSnapshot: QqManagedConfigSnapshot = {
      revision: "rev-external-003",
      config: { version: 1, enabled: false },
    };
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedConfig: vi.fn(async () => externalSnapshot),
        getQqManagedStatus: vi.fn(async () => mockManagedStatus),
      },
    });

    await store.getState().refreshQqManaged();

    s = store.getState();
    expect(s.qqInputs.managed?.enabled).toBe(true);
    expect(s.qqInputs.managed?.source.revision).toBe("rev-external-003");
  });

  it("participates in saveQqDrafts, discardQqDrafts, and qqDraftChanges preview without advancing QQ number revision chain", async () => {
    const updateManaged = vi.fn(
      async (body: { config: { version: 1; enabled: boolean }; expected_revision: string }) => ({
        revision: "rev-managed-004",
        config: body.config,
      }),
    );
    const updateQqSettings = vi.fn();

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqManagedConfig: updateManaged,
        updateQqSettings,
      },
      qqSettings: mockQqSettings,
      qqInputs: {
        ...store.getState().qqInputs,
        managed: {
          source: mockManagedConfig,
          enabled: true,
        },
      },
    });

    const changes = qqDraftChanges(store.getState());
    const managedChange = changes.find(
      (row) => row.id === "managed-component" || row.resource.includes("托管"),
    );
    expect(managedChange).toBeDefined();

    const ok = await store.getState().saveQqDrafts();
    expect(ok).toBe(true);

    expect(updateManaged).toHaveBeenCalledWith({
      expected_revision: "rev-managed-alpha-001",
      config: { version: 1, enabled: true },
    });
    expect(updateQqSettings).not.toHaveBeenCalled();

    let s = store.getState();
    expect(s.qqSettings?.revision).toBe(5);
    expect(s.qqInputs.managed).toBeNull();

    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        managed: {
          source: mockManagedConfig,
          enabled: true,
        },
      },
    });

    store.getState().discardQqDrafts();
    s = store.getState();
    expect(s.qqInputs.managed).toBeNull();
  });

  it("handles native gate blocked status: records preference without manufacturing unverified native runnable actions", async () => {
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedStatus: async () => ({
          process: "unavailable",
          apply: "blocked",
          unavailable_reason: "native_validation_required",
        }),
      },
    });

    await store.getState().loadQqManaged();

    const s = store.getState();
    expect(s.qqManagedStatus?.apply).toBe("blocked");
    if (s.qqManagedStatus?.apply === "blocked") {
      expect(s.qqManagedStatus.unavailable_reason).toBe("native_validation_required");
      expect(s.qqManagedStatus.process).toBe("unavailable");
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const savedManagedConfig: QqManagedConfigSnapshot = {
  revision: "rev-managed-saved",
  config: { version: 1, enabled: true },
};

function prepareManagedDraft() {
  store.setState({ qqManagedConfig: mockManagedConfig });
  store.getState().patchQqManagedDraft(true);
}

describe("QQ managed read, write and draft ownership", () => {
  it("starts a fresh read after reset with the same API instead of joining the old owner", async () => {
    const oldRead = deferred<QqManagedConfigSnapshot>();
    const freshRead = deferred<QqManagedConfigSnapshot>();
    const getConfig = vi
      .fn()
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => freshRead.promise);
    const sameApi = { ...store.getState().apiClient, getQqManagedConfig: getConfig };
    store.getState().resetForTests(sameApi);
    const oldLoad = store.getState().loadQqManaged();
    store.getState().resetForTests(sameApi);
    const freshLoad = store.getState().loadQqManaged();
    freshRead.resolve(savedManagedConfig);
    oldRead.resolve(mockManagedConfig);
    await Promise.all([oldLoad, freshLoad]);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(store.getState().qqManagedConfig).toEqual(savedManagedConfig);
    expect(store.getState().qqManagedLoading).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "ignores a pending PUT %s and its cleanup after same-API reset",
    async (outcome) => {
      const put = deferred<QqManagedConfigSnapshot>();
      const sameApi = {
        ...store.getState().apiClient,
        updateQqManagedConfig: vi.fn(() => put.promise),
        getQqManagedStatus: vi.fn(async () => mockManagedStatus),
      };
      store.getState().resetForTests(sameApi);
      prepareManagedDraft();
      const save = store.getState().saveQqManagedConfig();
      store.getState().resetForTests(sameApi);
      store.setState({ feedback: "fresh feedback", qqManagedSaving: true });
      if (outcome === "success") put.resolve(savedManagedConfig);
      else put.reject(new Error("old PUT failure"));
      expect(await save).toBe(false);
      expect(store.getState()).toMatchObject({
        qqManagedConfig: null,
        qqManagedStatus: null,
        qqManagedSaving: true,
        error: null,
        feedback: "fresh feedback",
      });
      expect(sameApi.getQqManagedStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["loadQqManaged", "refreshQqManaged"] as const)(
    "does not let %s started during PUT overwrite the committed saved revision",
    async (readAction) => {
      const put = deferred<QqManagedConfigSnapshot>();
      const read = deferred<QqManagedConfigSnapshot>();
      store.setState({
        apiClient: {
          ...store.getState().apiClient,
          updateQqManagedConfig: vi.fn(() => put.promise),
          getQqManagedConfig: vi.fn(() => read.promise),
        },
      });
      prepareManagedDraft();
      const save = store.getState().saveQqManagedConfig();
      const load = store.getState()[readAction]();
      put.resolve(savedManagedConfig);
      expect(await save).toBe(true);
      read.resolve(mockManagedConfig);
      await load;
      expect(store.getState().qqManagedConfig).toEqual(savedManagedConfig);
      expect(store.getState().qqManagedLoading).toBe(false);
      expect(store.getState().qqInputs.managed).toBeNull();
    },
  );

  it.each(["patch", "discard and recreate"] as const)(
    "keeps newer input after pending PUT when the user chooses %s",
    async (change) => {
      const put = deferred<QqManagedConfigSnapshot>();
      store.setState({
        apiClient: {
          ...store.getState().apiClient,
          updateQqManagedConfig: vi.fn(() => put.promise),
        },
      });
      prepareManagedDraft();
      const save = store.getState().saveQqManagedConfig();
      if (change === "discard and recreate") store.getState().discardQqDrafts();
      store.getState().patchQqManagedDraft(false);
      put.resolve(savedManagedConfig);
      expect(await save).toBe(true);
      expect(store.getState().qqInputs.managed).toEqual({
        source: savedManagedConfig,
        enabled: false,
      });
      expect(qqDraftChanges(store.getState()).map((row) => row.id)).toContain("managed-component");
    },
  );

  it.each([false, true])(
    "refresh advances the baseline and preserves only dirty input (dirty=%s)",
    async (dirty) => {
      const external: QqManagedConfigSnapshot = {
        revision: "rev-managed-external",
        config: { version: 1, enabled: !dirty },
      };
      store.setState({
        qqManagedConfig: mockManagedConfig,
        qqInputs: {
          ...store.getState().qqInputs,
          managed: { source: mockManagedConfig, enabled: dirty },
        },
        apiClient: {
          ...store.getState().apiClient,
          getQqManagedConfig: vi.fn(async () => external),
        },
      });
      await store.getState().refreshQqManaged();
      expect(store.getState().qqManagedConfig).toEqual(external);
      expect(store.getState().qqInputs.managed).toEqual({
        source: external,
        enabled: dirty ? true : external.config.enabled,
      });
      expect(qqDraftChanges(store.getState()).some((row) => row.id === "managed-component")).toBe(
        dirty,
      );
    },
  );

  it("keeps draft-owned save and discard available after an implicit load", async () => {
    prepareManagedDraft();
    const source = store.getState().qqInputs.managed?.source;
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedConfig: vi.fn(async () => savedManagedConfig),
      },
    });
    await store.getState().loadQqManaged();
    expect(store.getState().qqInputs.managed?.source).toBe(source);
    render(<QqConnectionTab active={false} />);
    const card = screen
      .getByRole("heading", {
        name: translate("connections.managed.title"),
      })
      .closest("section");
    expect(card?.parentElement).not.toBeNull();
    const panel = within(card?.parentElement as HTMLElement);
    expect(
      (panel.getByRole("button", { name: translate("library.save") }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (panel.getByRole("button", { name: translate("models.discard") }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("shows the latest saved value after implicit load when a draft has returned to clean", async () => {
    await store.getState().loadQqManaged();
    store.getState().patchQqManagedDraft(true);
    store.getState().patchQqManagedDraft(false);
    const source = store.getState().qqInputs.managed?.source;
    expect(source).toBe(mockManagedConfig);
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedConfig: vi.fn(async () => savedManagedConfig),
      },
    });
    await store.getState().loadQqManaged();
    expect(store.getState().qqInputs.managed?.source).toBe(source);
    render(<QqConnectionTab active={false} />);
    const card = screen
      .getByRole("heading", {
        name: translate("connections.managed.title"),
      })
      .closest("section");
    expect(card?.parentElement).not.toBeNull();
    const panel = within(card?.parentElement as HTMLElement);
    expect(
      panel
        .getByRole("checkbox", {
          name: translate("connections.managed.enable"),
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (panel.getByRole("button", { name: translate("library.save") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (panel.getByRole("button", { name: translate("models.discard") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it.each(["initial read", "status after save"] as const)(
    "shows a safe local alert for %s failure without changing QQ connection state",
    async (stage) => {
      const secret = "RAW_VENDOR_SECRET_SENTINEL";
      store.setState({
        apiClient: {
          ...store.getState().apiClient,
          getQqManagedStatus: vi.fn(async () => {
            throw new Error(secret);
          }),
        },
      });
      if (stage === "status after save") {
        prepareManagedDraft();
        expect(await store.getState().saveQqManagedConfig()).toBe(true);
        expect(store.getState().qqManagedConfig?.config.enabled).toBe(true);
        expect(store.getState().qqInputs.managed).toBeNull();
      } else {
        await store.getState().loadQqManaged();
      }
      await act(async () => {
        render(<QqConnectionTab active={false} />);
      });
      const card = screen
        .getByRole("heading", {
          name: translate("connections.managed.title"),
        })
        .closest("section");
      expect(card?.parentElement).not.toBeNull();
      const alert = within(card?.parentElement as HTMLElement).getByRole("alert");
      expect(alert.textContent).toBe(translate("connections.managed.diag.unknown"));
      expect(document.body.textContent).not.toContain(secret);
      expect(store.getState().qqConnection).toEqual(mockQqConnection);
    },
  );
});

describe("QQ managed ready status mapping, explicit actions, and QR lifecycle fencing", () => {
  it("maps backend ready-branch status (core_online, running, owned) directly into runtime store and UI instead of hardcoded stopped/blocked", async () => {
    const readyStatus: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "core_online",
      core_ready: true,
      network_apply: "pending",
      transport_phase: "ready",
      diagnostic_code: null,
    };

    const getStatus = vi.fn(async (): Promise<QqManagedStatus> => readyStatus);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedStatus: getStatus,
      },
    });

    await store.getState().loadQqManaged();

    const s = store.getState();
    expect(s.qqManagedStatus).toEqual(readyStatus);
    expect(s.qqManagedStatus?.apply).toBe("ready");
    if (s.qqManagedStatus?.apply === "ready") {
      expect(s.qqManagedStatus.phase).toBe("core_online");
      expect(s.qqManagedStatus.ownership).toBe("owned");
    }

    await act(async () => {
      render(<QqConnectionTab active={false} />);
    });

    const badge = document.querySelector("[data-phase]");
    expect(badge?.getAttribute("data-phase")).toBe("core_online");
    expect(badge?.textContent).toBe(translate("connections.managed.phase.core_online"));
    expect(badge?.textContent).not.toBe(translate("connections.managed.phase.stopped"));
  });

  it("handles external ownership without collapsing to false stopped badge when external OneBot is ready", async () => {
    const externalStatus: QqManagedStatus = {
      process: "disabled",
      apply: "ready",
      ownership: "external",
      phase: "transport_ready",
      core_ready: true,
      network_apply: "not_owned",
      transport_phase: "ready",
      diagnostic_code: null,
    };

    const getExternalStatus = vi.fn(async (): Promise<QqManagedStatus> => externalStatus);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedStatus: getExternalStatus,
      },
      qqConnection: { phase: "ready", reason: null },
    });

    await store.getState().loadQqManaged();

    await act(async () => {
      render(<QqConnectionTab active={false} />);
    });

    const badge = document.querySelector("[data-phase]");
    expect(badge?.getAttribute("data-phase")).toBe("transport_ready");
    expect(badge?.textContent).not.toBe(translate("connections.managed.phase.stopped"));
  });

  it("triggers explicit POST for retry and refresh-qr without invoking readonly GET or synthetic QR", async () => {
    const retryStatus: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "core_online",
      core_ready: true,
      network_apply: "pending",
      transport_phase: "ready",
      diagnostic_code: null,
    };
    const retrySpy = vi.fn(async (): Promise<QqManagedStatus> => retryStatus);
    const refreshQrSpy = vi.fn(
      async (): Promise<QqManagedQr> => ({ qr_payload: "2ban://explicit-post-qr-token" }),
    );
    const getStatusSpy = vi.fn(async (): Promise<QqManagedStatus> => mockManagedStatus);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        retryQqManaged: retrySpy,
        refreshQqManagedQr: refreshQrSpy,
        getQqManagedStatus: getStatusSpy,
      },
    });

    await store.getState().retryQqManaged();
    expect(retrySpy).toHaveBeenCalledTimes(1);

    await store.getState().refreshQqManagedQr();
    expect(refreshQrSpy).toHaveBeenCalledTimes(1);

    expect(getStatusSpy).not.toHaveBeenCalled();
  });

  it("discards late-arriving QR response after store reset or API client switch to prevent QR leakage across lifecycles", async () => {
    let resolveSlowQr: (val: QqManagedQr) => void = () => {};
    const slowQrPromise = new Promise<QqManagedQr>((res) => {
      resolveSlowQr = res;
    });

    const initialApi = {
      ...store.getState().apiClient,
      refreshQqManagedQr: vi.fn(() => slowQrPromise),
      getQqManagedStatus: vi.fn(async (): Promise<QqManagedStatus> => mockManagedStatus),
    };

    store.setState({ apiClient: initialApi });
    const inFlight = store.getState().refreshQqManagedQr();

    const freshApi = {
      ...store.getState().apiClient,
      refreshQqManagedQr: vi.fn(async (): Promise<QqManagedQr> => ({ qr_payload: null })),
      getQqManagedStatus: vi.fn(async (): Promise<QqManagedStatus> => mockManagedStatus),
    };
    store.getState().resetForTests(freshApi);

    resolveSlowQr({ qr_payload: "2ban://stale-secret-qr-leak-token" });
    await inFlight;

    expect(store.getState().qqManagedQrPayload).toBeNull();
  });

  it("discards late-arriving QR response after clearQqManagedQr, ensuring zero payload and raw secret never reaches DOM", async () => {
    let resolveSlowQr: (val: QqManagedQr) => void = () => {};
    const slowQrPromise = new Promise<QqManagedQr>((res) => {
      resolveSlowQr = res;
    });

    const secretPayload = "2ban://leak-secret-raw-token-never-in-dom";

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        refreshQqManagedQr: vi.fn(() => slowQrPromise),
        getQqManagedStatus: vi.fn(
          async (): Promise<QqManagedStatus> => ({
            process: "running",
            apply: "ready",
            ownership: "owned",
            phase: "waiting_scan",
            core_ready: true,
            network_apply: "pending",
            transport_phase: "ready",
            diagnostic_code: null,
          }),
        ),
      },
      qqManagedStatus: {
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: true,
        network_apply: "pending",
        transport_phase: "ready",
        diagnostic_code: null,
      },
    });

    const inFlight = store.getState().refreshQqManagedQr();

    store.getState().clearQqManagedQr();
    expect(store.getState().qqManagedQrPayload).toBeNull();

    resolveSlowQr({ qr_payload: secretPayload });
    await inFlight;

    expect(store.getState().qqManagedQrPayload).toBeNull();

    await act(async () => {
      render(<QqConnectionTab active={true} />);
    });
    expect(document.body.innerHTML).not.toContain("leak-secret-raw-token-never-in-dom");
  });

  it("does not restore a late QR payload after status advances to waiting_confirm", async () => {
    const qr = deferred<QqManagedQr>();
    const waitingScan: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "waiting_scan",
      core_ready: false,
      network_apply: "pending",
      transport_phase: "connecting",
      diagnostic_code: null,
    };
    const waitingConfirm: QqManagedStatus = { ...waitingScan, phase: "waiting_confirm" };
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        refreshQqManagedQr: vi.fn(() => qr.promise),
        getQqManagedStatus: vi.fn(async (): Promise<QqManagedStatus> => waitingConfirm),
      },
      qqManagedStatus: waitingScan,
      qqManagedQrPayload: "2ban://previous-scan-payload",
    });

    const refreshQr = store.getState().refreshQqManagedQr();
    await store.getState().loadQqManaged();
    expect(store.getState().qqManagedStatus).toEqual(waitingConfirm);
    expect(store.getState().qqManagedQrPayload).toBeNull();

    qr.resolve({ qr_payload: "2ban://late-confirm-payload" });
    await refreshQr;

    expect(store.getState().qqManagedStatus).toEqual(waitingConfirm);
    expect(store.getState().qqManagedQrPayload).toBeNull();
  });

  it("does not let a read started during retry overwrite the committed retry status", async () => {
    const retry = deferred<QqManagedStatus>();
    const read = deferred<QqManagedStatus>();
    const oldStatus: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "error",
      core_ready: false,
      network_apply: "failed",
      transport_phase: "closed",
      diagnostic_code: "control_unavailable",
    };
    const retriedStatus: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "core_online",
      core_ready: true,
      network_apply: "pending",
      transport_phase: "connecting",
      diagnostic_code: null,
    };
    const retryManaged = vi.fn(() => retry.promise);
    const getStatus = vi.fn(() => read.promise);
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        retryQqManaged: retryManaged,
        getQqManagedStatus: getStatus,
      },
      qqManagedStatus: oldStatus,
    });

    const retryAction = store.getState().retryQqManaged();
    expect(getStatus).not.toHaveBeenCalled();
    const load = store.getState().loadQqManaged();
    expect(getStatus).toHaveBeenCalledTimes(1);

    retry.resolve(retriedStatus);
    expect(await retryAction).toBe(true);
    expect(store.getState().qqManagedStatus).toEqual(retriedStatus);

    read.resolve(oldStatus);
    await load;

    expect(store.getState().qqManagedStatus).toEqual(retriedStatus);
    expect(store.getState().qqManagedLoading).toBe(false);
    expect(retryManaged).toHaveBeenCalledTimes(1);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe("QQ managed resources error projection", () => {
  it("shows the failed read, retries the real resource action, and distinguishes missing", async () => {
    const missing: QqManagedResourceSnapshot = {
      revision: "missing-revision",
      status: "missing",
      root: null,
      diagnostic_code: "runtime_not_selected",
    };
    const getResources = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 resource unavailable"))
      .mockResolvedValueOnce(missing);
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedResources: getResources,
        listQqManagedAccounts: async () => ({ accounts: [] }),
        getQqSettings: async () => mockQqSettings,
        getQqStatus: async () => ({ connection: mockQqConnection }),
      },
    });
    render(<QqConnectionTab />);
    await act(async () => {});
    expect(screen.getByText("HTTP 503 resource unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: translate("capabilities.retry") }));
    await act(async () => {});
    expect(getResources).toHaveBeenCalledTimes(2);
    expect(store.getState().qqManagedResources).toEqual(missing);
    expect(store.getState().qqManagedResourceError).toBeNull();
  });
});

describe("QQ managed resources, accounts discovery and quick-login lifecycle", () => {
  const mockResourceSnapshot: QqManagedResourceSnapshot = {
    revision: "rev-resource-001",
    status: "ready",
    root: "C:\\tools\\napcat",
    diagnostic_code: null,
  };

  const ownedStatus: QqManagedStatus = {
    apply: "ready",
    process: "running",
    ownership: "owned",
    phase: "waiting_scan",
    core_ready: false,
    network_apply: "pending",
    transport_phase: "idle",
    diagnostic_code: null,
  };
  async function readAccountsPrerequisites() {
    await store.getState().loadQqManaged();
    await store.getState().loadQqManagedResources();
  }

  const mockAccounts: QqManagedAccounts = {
    accounts: [
      { account_id: "10001", display_name: "Test Bot" },
      { account_id: "20002", display_name: "Backup Bot" },
    ],
  };

  it("loads managed resources and accounts into store state without polluting generic connection", async () => {
    const getResources = vi.fn(
      async (): Promise<QqManagedResourceSnapshot> => mockResourceSnapshot,
    );
    const listAccounts = vi.fn(async (): Promise<QqManagedAccounts> => mockAccounts);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedResources: getResources,
        listQqManagedAccounts: listAccounts,
        getQqManagedConfig: async () => savedManagedConfig,
        getQqManagedStatus: async () => ownedStatus,
      },
    });

    await store.getState().loadQqManaged();
    await store.getState().loadQqManagedResources();
    expect(getResources).toHaveBeenCalledTimes(1);
    expect(store.getState().qqManagedResources).toEqual(mockResourceSnapshot);

    await store.getState().loadQqManagedAccounts();
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(store.getState().qqManagedAccounts).toEqual(mockAccounts.accounts);
  });

  it("tracks managed resource root draft, previews in qqDraftChanges, and discards cleanly", () => {
    store.setState({ qqManagedResources: mockResourceSnapshot });
    store.getState().patchQqManagedResourceDraft("D:\\new\\napcat\\runtime");

    expect(store.getState().qqInputs.managedResources).toEqual({
      source: mockResourceSnapshot,
      root: "D:\\new\\napcat\\runtime",
    });

    const changes = qqDraftChanges(store.getState());
    const resourceChange = changes.find((c) => c.id === "managed-resources");
    expect(resourceChange).toBeDefined();

    store.getState().discardQqDrafts();
    expect(store.getState().qqInputs.managedResources).toBeNull();
  });

  it("saves managed resources using expected_revision and updates baseline on success", async () => {
    const updatedResource: QqManagedResourceSnapshot = {
      revision: "rev-resource-002",
      status: "ready",
      root: "D:\\new\\napcat\\runtime",
      diagnostic_code: null,
    };
    const updateResources = vi.fn(async (): Promise<QqManagedResourceSnapshot> => updatedResource);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqManagedResources: updateResources,
      },
      qqManagedResources: mockResourceSnapshot,
    });

    store.getState().patchQqManagedResourceDraft("D:\\new\\napcat\\runtime");
    const ok = await store.getState().saveQqManagedResources();

    expect(ok).toBe(true);
    expect(updateResources).toHaveBeenCalledWith({
      expected_revision: "rev-resource-001",
      root: "D:\\new\\napcat\\runtime",
    });
    expect(store.getState().qqManagedResources).toEqual(updatedResource);
    expect(store.getState().qqInputs.managedResources).toBeNull();
  });

  it("handles resource save CAS conflict without dropping draft and records error", async () => {
    const conflictError = new Error("Resource conflict 409");
    const updateResources = vi.fn(async () => {
      throw conflictError;
    });

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqManagedResources: updateResources,
      },
      qqManagedResources: mockResourceSnapshot,
    });

    store.getState().patchQqManagedResourceDraft("D:\\invalid\\path");
    const ok = await store.getState().saveQqManagedResources();

    expect(ok).toBe(false);
    expect(store.getState().qqInputs.managedResources?.root).toBe("D:\\invalid\\path");
    expect(store.getState().qqManagedResourceError).toContain("Resource conflict 409");
    expect(store.getState().qqManagedError).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "keeps the fresh resource read owner when an old %s settles after same-API reset",
    async (outcome) => {
      const oldRead = deferred<QqManagedResourceSnapshot>();
      const freshRead = deferred<QqManagedResourceSnapshot>();
      const getResources = vi
        .fn()
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValueOnce(freshRead.promise);
      const client = { ...store.getState().apiClient, getQqManagedResources: getResources };
      store.getState().resetForTests(client);
      const oldLoads = [
        store.getState().loadQqManagedResources(),
        store.getState().loadQqManagedResources(),
      ];
      expect(getResources).toHaveBeenCalledTimes(1);

      store.getState().resetForTests(client);
      const freshLoads = [
        store.getState().loadQqManagedResources(),
        store.getState().loadQqManagedResources(),
      ];
      expect(getResources).toHaveBeenCalledTimes(2);
      if (outcome === "success") oldRead.resolve(mockResourceSnapshot);
      else oldRead.reject(new Error("old resource failure"));
      await Promise.all(oldLoads);
      expect(store.getState()).toMatchObject({
        qqManagedResources: null,
        qqManagedResourcesLoading: true,
        qqManagedResourceError: null,
      });

      const joinedFresh = store.getState().loadQqManagedResources();
      expect(getResources).toHaveBeenCalledTimes(2);
      const freshResource = { ...mockResourceSnapshot, revision: "rev-resource-fresh" };
      freshRead.resolve(freshResource);
      await Promise.all([...freshLoads, joinedFresh]);
      expect(store.getState()).toMatchObject({
        qqManagedResources: freshResource,
        qqManagedResourcesLoading: false,
        qqManagedResourceError: null,
      });
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps the fresh accounts read owner when an old %s settles after same-API reset",
    async (outcome) => {
      const oldRead = deferred<QqManagedAccounts>();
      const freshRead = deferred<QqManagedAccounts>();
      const listAccounts = vi
        .fn()
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValueOnce(freshRead.promise);
      const client = {
        ...store.getState().apiClient,
        listQqManagedAccounts: listAccounts,
        getQqManagedConfig: async () => savedManagedConfig,
        getQqManagedStatus: async () => ownedStatus,
        getQqManagedResources: async () => mockResourceSnapshot,
      };
      store.getState().resetForTests(client);
      await readAccountsPrerequisites();
      const oldLoads = [
        store.getState().loadQqManagedAccounts(),
        store.getState().loadQqManagedAccounts(),
      ];
      await act(async () => {});
      expect(listAccounts).toHaveBeenCalledTimes(1);

      store.getState().resetForTests(client);
      await readAccountsPrerequisites();
      const freshLoads = [
        store.getState().loadQqManagedAccounts(),
        store.getState().loadQqManagedAccounts(),
      ];
      await act(async () => {});
      expect(listAccounts).toHaveBeenCalledTimes(2);
      if (outcome === "success") oldRead.resolve(mockAccounts);
      else oldRead.reject(new Error("old accounts failure"));
      await Promise.all(oldLoads);
      expect(store.getState()).toMatchObject({
        qqManagedAccounts: [],
        qqManagedAccountsLoaded: false,
        qqManagedAccountsLoading: true,
        qqManagedAccountsError: null,
      });

      const joinedFresh = store.getState().loadQqManagedAccounts();
      expect(listAccounts).toHaveBeenCalledTimes(2);
      const freshAccounts: QqManagedAccounts = {
        accounts: [{ account_id: "30003", display_name: "Fresh Bot" }],
      };
      freshRead.resolve(freshAccounts);
      await Promise.all([...freshLoads, joinedFresh]);
      expect(store.getState()).toMatchObject({
        qqManagedAccounts: freshAccounts.accounts,
        qqManagedAccountsLoaded: true,
        qqManagedAccountsLoading: false,
        qqManagedAccountsError: null,
      });
    },
  );

  async function discoverQuickLoginAccounts(preserveNegativeInput = false) {
    const previous = store.getState();
    store.setState({
      apiClient: {
        ...previous.apiClient,
        getQqManagedConfig: async () => savedManagedConfig,
        getQqManagedStatus: async () => ownedStatus,
        getQqManagedResources: async () => mockResourceSnapshot,
        listQqManagedAccounts: async () => mockAccounts,
      },
    });
    await readAccountsPrerequisites();
    await store.getState().loadQqManagedAccounts();
    if (preserveNegativeInput)
      store.setState({
        qqManagedStatus: previous.qqManagedStatus,
        qqManagedResources: previous.qqManagedResources,
        qqManagedAccounts: previous.qqManagedAccounts,
        qqManagedAccountsLoaded: previous.qqManagedAccountsLoaded,
      });
  }

  it("saves the changed account through settings CAS before quick-login with the saved revision", async () => {
    const settingsPut = deferred<QqSettingsResponse>();
    const order: string[] = [];
    const savedSettings: QqSettingsResponse = {
      ...mockQqSettings,
      account_id: "20002",
      revision: 6,
    };
    const waitingConfirm: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "waiting_confirm",
      core_ready: false,
      network_apply: "pending",
      transport_phase: "idle",
      diagnostic_code: null,
    };
    const updateSettings = vi.fn(() => {
      order.push("settings PUT");
      return settingsPut.promise;
    });
    const quickLogin = vi.fn(async () => {
      order.push("quick-login POST");
      return waitingConfirm;
    });
    const updateTransport = vi.fn();
    const updateConfig = vi.fn();
    const updateResources = vi.fn();
    const connectionDraft = {
      source: mockQqSettings,
      accountId: "20002",
      endpoint: "ws://127.0.0.1:4002",
      token: "synthetic-unsaved-token",
    };
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqSettings: updateSettings,
        updateQqTransport: updateTransport,
        updateQqManagedConfig: updateConfig,
        updateQqManagedResources: updateResources,
        quickLoginQqManaged: quickLogin,
      },
      qqSettings: mockQqSettings,
      qqInputs: { ...store.getState().qqInputs, connection: connectionDraft },
      qqManagedResources: mockResourceSnapshot,
      qqManagedAccounts: mockAccounts.accounts,
      qqManagedAccountsLoaded: true,
      qqManagedStatus: { ...waitingConfirm, phase: "waiting_scan" },
    });

    await discoverQuickLoginAccounts();
    const login = store.getState().quickLoginQqManaged("20002");
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ account_id: "20002", expected_revision: 5 });
    expect(quickLogin).not.toHaveBeenCalled();
    expect(order).toEqual(["settings PUT"]);
    settingsPut.resolve(savedSettings);
    expect(await login).toBe(true);

    expect(order).toEqual(["settings PUT", "quick-login POST"]);
    expect(quickLogin).toHaveBeenCalledTimes(1);
    expect(quickLogin).toHaveBeenCalledWith({
      account_id: "20002",
      expected_settings_revision: 6,
    });
    expect(updateTransport).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(updateResources).not.toHaveBeenCalled();
    expect(store.getState().qqSettings).toEqual(savedSettings);
    expect(store.getState().qqInputs.connection).toEqual({
      ...connectionDraft,
      source: savedSettings,
    });
    expect(store.getState().qqManagedStatus).toEqual(waitingConfirm);
    expect(store.getState().qqManagedSaving).toBe(false);
    expect(store.getState().qqAccessSaving).toBe(false);
  });

  it("does not quick-login or save transport when the changed account settings CAS returns 409", async () => {
    const conflict = Object.assign(new Error("Account settings conflict"), { status: 409 });
    const updateSettings = vi.fn(async () => {
      throw conflict;
    });
    const quickLogin = vi.fn();
    const updateTransport = vi.fn();
    const updateConfig = vi.fn();
    const updateResources = vi.fn();
    const connectionDraft = {
      source: mockQqSettings,
      accountId: "20002",
      endpoint: "ws://127.0.0.1:4002",
      token: "synthetic-unsaved-token",
    };
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        updateQqSettings: updateSettings,
        updateQqTransport: updateTransport,
        updateQqManagedConfig: updateConfig,
        updateQqManagedResources: updateResources,
        quickLoginQqManaged: quickLogin,
      },
      qqSettings: mockQqSettings,
      qqInputs: { ...store.getState().qqInputs, connection: connectionDraft },
      qqManagedResources: mockResourceSnapshot,
      qqManagedAccounts: mockAccounts.accounts,
      qqManagedAccountsLoaded: true,
      qqManagedStatus: {
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: false,
        network_apply: "pending",
        transport_phase: "idle",
        diagnostic_code: null,
      },
    });

    await discoverQuickLoginAccounts();
    expect(await store.getState().quickLoginQqManaged("20002")).toBe(false);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ account_id: "20002", expected_revision: 5 });
    expect(quickLogin).not.toHaveBeenCalled();
    expect(updateTransport).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(updateResources).not.toHaveBeenCalled();
    expect(store.getState().qqSettings).toEqual(mockQqSettings);
    expect(store.getState().qqInputs.connection).toEqual(connectionDraft);
    expect(store.getState().error).toBe(conflict.message);
    expect(store.getState().qqManagedSaving).toBe(false);
    expect(store.getState().qqAccessSaving).toBe(false);
  });

  it("executes quick-login for the selected saved account only after explicit runtime/account discovery", async () => {
    const waitingConfirm: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "waiting_confirm",
      core_ready: false,
      network_apply: "pending",
      transport_phase: "idle",
      diagnostic_code: null,
    };
    const quickLoginSpy = vi.fn(async (): Promise<QqManagedStatus> => waitingConfirm);

    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        quickLoginQqManaged: quickLoginSpy,
      },
      qqSettings: mockQqSettings,
      qqManagedResources: mockResourceSnapshot,
      qqManagedAccounts: mockAccounts.accounts,
      qqManagedAccountsLoaded: true,
      qqManagedStatus: {
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: false,
        network_apply: "pending",
        transport_phase: "idle",
        diagnostic_code: null,
      },
    });

    await discoverQuickLoginAccounts();
    const success = await store.getState().quickLoginQqManaged("10001");
    expect(success).toBe(true);
    expect(quickLoginSpy).toHaveBeenCalledWith({
      account_id: "10001",
      expected_settings_revision: mockQqSettings.revision,
    });
    expect(store.getState().qqManagedStatus).toEqual(waitingConfirm);
  });

  it.each([
    [
      "runtime resources are not ready",
      { resources: { ...mockResourceSnapshot, status: "missing" as const } },
    ],
    ["account list is unknown", { accountsLoaded: false }],
    [
      "account is absent from the explicit list",
      { accounts: [{ account_id: "20002", display_name: null }] },
    ],
    [
      "account is already logged in",
      {
        status: {
          process: "running" as const,
          apply: "ready" as const,
          ownership: "owned" as const,
          phase: "core_online" as const,
          core_ready: true,
          network_apply: "pending" as const,
          transport_phase: "ready" as const,
          diagnostic_code: null,
        },
      },
    ],
    [
      "runtime is externally owned",
      {
        status: {
          process: "running" as const,
          apply: "ready" as const,
          ownership: "external" as const,
          phase: "waiting_scan" as const,
          core_ready: false,
          network_apply: "not_owned" as const,
          transport_phase: "idle" as const,
          diagnostic_code: null,
        },
      },
    ],
  ] as const)("does not quick-login when %s", async (_reason, override) => {
    const quickLoginSpy = vi.fn();
    store.setState({
      apiClient: { ...store.getState().apiClient, quickLoginQqManaged: quickLoginSpy },
      qqSettings: mockQqSettings,
      qqManagedResources: "resources" in override ? override.resources : mockResourceSnapshot,
      qqManagedAccounts: "accounts" in override ? [...override.accounts] : mockAccounts.accounts,
      qqManagedAccountsLoaded: "accountsLoaded" in override ? override.accountsLoaded : true,
      qqManagedStatus:
        "status" in override
          ? override.status
          : {
              process: "running",
              apply: "ready",
              ownership: "owned",
              phase: "waiting_scan",
              core_ready: false,
              network_apply: "pending",
              transport_phase: "idle",
              diagnostic_code: null,
            },
    });

    await discoverQuickLoginAccounts(true);
    expect(await store.getState().quickLoginQqManaged("10001")).toBe(false);
    expect(quickLoginSpy).not.toHaveBeenCalled();
  });

  it("rejects quick-login when the requested account is not the saved selected account", async () => {
    const quickLoginSpy = vi.fn();
    store.setState({
      apiClient: { ...store.getState().apiClient, quickLoginQqManaged: quickLoginSpy },
      qqSettings: { ...mockQqSettings, account_id: "20002" },
      qqManagedResources: mockResourceSnapshot,
      qqManagedAccounts: mockAccounts.accounts,
      qqManagedAccountsLoaded: true,
      qqManagedStatus: {
        process: "running",
        apply: "ready",
        ownership: "owned",
        phase: "waiting_scan",
        core_ready: false,
        network_apply: "pending",
        transport_phase: "idle",
        diagnostic_code: null,
      },
    });

    await discoverQuickLoginAccounts();
    expect(await store.getState().quickLoginQqManaged("10001")).toBe(false);
    expect(quickLoginSpy).not.toHaveBeenCalled();
  });
});

describe("QQ accounts shared read eligibility and cancellation", () => {
  const owned: QqManagedStatus = {
    apply: "ready",
    process: "running",
    ownership: "owned",
    phase: "waiting_scan",
    core_ready: false,
    network_apply: "pending",
    transport_phase: "idle",
    diagnostic_code: null,
  };
  const readyResources: QqManagedResourceSnapshot = {
    revision: "accounts-runtime",
    status: "ready",
    root: "C:/synthetic-runtime",
    diagnostic_code: null,
  };
  const accounts: QqManagedAccounts = {
    accounts: [{ account_id: "10001", display_name: "Synthetic" }],
  };
  const bind = (overrides: Partial<typeof api> = {}) => {
    const client = {
      ...store.getState().apiClient,
      getQqManagedStatus: async () => owned,
      getQqManagedConfig: async () => savedManagedConfig,
      getQqManagedResources: async () => readyResources,
      listQqManagedAccounts: vi.fn(async () => accounts),
      ...overrides,
    };
    store.getState().resetForTests(client);
    store.setState({ qqSettings: mockQqSettings, qqConnection: mockQqConnection });
    return client;
  };
  const prerequisites = async () => {
    await Promise.all([
      store.getState().loadQqManaged(),
      store.getState().loadQqManagedResources(),
    ]);
  };

  it.each([
    ["blocked", mockManagedStatus, savedManagedConfig, readyResources],
    ["ready but unowned", { ...owned, ownership: "none" }, savedManagedConfig, readyResources],
    ["external", { ...owned, ownership: "external" }, savedManagedConfig, readyResources],
    ["disabled", { ...owned, process: "disabled" }, savedManagedConfig, readyResources],
    [
      "starting",
      { ...owned, process: "starting", phase: "starting" },
      savedManagedConfig,
      readyResources,
    ],
    [
      "challenge has no credential",
      { ...owned, phase: "challenge" },
      savedManagedConfig,
      readyResources,
    ],
    ["saved off", owned, mockManagedConfig, readyResources],
    [
      "missing resources",
      owned,
      savedManagedConfig,
      { ...readyResources, status: "missing", root: null },
    ],
  ] as const)(
    "does zero accounts network work for %s without treating it as an empty list",
    async (_label, status, config, resources) => {
      const list = vi.fn(async () => accounts);
      bind({
        getQqManagedStatus: async () => status,
        getQqManagedConfig: async () => config,
        getQqManagedResources: async () => resources,
        listQqManagedAccounts: list,
      });
      await store.getState().loadQqManagedAccounts();
      expect(store.getState().qqManagedAccountsAvailability).toBe("unknown");
      await prerequisites();
      await store.getState().loadQqManagedAccounts();
      expect(list).not.toHaveBeenCalled();
      expect(store.getState()).toMatchObject({
        qqManagedAccountsAvailability: "unavailable",
        qqManagedAccountsLoaded: false,
        qqManagedAccountsError: null,
      });
    },
  );

  it("uses one network read for concurrent consumers and aborts only after the last release", async () => {
    const response = deferred<QqManagedAccounts>();
    let signal: AbortSignal | undefined;
    const list = vi.fn((input?: AbortSignal) => {
      signal = input;
      return response.promise;
    });
    bind({ listQqManagedAccounts: list });
    await prerequisites();
    const first = {},
      second = {};
    const reads = [
      store.getState().acquireQqManagedAccounts(first),
      store.getState().acquireQqManagedAccounts(second),
    ];
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    store.getState().releaseQqManagedAccounts(first);
    expect(signal?.aborted).toBe(false);
    store.getState().releaseQqManagedAccounts(second);
    expect(signal?.aborted).toBe(true);
    await Promise.all(reads);
    response.resolve(accounts);
    await act(async () => {});
    expect(store.getState()).toMatchObject({
      qqManagedAccountsLoaded: false,
      qqManagedAccountsLoading: false,
      qqManagedAccountsError: null,
    });
  });

  it.each(["success", "failure"] as const)(
    "discards an off/on ABA late %s, then reads the recovered owner",
    async (outcome) => {
      const old = deferred<QqManagedAccounts>();
      let signal: AbortSignal | undefined;
      let status = owned;
      const list = vi
        .fn()
        .mockImplementationOnce((input?: AbortSignal) => {
          signal = input;
          return old.promise;
        })
        .mockResolvedValue(accounts);
      bind({ listQqManagedAccounts: list, getQqManagedStatus: async () => status });
      await prerequisites();
      const owner = {};
      const pending = store.getState().acquireQqManagedAccounts(owner);
      await act(async () => {});
      status = { ...owned, ownership: "none", process: "stopped", phase: "stopped" };
      await store.getState().refreshQqManaged();
      expect(signal?.aborted).toBe(true);
      expect(store.getState().qqManagedAccountsAvailability).toBe("unavailable");
      status = owned;
      await store.getState().refreshQqManaged();
      await act(async () => {});
      if (outcome === "success")
        old.resolve({ accounts: [{ account_id: "99999", display_name: "Old" }] });
      else old.reject(new Error("old accounts failure"));
      await pending;
      await act(async () => {});
      expect(list).toHaveBeenCalledTimes(2);
      expect(store.getState()).toMatchObject({
        qqManagedAccounts: accounts.accounts,
        qqManagedAccountsLoaded: true,
        qqManagedAccountsError: null,
      });
      store.getState().releaseQqManagedAccounts(owner);
    },
  );

  it.each(["API", "lifecycle"] as const)(
    "aborts the old %s consumer and rejects a late adapter result",
    async (boundary) => {
      const old = deferred<QqManagedAccounts>();
      let signal: AbortSignal | undefined;
      const list = vi.fn((input?: AbortSignal) => {
        signal = input;
        return old.promise;
      });
      const client = bind({ listQqManagedAccounts: list });
      await prerequisites();
      const owner = {};
      const pending = store.getState().acquireQqManagedAccounts(owner);
      await act(async () => {});
      if (boundary === "API")
        store.setState({ apiClient: { ...client, listQqManagedAccounts: async () => accounts } });
      else store.getState().resetForTests(client);
      store.getState().releaseQqManagedAccounts(owner);
      expect(signal?.aborted).toBe(true);
      old.resolve({ accounts: [{ account_id: "99999", display_name: "stale" }] });
      await pending;
      await act(async () => {});
      expect(store.getState()).toMatchObject({
        qqManagedAccountsLoaded: false,
        qqManagedAccountsLoading: false,
        qqManagedAccountsError: null,
      });
    },
  );

  it("keeps active=false silent, refreshes current eligibility once, and preserves unsaved drafts", async () => {
    let status: QqManagedStatus = {
      ...owned,
      ownership: "none",
      process: "stopped",
      phase: "stopped",
    };
    const getStatus = vi.fn(async () => status);
    const list = vi.fn(async () => accounts);
    bind({ getQqManagedStatus: getStatus, listQqManagedAccounts: list });
    const view = render(<QqConnectionTab active={false} />);
    await act(async () => {});
    expect(getStatus).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    view.rerender(<QqConnectionTab active />);
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
    store.getState().patchQqManagedDraft(false);
    store.getState().patchQqManagedResourceDraft("D:/unsaved-runtime");
    const draft = store.getState().qqInputs.managedResources?.root;
    status = owned;
    fireEvent.click(screen.getByRole("button", { name: translate("connections.refreshState") }));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().qqInputs.managed?.enabled).toBe(false);
    expect(store.getState().qqInputs.managedResources?.root).toBe(draft);
    view.rerender(<QqConnectionTab active={false} />);
    await act(async () => {});
    expect(store.getState().qqManagedAccountsLoaded).toBe(false);
  });

  it("invalidates discovered accounts during managed config writes and recovers only after current status", async () => {
    const write = deferred<QqManagedConfigSnapshot>();
    let status = owned;
    const list = vi.fn(async () => accounts);
    bind({
      listQqManagedAccounts: list,
      updateQqManagedConfig: async () => write.promise,
      getQqManagedStatus: async () => status,
    });
    await prerequisites();
    const owner = {};
    await store.getState().acquireQqManagedAccounts(owner);
    expect(list).toHaveBeenCalledTimes(1);
    store.getState().patchQqManagedDraft(false);
    const save = store.getState().saveQqManagedConfig();
    expect(store.getState().qqManagedAccountsLoaded).toBe(false);
    status = { ...owned, ownership: "none", process: "stopped", phase: "stopped" };
    write.resolve(mockManagedConfig);
    expect(await save).toBe(true);
    expect(store.getState().qqManagedAccountsAvailability).toBe("unavailable");
    expect(list).toHaveBeenCalledTimes(1);
    status = owned;
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getQqManagedConfig: async () => savedManagedConfig,
      },
    });
    await prerequisites();
    const nextOwner = {};
    await store.getState().acquireQqManagedAccounts(nextOwner);
    expect(list).toHaveBeenCalledTimes(2);
    store.getState().releaseQqManagedAccounts(nextOwner);
    store.getState().releaseQqManagedAccounts(owner);
  });

  it("preserves quick-login CAS-first ordering while rediscovering the changed connection owner", async () => {
    const order: string[] = [];
    const login = vi.fn(async () => {
      order.push("quick-login");
      return { ...owned, phase: "waiting_confirm" as const };
    });
    const readStatus = vi.fn(async () => {
      order.push("status");
      return owned;
    });
    const list = vi.fn(async () => {
      order.push("accounts");
      return { accounts: [{ account_id: "20002", display_name: null }] };
    });
    const put = vi.fn(async () => {
      order.push("settings");
      return { ...mockQqSettings, account_id: "20002", revision: 6 };
    });
    bind({
      getQqManagedStatus: readStatus,
      listQqManagedAccounts: list,
      updateQqSettings: put,
      quickLoginQqManaged: login,
    });
    await prerequisites();
    await store.getState().loadQqManagedAccounts();
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        connection: {
          source: mockQqSettings,
          accountId: "20002",
          endpoint: "ws://unsaved",
          token: "unsaved-token",
        },
      },
    });
    order.length = 0;
    expect(await store.getState().quickLoginQqManaged("20002")).toBe(true);
    expect(order).toEqual(["settings", "status", "accounts", "quick-login"]);
    expect(login).toHaveBeenCalledWith({ account_id: "20002", expected_settings_revision: 6 });
    expect(store.getState().qqInputs.connection?.endpoint).toBe("ws://unsaved");
    expect(store.getState().qqInputs.connection?.token).toBe("unsaved-token");
  });

  it("waits for shared pending account rediscovery after CAS without another GET or early login", async () => {
    const rediscovery = deferred<QqManagedAccounts>();
    const selectedAccounts: QqManagedAccounts = {
      accounts: [{ account_id: "20002", display_name: null }],
    };
    const order: string[] = [];
    const list = vi
      .fn(async () => {
        order.push("accounts:explicit-after-login");
        return selectedAccounts;
      })
      .mockImplementationOnce(async () => {
        order.push("accounts:initial");
        return selectedAccounts;
      })
      .mockImplementationOnce(() => {
        order.push("accounts:after-CAS");
        return rediscovery.promise;
      });
    const login = vi.fn(async () => {
      const status = store.getState().qqManagedStatus;
      order.push(`POST:${status?.apply === "ready" ? status.phase : "blocked"}`);
      return { ...owned, phase: "waiting_confirm" as const };
    });
    bind({
      listQqManagedAccounts: list,
      updateQqSettings: async () => {
        order.push("CAS");
        return { ...mockQqSettings, account_id: "20002", revision: 6 };
      },
      quickLoginQqManaged: login,
    });
    await prerequisites();
    const owner = {};
    await store.getState().acquireQqManagedAccounts(owner);
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        connection: { source: mockQqSettings, accountId: "20002", endpoint: "", token: "" },
      },
    });
    let settled = false;
    const pendingLogin = store
      .getState()
      .quickLoginQqManaged("20002")
      .then((result) => {
        settled = true;
        return result;
      });
    await act(async () => {});
    expect(store.getState().qqSettings?.revision).toBe(6);
    expect(store.getState().qqManagedAccountsLoading).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(order).toEqual(["accounts:initial", "CAS", "accounts:after-CAS"]);
    rediscovery.resolve(selectedAccounts);
    expect(await pendingLogin).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledExactlyOnceWith({
      account_id: "20002",
      expected_settings_revision: 6,
    });
    expect(order).toEqual(["accounts:initial", "CAS", "accounts:after-CAS", "POST:waiting_scan"]);
    expect(store.getState()).toMatchObject({
      qqManagedStatus: { phase: "waiting_confirm" },
      qqManagedAccounts: [],
      qqManagedAccountsLoaded: false,
      qqManagedAccountsLoading: false,
      qqManagedAccountsAvailability: "available",
      qqManagedAccountsError: null,
    });
    await store.getState().loadQqManagedAccounts();
    expect(list).toHaveBeenCalledTimes(3);
    expect(order.at(-1)).toBe("accounts:explicit-after-login");
    expect(store.getState().qqManagedAccountsLoaded).toBe(true);
    store.getState().releaseQqManagedAccounts(owner);
  });

  it("keeps a failed quick login visible and recovers discovery through current status before retry", async () => {
    const list = vi.fn(async () => ({
      accounts: [{ account_id: "10001", display_name: null }],
    }));
    const login = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 quick login unavailable"))
      .mockResolvedValueOnce({ ...owned, phase: "waiting_confirm" as const });
    bind({ listQqManagedAccounts: list, quickLoginQqManaged: login });
    await prerequisites();
    const owner = {};
    await store.getState().acquireQqManagedAccounts(owner);
    expect(await store.getState().quickLoginQqManaged("10001")).toBe(false);
    expect(store.getState().qqManagedError).toBe("HTTP 503 quick login unavailable");
    expect(store.getState().qqManagedAccountsLoaded).toBe(false);
    expect(store.getState().qqManagedAccountsLoading).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    await store.getState().refreshQqManaged();
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(await store.getState().quickLoginQqManaged("10001")).toBe(true);
    expect(login).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.getState().qqManagedStatus).toMatchObject({ phase: "waiting_confirm" });
    expect(store.getState().qqManagedAccountsLoaded).toBe(false);
    expect(store.getState().qqManagedError).toBeNull();
    store.getState().releaseQqManagedAccounts(owner);
  });

  it.each(["choice", "API", "lifecycle"] as const)(
    "rejects %s replacement while account CAS is pending",
    async (replacement) => {
      const write = deferred<QqSettingsResponse>();
      const login = vi.fn();
      const client = bind({
        listQqManagedAccounts: async () => ({
          accounts: [{ account_id: "20002", display_name: null }],
        }),
        updateQqSettings: () => write.promise,
        quickLoginQqManaged: login,
      });
      await prerequisites();
      await store.getState().loadQqManagedAccounts();
      store.setState({
        qqInputs: {
          ...store.getState().qqInputs,
          connection: {
            source: mockQqSettings,
            accountId: "20002",
            endpoint: "",
            token: "",
          },
        },
      });
      const pending = store.getState().quickLoginQqManaged("20002");
      if (replacement === "choice")
        store.setState({
          qqInputs: {
            ...store.getState().qqInputs,
            connection: { ...store.getState().qqInputs.connection!, accountId: "30003" },
          },
        });
      else if (replacement === "API") store.setState({ apiClient: { ...client } });
      else store.getState().resetForTests(client);
      write.resolve({ ...mockQqSettings, account_id: "20002", revision: 6 });
      expect(await pending).toBe(false);
      expect(login).not.toHaveBeenCalled();
    },
  );

  it("does not call quick-login or pretend success when rediscovery after CAS fails", async () => {
    const login = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ accounts: [{ account_id: "20002", display_name: null }] })
      .mockRejectedValueOnce(new Error("HTTP 503 after account CAS"));
    bind({
      listQqManagedAccounts: list,
      updateQqSettings: async () => ({ ...mockQqSettings, account_id: "20002", revision: 6 }),
      quickLoginQqManaged: login,
    });
    await prerequisites();
    await store.getState().loadQqManagedAccounts();
    store.setState({
      qqInputs: {
        ...store.getState().qqInputs,
        connection: {
          source: mockQqSettings,
          accountId: "20002",
          endpoint: "",
          token: "",
        },
      },
    });
    expect(await store.getState().quickLoginQqManaged("20002")).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(store.getState().qqSettings?.revision).toBe(6);
    expect(store.getState().qqManagedAccountsError).toBe("HTTP 503 after account CAS");
  });

  it("rejects quick login using account discovery from a replaced API", async () => {
    const quickLogin = vi.fn();
    bind({ quickLoginQqManaged: quickLogin });
    await prerequisites();
    await store.getState().loadQqManagedAccounts();
    store.setState({ apiClient: { ...store.getState().apiClient } });
    expect(await store.getState().quickLoginQqManaged("10001")).toBe(false);
    expect(quickLogin).not.toHaveBeenCalled();
  });

  it("reconciles retry status and a saved resource path through the same account owner", async () => {
    const list = vi.fn(async () => accounts);
    const retry = vi.fn(async () => owned);
    const saveResources = vi.fn(async () => ({
      ...readyResources,
      revision: "resource-after-save",
      root: "D:/next-runtime",
    }));
    bind({
      listQqManagedAccounts: list,
      retryQqManaged: retry,
      updateQqManagedResources: saveResources,
    });
    await prerequisites();
    const owner = {};
    await store.getState().acquireQqManagedAccounts(owner);
    expect(list).toHaveBeenCalledTimes(1);
    expect(await store.getState().retryQqManaged()).toBe(true);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    store.getState().patchQqManagedResourceDraft("D:/next-runtime");
    expect(await store.getState().saveQqManagedResources()).toBe(true);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(3);
    expect(store.getState().qqInputs.managedResources).toBeNull();
    store.getState().releaseQqManagedAccounts(owner);
  });

  it("renders real query failure, retries independently, and never starts a managed write", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 accounts unavailable"))
      .mockResolvedValue({ accounts: [] });
    const retryManaged = vi.fn();
    const client = bind({ listQqManagedAccounts: list, retryQqManaged: retryManaged });
    render(<QqConnectionTab />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("HTTP 503 accounts unavailable");
    fireEvent.click(
      screen.getByRole("button", {
        name: translate("connections.managed.quickLogin.refreshAccounts"),
      }),
    );
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(retryManaged).not.toHaveBeenCalled();
    expect(store.getState().qqManagedAccountsLoaded).toBe(true);
    expect(
      screen.getByText(translate("connections.managed.quickLogin.emptyAccounts")),
    ).toBeTruthy();
    expect(client).toBe(store.getState().apiClient);
  });

  it("aborts on task leave and hidden, revalidates once on return, and ignores blur", async () => {
    const responses = [
      deferred<QqManagedAccounts>(),
      deferred<QqManagedAccounts>(),
      deferred<QqManagedAccounts>(),
    ];
    const signals: AbortSignal[] = [];
    const list = vi.fn((signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return responses[signals.length - 1].promise;
    });
    bind({ listQqManagedAccounts: list });
    const view = render(<QqConnectionTab />);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    expect(signals[0].aborted).toBe(false);
    view.rerender(<QqConnectionTab task="events" />);
    await act(async () => {});
    expect(signals[0].aborted).toBe(true);
    view.rerender(<QqConnectionTab task="connection" />);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(signals[1].aborted).toBe(true);
    hidden.mockReturnValue(false);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(3);
    responses[0].resolve({ accounts: [{ account_id: "99999", display_name: "old" }] });
    responses[1].reject(new Error("hidden old failure"));
    responses[2].resolve(accounts);
    await act(async () => {});
    expect(store.getState()).toMatchObject({
      qqManagedAccounts: accounts.accounts,
      qqManagedAccountsError: null,
    });
    hidden.mockRestore();
    visibility.mockRestore();
  });
});
