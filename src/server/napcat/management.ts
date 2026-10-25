import {
  type QqManagedConfig,
  type QqManagedConfigSnapshot,
  type QqManagedQr,
  QqManagedQrSchema,
  type QqManagedStatus,
} from "../../shared/contracts/qq-managed";
import type { FileNapCatConfigStore } from "./config";
import {
  deriveNapCatTokenHash,
  type NapCatControlClient,
  NapCatControlError,
} from "./control-client";
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
}

export interface NapCatManagedRuntime {
  readonly client: NapCatControlClient;
  readonly launch: NapCatRuntimeStartInput;
  readonly token: string;
}

type ActualStatus = Extract<QqManagedStatus, { apply: "ready" }>;
type LoginStatus = Awaited<ReturnType<NapCatControlClient["checkLoginStatus"]>>;

export interface NapCatManagedSessionOptions {
  readonly store: Pick<FileNapCatConfigStore, "read" | "replace">;
  readonly manager: NapCatRuntimeManager;
  readonly loadRuntime: () => NapCatManagedRuntime | Promise<NapCatManagedRuntime>;
  readonly transportState: () => { readonly phase: ActualStatus["transport_phase"] };
  readonly identityMatches: () => boolean;
  readonly pollIntervalMs: number;
  readonly stopDeadlineMs: number;
  readonly setTimeoutFn?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

/** Owns control authentication and one sequential poll; the manager alone owns spawned children. */
export function createNapCatManagedSession(
  options: NapCatManagedSessionOptions,
): NapCatManagedSession {
  let status: ActualStatus = {
    process: "stopped",
    apply: "ready",
    ownership: "none",
    phase: "stopped",
    core_ready: false,
    transport_phase: "idle",
    diagnostic_code: null,
  };
  let runtime: NapCatManagedRuntime | null = null;
  let credential: string | null = null;
  let loggedIn: boolean | null = null;
  let stopped = true;
  let generation = 0;
  let controller = new AbortController();
  let timer: unknown = null;
  let operation: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer =
    options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as number));
  const current = (id: number) => !stopped && id === generation;
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const fail = (code: ActualStatus["diagnostic_code"]) => {
    loggedIn = null;
    status = {
      ...status,
      process: code === "spawn_failed" ? "failed" : status.process,
      phase: "error",
      core_ready: false,
      diagnostic_code: code,
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
          transport_phase: transport,
          diagnostic_code: "process_crashed",
        };
      }
    }
    if (status.core_ready) {
      if (transport === "ready" && !options.identityMatches()) {
        return {
          ...status,
          phase: "error",
          transport_phase: transport,
          diagnostic_code: "account_mismatch",
        };
      }
      return {
        ...status,
        phase: transport === "ready" ? "transport_ready" : "core_online",
        transport_phase: transport,
        diagnostic_code: null,
      };
    }
    return { ...status, transport_phase: transport };
  };
  const applyLogin = (value: LoginStatus) => {
    loggedIn = value.isLogin;
    const core = value.isLogin && !value.isOffline && value.coreReady;
    status = {
      ...status,
      process: "running",
      core_ready: core,
      phase: core ? "core_online" : value.qrLoginAccepted ? "waiting_confirm" : "waiting_scan",
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
    if (status.ownership === "none") status = { ...status, ownership: "external" };
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
  const observe = async (id: number, maySpawn: boolean): Promise<void> => {
    if (!runtime || !current(id)) return;
    if (!credential) {
      try {
        await authenticate(id);
      } catch (error) {
        if (!current(id)) return;
        // An HTTP/auth rejection proves a server is present. Never launch over it.
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
    if (current(id)) applyLogin(value);
  };
  const schedule = (id: number) => {
    if (!current(id) || timer !== null) return;
    timer = setTimer(() => {
      if (!current(id)) return;
      timer = null;
      void run(false);
    }, options.pollIntervalMs);
  };
  const run = (maySpawn: boolean): Promise<void> => {
    if (operation) return operation;
    const id = generation;
    const work = (async () => {
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
          status = {
            ...status,
            process: "disabled",
            phase: "stopped",
            core_ready: false,
            ownership: "none",
            diagnostic_code: null,
          };
          return;
        }
        if (!current(id)) return;
        if (status.ownership === "owned" && options.manager.snapshot.status === "stopped") {
          credential = null;
          if (!maySpawn) {
            fail("process_crashed");
            return;
          }
          status = { ...status, ownership: "none", core_ready: false };
        }
        runtime ??= await options.loadRuntime();
        if (!current(id)) return;
        await observe(id, maySpawn);
      } catch (error) {
        if (!current(id)) return;
        credential = null;
        const managerFailed = options.manager.snapshot.status === "failed";
        fail(
          managerFailed
            ? "spawn_failed"
            : error instanceof NapCatControlError && error.code === "timeout"
              ? "handshake_timeout"
              : "control_unavailable",
        );
      }
    })();
    const tracked = work.finally(() => {
      if (operation === tracked) operation = null;
      schedule(id);
    });
    operation = tracked;
    return tracked;
  };
  const start = async (): Promise<void> => {
    if (stopping) await stopping;
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
    const pending = operation;
    const work = (async () => {
      try {
        await pending;
        if (status.ownership === "owned") {
          const result = await options.manager.stop({ deadlineMs: options.stopDeadlineMs });
          if (result.status === "failed") {
            fail("stop_failed");
            return;
          }
        }
        runtime = null;
        status = {
          ...status,
          process: "stopped",
          phase: "stopped",
          core_ready: false,
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
    if (stopped || !runtime || !credential || loggedIn !== false) {
      return { qr_payload: null };
    }
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
  return {
    readConfig: () => options.store.read(),
    replaceConfig(expectedRevision, config) {
      const saved = options.store.replace(expectedRevision, config);
      // Persistence has succeeded; activation failures belong to status, not the save response.
      void Promise.resolve().then(() => (saved.config.enabled ? start() : stop()));
      return saved;
    },
    snapshot,
    start,
    stop,
    retry: start,
    getQr: () => qr(false),
    refreshQr: () => qr(true),
  };
}
