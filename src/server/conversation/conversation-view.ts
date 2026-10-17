import type { Database } from "bun:sqlite";
import type { ConversationEvent, ConversationEventView } from "../../shared/contracts/conversation";
import { bodyRevision } from "../db/conversation-event-repository";

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
export function projectConversationEvent(
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
