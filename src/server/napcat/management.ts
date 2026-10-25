import {
  type QqManagedAccounts,
  type QqManagedConfig,
  type QqManagedConfigSnapshot,
  type QqManagedQr,
  QqManagedQrSchema,
  type QqManagedQuickLoginRequest,
  type QqManagedResourceSnapshot,
  type QqManagedStatus,
  type UpdateQqManagedResourcesRequest,
} from "../../shared/contracts/qq-managed";
import type { FileNapCatConfigStore } from "./config";
import {
  deriveNapCatTokenHash,
  type NapCatControlClient,
  NapCatControlError,
} from "./control-client";
import { mergeNapCatOneBotConfig, verifyNapCatOneBotConfig } from "./onebot-config";
import type { NapCatRuntimeManager, NapCatRuntimeStartInput } from "./runtime-manager";

export interface NapCatManagementPort {
  readConfig(): QqManagedConfigSnapshot;
  replaceConfig(expectedRevision: string, config: QqManagedConfig): QqManagedConfigSnapshot;
  snapshot(): QqManagedStatus;
}

/** A preference remains writable when no runtime has been provisioned. */
export function createNapCatManagement(
  store: Pick<FileNapCatConfigStore, "read" | "replace">,
): NapCatManagementPort {
  return {
    readConfig: () => store.read(),
    replaceConfig: (expectedRevision, config) => store.replace(expectedRevision, config),
    snapshot: () => ({
      process: "unavailable",
      apply: "blocked",
      unavailable_reason: "native_validation_required",
    }),
  };
}

export interface NapCatManagedSession extends NapCatManagementPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  retry(): Promise<void>;
  getQr(): Promise<QqManagedQr>;
  refreshQr(): Promise<QqManagedQr>;
  readResources(): QqManagedResourceSnapshot;
  prepareResources(input: UpdateQqManagedResourcesRequest): Promise<QqManagedResourceSnapshot>;
  listAccounts(): Promise<QqManagedAccounts>;
  quickLogin(input: QqManagedQuickLoginRequest): Promise<void>;
}

export interface NapCatManagedRuntime {
  readonly client: NapCatControlClient;
  readonly launch: NapCatRuntimeStartInput;
  readonly token: string;
}

type ActualStatus = Extract<QqManagedStatus, { apply: "ready" }>;
type LoginStatus = Awaited<ReturnType<NapCatControlClient["checkLoginStatus"]>>;

export interface NapCatConnectionSettings {
  readonly revision: number;
  readonly enabled: boolean;
  readonly accountId: string | null;
  readonly endpoint: string | null;
  readonly token: string | null;
}

export interface NapCatManagedSessionOptions {
  readonly store: Pick<FileNapCatConfigStore, "read" | "replace">;
  readonly manager: NapCatRuntimeManager;
  readonly loadRuntime: () => NapCatManagedRuntime | Promise<NapCatManagedRuntime>;
  readonly resources: {
    read(): QqManagedResourceSnapshot;
    prepare(input: UpdateQqManagedResourcesRequest): QqManagedResourceSnapshot;
  };
  readonly readConnectionSettings: () => NapCatConnectionSettings;
  readonly transportState: () => { readonly phase: ActualStatus["transport_phase"] };
  readonly identityMatches: () => boolean;
  readonly pollIntervalMs: number;
  readonly stopDeadlineMs: number;
  readonly setTimeoutFn?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

type DesiredConnection = {
  readonly accountId: string;
  readonly endpoint: string;
  readonly token: string;
  readonly resourceRevision: string;
};

function sameConnection(left: DesiredConnection | null, right: DesiredConnection | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.accountId === right.accountId &&
    left.endpoint === right.endpoint &&
    left.token === right.token &&
    left.resourceRevision === right.resourceRevision
  );
}

function unavailable(code = "NAPCAT_LOGIN_UNAVAILABLE"): Error {
  return Object.assign(new Error("NapCat managed operation is unavailable"), { code });
}

/** Owns control authentication, one sequential operation and one bounded status poll. */
export function createNapCatManagedSession(
  options: NapCatManagedSessionOptions,
): NapCatManagedSession {
  let status: ActualStatus = {
    process: "stopped",
    apply: "ready",
    ownership: "none",
    phase: "stopped",
    core_ready: false,
    network_apply: "not_configured",
    transport_phase: "idle",
    diagnostic_code: null,
  };
  let runtime: NapCatManagedRuntime | null = null;
  let runtimeResourceRevision: string | null = null;
  let externalObserved = false;
  let credential: string | null = null;
  let loggedIn: boolean | null = null;
  let stopped = true;
  let generation = 0;
  let controller = new AbortController();
  let timer: unknown = null;
  let operation: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let applied: DesiredConnection | null = null;
  let attempt: { desired: DesiredConnection; before: Record<string, unknown> } | null = null;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer =
    options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as number));
  const current = (id: number) => !stopped && id === generation;
  const desiredConnection = (
    settings: NapCatConnectionSettings = options.readConnectionSettings(),
  ): DesiredConnection | null => {
    if (!settings.accountId || !settings.endpoint || !settings.token) return null;
    return {
      accountId: settings.accountId,
      endpoint: settings.endpoint,
      token: settings.token,
      resourceRevision: runtimeResourceRevision ?? "",
    };
  };
  const currentConnection = (id: number, desired: DesiredConnection) =>
    current(id) && sameConnection(desired, desiredConnection());
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const fail = (code: ActualStatus["diagnostic_code"]) => {
    loggedIn = null;
    applied = null;
    status = {
      ...status,
      process: code === "spawn_failed" ? "failed" : status.process,
      phase: "error",
      core_ready: false,
      diagnostic_code: code,
    };
  };
  const networkFailure = () => {
    applied = null;
    status = {
      ...status,
      network_apply: "failed",
      phase: "error",
      diagnostic_code: "network_apply_failed",
    };
  };
  const snapshot = (): QqManagedStatus => {
    const transport = options.transportState().phase;
    if (status.ownership === "owned") {
      const child = options.manager.snapshot;
      if ((child.status === "stopped" || child.status === "failed") && !stopped) {
        return {
          ...status,
          process: child.status,
          phase: "error",
          core_ready: false,
          network_apply: "pending",
          transport_phase: transport,
          diagnostic_code: "process_crashed",
        };
      }
    }
    if (!status.core_ready) return { ...status, transport_phase: transport };
    if (
      status.diagnostic_code === "account_mismatch" ||
      status.network_apply === "failed" ||
      status.phase === "configuration_required"
    )
      return { ...status, transport_phase: transport };
    if (status.ownership === "external") {
      if (transport === "ready" && !options.identityMatches())
        return {
          ...status,
          phase: "error",
          transport_phase: transport,
          diagnostic_code: "account_mismatch",
        };
      return {
        ...status,
        phase: transport === "ready" ? "transport_ready" : "core_online",
        network_apply: "not_owned",
        transport_phase: transport,
        diagnostic_code: null,
      };
    }
    const settings = options.readConnectionSettings();
    const desired = desiredConnection(settings);
    if (!desired)
      return {
        ...status,
        phase: "configuration_required",
        network_apply: "not_configured",
        transport_phase: transport,
        diagnostic_code: "network_configuration_required",
      };
    if (!sameConnection(applied, desired))
      return {
        ...status,
        phase: "applying_network",
        network_apply: "pending",
        transport_phase: transport,
      };
    const matched = transport === "ready" && options.identityMatches();
    const verified = settings.enabled && matched;
    const mismatch = transport === "ready" && !matched;
    return {
      ...status,
      phase: mismatch ? "error" : verified ? "transport_ready" : "core_online",
      network_apply: verified ? "verified" : "pending",
      transport_phase: transport,
      diagnostic_code: mismatch ? "account_mismatch" : null,
    };
  };
  const applyLogin = (value: LoginStatus) => {
    loggedIn = value.isLogin;
    const core = value.isLogin && !value.isOffline && value.coreReady;
    if (!core) applied = null;
    status = {
      ...status,
      process: "running",
      core_ready: core,
      phase: core ? "core_online" : value.qrLoginAccepted ? "waiting_confirm" : "waiting_scan",
      network_apply: status.ownership === "external" ? "not_owned" : "pending",
      diagnostic_code: null,
    };
  };
  const authenticate = async (id: number): Promise<void> => {
    if (!runtime || !current(id)) return;
    const result = await runtime.client.login(
      { hash: await deriveNapCatTokenHash(runtime.token) },
      { signal: controller.signal },
    );
    if (!current(id)) return;
    if (status.ownership === "none") {
      externalObserved = true;
      status = { ...status, ownership: "external" };
    }
    if (result.kind === "requires_2fa") {
      credential = null;
      status = {
        ...status,
        process: "running",
        phase: "challenge",
        core_ready: false,
        diagnostic_code: "challenge_required",
      };
      return;
    }
    credential = result.credential;
  };
  const reconcileNetwork = async (id: number): Promise<void> => {
    if (!runtime || !credential || !status.core_ready || status.ownership !== "owned") return;
    const desired = desiredConnection();
    if (!desired) {
      applied = null;
      attempt = null;
      status = {
        ...status,
        phase: "configuration_required",
        network_apply: "not_configured",
        diagnostic_code: "network_configuration_required",
      };
      return;
    }
    const client = runtime.client;
    const accountId = await client.getLoginAccount(credential, { signal: controller.signal });
    if (!currentConnection(id, desired)) return;
    if (accountId !== desired.accountId) {
      applied = null;
      status = {
        ...status,
        phase: "error",
        network_apply: "not_configured",
        diagnostic_code: "account_mismatch",
      };
      return;
    }
    if (sameConnection(applied, desired)) return;
    applied = null;
    status = {
      ...status,
      phase: "applying_network",
      network_apply: "pending",
      diagnostic_code: null,
    };
    try {
      if (attempt && sameConnection(attempt.desired, desired)) {
        const readback = await client.getOneBotConfig(credential, { signal: controller.signal });
        if (!currentConnection(id, desired)) return;
        if (verifyNapCatOneBotConfig(attempt.before, readback, desired)) {
          applied = desired;
          return;
        }
        networkFailure();
        return;
      }
      const before = await client.getOneBotConfig(credential, { signal: controller.signal });
      if (!currentConnection(id, desired)) return;
      const merged = mergeNapCatOneBotConfig(before, desired);
      if (!merged.changed) {
        const readback = await client.getOneBotConfig(credential, { signal: controller.signal });
        if (!currentConnection(id, desired)) return;
        if (verifyNapCatOneBotConfig(before, readback, desired)) {
          applied = desired;
          attempt = null;
        } else networkFailure();
        return;
      }
      // Retain the attempted identity before sending: timeout/abort is not a failed write proof.
      attempt = { desired, before };
      try {
        await client.setOneBotConfig(credential, merged.config, { signal: controller.signal });
      } catch {
        if (!currentConnection(id, desired)) return;
      }
      if (!currentConnection(id, desired)) return;
      const readback = await client.getOneBotConfig(credential, { signal: controller.signal });
      if (!currentConnection(id, desired)) return;
      if (verifyNapCatOneBotConfig(before, readback, desired)) applied = desired;
      else networkFailure();
    } catch (error) {
      if (!currentConnection(id, desired)) return;
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "NAPCAT_NETWORK_LISTENER_CONFLICT"
      ) {
        status = {
          ...status,
          phase: "configuration_required",
          network_apply: "not_configured",
          diagnostic_code: "network_configuration_required",
        };
      } else networkFailure();
    }
  };
  const observe = async (id: number, maySpawn: boolean): Promise<void> => {
    if (!runtime || !current(id)) return;
    if (!credential) {
      try {
        await authenticate(id);
      } catch (error) {
        if (!current(id)) return;
        if (
          error instanceof NapCatControlError &&
          error.code === "connection_refused" &&
          maySpawn &&
          status.ownership === "none"
        ) {
          status = { ...status, process: "starting", phase: "starting" };
          await options.manager.start(runtime.launch);
          status = { ...status, ownership: "owned" };
          if (!current(id)) return;
          await authenticate(id);
        } else {
          if (
            error instanceof NapCatControlError &&
            ["http_error", "upstream_rejected", "invalid_response"].includes(error.code)
          ) {
            if (status.ownership === "none") externalObserved = true;
            status = {
              ...status,
              ownership: status.ownership === "none" ? "external" : status.ownership,
            };
          }
          throw error;
        }
      }
    }
    if (!current(id) || !credential) return;
    const value = await runtime.client.checkLoginStatus(credential, { signal: controller.signal });
    if (!current(id)) return;
    applyLogin(value);
    await reconcileNetwork(id);
  };
  const schedule = (id: number) => {
    if (!current(id) || timer !== null) return;
    timer = setTimer(() => {
      if (!current(id)) return;
      timer = null;
      void run(false);
    }, options.pollIntervalMs);
  };
  const track = (id: number, work: Promise<void>): Promise<void> => {
    cancelTimer();
    const tracked = work.finally(() => {
      if (operation === tracked) operation = null;
      schedule(id);
    });
    operation = tracked;
    return tracked;
  };
  const run = (maySpawn: boolean): Promise<void> => {
    if (operation) return operation;
    const id = generation;
    return track(
      id,
      (async () => {
        try {
          if (!options.store.read().config.enabled) {
            stopped = true;
            cancelTimer();
            if (status.ownership === "owned") {
              const result = await options.manager.stop({ deadlineMs: options.stopDeadlineMs });
              if (result.status === "failed") {
                fail("stop_failed");
                return;
              }
            }
            credential = null;
            loggedIn = null;
            applied = null;
            attempt = null;
            status = {
              ...status,
              process: "disabled",
              phase: "stopped",
              core_ready: false,
              network_apply: "not_configured",
              ownership: "none",
              diagnostic_code: null,
            };
            return;
          }
          if (!current(id)) return;
          const resources = options.resources.read();
          if (resources.status !== "ready") {
            fail(
              resources.status === "missing" ? "runtime_not_selected" : "runtime_resources_invalid",
            );
            return;
          }
          if (status.ownership === "owned" && options.manager.snapshot.status === "stopped") {
            credential = null;
            applied = null;
            if (!maySpawn) {
              fail("process_crashed");
              return;
            }
            status = { ...status, ownership: "none", core_ready: false };
          }
          if (runtime && runtimeResourceRevision !== resources.revision) {
            fail("runtime_resources_invalid");
            return;
          }
          if (!runtime) {
            runtime = await options.loadRuntime();
            runtimeResourceRevision = resources.revision;
          }
          if (current(id)) await observe(id, maySpawn);
        } catch (error) {
          if (!current(id)) return;
          credential = null;
          fail(
            options.manager.snapshot.status === "failed"
              ? "spawn_failed"
              : error instanceof NapCatControlError && error.code === "timeout"
                ? "handshake_timeout"
                : "control_unavailable",
          );
        }
      })(),
    );
  };
  const start = async (): Promise<void> => {
    if (stopping) await stopping;
    if (stopped && operation) throw unavailable("NAPCAT_RESOURCE_BUSY");
    if (stopped) {
      stopped = false;
      generation += 1;
      controller = new AbortController();
    }
    cancelTimer();
    return run(true);
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    generation += 1;
    controller.abort();
    cancelTimer();
    credential = null;
    loggedIn = null;
    applied = null;
    attempt = null;
    const pending = operation;
    const work = (async () => {
      try {
        await Promise.allSettled(pending ? [pending] : []);
        if (status.ownership === "owned") {
          const result = await options.manager.stop({ deadlineMs: options.stopDeadlineMs });
          if (result.status === "failed") {
            fail("stop_failed");
            return;
          }
        }
        if (!externalObserved) {
          runtime = null;
          runtimeResourceRevision = null;
        }
        status = {
          ...status,
          process: "stopped",
          phase: "stopped",
          core_ready: false,
          network_apply: "not_configured",
          ownership: "none",
          diagnostic_code: null,
        };
      } catch {
        fail("stop_failed");
      }
    })();
    const tracked = work.finally(() => {
      if (stopping === tracked) stopping = null;
    });
    stopping = tracked;
    return tracked;
  };
  const qr = async (refresh: boolean): Promise<QqManagedQr> => {
    const id = generation;
    if (stopped || !runtime || !credential || loggedIn !== false || status.ownership !== "owned")
      return { qr_payload: null };
    try {
      const response = refresh
        ? await runtime.client.refreshLoginQrCode(credential, { signal: controller.signal })
        : await runtime.client.getLoginQrCode(credential, { signal: controller.signal });
      if (!current(id) || loggedIn !== false) return { qr_payload: null };
      const payload = "qrcode" in response ? response.qrcode : response.qrcodeurl;
      return QqManagedQrSchema.parse({ qr_payload: payload || null });
    } catch {
      if (current(id)) fail("control_unavailable");
      return { qr_payload: null };
    }
  };
  const ownedControl = () => {
    if (stopped || !runtime || !credential || status.ownership !== "owned") throw unavailable();
    return { runtime, credential, id: generation };
  };
  return {
    readConfig: () => options.store.read(),
    replaceConfig(expectedRevision, config) {
      const saved = options.store.replace(expectedRevision, config);
      // Persistence succeeded; activation failures belong to status, not the save response.
      void Promise.resolve().then(() => (saved.config.enabled ? start() : stop()));
      return saved;
    },
    readResources: () => options.resources.read(),
    async prepareResources(input) {
      const child = options.manager.snapshot;
      if (
        operation ||
        stopping ||
        status.ownership === "owned" ||
        child.status === "running" ||
        child.status === "starting" ||
        child.status === "stopping" ||
        child.pid !== undefined
      )
        throw unavailable("NAPCAT_RESOURCE_BUSY");
      if (externalObserved) {
        if (!stopped || !runtime) throw unavailable("NAPCAT_RESOURCE_BUSY");
        const id = generation;
        controller = new AbortController();
        await track(
          id,
          (async () => {
            if (!runtime) throw unavailable("NAPCAT_RESOURCE_BUSY");
            try {
              await runtime.client.login(
                { hash: await deriveNapCatTokenHash(runtime.token) },
                { signal: controller.signal },
              );
            } catch (error) {
              if (
                error instanceof NapCatControlError &&
                error.code === "connection_refused" &&
                stopped &&
                generation === id
              ) {
                externalObserved = false;
                return;
              }
            }
            throw unavailable("NAPCAT_RESOURCE_BUSY");
          })(),
        );
        if (!stopped || operation || stopping) throw unavailable("NAPCAT_RESOURCE_BUSY");
      }
      const saved = options.resources.prepare(input);
      generation += 1;
      controller.abort();
      controller = new AbortController();
      cancelTimer();
      runtime = null;
      runtimeResourceRevision = null;
      credential = null;
      loggedIn = null;
      applied = null;
      attempt = null;
      return saved;
    },
    async listAccounts() {
      if (operation) throw unavailable();
      const control = ownedControl();
      let accounts: QqManagedAccounts["accounts"] = [];
      await track(
        control.id,
        (async () => {
          try {
            const value = await control.runtime.client.getQuickLoginAccounts(control.credential, {
              signal: controller.signal,
            });
            if (!current(control.id)) throw unavailable();
            accounts = [...value];
          } catch {
            throw unavailable();
          }
        })(),
      );
      return { accounts };
    },
    async quickLogin(input) {
      if (operation) throw unavailable();
      const control = ownedControl();
      const settings = options.readConnectionSettings();
      if (
        loggedIn !== false ||
        settings.revision !== input.expected_settings_revision ||
        settings.accountId !== input.account_id
      )
        throw unavailable("NAPCAT_ACCOUNT_SELECTION_CONFLICT");
      await track(
        control.id,
        (async () => {
          let accounts: Awaited<ReturnType<NapCatControlClient["getQuickLoginAccounts"]>>;
          try {
            accounts = await control.runtime.client.getQuickLoginAccounts(control.credential, {
              signal: controller.signal,
            });
          } catch {
            throw unavailable();
          }
          const latest = options.readConnectionSettings();
          if (
            !current(control.id) ||
            latest.revision !== input.expected_settings_revision ||
            latest.accountId !== input.account_id ||
            !accounts.some((account) => account.account_id === input.account_id)
          )
            throw unavailable("NAPCAT_ACCOUNT_SELECTION_CONFLICT");
          try {
            await control.runtime.client.quickLogin(
              control.credential,
              { account_id: input.account_id },
              { signal: controller.signal },
            );
          } catch {
            throw unavailable();
          }
          const saved = options.readConnectionSettings();
          if (
            !current(control.id) ||
            saved.revision !== input.expected_settings_revision ||
            saved.accountId !== input.account_id
          )
            return;
          applied = null;
          status = { ...status, phase: "waiting_confirm", network_apply: "pending" };
        })(),
      );
    },
    snapshot,
    start,
    stop,
    retry: start,
    getQr: () => qr(false),
    refreshQr: () => qr(true),
  };
}
