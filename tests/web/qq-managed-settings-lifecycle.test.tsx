import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSettingsResponse, QqStatusResponse } from "../../src/shared/contracts/qq";
import type {
  QqManagedConfigSnapshot,
  QqManagedQr,
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
      transport_phase: "closed",
      diagnostic_code: "control_unavailable",
    };
    const retriedStatus: QqManagedStatus = {
      process: "running",
      apply: "ready",
      ownership: "owned",
      phase: "core_online",
      core_ready: true,
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
