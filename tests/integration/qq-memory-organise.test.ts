// 「立即整理」and the pending count on the bindings surface .
//
// Why this file exists: both halves of QQ memory had no entrance at all — the automatic one needed
// a per-conversation count no page could set, and the manual action had no caller anywhere — so a
// group could talk for days and still end up with zero memories. The route's answer is a VERDICT
// rather than an error, and each verdict is a fact the page states plainly, so each one is pinned
// here: queued, nothing_to_organise, switch_off, paused, busy, agent_disabled. Also pinned is the
// count that makes the whole thing legible (`pending_observations` on every binding).

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { pendingObservationCount } from "../../src/server/db/qq-observation-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { qqConversationScopeOf } from "../../src/server/services/qq-binding-contract";
import type {
  QqBindingResponse,
  QqMemoryOrganiseResponse,
  QqSchemeResponse,
} from "../../src/shared/contracts/qq";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MISSING_BINDING_ID = "00000000-0000-4000-8000-0000000000ff";
const NOW_SECONDS = Math.floor(Date.parse("2026-09-25T12:00:00.000Z") / 1000);

type App = ReturnType<typeof createApp>;

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-qq-memory-"));
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  const app = createApp({
    business,
    qqTransportKeyPath: path.join(dir, "qq-transport.key"),
  });
  return { business, orm: business.orm, app, dir };
}

function cleanup(h: ReturnType<typeof setup>) {
  h.business.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function json(app: App, method: string, route: string, payload: unknown) {
  return app.request(route, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The switch must be on for observations to exist at all, and for organising to be allowed. */
async function enableSwitch(app: App) {
  const current = await read<{ revision: number }>(await app.request("/qq/settings"));
  const saved = await json(app, "PUT", "/qq/settings", {
    enabled: true,
    account_id: "10001",
    expected_revision: current.revision,
  });
  expect(saved.status).toBe(200);
}

async function createBinding(
  app: App,
  overrides: Record<string, unknown> = {},
): Promise<QqBindingResponse> {
  const scheme = await read<QqSchemeResponse>(
    await json(app, "POST", "/qq/schemes", { name: "方案" }),
  );
  const response = await json(app, "POST", "/qq/bindings", {
    account_id: "10001",
    kind: "group",
    peer_id: "20001",
    agent_id: AGENT_ID,
    scheme_id: scheme.id,
    ...overrides,
  });
  expect(response.status).toBe(201);
  return read<QqBindingResponse>(response);
}

function organise(app: App, bindingId: string) {
  return Promise.resolve(app.request(`/qq/bindings/${bindingId}/memory`, { method: "POST" }));
}

async function organiseVerdict(app: App, bindingId: string): Promise<QqMemoryOrganiseResponse> {
  const response = await organise(app, bindingId);
  expect(response.status).toBe(200);
  return read<QqMemoryOrganiseResponse>(response);
}

/** One readable observation of the bound conversation, exactly as the intake would record it. */
function observe(orm: Orm, key: string, index: number): void {
  const observation: QqObservation = {
    accountId: "10001",
    conversation: {
      kind: "group",
      peerId: "20001",
      key: JSON.stringify(["qq", "10001", "group", "20001"]),
    },
    eventKey: key,
    messageId: `-${index}`,
    occurredAtSeconds: NOW_SECONDS + index,
    subType: "normal",
    speaker: { kind: "member", id: "30001", displayName: "群友" },
    segments: [{ kind: "text", text: `消息${index}` }],
    text: `消息${index}`,
    mentionsSelf: false,
  };
  recordObservation(orm, observation, AGENT_ID);
}

function jobRows(orm: Orm) {
  return orm.select().from(schema.memoryJobs).all();
}

/** The wire shape is snake_case; the scope builder speaks the contract's camelCase fields. */
function scopeOf(binding: QqBindingResponse) {
  return qqConversationScopeOf({
    accountId: binding.account_id,
    conversationKind: binding.kind,
    peerId: binding.peer_id,
    agentId: binding.agent_id,
  });
}

function snapshotOf(orm: Orm) {
  const job = jobRows(orm)[0];
  return JSON.parse(job?.configSnapshot ?? "{}") as {
    scope?: string;
    scope_key?: string;
    source_event_ids?: string[];
  };
}

describe("the pending count on the bindings surface", () => {
  it("reports what is waiting, and returns to zero once a batch is taken", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app);
      expect(binding.pending_observations).toBe(0);

      observe(h.orm, "evt_0", 0);
      observe(h.orm, "evt_1", 1);
      const listed = await read<QqBindingResponse[]>(await h.app.request("/qq/bindings"));
      expect(listed[0]?.pending_observations).toBe(2);

      expect((await organiseVerdict(h.app, binding.id)).status).toBe("queued");
      const after = await read<QqBindingResponse[]>(await h.app.request("/qq/bindings"));
      // Taking a batch is what consumes it: the observations are marked offered at enqueue time.
      expect(after[0]?.pending_observations).toBe(0);
    } finally {
      cleanup(h);
    }
  });
});

describe("the manual 「立即整理」 verdict", () => {
  it("queues every readable observation, with the conversation's own scope", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app);
      observe(h.orm, "evt_0", 0);
      observe(h.orm, "evt_1", 1);
      observe(h.orm, "evt_2", 2);

      const verdict = await organiseVerdict(h.app, binding.id);
      expect(verdict.status).toBe("queued");
      expect(verdict.pending).toBe(3);
      expect(verdict.job_id).toMatch(/^[0-9a-f-]{36}$/);

      const jobs = jobRows(h.orm);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.kind).toBe("manual");
      const snapshot = snapshotOf(h.orm);
      // The job cites the observations, not turns, and carries the exact conversation scope —
      // this is the structure that makes mixing two conversations' messages impossible.
      expect(snapshot.source_event_ids).toEqual(["evt_0", "evt_1", "evt_2"]);
      expect(snapshot.scope).toBe("reality_user");
      expect(snapshot.scope_key).toBe(JSON.stringify(["qq", "10001", "group", "20001", AGENT_ID]));
      expect(pendingObservationCount(h.orm, scopeOf(binding))).toBe(0);
    } finally {
      cleanup(h);
    }
  });

  it("says there is nothing to organise instead of queueing an empty job", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app);
      const verdict = await organiseVerdict(h.app, binding.id);
      expect(verdict).toEqual({ status: "nothing_to_organise", job_id: null, pending: 0 });
      expect(jobRows(h.orm)).toHaveLength(0);
    } finally {
      cleanup(h);
    }
  });

  it("refuses while the third-party switch is off, and spends nothing", async () => {
    const h = setup();
    try {
      // Observations are recorded directly: with the switch off the intake would drop them, and
      // the point here is a conversation that arrived BEFORE the switch was turned off.
      const binding = await createBinding(h.app);
      observe(h.orm, "evt_0", 0);
      const verdict = await organiseVerdict(h.app, binding.id);
      expect(verdict).toEqual({ status: "switch_off", job_id: null, pending: 1 });
      expect(jobRows(h.orm)).toHaveLength(0);
      // Still waiting: a refused attempt must not consume the batch.
      expect(pendingObservationCount(h.orm, scopeOf(binding))).toBe(1);
    } finally {
      cleanup(h);
    }
  });

  it("refuses while the conversation is paused", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app, { paused: true });
      observe(h.orm, "evt_0", 0);
      const verdict = await organiseVerdict(h.app, binding.id);
      expect(verdict).toEqual({ status: "paused", job_id: null, pending: 1 });
      expect(jobRows(h.orm)).toHaveLength(0);
    } finally {
      cleanup(h);
    }
  });

  it("waits rather than doubling up while the assistant already has a job", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app);
      observe(h.orm, "evt_0", 0);
      expect((await organiseVerdict(h.app, binding.id)).status).toBe("queued");

      observe(h.orm, "evt_1", 1);
      const second = await organiseVerdict(h.app, binding.id);
      // One active job per assistant: "wait" is the honest answer, and the new message stays
      // readable for the next attempt.
      expect(second).toEqual({ status: "busy", job_id: null, pending: 1 });
      expect(jobRows(h.orm)).toHaveLength(1);
    } finally {
      cleanup(h);
    }
  });

  it("refuses for a disabled assistant", async () => {
    const h = setup();
    try {
      await enableSwitch(h.app);
      const binding = await createBinding(h.app);
      observe(h.orm, "evt_0", 0);
      h.orm
        .update(schema.agents)
        .set({ isActive: 0, updatedAt: nowIso() })
        .where(eq(schema.agents.id, AGENT_ID))
        .run();

      const verdict = await organiseVerdict(h.app, binding.id);
      expect(verdict).toEqual({ status: "agent_disabled", job_id: null, pending: 1 });
      expect(jobRows(h.orm)).toHaveLength(0);
    } finally {
      cleanup(h);
    }
  });

  it("answers 404 for a binding that does not exist", async () => {
    const h = setup();
    try {
      const response = await organise(h.app, MISSING_BINDING_ID);
      expect(response.status).toBe(404);
    } finally {
      cleanup(h);
    }
  });
});
