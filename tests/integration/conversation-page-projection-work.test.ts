import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as projection from "../../src/server/conversation/conversation-view";
import { bodyRevision } from "../../src/server/db/conversation-event-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import type {
  ConversationEvent,
  ConversationEventView,
} from "../../src/shared/contracts/conversation";
import { cloneBusinessDb } from "../harness/business-db";

type ProjectedTask = {
  id: string;
  status: NonNullable<ConversationEventView["task"]>["status"];
  error_code: string | null;
  origin_run_id: string | null;
  origin_wake_id: string | null;
  cause: string;
  source_through_seq: number;
};

type ProjectedWake = {
  id: string;
  cause: string;
  status: NonNullable<ConversationEventView["wake"]>["status"];
  ready_at: string;
  error_code: string | null;
  through_seq: number;
};

/**
 * A persisted step is inserted immediately before its model call. Only the initiative judge
 * leaf and an ordinary reply decision step prove that this wake reached intent judgement.
 */
function initiativeJudgementStarted(
  db: Database,
  wake: ProjectedWake,
  conversationId: string,
): boolean | undefined {
  if (wake.cause !== "chiming_in" && wake.cause !== "idle_topic") return undefined;
  const row = db
    .query(
      `WITH scope AS (
        SELECT w.id AS wake_id,w.status,w.error_code,c.id AS conversation_id,
          c.source_id,c.user_id,c.agent_id
        FROM wake_signals w JOIN conversations c ON c.id=w.conversation_id
        WHERE w.id=? AND w.conversation_id=?
      ), candidates AS (
        SELECT r.run_id,r.spec_id,r.owner_kind
        FROM scope s JOIN agent_runs r INDEXED BY ix_agent_runs_conversation
          ON r.conversation_id=s.conversation_id
        WHERE ((r.owner_kind='conversation' AND r.owner_id=s.conversation_id)
            OR (r.owner_kind='qq_binding' AND r.owner_id=s.source_id))
          AND r.user_id=s.user_id AND r.agent_id=s.agent_id
          AND r.conversation_id=s.conversation_id AND r.wake_id=s.wake_id
      ), evidence AS (
        SELECT s.status,s.error_code,COUNT(DISTINCT r.run_id) AS run_count,
          MAX(CASE WHEN step.step_id IS NOT NULL THEN 1 ELSE 0 END) AS intent_step_started
        FROM scope s
        LEFT JOIN candidates r ON 1=1
        LEFT JOIN agent_steps step ON step.run_id=r.run_id AND (
          (r.owner_kind='qq_binding' AND r.spec_id='onebot.initiative.evaluate_batch'
            AND step.phase='leaf')
          OR (r.owner_kind='conversation' AND r.spec_id='onebot.main' AND step.phase='next')
        )
        GROUP BY s.wake_id
      )
      SELECT CASE
        WHEN intent_step_started=1 THEN 1
        WHEN run_count>0 OR status IN ('pending','leased')
          OR error_code IN ('BATCH_NO_ELIGIBLE_SOURCE','BATCH_WAITING_FOR_COUNT') THEN 0
        ELSE NULL
      END AS judgmentStarted
      FROM evidence`,
    )
    .get(wake.id, conversationId) as { judgmentStarted: number | null } | null;
  if (!row || row.judgmentStarted === null) return undefined;
  return row.judgmentStarted === 1;
}

function taskActivity(db: Database, event: ConversationEvent, wake: ProjectedWake | null) {
  if (
    !(
      (event.kind === "wake" && event.source.kind === "wake") ||
      (event.kind === "inbound" && event.source.kind === "qq_event") ||
      event.source.kind === "outbound_intent"
    )
  )
    return undefined;
  const conversation = db
    .query("SELECT binding_epoch,agent_id,source_id FROM conversations WHERE id=?")
    .get(event.conversationId) as {
    binding_epoch: number;
    agent_id: string;
    source_id: string;
  } | null;
  if (!conversation) return undefined;
  const columns =
    "t.id,t.status,t.error_code,t.origin_run_id,t.origin_wake_id,t.cause,t.source_through_seq";
  const scope = "t.conversation_id=? AND t.binding_epoch=? AND t.agent_id=?";
  const scopeArgs = [event.conversationId, conversation.binding_epoch, conversation.agent_id];
  let candidates: ProjectedTask[] = [];
  if (event.kind === "wake" && event.source.kind === "wake") {
    candidates = db
      .query(`SELECT ${columns} FROM wake_signals w JOIN qq_conversation_tasks t
        ON t.id=w.transferred_task_id AND t.origin_wake_id=w.id
        WHERE w.id=? AND w.conversation_id=? AND ${scope}`)
      .all(event.source.id, event.conversationId, ...scopeArgs) as ProjectedTask[];
    if (candidates.length === 0) {
      if (wake?.cause === "direct_reply") {
        candidates = db
          .query(`SELECT ${columns} FROM qq_conversation_tasks t
            JOIN conversation_events e ON e.conversation_id=t.conversation_id
              AND e.seq=t.source_through_seq AND e.source_kind='qq_event'
              AND e.source_id=t.origin_event_key AND e.kind='inbound'
            WHERE ${scope} AND t.task_class='mention' AND t.cause='direct_reply'
              AND t.origin_wake_id IS NULL AND t.source_through_seq=?`)
          .all(...scopeArgs, wake.through_seq) as ProjectedTask[];
      }
    }
  } else if (event.kind === "inbound" && event.source.kind === "qq_event") {
    candidates = db
      .query(`SELECT ${columns} FROM qq_conversation_tasks t WHERE ${scope}
        AND t.task_class='mention' AND t.cause='direct_reply' AND t.origin_wake_id IS NULL
        AND t.source_through_seq=? AND t.origin_event_key=?`)
      .all(...scopeArgs, event.seq, event.source.id) as ProjectedTask[];
  } else if (event.source.kind === "outbound_intent") {
    const intent = db
      .query(
        "SELECT run_id,source_through_seq,speech_kind,target FROM outbound_intents WHERE id=? AND conversation_id=?",
      )
      .get(event.source.id, event.conversationId) as {
      run_id: string;
      source_through_seq: number;
      speech_kind: string;
      target: string;
    } | null;
    if (!intent) return undefined;
    let target: {
      qqTaskId?: unknown;
      bindingId?: unknown;
      bindingEpoch?: unknown;
      agentId?: unknown;
      observedThroughSeq?: unknown;
    };
    try {
      target = JSON.parse(intent.target);
    } catch {
      return undefined;
    }
    if (
      !target ||
      typeof target.qqTaskId !== "string" ||
      target.bindingId !== conversation.source_id ||
      target.bindingEpoch !== conversation.binding_epoch ||
      target.agentId !== conversation.agent_id
    )
      return undefined;
    candidates = db
      .query(`SELECT ${columns} FROM qq_conversation_tasks t WHERE ${scope}
      AND t.id=? AND t.source_through_seq=? AND t.cause=?`)
      .all(
        ...scopeArgs,
        target.qqTaskId,
        intent.source_through_seq,
        intent.speech_kind,
      ) as ProjectedTask[];
    const run = db
      .query(
        "SELECT conversation_id,owner_kind,owner_id,agent_id,wake_id,observed_seq FROM agent_runs WHERE run_id=?",
      )
      .get(intent.run_id) as {
      conversation_id: string | null;
      owner_kind: string;
      owner_id: string;
      agent_id: string | null;
      wake_id: string | null;
      observed_seq: number | null;
    } | null;
    const observed = target.observedThroughSeq ?? intent.source_through_seq;
    if (
      !Number.isSafeInteger(observed) ||
      (observed as number) < intent.source_through_seq ||
      !run ||
      run.conversation_id !== event.conversationId ||
      run.owner_kind !== "conversation" ||
      run.owner_id !== event.conversationId ||
      run.agent_id !== conversation.agent_id ||
      run.observed_seq !== observed
    )
      return undefined;
    const candidate = candidates[0];
    if (
      candidates.length !== 1 ||
      !candidate ||
      run.wake_id !== candidate.origin_wake_id ||
      (intent.run_id !== candidate.origin_run_id &&
        candidate.cause !== "chiming_in" &&
        candidate.cause !== "idle_topic")
    )
      return undefined;
    return {
      activityId: candidate.id,
      task: { id: candidate.id, status: candidate.status, errorCode: candidate.error_code },
      runId: intent.run_id,
    };
  }
  if (candidates.length !== 1) return undefined;
  const task = candidates[0];
  if (!task) return undefined;
  const run = task.origin_run_id
    ? (db
        .query(
          "SELECT rowid AS origin_rowid,run_id,spec_id,spec_version,agent_id,observed_seq FROM agent_runs WHERE run_id=? AND conversation_id=? AND owner_kind='conversation' AND owner_id=? AND (agent_id=? OR agent_id IS NULL) AND wake_id IS ?",
        )
        .get(
          task.origin_run_id,
          event.conversationId,
          event.conversationId,
          conversation.agent_id,
          task.origin_wake_id,
        ) as {
        origin_rowid: number;
        run_id: string;
        spec_id: string;
        spec_version: string;
        agent_id: string | null;
        observed_seq: number | null;
      } | null)
    : null;
  const parentAttempt =
    run?.spec_id === "onebot.initiative.batch" &&
    run.agent_id === conversation.agent_id &&
    run.observed_seq === task.source_through_seq
      ? (db
          .query(`SELECT run_id FROM agent_runs NOT INDEXED
            WHERE rowid>=? AND conversation_id=? AND owner_kind='conversation' AND owner_id=?
              AND agent_id=? AND wake_id IS ? AND spec_id=? AND spec_version=?
              AND observed_seq=? ORDER BY rowid DESC LIMIT 1`)
          .get(
            run.origin_rowid,
            event.conversationId,
            event.conversationId,
            conversation.agent_id,
            task.origin_wake_id,
            run.spec_id,
            run.spec_version,
            task.source_through_seq,
          ) as { run_id: string })
      : run;
  return {
    activityId: task.id,
    task: { id: task.id, status: task.status, errorCode: task.error_code },
    runId: parentAttempt?.run_id ?? null,
  };
}

/** Resolve current source bodies on demand. The journal is never a retention bypass. */
function scalarConversationEvent(
  db: Database,
  event: ConversationEvent,
  at = new Date().toISOString(),
): ConversationEventView {
  const wake =
    event.kind === "wake" && event.source.kind === "wake"
      ? (db
          .query(
            "SELECT id,cause,status,ready_at,error_code,through_seq FROM wake_signals WHERE id=? AND conversation_id=?",
          )
          .get(event.source.id, event.conversationId) as ProjectedWake | null)
      : null;
  const base: ConversationEventView = {
    ...event,
    wake: null,
    text: null,
    messageStatus: null,
    contentState: "unavailable",
    media: [],
    deliveryStatus: null,
    deliveryStaleReason: null,
    ...taskActivity(db, event, wake),
  };
  if (event.kind === "wake" && event.source.kind === "wake") {
    if (!wake) return { ...base, contentState: "revoked" };
    const run = base.task
      ? null
      : (db
          .query(
            "SELECT run_id FROM agent_runs WHERE wake_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(wake.id, event.conversationId) as { run_id: string } | null);
    const judgmentStarted = initiativeJudgementStarted(db, wake, event.conversationId);
    return {
      ...base,
      contentState: "active",
      runId: base.runId ?? run?.run_id ?? null,
      wake: {
        id: wake.id,
        cause: wake.cause,
        status: wake.status,
        readyAt: wake.ready_at,
        errorCode: wake.error_code,
        ...(judgmentStarted === undefined ? {} : { judgmentStarted }),
      },
    };
  }
  const expired = (until: string | null | undefined) => !!until && until <= at;
  // Delivery metadata survives content retention; its branch still hides expired payloads.
  if (event.source.kind !== "outbound_intent" && expired(event.source.expiresAt))
    return { ...base, contentState: "expired" };
  if (event.source.kind === "web_message") {
    const m = db
      .query(
        "SELECT m.content,m.status,m.role,t.source_valid,t.context_valid,t.generation_status,t.cancel_requested,t.generation_token FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.id=?",
      )
      .get(event.source.id) as {
      content: string;
      status: string;
      source_valid: number;
      context_valid: number;
      role: string;
      generation_status: string;
      cancel_requested: number;
      generation_token: string | null;
    } | null;
    if (!m) return { ...base, contentState: "revoked" };
    if (
      m.status === "pending" ||
      bodyRevision(`${m.status}\0${m.content}`) !== event.source.revision
    )
      return { ...base, contentState: "unavailable" };
    return {
      ...base,
      text: m.content,
      contentState: "active",
      messageStatus: m.status as "completed" | "failed" | "cancelled",
    };
  }
  if (event.source.kind === "qq_event" || event.source.kind === "qq_observation") {
    const row = db
      .query(
        "SELECT t.body,t.expires_at FROM qq_events e LEFT JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.event_key=?",
      )
      .get(event.source.id) as { body: string | null; expires_at: string | null } | null;
    if (!row) return { ...base, contentState: "revoked" };
    const media = db
      .query(
        "SELECT id,segment_kind,note,expires_at FROM qq_media_notes WHERE event_key=? ORDER BY segment_index",
      )
      .all(event.source.id) as {
      id: string;
      segment_kind: string;
      note: string | null;
      expires_at: string;
    }[];
    base.media = media.map((m) => ({
      id: m.id,
      kind: m.segment_kind,
      description: expired(m.expires_at) ? null : m.note,
      availability: expired(m.expires_at) ? "expired" : m.note ? "available" : "unavailable",
    }));
    const stale =
      expired(row.expires_at) ||
      event.sources.some((s) => s.kind === "qq_observation" && expired(s.expiresAt));
    return {
      ...base,
      text: stale ? null : row.body,
      contentState: stale
        ? "expired"
        : row.body || base.media.some((m) => m.availability === "available")
          ? "active"
          : "unavailable",
    };
  }
  if (event.source.kind === "qq_media") {
    const m = db
      .query("SELECT id,segment_kind,note,expires_at,attempts FROM qq_media_notes WHERE id=?")
      .get(event.source.id) as {
      id: string;
      segment_kind: string;
      note: string | null;
      expires_at: string;
      attempts: number;
    } | null;
    if (!m) return { ...base, contentState: "expired" };
    if (expired(m.expires_at)) return { ...base, contentState: "expired" };
    if (String(m.attempts) !== event.source.revision) return base;
    return {
      ...base,
      text: m.note,
      contentState: m.note ? "active" : "unavailable",
      media: [
        {
          id: m.id,
          kind: m.segment_kind,
          description: m.note,
          availability: m.note ? "available" : "unavailable",
        },
      ],
    };
  }
  if (event.source.kind === "qq_speech") {
    const m = db
      .query(
        "SELECT t.body,l.expires_at FROM qq_speech_log l LEFT JOIN qq_speech_text t ON t.speech_id=l.id WHERE l.id=?",
      )
      .get(event.source.id) as { body: string | null; expires_at: string } | null;
    if (!m || expired(m.expires_at)) return { ...base, contentState: "expired" };
    return { ...base, text: m.body, contentState: "active", deliveryStatus: "confirmed" };
  }
  if (event.source.kind === "qq_send") {
    const m = db.query("SELECT * FROM qq_send_log WHERE id=?").get(event.source.id) as {
      account_id: string;
      conversation_kind: string;
      peer_id: string;
      agent_id: string;
      sent_at_seconds: number;
      expires_at: string;
      outcome: string;
    } | null;
    if (!m || expired(m.expires_at)) return { ...base, contentState: "expired" };
    const speech = event.sources.find((s) => s.kind === "qq_speech");
    const body = speech
      ? (db
          .query("SELECT body,expires_at FROM qq_speech_text WHERE speech_id=?")
          .get(speech.id) as { body: string; expires_at: string } | null)
      : null;
    const parts = db
      .query("SELECT sticker_id,result FROM qq_send_part WHERE send_id=? AND part_kind='sticker'")
      .all(event.source.id) as { sticker_id: string; result: string }[];
    return {
      ...base,
      text: body && !expired(body.expires_at) ? body.body : null,
      contentState: body && expired(body.expires_at) ? "expired" : "active",
      deliveryStatus:
        m.outcome === "sent" ? "confirmed" : m.outcome === "unknown" ? "unknown" : "failed",
      media: parts.map((p) => ({
        id: p.sticker_id,
        kind: "sticker",
        description: null,
        availability: p.result === "confirmed" ? "available" : "unavailable",
      })),
    };
  }
  if (event.source.kind === "outbound_intent") {
    const i = db
      .query(
        "SELECT status,expires_at,stale_reason FROM outbound_intents WHERE id=? AND conversation_id=?",
      )
      .get(event.source.id, event.conversationId) as {
      status: ConversationEventView["deliveryStatus"];
      expires_at: string;
      stale_reason: ConversationEventView["deliveryStaleReason"];
    } | null;
    if (!i) return base;
    // 原因只随失效出现：非失效行（含残留合法代码的历史行）一律按 null 投影，与 repo.get 同口径。
    const staleReason = i.status === "stale" ? i.stale_reason : null;
    // 正文回收与未送达原因各自独立，早退分支仍带出原因。
    if (expired(i.expires_at) || expired(event.source.expiresAt))
      return {
        ...base,
        contentState: "expired",
        deliveryStatus: i.status,
        deliveryStaleReason: staleReason,
      };
    const parts = db
      .query("SELECT kind,payload,status FROM outbound_parts WHERE intent_id=? ORDER BY ordinal")
      .all(event.source.id) as { kind: string; payload: string | null; status: string }[];
    const words = parts
      .filter((p) => p.kind === "text" && p.status === "confirmed" && p.payload)
      .map((p) => (JSON.parse(p.payload!) as { text: string }).text);
    return {
      ...base,
      text: words.length ? words.join("\n") : null,
      contentState: "active",
      deliveryStatus: i.status,
      deliveryStaleReason: staleReason,
      media: parts
        .filter((p) => p.kind === "sticker" && p.payload)
        .map((p) => ({
          id: (JSON.parse(p.payload!) as { stickerId: string }).stickerId,
          kind: "sticker",
          description: null,
          availability: p.status === "confirmed" ? "available" : "unavailable",
        })),
    };
  }
  if (event.kind === "wake") return { ...base, contentState: "active" };
  return base;
}

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const at = "2026-01-01T00:00:00.000Z";
const far = "2099-01-01T00:00:00.000Z";
const expiredAt = "2025-01-01T00:00:00.000Z";
const conversationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";

type PageProjector = (
  db: Database,
  events: readonly ConversationEvent[],
  at?: string,
) => ConversationEventView[];
function pageProjector(): PageProjector {
  const project = (projection as unknown as { projectConversationEvents?: PageProjector })
    .projectConversationEvents;
  expect(typeof project).toBe("function");
  return project!;
}

function fixture(historySize = 0) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  const db = h.db;
  db.query(
    "INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('page-scheme','page',?,?)",
  ).run(at, at);
  db.query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,
    scheme_id,created_at,updated_at) VALUES(?,'100','group','200',?,'page-scheme',?,?)`).run(
    bindingId,
    DEFAULT_AGENT_ID,
    at,
    at,
  );
  db.query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,
    binding_epoch,next_seq,consumed_seq,created_at,updated_at)
    VALUES(?,'onebot11','shared',?,?,?,1,101,0,?,?)`).run(
    conversationId,
    bindingId,
    DEFAULT_AGENT_ID,
    DEFAULT_USER_ID,
    at,
    at,
  );
  const events: ConversationEvent[] = [];
  function event(kind: ConversationEvent["kind"], source: ConversationEvent["source"]) {
    const seq = events.length + 1;
    const value: ConversationEvent = {
      conversationId,
      seq,
      eventKey: `page:${seq}`,
      kind,
      source,
      sources: [source],
      occurredAt: at,
      recordedAt: at,
      participant: null,
      addressing: { reasons: [], mentionIds: [] },
      runId: null,
      outputId: null,
    };
    events.push(value);
    return value;
  }
  function wake(
    id: string,
    cause = "chiming_in",
    status = "completed",
    through = 1,
    error: string | null = null,
  ) {
    db.query(`INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,
      ready_at,priority,status,created_at,error_code) VALUES(?,?,?,?,?,?,0,?,?,?)`).run(
      id,
      conversationId,
      cause,
      through,
      id,
      at,
      status,
      at,
      error,
    );
    return id;
  }
  function run(
    id: string,
    wakeId: string | null,
    overrides: Partial<{
      conversation: string | null;
      ownerKind: string;
      owner: string;
      user: string | null;
      agent: string | null;
      spec: string;
      version: string;
      observed: number;
      phase: string;
    }> = {},
  ) {
    const row = {
      conversation: conversationId,
      ownerKind: "conversation",
      owner: conversationId,
      user: DEFAULT_USER_ID,
      agent: DEFAULT_AGENT_ID,
      spec: "onebot.initiative.batch",
      version: "1",
      observed: 1,
      phase: "",
      ...overrides,
    };
    db.query(`INSERT INTO agent_runs(run_id,spec_id,spec_version,owner_kind,owner_id,user_id,
      agent_id,status,started_at,conversation_id,wake_id,observed_seq)
      VALUES(?,?,?,?,?,?,?,'completed',?,?,?,?)`).run(
      id,
      row.spec,
      row.version,
      row.ownerKind,
      row.owner,
      row.user,
      row.agent,
      at,
      row.conversation,
      wakeId,
      row.observed,
    );
    if (row.phase)
      db.query(`INSERT INTO agent_steps(step_id,run_id,step_no,model,phase,status,
      started_at) VALUES(?,?,1,'fixture',?,'completed',?)`).run(`step:${id}`, id, row.phase, at);
    return id;
  }
  function task(
    id: string,
    wakeId: string | null,
    originRun: string | null,
    source: ConversationEvent,
    overrides: Partial<{
      epoch: number;
      agent: string;
      cause: string;
      originEvent: string | null;
      platformId: string | null;
      taskKey: string;
    }> = {},
  ) {
    const row = {
      epoch: 1,
      agent: DEFAULT_AGENT_ID,
      cause: wakeId ? "chiming_in" : "direct_reply",
      originEvent: wakeId ? null : source.source.id,
      platformId: wakeId ? null : source.source.id,
      taskKey: id,
      ...overrides,
    };
    db.query(`INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,
      agent_id,task_class,cause,source_from_seq,source_through_seq,origin_wake_id,
      origin_event_key,platform_message_id,origin_run_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?)`).run(
      id,
      row.taskKey,
      conversationId,
      row.epoch,
      row.agent,
      wakeId ? "ordinary" : "mention",
      row.cause,
      source.seq,
      source.seq,
      wakeId,
      row.originEvent,
      row.platformId,
      originRun,
      at,
      at,
    );
    return id;
  }
  function inbound(id: string, until = far) {
    db.query(`INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,
      message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at)
      VALUES(?,'100','group','200',?,?,1,'member','300',?)`).run(id, DEFAULT_AGENT_ID, id, at);
    db.query("INSERT INTO qq_observation_text VALUES(?,?,1,?,?)").run(
      id,
      `synthetic ${id}`,
      until,
      at,
    );
    return event("inbound", { kind: "qq_event", id, revision: "1", expiresAt: until });
  }
  function outbound(
    id: string,
    taskId: string,
    runId: string,
    source: ConversationEvent,
    overrides: Record<string, unknown> = {},
  ) {
    const target = {
      accountId: "100",
      conversationKind: "group",
      peerId: "200",
      bindingId,
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      qqTaskId: taskId,
      observedThroughSeq: source.seq,
      ...overrides,
    };
    db.query(`INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,
      speech_kind,source_through_seq,deliver_by,status,created_at,expires_at)
      VALUES(?,?,?,0,?,'direct_reply',?,?,'confirmed',?,?)`).run(
      id,
      runId,
      conversationId,
      JSON.stringify(target),
      source.seq,
      far,
      at,
      far,
    );
    db.query(`INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status,
      platform_message_id,finished_at) VALUES(?,?,0,'text',?,'confirmed',?,?)`).run(
      `part:${id}`,
      id,
      JSON.stringify({ text: `synthetic ${id}` }),
      id,
      at,
    );
    return event("delivery", {
      kind: "outbound_intent",
      id,
      revision: "confirmed",
      expiresAt: far,
    });
  }
  db.transaction(() => {
    for (let n = 0; n < historySize; n++) {
      const w = wake(`old-wake:${n}`);
      run(`old-run:${n}`, w);
      // Unrelated retained tasks share the same indexed conversation prefix.
      const source = { seq: n + 1000, source: { id: "unused" } } as ConversationEvent;
      task(`old-task:${n}`, w, `old-run:${n}`, source);
    }
  })();
  return { h, db, events, event, wake, run, task, inbound, outbound };
}

function measure(db: Database, read: () => ConversationEventView[]) {
  const sql: string[] = [];
  let rows = 0;
  const original = db.query.bind(db);
  const trace = spyOn(db, "query").mockImplementation(((text: string) => {
    const statement = original(text);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (key === "get" || key === "all" || key === "values") {
            sql.push(text);
            rows += Array.isArray(result) ? result.length : result ? 1 : 0;
          }
          return result;
        };
      },
    });
  }) as typeof db.query);
  const start = performance.now();
  try {
    return { views: read(), sql, rows, ms: performance.now() - start };
  } finally {
    trace.mockRestore();
  }
}

function expectScalar(f: ReturnType<typeof fixture>, atTime = at) {
  const expected = f.events.map((event) => scalarConversationEvent(f.db, event, atTime));
  expect(pageProjector()(f.db, f.events, atTime)).toEqual(expected);
  return expected;
}

describe("selected conversation page projection", () => {
  for (const historySize of [100, 1000, 10000]) {
    it(`shares metadata reads for 100 selected events with ${historySize} retained activations`, () => {
      const f = fixture(historySize);
      for (let n = 0; n < 40; n++) {
        const source = f.inbound(`input:${n}`);
        const origin = f.run(`mention-run:${n}`, null, {
          spec: "onebot.main",
          observed: source.seq,
        });
        const taskId = f.task(`mention:${n}`, null, origin, source);
        if (n < 30) f.outbound(`delivery:${n}`, taskId, origin, source);
      }
      for (let n = 0; n < 30; n++) {
        const w = f.wake(`selected:${n}`);
        f.run(`judge:${n}`, w, {
          ownerKind: "qq_binding",
          owner: bindingId,
          spec: "onebot.initiative.evaluate_batch",
          phase: "leaf",
        });
        f.event("wake", { kind: "wake", id: w, revision: "1" });
      }
      expect(f.events).toHaveLength(100);
      const expected = f.events.map((event) => scalarConversationEvent(f.db, event, at));
      const project = pageProjector();
      const scalar = measure(f.db, () =>
        f.events.map((event) => scalarConversationEvent(f.db, event, at)),
      );
      const selected = measure(f.db, () => project(f.db, f.events, at));
      expect(selected.views).toEqual(expected);
      expect(selected.sql.length).toBeLessThan(scalar.sql.length);
      // A bounded page may select rows only for its own identities. This counts
      // materialized rows, not SQLite VM visits; query plans and native timings
      // separately establish whether an unavoidable shared scan remains O(N).
      expect(selected.rows).toBeLessThan(1200);
      expect(
        selected.sql.filter((sql) => sql.includes("FROM conversations WHERE id=?")),
      ).toHaveLength(1);
      expect(selected.sql.filter((sql) => sql.includes("WITH scope AS"))).toHaveLength(0);
      expect(
        selected.sql.filter((sql) =>
          /SELECT run_id,source_through_seq,speech_kind,target/.test(sql),
        ),
      ).toHaveLength(30);
      expect(selected.sql.filter((sql) => sql.includes("outbound_intent_metadata"))).toHaveLength(
        1,
      );
      console.info(
        JSON.stringify({
          pageProjectionWork: {
            historySize,
            pageSize: 100,
            scalar: { statements: scalar.sql.length, rows: scalar.rows, ms: scalar.ms },
            selected: { statements: selected.sql.length, rows: selected.rows, ms: selected.ms },
          },
        }),
      );
    });
  }

  it("preserves full wake judgment scope, pending/deferred evidence and unknown state", () => {
    const f = fixture();
    const statuses = ["pending", "completed", "completed", "completed", "completed"];
    const errors = [null, "BATCH_NO_ELIGIBLE_SOURCE", "BATCH_WAITING_FOR_COUNT", null, null];
    for (let n = 0; n < statuses.length; n++) {
      const w = f.wake(`judgment:${n}`, "chiming_in", statuses[n]!, 1, errors[n]);
      f.event("wake", { kind: "wake", id: w, revision: "1" });
    }
    f.run("wrong-owner", "judgment:3", { owner: "foreign", spec: "onebot.main", phase: "next" });
    f.run("wrong-user", "judgment:3", { user: "foreign", spec: "onebot.main", phase: "next" });
    f.run("wrong-agent", "judgment:3", { agent: null, spec: "onebot.main", phase: "next" });
    f.run("valid-no-step", "judgment:4");
    const expected = expectScalar(f);
    expect(expected.map((view) => view.wake?.judgmentStarted)).toEqual([
      false,
      false,
      false,
      undefined,
      false,
    ]);
    f.run("valid-judge", "judgment:3", {
      ownerKind: "qq_binding",
      owner: bindingId,
      spec: "onebot.initiative.evaluate_batch",
      phase: "leaf",
    });
    expect(expectScalar(f)[3]!.wake?.judgmentStarted).toBe(true);
  });

  it("keeps ambiguous direct tasks, exact parent insertion and stale task epochs", () => {
    const f = fixture();
    const input = f.inbound("task-input");
    const first = f.run("direct-origin", null, { spec: "onebot.main" });
    f.task("direct-a", null, first, input);
    expect(expectScalar(f)[0]!.activityId).toBe("direct-a");
    f.task("direct-b", null, first, input);
    expect(expectScalar(f)[0]!.activityId).toBeUndefined();
    f.db.query("DELETE FROM qq_conversation_tasks WHERE id='direct-b'").run();
    const w = f.wake("parent-wake");
    const wakeEvent = f.event("wake", { kind: "wake", id: w, revision: "1" });
    const parent = f.run("parent-origin", w, { observed: wakeEvent.seq });
    f.task("parent-task", w, parent, wakeEvent);
    f.db.query("UPDATE wake_signals SET transferred_task_id='parent-task' WHERE id=?").run(w);
    f.run("parent-retry", w, { observed: wakeEvent.seq });
    f.run("parent-new-child", w, { spec: "onebot.main", observed: wakeEvent.seq });
    f.run("parent-wrong-version", w, { version: "2", observed: wakeEvent.seq });
    expect(expectScalar(f)[1]!.runId).toBe("parent-retry");
    f.db.query("UPDATE agent_runs SET agent_id=NULL WHERE run_id='parent-origin'").run();
    expect(expectScalar(f)[1]!.runId).toBe("parent-origin");
    f.db.query("UPDATE qq_conversation_tasks SET binding_epoch=2").run();
    expect(expectScalar(f).map((view) => view.activityId)).toEqual([undefined, undefined]);
  });

  it("does not treat JSON booleans or compound IDs as scalar metadata identities", () => {
    const f = fixture();
    const source = f.inbound("typed-input");
    const run = f.run("typed-run", null, { spec: "onebot.main", observed: source.seq });
    const task = f.task("typed-task", null, run, source);
    const delivery = f.outbound("typed-delivery", task, run, source);
    const original = (
      f.db.query("SELECT target FROM outbound_intents WHERE id=?").get(delivery.source.id) as {
        target: string;
      }
    ).target;
    for (const override of [
      { bindingEpoch: true },
      { bindingEpoch: "1" },
      { bindingEpoch: [1] },
      { bindingEpoch: { value: 1 } },
      { qqTaskId: [task] },
      { qqTaskId: { id: task } },
      { qqTaskId: 1 },
      { observedThroughSeq: true },
      { observedThroughSeq: "1" },
      { observedThroughSeq: [1] },
      { observedThroughSeq: { value: 1 } },
    ]) {
      f.db
        .query("UPDATE outbound_intents SET target=? WHERE id=?")
        .run(JSON.stringify({ ...JSON.parse(original), ...override }), delivery.source.id);
      expect(expectScalar(f)[1]!.activityId).toBeUndefined();
    }
    for (const observed of [null, undefined, source.seq]) {
      f.db
        .query("UPDATE outbound_intents SET target=? WHERE id=?")
        .run(
          JSON.stringify({ ...JSON.parse(original), observedThroughSeq: observed }),
          delivery.source.id,
        );
      expect(expectScalar(f)[1]!.activityId).toBe(task);
    }
  });

  it("rereads scope, outbound target types, expiry and revisions on the next call", () => {
    const f = fixture();
    const source = f.inbound("fresh-input");
    const run = f.run("fresh-run", null, { spec: "onebot.main", observed: source.seq });
    const task = f.task("fresh-task", null, run, source);
    const delivery = f.outbound("fresh-delivery", task, run, source);
    expect(expectScalar(f)[1]!.activityId).toBe(task);
    f.db
      .query("UPDATE outbound_intents SET target=json_set(target,'$.bindingEpoch','1') WHERE id=?")
      .run(delivery.source.id);
    expect(expectScalar(f)[1]!.activityId).toBeUndefined();
    f.db
      .query("UPDATE outbound_intents SET target=json_set(target,'$.bindingEpoch',1) WHERE id=?")
      .run(delivery.source.id);
    expect(expectScalar(f)[1]!.activityId).toBe(task);
    f.db
      .query("UPDATE outbound_intents SET expires_at=? WHERE id=?")
      .run(expiredAt, delivery.source.id);
    expect(expectScalar(f)[1]).toMatchObject({
      contentState: "expired",
      text: null,
      deliveryStatus: "confirmed",
    });
    f.db
      .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
      .run(expiredAt, source.source.id);
    expect(expectScalar(f)[0]).toMatchObject({ contentState: "expired", text: null });
    f.db.query("UPDATE conversations SET binding_epoch=2 WHERE id=?").run(conversationId);
    expect(expectScalar(f).every((view) => view.activityId === undefined)).toBe(true);
    expect(pageProjector()(f.db, [], at)).toEqual([]);
  });
});
