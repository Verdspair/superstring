import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  QqManagedAccountsSchema,
  QqManagedConfigSnapshotSchema,
  QqManagedQrSchema,
  QqManagedQuickLoginRequestSchema,
  QqManagedResourceSnapshotSchema,
  QqManagedStatusSchema,
  UpdateQqManagedConfigRequestSchema,
  UpdateQqManagedResourcesRequestSchema,
} from "../../shared/contracts/qq-managed";
import {
  QqManagedEventCursorSchema,
  type QqManagedEventQuery,
  QqManagedEventQuerySchema,
  type QqManagedEventsInvalidation,
  QqManagedEventsInvalidationSchema,
  type QqManagedEventsPage,
  QqManagedEventsPageSchema,
} from "../../shared/contracts/qq-managed-events";
import { managementErrors, managementGuard } from "../api/management";
import { createSseResponse } from "../api/sse";
import { parseBody, readJsonBody, validationFailed } from "../api/validation";
import type { NapCatManagedSession, NapCatManagementPort } from "./management";

const managedErrors = {
  NAPCAT_CONFIG_CONFLICT: [409, "托管组件配置已变化，请重新读取后保存"],
  NAPCAT_CONFIG_INVALID: [503, "托管组件配置不可用，请检查配置文件"],
  NAPCAT_CONFIG_UNAVAILABLE: [503, "托管组件配置不可用，请检查配置文件"],
  NAPCAT_MANAGEMENT_UNAVAILABLE: [503, "托管组件管理尚未配置"],
  NAPCAT_RESOURCE_CONFLICT: [409, "运行资源已变化，请重新读取后准备"],
  NAPCAT_RESOURCE_BUSY: [409, "运行组件仍在使用中，请先停止托管组件再更换资源"],
  NAPCAT_RESOURCE_UNAVAILABLE: [503, "运行资源不可用，请检查所选官方运行目录"],
  NAPCAT_ACCOUNT_SELECTION_CONFLICT: [409, "账号选择已变化或尚未保存，请核对后重试"],
  NAPCAT_LOGIN_UNAVAILABLE: [503, "当前托管登录操作不可用，请检查组件状态"],
} as const;

const EmptyManagedActionRequestSchema = z.strictObject({});

function isManagedSession(port: NapCatManagementPort): port is NapCatManagedSession {
  return (
    "start" in port &&
    typeof port.start === "function" &&
    "stop" in port &&
    typeof port.stop === "function" &&
    "retry" in port &&
    typeof port.retry === "function" &&
    "getQr" in port &&
    typeof port.getQr === "function" &&
    "refreshQr" in port &&
    typeof port.refreshQr === "function" &&
    "readResources" in port &&
    typeof port.readResources === "function" &&
    "prepareResources" in port &&
    typeof port.prepareResources === "function" &&
    "listAccounts" in port &&
    typeof port.listAccounts === "function" &&
    "quickLogin" in port &&
    typeof port.quickLogin === "function"
  );
}

function managedStatusResponse(status: ReturnType<NapCatManagementPort["snapshot"]>) {
  if (status.apply === "blocked") {
    return QqManagedStatusSchema.parse({
      process: status.process,
      apply: status.apply,
      unavailable_reason: status.unavailable_reason,
    });
  }
  return QqManagedStatusSchema.parse({
    process: status.process,
    apply: status.apply,
    ownership: status.ownership,
    phase: status.phase,
    core_ready: status.core_ready,
    transport_phase: status.transport_phase,
    network_apply: status.network_apply,
    diagnostic_code: status.diagnostic_code,
  });
}

export interface QqManagedEventsPort {
  snapshot(query: Partial<QqManagedEventQuery>): QqManagedEventsPage;
  subscribe(listener: (notice: QqManagedEventsInvalidation) => void): () => void;
  readonly generation: string;
  readonly latestSequence: number;
  readonly revision: number;
}

/** Mounted separately so the existing QQ routes keep their paths and error handling. */
export function qqManagedComponentRoutes(
  port?: NapCatManagementPort,
  events?: QqManagedEventsPort,
): Hono {
  const router = new Hono();
  router.onError(managementErrors(managedErrors));

  function configured(): NapCatManagementPort {
    if (!port) {
      throw Object.assign(new Error("托管组件管理尚未配置"), {
        code: "NAPCAT_MANAGEMENT_UNAVAILABLE",
      });
    }
    return port;
  }

  function configuredSession(): NapCatManagedSession {
    const available = configured();
    if (!isManagedSession(available)) {
      throw Object.assign(new Error("托管组件管理尚未配置"), {
        code: "NAPCAT_MANAGEMENT_UNAVAILABLE",
      });
    }
    return available;
  }

  async function validateEmptyActionRequest(c: Context): Promise<void> {
    if (new URL(c.req.url).searchParams.size > 0) throw validationFailed();
    const raw = await c.req.raw.text();
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw validationFailed();
    }
    parseBody(EmptyManagedActionRequestSchema, parsed);
  }

  router.get("/events", managementGuard(), (c) => {
    if (!events)
      throw Object.assign(new Error("托管消息观察尚未配置"), {
        code: "NAPCAT_MANAGEMENT_UNAVAILABLE",
      });
    const parsed = QqManagedEventQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw validationFailed();
    if (parsed.data.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(parsed.data.cursor);
      } catch {
        throw validationFailed();
      }
      if (!QqManagedEventCursorSchema.safeParse(cursor).success) throw validationFailed();
    }
    const page = QqManagedEventsPageSchema.parse(events.snapshot(parsed.data));
    return c.json(page, page.status === "reset_required" ? 409 : 200);
  });
  router.get("/events/changes", managementGuard(), (c) => {
    if (!events)
      throw Object.assign(new Error("托管消息观察尚未配置"), {
        code: "NAPCAT_MANAGEMENT_UNAVAILABLE",
      });
    if (new URL(c.req.url).searchParams.size > 0) throw validationFailed();
    let stopped = false;
    let pending: QqManagedEventsInvalidation | null = null;
    let wake: (() => void) | undefined;
    const notify = () => {
      const ready = wake;
      wake = undefined;
      ready?.();
    };
    const unsubscribe = events.subscribe((notice) => {
      if (stopped) return;
      pending = QqManagedEventsInvalidationSchema.parse(notice);
      notify();
    });
    const response = createSseResponse(
      {
        requestSignal: c.req.raw.signal,
        onDisconnect() {
          stopped = true;
          unsubscribe();
          pending = null;
          notify();
        },
      },
      async (stream) => {
        await stream.send(
          "managed_events_ready",
          QqManagedEventsInvalidationSchema.parse({
            generation: events.generation,
            latest_sequence: events.latestSequence,
            revision: events.revision,
          }),
        );
        while (!stopped) {
          if (!pending) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          const notice = pending;
          pending = null;
          await stream.send("managed_events_changed", notice);
        }
      },
    );
    response.headers.set("cache-control", "no-store");
    return response;
  });
  router.get("/config", managementGuard(), (c) =>
    c.json(QqManagedConfigSnapshotSchema.parse(configured().readConfig())),
  );
  router.put("/config", managementGuard(), async (c) => {
    const input = parseBody(UpdateQqManagedConfigRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      QqManagedConfigSnapshotSchema.parse(
        configured().replaceConfig(input.expected_revision, input.config),
      ),
    );
  });
  router.get("/status", managementGuard(), (c) => {
    const status = port?.snapshot() ?? {
      process: "unavailable",
      apply: "blocked",
      unavailable_reason: "management_not_configured",
    };
    return c.json(managedStatusResponse(status));
  });
  router.get("/resources", managementGuard(), (c) =>
    c.json(QqManagedResourceSnapshotSchema.parse(configuredSession().readResources())),
  );
  router.put("/resources", managementGuard(), async (c) => {
    const input = parseBody(UpdateQqManagedResourcesRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      QqManagedResourceSnapshotSchema.parse(await configuredSession().prepareResources(input)),
    );
  });
  router.get("/accounts", managementGuard(), async (c) =>
    c.json(QqManagedAccountsSchema.parse(await configuredSession().listAccounts())),
  );
  router.post("/quick-login", managementGuard(), async (c) => {
    const input = parseBody(QqManagedQuickLoginRequestSchema, await readJsonBody(c.req.raw));
    const session = configuredSession();
    await session.quickLogin(input);
    return c.json(managedStatusResponse(session.snapshot()));
  });
  router.post("/retry", managementGuard(), async (c) => {
    await validateEmptyActionRequest(c);
    const session = configuredSession();
    await session.retry();
    return c.json(managedStatusResponse(session.snapshot()));
  });
  router.post("/qr", managementGuard(), async (c) => {
    await validateEmptyActionRequest(c);
    const result = await configuredSession().getQr();
    return c.json(QqManagedQrSchema.parse({ qr_payload: result.qr_payload }));
  });
  router.post("/refresh-qr", managementGuard(), async (c) => {
    await validateEmptyActionRequest(c);
    const result = await configuredSession().refreshQr();
    return c.json(QqManagedQrSchema.parse({ qr_payload: result.qr_payload }));
  });
  return router;
}
