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

type ProjectionConversation = {
  binding_epoch: number;
  agent_id: string;
  source_id: string;
  user_id: string;
};

type ProjectionIntent = {
  run_id: string;
  source_through_seq: number;
  speech_kind: string;
  qq_task_id: unknown;
  binding_id: unknown;
  binding_epoch: unknown;
  agent_id: unknown;
  observed_through_seq: unknown;
};

type ProjectedActivity = {
  activityId: string;
  task: NonNullable<ConversationEventView["task"]>;
  runId: string | null;
};

type PageMetadata = {
  conversations: Map<string, ProjectionConversation | null>;
  wakes: Map<string, ProjectedWake>;
  tasks: Map<string, ProjectedTask[]>;
  intents: Map<string, ProjectionIntent>;
  activities: Map<string, ProjectedActivity | undefined>;
  judgments: Map<string, { started: boolean | undefined; latestRunId: string }>;
};

const eventIdentity = (event: ConversationEvent) =>
  JSON.stringify([event.conversationId, event.kind, event.seq, event.source.kind, event.source.id]);
const wakeIdentity = (conversationId: string, wakeId: string) =>
  JSON.stringify([conversationId, wakeId]);

/** Metadata is selected once for this synchronous projection, never retained across reads. */
function pageMetadata(db: Database, events: readonly ConversationEvent[]): PageMetadata {
  const page: PageMetadata = {
    conversations: new Map(),
    wakes: new Map(),
    tasks: new Map(),
    intents: new Map(),
    judgments: new Map(),
    activities: new Map(),
  };
  const groups = new Map<string, ConversationEvent[]>();
  for (const event of events) {
    if (
      !(
        (event.kind === "wake" && event.source.kind === "wake") ||
        (event.kind === "inbound" && event.source.kind === "qq_event") ||
        event.source.kind === "outbound_intent"
      )
    )
      continue;
    const group = groups.get(event.conversationId) ?? [];
    group.push(event);
    groups.set(event.conversationId, group);
  }
  for (const [conversationId, selected] of groups) {
    const conversation = db
      .query("SELECT binding_epoch,agent_id,source_id,user_id FROM conversations WHERE id=?")
      .get(conversationId) as ProjectionConversation | null;
    page.conversations.set(conversationId, conversation);
    const wakeIds = [
      ...new Set(
        selected
          .filter((event) => event.kind === "wake" && event.source.kind === "wake")
          .map((event) => event.source.id),
      ),
    ];
    const transferred = new Map<string, string | null>();
    if (wakeIds.length) {
      const placeholders = wakeIds.map(() => "?").join(",");
      const wakes = db
        .query(`SELECT id,cause,status,ready_at,error_code,through_seq,
        transferred_task_id FROM wake_signals WHERE conversation_id=? AND id IN (${placeholders})`)
        .all(conversationId, ...wakeIds) as (ProjectedWake & {
        transferred_task_id: string | null;
      })[];
      for (const wake of wakes) {
        page.wakes.set(wakeIdentity(conversationId, wake.id), wake);
        transferred.set(wake.id, wake.transferred_task_id);
      }
      if (conversation) {
        const judgments = db
          .query(`WITH evidence AS (
          SELECT r.wake_id,MAX(r.rowid) AS latest_rowid,
            MAX(CASE WHEN ((r.owner_kind='conversation' AND r.owner_id=?)
                OR (r.owner_kind='qq_binding' AND r.owner_id=?))
              AND r.user_id=? AND r.agent_id=? THEN 1 ELSE 0 END) AS has_run,
            MAX(CASE WHEN ((r.owner_kind='conversation' AND r.owner_id=?)
                OR (r.owner_kind='qq_binding' AND r.owner_id=?))
              AND r.user_id=? AND r.agent_id=? AND EXISTS (
                SELECT 1 FROM agent_steps step WHERE step.run_id=r.run_id AND (
                  (r.owner_kind='qq_binding' AND r.spec_id='onebot.initiative.evaluate_batch'
                    AND step.phase='leaf')
                  OR (r.owner_kind='conversation' AND r.spec_id='onebot.main' AND step.phase='next')
                )
              ) THEN 1 ELSE 0 END) AS intent_step_started
          FROM agent_runs r INDEXED BY ix_agent_runs_conversation
          WHERE r.conversation_id=? AND r.wake_id IN (${placeholders}) GROUP BY r.wake_id
        ) SELECT e.wake_id,e.has_run,e.intent_step_started,r.run_id AS latest_run_id
          FROM evidence e JOIN agent_runs r ON r.rowid=e.latest_rowid`)
          .all(
            conversationId,
            conversation.source_id,
            conversation.user_id,
            conversation.agent_id,
            conversationId,
            conversation.source_id,
            conversation.user_id,
            conversation.agent_id,
            conversationId,
            ...wakeIds,
          ) as {
          wake_id: string;
          has_run: number;
          intent_step_started: number;
          latest_run_id: string;
        }[];
        for (const judgment of judgments) {
          page.judgments.set(wakeIdentity(conversationId, judgment.wake_id), {
            started:
              judgment.intent_step_started === 1 ? true : judgment.has_run ? false : undefined,
            latestRunId: judgment.latest_run_id,
          });
        }
      }
    }
    if (!conversation) continue;
    const intentIds = [
      ...new Set(
        selected
          .filter((event) => event.source.kind === "outbound_intent")
          .map((event) => event.source.id),
      ),
    ];
    if (intentIds.length) {
      const intents = db
        .query(`SELECT metadata.intent_id,metadata.run_id,
        metadata.source_through_seq,metadata.speech_kind,metadata.qq_task_id,metadata.binding_id,
        metadata.binding_epoch,metadata.agent_id,metadata.observed_through_seq
        FROM json_each(?) selected
        CROSS JOIN outbound_intent_metadata metadata ON metadata.intent_id=selected.value
        WHERE metadata.conversation_id=?`)
        .all(JSON.stringify(intentIds), conversationId) as (ProjectionIntent & {
        intent_id: string;
      })[];
      for (const intent of intents) page.intents.set(intent.intent_id, intent);
    }
    const taskIds = new Set<string>();
    for (const id of transferred.values()) if (id) taskIds.add(id);
    const throughSeqs = new Set<number>();
    for (const event of selected) {
      if (event.kind === "inbound" && event.source.kind === "qq_event") throughSeqs.add(event.seq);
      const wake = page.wakes.get(wakeIdentity(conversationId, event.source.id));
      if (event.kind === "wake" && wake?.cause === "direct_reply")
        throughSeqs.add(wake.through_seq);
      const intent = page.intents.get(event.source.id);
      if (
        event.source.kind === "outbound_intent" &&
        intent &&
        typeof intent.qq_task_id === "string" &&
        intent.binding_id === conversation.source_id &&
        intent.binding_epoch === conversation.binding_epoch &&
        intent.agent_id === conversation.agent_id
      )
        taskIds.add(intent.qq_task_id);
    }
    type CandidateTask = ProjectedTask & {
      origin_event_key?: string | null;
      task_class?: string;
    };
    const tasksById = new Map<string, CandidateTask>();
    const columns =
      "t.id,t.status,t.error_code,t.origin_run_id,t.origin_wake_id,t.cause,t.source_through_seq";
    const scopeArgs = [conversationId, conversation.binding_epoch, conversation.agent_id];
    if (taskIds.size) {
      const tasks = db
        .query(`SELECT ${columns} FROM json_each(?) selected
        CROSS JOIN qq_conversation_tasks t ON t.id=selected.value
        WHERE t.conversation_id=? AND t.binding_epoch=? AND t.agent_id=?`)
        .all(JSON.stringify([...taskIds]), ...scopeArgs) as CandidateTask[];
      for (const task of tasks) tasksById.set(task.id, task);
    }
    if (throughSeqs.size) {
      const tasks = db
        .query(`SELECT ${columns},t.origin_event_key,t.task_class
        FROM qq_conversation_tasks t WHERE t.conversation_id=? AND t.binding_epoch=? AND t.agent_id=?
          AND t.task_class='mention' AND t.cause='direct_reply' AND t.origin_wake_id IS NULL
          AND t.source_through_seq IN (${[...throughSeqs].map(() => "?").join(",")})`)
        .all(...scopeArgs, ...throughSeqs) as CandidateTask[];
      for (const task of tasks) tasksById.set(task.id, task);
    }
    const tasks = [...tasksById.values()];
    for (const event of selected) {
      let candidates: ProjectedTask[] = [];
      if (event.kind === "wake" && event.source.kind === "wake") {
        candidates = tasks.filter(
          (task) =>
            task.id === transferred.get(event.source.id) && task.origin_wake_id === event.source.id,
        );
        const wake = page.wakes.get(wakeIdentity(conversationId, event.source.id));
        if (!candidates.length && wake?.cause === "direct_reply") {
          candidates = tasks.filter(
            (task) =>
              task.task_class === "mention" &&
              task.cause === "direct_reply" &&
              task.origin_wake_id === null &&
              task.source_through_seq === wake.through_seq &&
              typeof task.origin_event_key === "string" &&
              !!db
                .query(`SELECT 1
              FROM conversation_events WHERE conversation_id=? AND seq=? AND source_kind='qq_event'
                AND source_id=? AND kind='inbound'`)
                .get(conversationId, task.source_through_seq, task.origin_event_key),
          );
        }
      } else if (event.kind === "inbound" && event.source.kind === "qq_event") {
        candidates = tasks.filter(
          (task) =>
            task.task_class === "mention" &&
            task.cause === "direct_reply" &&
            task.origin_wake_id === null &&
            task.source_through_seq === event.seq &&
            task.origin_event_key === event.source.id,
        );
      } else if (event.source.kind === "outbound_intent") {
        const intent = page.intents.get(event.source.id);
        if (
          intent &&
          typeof intent.qq_task_id === "string" &&
          intent.binding_id === conversation.source_id &&
          intent.binding_epoch === conversation.binding_epoch &&
          intent.agent_id === conversation.agent_id
        )
          candidates = tasks.filter(
            (task) =>
              task.id === intent.qq_task_id &&
              task.source_through_seq === intent.source_through_seq &&
              task.cause === intent.speech_kind,
          );
      }
      page.tasks.set(eventIdentity(event), candidates);
    }
  }
  return page;
}

function initiativeJudgementStarted(
  page: PageMetadata,
  wake: ProjectedWake,
  conversationId: string,
): boolean | undefined {
  if (wake.cause !== "chiming_in" && wake.cause !== "idle_topic") return undefined;
  const judgment = page.judgments.get(wakeIdentity(conversationId, wake.id));
  if (judgment?.started === true) return true;
  if (
    judgment?.started === false ||
    wake.status === "pending" ||
    wake.status === "leased" ||
    wake.error_code === "BATCH_NO_ELIGIBLE_SOURCE" ||
    wake.error_code === "BATCH_WAITING_FOR_COUNT"
  )
    return false;
  return undefined;
}

function taskActivity(
  db: Database,
  event: ConversationEvent,
  page: PageMetadata,
): ProjectedActivity | undefined {
  const candidates = page.tasks.get(eventIdentity(event)) ?? [];
  if (candidates.length !== 1) return undefined;
  const key = JSON.stringify([
    event.conversationId,
    event.source.kind === "outbound_intent" ? "intent" : "task",
    event.source.kind === "outbound_intent" ? event.source.id : candidates[0]!.id,
  ]);
  if (!page.activities.has(key)) page.activities.set(key, resolveTaskActivity(db, event, page));
  return page.activities.get(key);
}

function resolveTaskActivity(
  db: Database,
  event: ConversationEvent,
  page: PageMetadata,
): ProjectedActivity | undefined {
  const conversation = page.conversations.get(event.conversationId);
  if (!conversation) return undefined;
  const candidates = page.tasks.get(eventIdentity(event)) ?? [];
  if (event.source.kind === "outbound_intent") {
    if (candidates.length !== 1) return undefined;
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
      candidate.id !== target.qqTaskId ||
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
  return projectConversationEvents(db, [event], at)[0]!;
}

/** Only this selected page shares synchronous metadata work; source bodies stay on demand. */
export function projectConversationEvents(
  db: Database,
  events: readonly ConversationEvent[],
  at = new Date().toISOString(),
): ConversationEventView[] {
  const page = pageMetadata(db, events);
  return events.map((event) => projectEvent(db, event, at, page));
}

function projectEvent(
  db: Database,
  event: ConversationEvent,
  at: string,
  page: PageMetadata,
): ConversationEventView {
  const wake =
    event.kind === "wake" && event.source.kind === "wake"
      ? (page.wakes.get(wakeIdentity(event.conversationId, event.source.id)) ?? null)
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
    ...taskActivity(db, event, page),
  };
  if (event.kind === "wake" && event.source.kind === "wake") {
    if (!wake) return { ...base, contentState: "revoked" };
    const runId = base.task
      ? null
      : page.judgments.get(wakeIdentity(event.conversationId, wake.id))?.latestRunId;
    const judgmentStarted = initiativeJudgementStarted(page, wake, event.conversationId);
    return {
      ...base,
      contentState: "active",
      runId: base.runId ?? runId ?? null,
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
