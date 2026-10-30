import type {
  QqManagedAccounts,
  QqManagedConfigSnapshot,
  QqManagedQr,
  QqManagedResourceSnapshot,
  QqManagedStatus,
} from "../../../shared/contracts/qq-managed";
import type { SuperstringApi } from "../../api";
import { msg } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";

export type QqManagedAccountsAvailability = "unknown" | "unavailable" | "available";

type ManagedReadOwner = { api: SuperstringApi; lifecycleId: number };

export interface QqManagedState {
  qqManagedConfig: QqManagedConfigSnapshot | null;
  qqManagedStatus: QqManagedStatus | null;
  qqManagedResources: QqManagedResourceSnapshot | null;
  qqManagedResourcesLoading: boolean;
  qqManagedResourcesReadId: number;
  qqManagedResourceError: string | null;
  qqManagedAccounts: QqManagedAccounts["accounts"];
  qqManagedAccountsLoaded: boolean;
  qqManagedAccountsLoading: boolean;
  qqManagedAccountsReadId: number;
  qqManagedAccountsError: string | null;
  qqManagedAccountsAvailability: QqManagedAccountsAvailability;
  qqManagedLoading: boolean;
  qqManagedSaving: boolean;
  qqManagedReadId: number;
  qqManagedError: string | null;
  qqManagedQrPayload: string | null;
  loadQqManaged: () => Promise<void>;
  loadQqManagedResources: () => Promise<void>;
  refreshQqManagedResources: () => Promise<void>;
  saveQqManagedResources: () => Promise<boolean>;
  patchQqManagedResourceDraft: (root: string) => void;
  loadQqManagedAccounts: () => Promise<void>;
  acquireQqManagedAccounts: (owner: object) => Promise<void>;
  releaseQqManagedAccounts: (owner: object) => void;
  beginQqManagedConnectionWrite: () => object;
  endQqManagedConnectionWrite: (owner: object, changed: boolean) => Promise<void>;
  quickLoginQqManaged: (accountId: string) => Promise<boolean>;
  saveQqManagedConfig: () => Promise<boolean>;
  refreshQqManaged: () => Promise<void>;
  patchQqManagedDraft: (enabled: boolean) => void;
  retryQqManaged: () => Promise<boolean>;
  getQqManagedQr: () => Promise<QqManagedQr | null>;
  refreshQqManagedQr: () => Promise<QqManagedQr | null>;
  clearQqManagedQr: () => void;
}

export const qqManagedInitial = {
  qqManagedConfig: null as QqManagedConfigSnapshot | null,
  qqManagedStatus: null as QqManagedStatus | null,
  qqManagedResources: null as QqManagedResourceSnapshot | null,
  qqManagedResourcesLoading: false,
  qqManagedResourcesReadId: 0,
  qqManagedResourceError: null as string | null,
  qqManagedAccounts: [] as QqManagedAccounts["accounts"],
  qqManagedAccountsLoaded: false,
  qqManagedAccountsLoading: false,
  qqManagedAccountsReadId: 0,
  qqManagedAccountsError: null as string | null,
  qqManagedAccountsAvailability: "unknown" as QqManagedAccountsAvailability,
  qqManagedLoading: false,
  qqManagedSaving: false,
  qqManagedReadId: 0,
  qqManagedError: null as string | null,
  qqManagedQrPayload: null as string | null,
};

function managedStatusPatch(status: QqManagedStatus) {
  const clearQr =
    status.apply === "blocked" || (status.apply === "ready" && status.phase !== "waiting_scan");
  return {
    qqManagedStatus: status,
    qqManagedError: null,
    ...(clearQr ? { qqManagedQrPayload: null } : {}),
  };
}

export function createQqManagedActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqManagedState,
  | "loadQqManaged"
  | "loadQqManagedResources"
  | "refreshQqManagedResources"
  | "saveQqManagedResources"
  | "patchQqManagedResourceDraft"
  | "loadQqManagedAccounts"
  | "acquireQqManagedAccounts"
  | "releaseQqManagedAccounts"
  | "beginQqManagedConnectionWrite"
  | "endQqManagedConnectionWrite"
  | "quickLoginQqManaged"
  | "saveQqManagedConfig"
  | "refreshQqManaged"
  | "patchQqManagedDraft"
  | "retryQqManaged"
  | "getQqManagedQr"
  | "refreshQqManagedQr"
  | "clearQqManagedQr"
> {
  let managedLoadInFlight: {
    promise: Promise<void>;
    api: SuperstringApi;
    readId: number;
    token: number;
    lifecycleId: number;
  } | null = null;
  let managedReadToken = 0;
  let managedResourceReadToken = 0;
  let managedAccountsReadToken = 0;
  let managedQrToken = 0;
  let managedResourcesLoadInFlight: {
    api: SuperstringApi;
    readId: number;
    token: number;
    lifecycleId: number;
    promise: Promise<void>;
  } | null = null;
  let managedAccountsLoadInFlight: {
    api: SuperstringApi;
    readId: number;
    token: number;
    lifecycleId: number;
    promise: Promise<void>;
    task: ReadTask | null;
    finish: () => void;
  } | null = null;
  const accountsConsumers = new Map<object, ManagedReadOwner>();
  let statusOwner: ManagedReadOwner | null = null;
  let resourcesOwner: ManagedReadOwner | null = null;
  let accountsOwner: ManagedReadOwner | null = null;
  let connectionWrite: {
    owner: object;
    api: SuperstringApi;
    lifecycleId: number;
    previousStatusOwner: ManagedReadOwner | null;
    previousAccountsOwner: ManagedReadOwner | null;
    accounts: QqManagedAccounts["accounts"];
    loaded: boolean;
    error: string | null;
    readToken: number;
    accountsToken: number;
  } | null = null;
  const beginManagedRead = () => {
    const state = get();
    managedReadToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqManagedReadId + 1,
      token: managedReadToken,
      lifecycleId: state.qqManagedLifecycleId,
    };
    suspendAccounts();
    statusOwner = null;
    set({ qqManagedReadId: operation.id });
    return operation;
  };
  const isCurrentManagedRead = (operation: ReturnType<typeof beginManagedRead>) =>
    get().qqManagedReadId === operation.id &&
    managedReadToken === operation.token &&
    get().qqManagedLifecycleId === operation.lifecycleId &&
    get().apiClient === operation.api;
  const invalidateManagedReads = () => {
    managedLoadInFlight = null;
    managedReadToken += 1;
    set({ qqManagedReadId: get().qqManagedReadId + 1, qqManagedLoading: false });
  };
  const invalidateManagedResourceReads = () => {
    managedResourcesLoadInFlight = null;
    managedResourceReadToken += 1;
    set({
      qqManagedResourcesReadId: get().qqManagedResourcesReadId + 1,
      qqManagedResourcesLoading: false,
    });
  };
  const invalidateManagedAccountsReads = (clear = false) => {
    const previous = managedAccountsLoadInFlight;
    managedAccountsLoadInFlight = null;
    previous?.task?.cancel();
    previous?.finish();
    managedAccountsReadToken += 1;
    if (clear) accountsOwner = null;
    set({
      qqManagedAccountsReadId: get().qqManagedAccountsReadId + 1,
      qqManagedAccountsLoading: false,
      ...(clear
        ? { qqManagedAccounts: [], qqManagedAccountsLoaded: false, qqManagedAccountsError: null }
        : {}),
    });
  };
  const suspendAccounts = () => {
    invalidateManagedAccountsReads(true);
    set({ qqManagedAccountsAvailability: "unknown" });
  };
  const accountsAvailability = (): QqManagedAccountsAvailability => {
    const state = get();
    const currentOwner = (owner: ManagedReadOwner | null) =>
      owner?.api === state.apiClient && owner.lifecycleId === state.qqManagedLifecycleId;
    if (
      !currentOwner(statusOwner) ||
      !currentOwner(resourcesOwner) ||
      state.qqManagedLoading ||
      state.qqManagedSaving ||
      (connectionWrite?.api === state.apiClient &&
        connectionWrite.lifecycleId === state.qqManagedLifecycleId) ||
      state.qqManagedResourcesLoading ||
      !state.qqManagedStatus ||
      !state.qqManagedConfig ||
      !state.qqManagedResources
    )
      return "unknown";
    const status = state.qqManagedStatus;
    // challenge explicitly clears the server credential. Other running phases may still
    // expose account control; credentials and in-flight operations remain server-owned.
    return state.qqManagedConfig.config.enabled &&
      state.qqManagedResources.status === "ready" &&
      !state.qqManagedResourceError &&
      status.apply === "ready" &&
      status.ownership === "owned" &&
      status.process === "running" &&
      status.phase !== "challenge"
      ? "available"
      : "unavailable";
  };
  const reconcileAccounts = (discover = true) => {
    const availability = accountsAvailability();
    if (availability !== "available") invalidateManagedAccountsReads(true);
    set({ qqManagedAccountsAvailability: availability });
    if (discover && availability === "available" && !document.hidden) {
      const state = get();
      if (
        !state.qqManagedAccountsLoaded &&
        !state.qqManagedAccountsError &&
        [...accountsConsumers.values()].some(
          (owner) =>
            owner.api === state.apiClient && owner.lifecycleId === state.qqManagedLifecycleId,
        )
      )
        void state.loadQqManagedAccounts();
    }
  };
  const statusPatch = (status: QqManagedStatus) => {
    statusOwner = { api: get().apiClient, lifecycleId: get().qqManagedLifecycleId };
    return managedStatusPatch(status);
  };
  const beginManagedResourceRead = () => {
    const state = get();
    managedResourceReadToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqManagedResourcesReadId + 1,
      token: managedResourceReadToken,
      lifecycleId: state.qqManagedLifecycleId,
    };
    suspendAccounts();
    resourcesOwner = null;
    set({ qqManagedResourcesReadId: operation.id });
    return operation;
  };
  const isCurrentManagedResourceRead = (operation: ReturnType<typeof beginManagedResourceRead>) =>
    get().qqManagedResourcesReadId === operation.id &&
    managedResourceReadToken === operation.token &&
    get().qqManagedLifecycleId === operation.lifecycleId &&
    get().apiClient === operation.api;
  const beginManagedAccountsRead = () => {
    const state = get();
    managedAccountsReadToken += 1;
    const operation = {
      api: state.apiClient,
      id: state.qqManagedAccountsReadId + 1,
      token: managedAccountsReadToken,
      lifecycleId: state.qqManagedLifecycleId,
    };
    set({ qqManagedAccountsReadId: operation.id });
    return operation;
  };
  const isCurrentManagedAccountsRead = (operation: ReturnType<typeof beginManagedAccountsRead>) =>
    get().qqManagedAccountsReadId === operation.id &&
    managedAccountsReadToken === operation.token &&
    get().qqManagedLifecycleId === operation.lifecycleId &&
    get().apiClient === operation.api &&
    accountsAvailability() === "available" &&
    !document.hidden;

  let managedWriteToken = 0;
  let currentManagedWriteOp: {
    token: number;
    api: SuperstringApi;
    lifecycleId: number;
  } | null = null;
  const beginManagedWrite = (changesStatus = true) => {
    suspendAccounts();
    if (changesStatus) statusOwner = null;
    managedWriteToken += 1;
    const op = {
      token: managedWriteToken,
      api: get().apiClient,
      lifecycleId: get().qqManagedLifecycleId,
    };
    currentManagedWriteOp = op;
    set({ qqManagedSaving: true, qqManagedError: null, error: null, feedback: "" });
    invalidateManagedReads();
    return op;
  };
  const isCurrentManagedWriteApi = (op: ReturnType<typeof beginManagedWrite>) =>
    currentManagedWriteOp?.token === op.token &&
    get().qqManagedLifecycleId === op.lifecycleId &&
    get().apiClient === op.api;
  const endManagedWrite = (op: ReturnType<typeof beginManagedWrite>, discoverAccounts = true) => {
    if (isCurrentManagedWriteApi(op)) {
      currentManagedWriteOp = null;
      set({ qqManagedSaving: false });
      reconcileAccounts(discoverAccounts);
    }
  };
  return {
    beginQqManagedConnectionWrite: () => {
      const state = get();
      const owner = {};
      const previousStatusOwner = statusOwner;
      const previousAccountsOwner = accountsOwner;
      suspendAccounts();
      statusOwner = null;
      invalidateManagedReads();
      connectionWrite = {
        owner,
        api: state.apiClient,
        lifecycleId: state.qqManagedLifecycleId,
        previousStatusOwner,
        previousAccountsOwner,
        accounts: state.qqManagedAccounts,
        loaded: state.qqManagedAccountsLoaded,
        error: state.qqManagedAccountsError,
        readToken: managedReadToken,
        accountsToken: managedAccountsReadToken,
      };
      return owner;
    },
    endQqManagedConnectionWrite: async (owner, changed) => {
      const write = connectionWrite;
      if (!write || write.owner !== owner) return;
      connectionWrite = null;
      const state = get();
      if (state.apiClient !== write.api || state.qqManagedLifecycleId !== write.lifecycleId) return;
      if (!changed) {
        if (
          write.readToken === managedReadToken &&
          write.accountsToken === managedAccountsReadToken
        ) {
          statusOwner = write.previousStatusOwner;
          accountsOwner = write.previousAccountsOwner;
          set({
            qqManagedAccounts: write.accounts,
            qqManagedAccountsLoaded: write.loaded,
            qqManagedAccountsError: write.error,
          });
        }
        reconcileAccounts();
        return;
      }
      if (
        !document.hidden &&
        [...accountsConsumers.values()].some(
          (consumer) => consumer.api === write.api && consumer.lifecycleId === write.lifecycleId,
        )
      )
        await state.loadQqManaged();
    },
    loadQqManagedResources: async () => {
      const state = get();
      const api = state.apiClient;
      if (
        managedResourcesLoadInFlight &&
        managedResourcesLoadInFlight.api === api &&
        managedResourcesLoadInFlight.readId === state.qqManagedResourcesReadId &&
        managedResourcesLoadInFlight.token === managedResourceReadToken &&
        managedResourcesLoadInFlight.lifecycleId === state.qqManagedLifecycleId
      )
        return managedResourcesLoadInFlight.promise;
      const operation = beginManagedResourceRead();
      set({ qqManagedResourcesLoading: true, qqManagedResourceError: null });
      const promise = (async () => {
        try {
          const resources = await operation.api.getQqManagedResources();
          if (!isCurrentManagedResourceRead(operation)) return;
          resourcesOwner = { api: operation.api, lifecycleId: operation.lifecycleId };
          set({
            qqManagedResources: resources,
            qqManagedResourcesLoading: false,
            qqManagedResourceError: null,
          });
          reconcileAccounts();
        } catch (error) {
          if (!isCurrentManagedResourceRead(operation)) return;
          set({ qqManagedResourcesLoading: false, qqManagedResourceError: errorText(error) });
        } finally {
          if (managedResourcesLoadInFlight?.token === operation.token)
            managedResourcesLoadInFlight = null;
        }
      })();
      managedResourcesLoadInFlight = {
        api,
        readId: operation.id,
        token: operation.token,
        lifecycleId: operation.lifecycleId,
        promise,
      };
      return promise;
    },
    refreshQqManagedResources: async () => {
      managedResourcesLoadInFlight = null;
      const operation = beginManagedResourceRead();
      set({ qqManagedResourcesLoading: true, qqManagedResourceError: null });
      try {
        const resources = await operation.api.getQqManagedResources();
        if (!isCurrentManagedResourceRead(operation)) return;
        resourcesOwner = { api: operation.api, lifecycleId: operation.lifecycleId };
        set((state) => {
          const draft = state.qqInputs.managedResources;
          return {
            qqManagedResources: resources,
            qqManagedResourcesLoading: false,
            qqManagedResourceError: null,
            qqInputs: {
              ...state.qqInputs,
              managedResources: draft
                ? {
                    source: resources,
                    root:
                      draft.root.trim() !== (draft.source.root ?? "")
                        ? draft.root
                        : (resources.root ?? ""),
                  }
                : null,
            },
          };
        });
        reconcileAccounts();
      } catch (error) {
        if (!isCurrentManagedResourceRead(operation)) return;
        set({ qqManagedResourcesLoading: false, qqManagedResourceError: errorText(error) });
      }
    },
    patchQqManagedResourceDraft: (root) => {
      const snapshot = get().qqManagedResources;
      const source = get().qqInputs.managedResources?.source ?? snapshot;
      if (!source) return;
      set((state) => ({
        qqInputs: {
          ...state.qqInputs,
          managedResources: { source, root },
        },
      }));
    },
    saveQqManagedResources: async () => {
      const draft = get().qqInputs.managedResources;
      if (!draft || get().qqManagedSaving || !draft.root.trim()) return false;
      const op = beginManagedWrite();
      invalidateManagedResourceReads();
      try {
        const saved = await op.api.updateQqManagedResources({
          expected_revision: draft.source.revision,
          root: draft.root.trim(),
        });
        if (!isCurrentManagedWriteApi(op)) return false;
        invalidateManagedResourceReads();
        invalidateManagedReads();
        managedQrToken += 1;
        resourcesOwner = { api: op.api, lifecycleId: op.lifecycleId };
        set((state) => ({
          qqManagedResources: saved,
          qqManagedResourceError: null,
          qqManagedStatus: null,
          qqManagedQrPayload: null,
          qqInputs: {
            ...state.qqInputs,
            managedResources:
              state.qqInputs.managedResources && state.qqInputs.managedResources !== draft
                ? { source: saved, root: state.qqInputs.managedResources.root }
                : null,
          },
          feedback: msg("已保存接入设置"),
        }));
        try {
          const status = await op.api.getQqManagedStatus();
          if (isCurrentManagedWriteApi(op)) set(statusPatch(status));
        } catch (error) {
          if (isCurrentManagedWriteApi(op)) set({ qqManagedError: errorText(error) });
        }
        return true;
      } catch (error) {
        if (isCurrentManagedWriteApi(op)) set({ qqManagedResourceError: errorText(error) });
        return false;
      } finally {
        endManagedWrite(op);
      }
    },
    acquireQqManagedAccounts: (owner) => {
      const state = get();
      if (
        managedAccountsLoadInFlight &&
        (managedAccountsLoadInFlight.api !== state.apiClient ||
          managedAccountsLoadInFlight.lifecycleId !== state.qqManagedLifecycleId)
      )
        suspendAccounts();
      for (const [consumer, identity] of accountsConsumers) {
        if (identity.api !== state.apiClient || identity.lifecycleId !== state.qqManagedLifecycleId)
          accountsConsumers.delete(consumer);
      }
      accountsConsumers.set(owner, {
        api: state.apiClient,
        lifecycleId: state.qqManagedLifecycleId,
      });
      if (state.qqManagedAccountsLoaded && accountsAvailability() === "available")
        return Promise.resolve();
      return state.loadQqManagedAccounts();
    },
    releaseQqManagedAccounts: (owner) => {
      const identity = accountsConsumers.get(owner);
      if (!identity) return;
      accountsConsumers.delete(owner);
      const state = get();
      if (identity.api !== state.apiClient || identity.lifecycleId !== state.qqManagedLifecycleId) {
        if (
          managedAccountsLoadInFlight?.api === identity.api &&
          managedAccountsLoadInFlight.lifecycleId === identity.lifecycleId
        )
          suspendAccounts();
        return;
      }
      if (
        ![...accountsConsumers.values()].some(
          (consumer) =>
            consumer.api === state.apiClient && consumer.lifecycleId === state.qqManagedLifecycleId,
        )
      ) {
        suspendAccounts();
        invalidateManagedReads();
        invalidateManagedResourceReads();
        statusOwner = null;
        resourcesOwner = null;
      }
    },
    loadQqManagedAccounts: async () => {
      const state = get();
      const api = state.apiClient;
      const availability = accountsAvailability();
      if (availability !== "available" || document.hidden) {
        invalidateManagedAccountsReads(true);
        set({ qqManagedAccountsAvailability: availability });
        return;
      }
      if (
        managedAccountsLoadInFlight &&
        managedAccountsLoadInFlight.api === api &&
        managedAccountsLoadInFlight.readId === state.qqManagedAccountsReadId &&
        managedAccountsLoadInFlight.token === managedAccountsReadToken &&
        managedAccountsLoadInFlight.lifecycleId === state.qqManagedLifecycleId
      )
        return managedAccountsLoadInFlight.promise;
      invalidateManagedAccountsReads();
      const operation = beginManagedAccountsRead();
      let finish!: () => void;
      const promise = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const pending = {
        ...operation,
        readId: operation.id,
        promise,
        task: null as ReadTask | null,
        finish,
      };
      managedAccountsLoadInFlight = pending;
      set({
        qqManagedAccountsAvailability: availability,
        qqManagedAccountsLoading: true,
        qqManagedAccountsError: null,
      });
      pending.task = startRead((signal) => operation.api.listQqManagedAccounts(signal), {
        success: (result) => {
          if (!isCurrentManagedAccountsRead(operation)) return;
          accountsOwner = { api: operation.api, lifecycleId: operation.lifecycleId };
          set({
            qqManagedAccounts: result.accounts,
            qqManagedAccountsLoaded: true,
            qqManagedAccountsError: null,
          });
        },
        failure: (error) => {
          if (!isCurrentManagedAccountsRead(operation)) return;
          set({
            qqManagedAccounts: [],
            qqManagedAccountsLoaded: false,
            qqManagedAccountsError: errorText(error),
          });
        },
        settled: () => {
          if (managedAccountsLoadInFlight !== pending) return;
          managedAccountsLoadInFlight = null;
          if (isCurrentManagedAccountsRead(operation)) set({ qqManagedAccountsLoading: false });
          finish();
        },
      });
      return promise;
    },
    quickLoginQqManaged: async (accountId) => {
      const currentAccounts = () =>
        accountsAvailability() === "available" &&
        get().qqManagedAccountsLoaded &&
        !get().qqManagedAccountsLoading &&
        !get().qqManagedAccountsError &&
        accountsOwner?.api === get().apiClient &&
        accountsOwner.lifecycleId === get().qqManagedLifecycleId;
      if (get().qqManagedSaving || !currentAccounts()) return false;
      const draft = get().qqInputs.connection;
      const settings = get().qqSettings;
      if (!settings || !get().qqManagedResources || get().qqManagedResources?.status !== "ready")
        return false;
      const targetAccount = draft ? draft.accountId.trim() : (settings.account_id ?? "");
      if (!targetAccount || targetAccount !== accountId) return false;
      const api = get().apiClient;
      const lifecycleId = get().qqManagedLifecycleId;
      const consumers = [...accountsConsumers.entries()];
      let savedAccount = false;
      const sameSelection = () => {
        const current = get();
        const selected = current.qqInputs.connection;
        return (
          current.apiClient === api &&
          current.qqManagedLifecycleId === lifecycleId &&
          consumers.every(([owner, identity]) => accountsConsumers.get(owner) === identity) &&
          (selected ? selected.accountId.trim() : current.qqSettings?.account_id) === accountId &&
          (draft
            ? !!selected && selected.endpoint === draft.endpoint && selected.token === draft.token
            : !selected)
        );
      };
      if (
        draft &&
        (draft.accountId.trim() !== (draft.source.account_id ?? "") ||
          settings.account_id !== accountId)
      ) {
        const saved = await get().saveQqSurface({ account_id: accountId }, draft.source.revision);
        if (!saved || !sameSelection()) return false;
        savedAccount = true;
        if (accountsAvailability() === "unknown") await get().loadQqManaged();
        if (!sameSelection()) return false;
        if (
          accountsAvailability() === "available" &&
          !get().qqManagedAccountsLoaded &&
          !get().qqManagedAccountsError
        )
          await get().loadQqManagedAccounts();
        if (!sameSelection()) return false;
        if (!currentAccounts()) {
          set({ qqManagedError: msg("操作失败，请重试。") });
          return false;
        }
      }
      const currentSettings = get().qqSettings;
      const currentDraft = get().qqInputs.connection;
      const status = get().qqManagedStatus;
      if (
        !currentAccounts() ||
        !currentSettings ||
        currentSettings.account_id !== accountId ||
        (currentDraft !== null && currentDraft.source.revision !== currentSettings.revision) ||
        !get().qqManagedAccountsLoaded ||
        !get().qqManagedAccounts.some((row) => row.account_id === accountId) ||
        status?.apply !== "ready" ||
        status.ownership !== "owned" ||
        status.process !== "running" ||
        status.phase !== "waiting_scan" ||
        get().qqManagedSaving
      ) {
        if (savedAccount) set({ qqManagedError: msg("操作失败，请重试。") });
        return false;
      }
      const op = beginManagedWrite();
      let loginSucceeded = false;
      try {
        const updated = await op.api.quickLoginQqManaged({
          account_id: accountId,
          expected_settings_revision: currentSettings.revision,
        });
        if (!isCurrentManagedWriteApi(op)) return false;
        invalidateManagedReads();
        const patch = statusPatch(updated);
        if ("qqManagedQrPayload" in patch) managedQrToken += 1;
        set(patch);
        loginSucceeded = true;
        return true;
      } catch (error) {
        if (isCurrentManagedWriteApi(op)) set({ qqManagedError: errorText(error) });
        return false;
      } finally {
        // Successful login changes the phase, not the local account catalog. Keep its
        // authority invalidated until an explicit read or status/resource revalidation.
        endManagedWrite(op, !loginSucceeded);
      }
    },
    loadQqManaged: async () => {
      const state = get();
      const api = state.apiClient;
      if (
        managedLoadInFlight &&
        managedLoadInFlight.api === api &&
        managedLoadInFlight.readId === state.qqManagedReadId &&
        managedLoadInFlight.token === managedReadToken &&
        managedLoadInFlight.lifecycleId === state.qqManagedLifecycleId
      ) {
        return managedLoadInFlight.promise;
      }
      const operation = beginManagedRead();
      set({ qqManagedLoading: true, qqManagedError: null });
      const promise = (async () => {
        try {
          const [status, config] = await Promise.all([
            operation.api.getQqManagedStatus(),
            operation.api.getQqManagedConfig(),
          ]);
          if (!isCurrentManagedRead(operation)) return;
          const patch = statusPatch(status);
          if ("qqManagedQrPayload" in patch) managedQrToken += 1;
          set({
            ...patch,
            qqManagedConfig: config,
            qqManagedLoading: false,
          });
          reconcileAccounts();
        } catch (error) {
          if (!isCurrentManagedRead(operation)) return;
          set({
            qqManagedLoading: false,
            qqManagedError: errorText(error),
          });
        } finally {
          if (managedLoadInFlight?.token === operation.token) {
            managedLoadInFlight = null;
          }
        }
      })();
      managedLoadInFlight = {
        promise,
        api,
        readId: operation.id,
        token: operation.token,
        lifecycleId: operation.lifecycleId,
      };
      return promise;
    },
    refreshQqManaged: async () => {
      managedLoadInFlight = null;
      const operation = beginManagedRead();
      set({ qqManagedLoading: true, qqManagedError: null });
      try {
        const [config, status] = await Promise.all([
          operation.api.getQqManagedConfig(),
          operation.api.getQqManagedStatus(),
        ]);
        if (!isCurrentManagedRead(operation)) return;
        const patch = statusPatch(status);
        if ("qqManagedQrPayload" in patch) managedQrToken += 1;
        set((state) => {
          const currentDraft = state.qqInputs.managed;
          return {
            ...patch,
            qqManagedConfig: config,
            qqManagedLoading: false,
            qqInputs: {
              ...state.qqInputs,
              managed: currentDraft
                ? {
                    source: config,
                    enabled:
                      currentDraft.enabled !== currentDraft.source.config.enabled
                        ? currentDraft.enabled
                        : config.config.enabled,
                  }
                : null,
            },
          };
        });
        reconcileAccounts();
      } catch (error) {
        if (!isCurrentManagedRead(operation)) return;
        set({ qqManagedLoading: false, qqManagedError: errorText(error) });
      }
    },
    saveQqManagedConfig: async () => {
      const draft = get().qqInputs.managed;
      if (!draft || get().qqManagedSaving) return false;
      const op = beginManagedWrite();
      try {
        const saved = await op.api.updateQqManagedConfig({
          expected_revision: draft.source.revision,
          config: { version: 1, enabled: draft.enabled },
        });
        if (!isCurrentManagedWriteApi(op)) return false;
        invalidateManagedReads();
        set((state) => ({
          qqManagedConfig: saved,
          qqInputs: {
            ...state.qqInputs,
            managed:
              state.qqInputs.managed && state.qqInputs.managed !== draft
                ? { source: saved, enabled: state.qqInputs.managed.enabled }
                : null,
          },
          feedback: msg("已保存接入设置"),
        }));
        try {
          const status = await op.api.getQqManagedStatus();
          if (isCurrentManagedWriteApi(op)) {
            const patch = statusPatch(status);
            if ("qqManagedQrPayload" in patch) managedQrToken += 1;
            set(patch);
          }
        } catch (statusError) {
          if (isCurrentManagedWriteApi(op)) {
            set({ qqManagedError: errorText(statusError) });
          }
        }
        return true;
      } catch (error) {
        if (isCurrentManagedWriteApi(op)) {
          set({ qqManagedError: errorText(error) });
        }
        return false;
      } finally {
        endManagedWrite(op);
      }
    },
    patchQqManagedDraft: (enabled: boolean) => {
      const config = get().qqManagedConfig;
      const source = get().qqInputs.managed?.source ?? config;
      if (!source) return;
      set((state) => ({
        qqInputs: {
          ...state.qqInputs,
          managed: { source, enabled },
        },
      }));
    },
    retryQqManaged: async () => {
      if (get().qqManagedSaving) return false;
      const op = beginManagedWrite();
      try {
        const status = await op.api.retryQqManaged();
        if (!isCurrentManagedWriteApi(op)) return false;
        invalidateManagedReads();
        const patch = statusPatch(status);
        if ("qqManagedQrPayload" in patch) managedQrToken += 1;
        set(patch);
        return true;
      } catch (error) {
        if (isCurrentManagedWriteApi(op)) {
          set({ qqManagedError: errorText(error) });
        }
        return false;
      } finally {
        endManagedWrite(op);
      }
    },
    getQqManagedQr: async () => {
      if (get().qqManagedSaving) return null;
      managedQrToken += 1;
      const currentToken = managedQrToken;
      const op = beginManagedWrite(false);
      try {
        const qr = await op.api.getQqManagedQr();
        if (!isCurrentManagedWriteApi(op) || managedQrToken !== currentToken) return null;
        const currentStatus = get().qqManagedStatus;
        const canAccept =
          currentStatus?.apply === "ready" && currentStatus.phase === "waiting_scan";
        if (canAccept) {
          set({ qqManagedQrPayload: qr.qr_payload, qqManagedError: null });
        }
        return qr;
      } catch (error) {
        if (isCurrentManagedWriteApi(op) && managedQrToken === currentToken) {
          set({ qqManagedError: errorText(error) });
        }
        return null;
      } finally {
        endManagedWrite(op);
      }
    },
    refreshQqManagedQr: async () => {
      if (get().qqManagedSaving) return null;
      managedQrToken += 1;
      const currentToken = managedQrToken;
      const op = beginManagedWrite(false);
      try {
        const qr = await op.api.refreshQqManagedQr();
        if (!isCurrentManagedWriteApi(op) || managedQrToken !== currentToken) return null;
        const currentStatus = get().qqManagedStatus;
        const canAccept =
          currentStatus?.apply === "ready" && currentStatus.phase === "waiting_scan";
        if (canAccept) {
          set({ qqManagedQrPayload: qr.qr_payload, qqManagedError: null });
        }
        return qr;
      } catch (error) {
        if (isCurrentManagedWriteApi(op) && managedQrToken === currentToken) {
          set({ qqManagedError: errorText(error) });
        }
        return null;
      } finally {
        endManagedWrite(op);
      }
    },
    clearQqManagedQr: () => {
      managedQrToken += 1;
      set({ qqManagedQrPayload: null });
    },
  };
}
