import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ConversationAddressing,
  ConversationEvent,
  ConversationSummary,
} from "../../shared/contracts/conversation";
import type { SourceRef } from "../../shared/contracts/evidence";
import { DEFAULT_USER_ID } from "./repositories";

type ConversationRow = {
  id: string;
  channel: "web" | "onebot11";
  topology: "direct" | "shared";
  source_id: string;
  agent_id: string;
  user_id: string;
  binding_epoch: number;
  source_watermark: number;
  next_seq: number;
  consumed_seq: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
type OneBotBindingSource = {
  id: string;
  account_id: string;
  conversation_kind: string;
  peer_id: string;
  agent_id: string;
};
type EventRow = {
  conversation_id: string;
  seq: number;
  event_key: string;
  kind: ConversationEvent["kind"];
  source_kind: string;
  source_id: string;
  source_revision: string;
  source_expires_at: string | null;
  sources: string;
  participant: string | null;
  addressing: string;
  occurred_at: string;
  recorded_at: string;
  run_id: string | null;
  output_id: string | null;
};
export const noAddressing: ConversationAddressing = { reasons: [], mentionIds: [] };
export const bodyRevision = (body: string) => createHash("sha256").update(body).digest("hex");
const eventFromRow = (r: EventRow): ConversationEvent => ({
  conversationId: r.conversation_id,
  seq: r.seq,
  eventKey: r.event_key,
  kind: r.kind,
  source: {
    kind: r.source_kind,
    id: r.source_id,
    revision: r.source_revision,
    ...(r.source_expires_at ? { expiresAt: r.source_expires_at } : {}),
  },
  sources: JSON.parse(r.sources),
  participant: r.participant ? JSON.parse(r.participant) : null,
  addressing: JSON.parse(r.addressing),
  occurredAt: r.occurred_at,
  recordedAt: r.recorded_at,
  runId: r.run_id,
  outputId: r.output_id,
});

/** Source-reference journal. SQLite allocates seq inside the same transaction as dedup. */
export class ConversationEventRepository {
  constructor(readonly db: Database) {}
  row(id: string): ConversationRow | null {
    return this.db
      .query("SELECT * FROM conversations WHERE id=?")
      .get(id) as ConversationRow | null;
  }
  ensureWeb(sessionId: string, userId?: string): ConversationSummary | null {
    const s = this.db
      .query("SELECT id,user_id,agent_id,created_at FROM sessions WHERE id=?")
      .get(sessionId) as {
      id: string;
      user_id: string;
      agent_id: string;
      created_at: string;
    } | null;
    if (!s || (userId !== undefined && userId !== s.user_id)) return null;
    return this.ensure({
      channel: "web",
      topology: "direct",
      sourceId: s.id,
      agentId: s.agent_id,
      userId: s.user_id,
      at: s.created_at,
    });
  }
  ensureOneBot(bindingId: string): ConversationSummary | null {
    const b = this.db.query("SELECT b.* FROM qq_bindings b WHERE b.id=?").get(bindingId) as {
      id: string;
      conversation_kind: string;
      agent_id: string;
      user_id: string;
      created_at: string;
    } | null;
    return b
      ? this.ensure({
          channel: "onebot11",
          topology: b.conversation_kind === "private" ? "direct" : "shared",
          sourceId: b.id,
          agentId: b.agent_id,
          userId: DEFAULT_USER_ID,
          at: b.created_at,
        })
      : null;
  }
  private ensure(input: {
    channel: ConversationRow["channel"];
    topology: ConversationRow["topology"];
    sourceId: string;
    agentId: string;
    userId: string;
    at: string;
  }): ConversationSummary {
    return this.db.transaction(() => {
      let row = this.db
        .query("SELECT * FROM conversations WHERE channel=? AND source_id=? AND closed_at IS NULL")
        .get(input.channel, input.sourceId) as ConversationRow | null;
      if (row && row.agent_id !== input.agentId) {
        this.db
          .query("UPDATE conversations SET closed_at=? WHERE id=?")
          .run(new Date().toISOString(), row.id);
        row = null;
      }
      if (!row) {
        const previous = this.db
          .query(
            "SELECT MAX(binding_epoch) AS n FROM conversations WHERE channel=? AND source_id=?",
          )
          .get(input.channel, input.sourceId) as { n: number | null };
        const id = crypto.randomUUID();
        this.db
          .query(
            "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at,source_watermark) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.channel,
            input.topology,
            input.sourceId,
            input.agentId,
            input.userId,
            (previous.n ?? 0) + 1,
            previous.n ? new Date().toISOString() : input.at,
            previous.n ? new Date().toISOString() : input.at,
            previous.n
              ? (
                  this.db.query("SELECT COALESCE(MAX(rowid),0) AS n FROM qq_events").get() as {
                    n: number;
                  }
                ).n
              : 0,
          );
        row = this.row(id)!;
        if (input.channel === "onebot11" && previous.n && this.historyRows(id).length === 1) {
          // Upgrade may have indexed B while legacy source tables still contain A.
          // At A's first real activation, import its retained references as an already
          // consumed prefix. The original source watermark still rejects these facts
          // on ingress/scan, so old addressed messages cannot become fresh opportunities.
          const binding = this.db
            .query("SELECT * FROM qq_bindings WHERE id=?")
            .get(input.sourceId) as OneBotBindingSource;
          this.backfillOneBot(binding, this.summary(row), true);
          row = this.row(id)!;
          this.acknowledge(id, row.next_seq - 1);
          row = this.row(id)!;
        }
      }
      return this.summary(row);
    })();
  }
  get(id: string, userId?: string): ConversationSummary | null {
    const r = this.row(id);
    return r && (!userId || r.user_id === userId) ? this.summary(r) : null;
  }
  /** Read scope only. Execution continues to use one immutable activation row and local seq. */
  historyRows(id: string): ConversationRow[] {
    return this.db
      .query(`SELECT c.* FROM conversations c JOIN conversations anchor ON anchor.id=?
        WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id
          AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id
        ORDER BY c.binding_epoch`)
      .all(id) as ConversationRow[];
  }
  historySummary(id: string): ConversationSummary | null {
    const rows = this.historyRows(id);
    const current = rows.at(-1);
    if (!current || current.closed_at !== null) return null;
    const offset = rows.slice(0, -1).reduce((total, row) => total + row.next_seq - 1, 0);
    return {
      ...this.summary(current),
      id: rows[0]!.id,
      lastSeq: offset + current.next_seq - 1,
      // Sealed activations have no actionable input. This is a read-view position,
      // never a watermark passed to acknowledge(), WakeRepository or an output intent.
      consumedSeq: offset + current.consumed_seq,
    };
  }
  /**
   * Stable history cursor: sealed epochs cannot append, so their seq ranges never move.
   * Keep the physical event identity until projection (wake/run joins require that ID).
   * Do not call this from an Agent host, scheduler or delivery authorization path.
   */
  historyAfter(
    id: string,
    after = 0,
    limit = 100,
  ): { items: { event: ConversationEvent; seq: number }[]; nextSeq: number; hasMore: boolean } {
    const rows = this.db
      .query(`WITH epochs AS (
        SELECT c.id, COALESCE(SUM(c.next_seq-1) OVER (
          ORDER BY c.binding_epoch ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),0) AS offset FROM conversations c JOIN conversations anchor ON anchor.id=?
        WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id
          AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id
      ) SELECT e.*,e.seq+epochs.offset AS history_seq FROM epochs
        JOIN conversation_events e ON e.conversation_id=epochs.id
        WHERE e.seq+epochs.offset>? ORDER BY history_seq LIMIT ?`)
      .all(id, after, limit + 1) as (EventRow & { history_seq: number })[];
    const items = rows.slice(0, limit).map((row) => ({
      event: eventFromRow(row),
      seq: row.history_seq,
    }));
    return { items, nextSeq: items.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }

  private summary(r: ConversationRow): ConversationSummary {
    const agent = this.db.query("SELECT name FROM agents WHERE id=?").get(r.agent_id) as {
      name: string;
    } | null;
    let title = "";
    let peerId = r.user_id;
    if (r.channel === "web") {
      title =
        (
          this.db.query("SELECT title FROM sessions WHERE id=?").get(r.source_id) as {
            title: string;
          } | null
        )?.title ?? "";
    } else {
      const b = this.db.query("SELECT peer_id FROM qq_bindings WHERE id=?").get(r.source_id) as {
        peer_id: string;
      } | null;
      peerId = b?.peer_id ?? r.source_id;
      title = `${r.topology === "shared" ? "群聊" : "私聊"} ${peerId}`;
    }
    return {
      id: r.id,
      channel: r.channel,
      topology: r.topology,
      sourceId: r.source_id,
      agentId: r.agent_id,
      bindingEpoch: r.binding_epoch,
      title,
      participants: [
        { id: r.agent_id, label: agent?.name ?? r.agent_id, role: "agent" },
        { id: peerId, label: peerId, role: r.topology === "shared" ? "member" : "user" },
      ],
      updatedAt: r.updated_at,
      lastSeq: r.next_seq - 1,
      consumedSeq: r.consumed_seq,
    };
  }
  list(input: {
    userId: string;
    channel?: ConversationRow["channel"];
    sourceId?: string;
    cursor?: string;
    limit?: number;
  }): { items: ConversationSummary[]; nextCursor: string | null } {
    const where = ["user_id=?", "closed_at IS NULL"];
    const args: (string | number)[] = [input.userId];
    if (input.channel) {
      where.push("channel=?");
      args.push(input.channel);
    }
    if (input.sourceId) {
      where.push("source_id=?");
      args.push(input.sourceId);
    }
    if (input.cursor) {
      const [at, id] = JSON.parse(Buffer.from(input.cursor, "base64url").toString()) as [
        string,
        string,
      ];
      where.push("(updated_at<? OR(updated_at=? AND id<?))");
      args.push(at, at, id);
    }
    const limit = input.limit ?? 50;
    args.push(limit + 1);
    const rows = this.db
      .query(
        `SELECT * FROM conversations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      )
      .all(...args) as ConversationRow[];
    const items = rows.slice(0, limit).map((r) => this.summary(r));
    const last = rows[limit - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString("base64url")
          : null,
    };
  }
  sourceThroughSeq(conversationId: string): number {
    return (
      this.db
        .query(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_events WHERE conversation_id=? AND kind IN('inbound','outbound','media_revision')",
        )
        .get(conversationId) as { seq: number }
    ).seq;
  }
  append(
    input: Omit<
      ConversationEvent,
      "seq" | "recordedAt" | "sources" | "participant" | "addressing" | "runId" | "outputId"
    > &
      Partial<
        Pick<
          ConversationEvent,
          "recordedAt" | "sources" | "participant" | "addressing" | "runId" | "outputId"
        >
      >,
  ): ConversationEvent {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_key=?")
        .get(input.conversationId, input.eventKey) as EventRow | null;
      if (existing) return eventFromRow(existing);
      const row = this.row(input.conversationId);
      if (!row || row.closed_at) throw new Error("CONVERSATION_CLOSED");
      const at = input.recordedAt ?? new Date().toISOString();
      this.db
        .query(
          `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.id,
          row.next_seq,
          input.eventKey,
          input.kind,
          input.source.kind,
          input.source.id,
          input.source.revision,
          input.source.expiresAt ?? null,
          JSON.stringify(input.sources ?? [input.source]),
          input.participant ? JSON.stringify(input.participant) : null,
          JSON.stringify(input.addressing ?? noAddressing),
          input.occurredAt,
          at,
          input.runId ?? null,
          input.outputId ?? null,
        );
      this.db
        .query(
          "UPDATE conversations SET next_seq=next_seq+1,updated_at=MAX(updated_at,?) WHERE id=?",
        )
        .run(at, row.id);
      return {
        ...input,
        seq: row.next_seq,
        recordedAt: at,
        sources: input.sources ?? [input.source],
        participant: input.participant ?? null,
        addressing: input.addressing ?? noAddressing,
        runId: input.runId ?? null,
        outputId: input.outputId ?? null,
      };
    })();
  }
  eventsAfter(
    conversationId: string,
    after = 0,
    limit = 100,
  ): { items: ConversationEvent[]; nextSeq: number; hasMore: boolean } {
    const rows = this.db
      .query(
        "SELECT * FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(conversationId, after, limit + 1) as EventRow[];
    const items = rows.slice(0, limit).map(eventFromRow);
    return { items, nextSeq: items.at(-1)?.seq ?? after, hasMore: rows.length > limit };
  }
  acknowledge(conversationId: string, throughSeq: number): void {
    const result = this.db
      .query("UPDATE conversations SET consumed_seq=MAX(consumed_seq,?) WHERE id=? AND ?<next_seq")
      .run(throughSeq, conversationId, throughSeq);
    if (!result.changes) throw new Error("CONVERSATION_SEQUENCE_INVALID");
  }
  linkRun(runId: string, conversationId: string, observedSeq: number, wakeId?: string): void {
    this.db
      .query("UPDATE agent_runs SET conversation_id=?,observed_seq=?,wake_id=? WHERE run_id=?")
      .run(conversationId, observedSeq, wakeId ?? null, runId);
  }
  ingestWebMessage(messageId: string): ConversationEvent | null {
    const m = this.db
      .query(
        "SELECT m.*,t.generation_token,t.source_valid,t.generation_status,t.cancel_requested FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.id=?",
      )
      .get(messageId) as {
      id: string;
      session_id: string;
      turn_id: string;
      role: string;
      content: string;
      status: string;
      created_at: string;
      generation_token: string | null;
      source_valid: number;
      generation_status: string;
      cancel_requested: number;
    } | null;
    if (!m || m.role === "system" || m.status === "pending") return null;
    const conversation = this.ensureWeb(m.session_id);
    if (!conversation) return null;
    return this.append({
      conversationId: conversation.id,
      eventKey: `web:${m.id}:${m.status}:${bodyRevision(m.content)}`,
      kind: m.role === "assistant" ? "outbound" : "inbound",
      source: {
        kind: "web_message",
        id: m.id,
        revision: bodyRevision(`${m.status}\0${m.content}`),
      },
      sources: [
        { kind: "web_message", id: m.id, revision: bodyRevision(`${m.status}\0${m.content}`) },
        { kind: "web_turn", id: m.turn_id, revision: m.generation_token ?? "completed" },
      ],
      participant: {
        id: m.role === "assistant" ? conversation.agentId : this.row(conversation.id)!.user_id,
        label: m.role === "assistant" ? conversation.participants[0]!.label : "用户",
        role: m.role === "assistant" ? "agent" : "user",
      },
      addressing: { reasons: m.role === "user" ? ["request"] : [], mentionIds: [] },
      occurredAt: m.created_at,
      recordedAt: m.created_at,
    });
  }
  ingestOneBotEvent(
    eventKey: string,
    bindingId: string,
    addressing?: ConversationAddressing,
  ): ConversationEvent | null {
    const c = this.ensureOneBot(bindingId);
    return c ? this.ingestOneBotReference(eventKey, bindingId, c, addressing) : null;
  }
  private ingestOneBotReference(
    eventKey: string,
    bindingId: string,
    c: ConversationSummary,
    addressing?: ConversationAddressing,
    historical = false,
  ): ConversationEvent | null {
    const e = this.db
      .query(
        `SELECT e.rowid AS source_rowid,e.*,t.body,t.expires_at FROM qq_events e LEFT JOIN qq_observation_text t ON t.event_key=e.event_key JOIN qq_bindings b ON b.account_id=e.account_id AND b.conversation_kind=e.conversation_kind AND b.peer_id=e.peer_id AND b.agent_id=e.agent_id WHERE e.event_key=? AND b.id=?`,
      )
      .get(eventKey, bindingId) as {
      source_rowid: number;
      event_key: string;
      message_id: string;
      body: string | null;
      expires_at: string | null;
      speaker_kind: string;
      speaker_id: string | null;
      occurred_at_seconds: number;
      recorded_at: string;
      addressed: number | null;
    } | null;
    if (
      !e ||
      (!historical && c.bindingEpoch > 1 && e.source_rowid <= this.row(c.id)!.source_watermark)
    )
      return null;
    const source: SourceRef = { kind: "qq_event", id: eventKey, revision: e.recorded_at };
    const sources: SourceRef[] = [source];
    if (e.body && e.expires_at)
      sources.push({
        kind: "qq_observation",
        id: eventKey,
        revision: bodyRevision(e.body),
        expiresAt: e.expires_at,
      });
    return this.append({
      conversationId: c.id,
      eventKey: `onebot:${eventKey}`,
      kind: "inbound",
      source,
      sources,
      occurredAt: new Date(e.occurred_at_seconds * 1000).toISOString(),
      recordedAt: e.recorded_at,
      participant: {
        id: e.speaker_id ?? "anonymous",
        label: e.speaker_id ?? "匿名",
        role: e.speaker_kind === "member" ? "member" : "anonymous",
      },
      addressing: addressing ?? {
        reasons: c.topology === "direct" ? ["private"] : e.addressed ? ["legacy_addressed"] : [],
        mentionIds: [],
      },
    });
  }
  ingestMedia(noteId: string, bindingId: string): ConversationEvent | null {
    const c = this.ensureOneBot(bindingId);
    return c ? this.ingestMediaReference(noteId, bindingId, c) : null;
  }
  private ingestMediaReference(
    noteId: string,
    bindingId: string,
    c: ConversationSummary,
    historical = false,
  ): ConversationEvent | null {
    const n = this.db.query("SELECT * FROM qq_media_notes WHERE id=?").get(noteId) as {
      id: string;
      event_key: string;
      attempts: number;
      updated_at: string;
      expires_at: string;
      note: string | null;
    } | null;
    if (!n) return null;
    const parent = this.ingestOneBotReference(n.event_key, bindingId, c, undefined, historical);
    if (!parent) return null;
    return this.append({
      conversationId: parent.conversationId,
      eventKey: `media:${n.id}:${n.attempts}`,
      kind: "media_revision",
      source: { kind: "qq_media", id: n.id, revision: String(n.attempts), expiresAt: n.expires_at },
      sources: [
        parent.source,
        { kind: "qq_media", id: n.id, revision: String(n.attempts), expiresAt: n.expires_at },
      ],
      occurredAt: n.updated_at,
      recordedAt: n.updated_at,
      participant: parent.participant,
      addressing: parent.addressing,
    });
  }
  /** Idempotent reference-only backfill before activation; history does not enqueue wakes. */
  backfill(): void {
    this.db.transaction(() => {
      for (const s of this.db.query("SELECT id FROM sessions ORDER BY created_at,id").all() as {
        id: string;
      }[])
        this.ensureWeb(s.id);
      for (const m of this.db
        .query("SELECT id FROM messages WHERE status!='pending' ORDER BY created_at,sequence_no,id")
        .all() as { id: string }[])
        this.ingestWebMessage(m.id);
      for (const b of this.db
        .query(
          "SELECT id,account_id,conversation_kind,peer_id,agent_id FROM qq_bindings ORDER BY created_at,id",
        )
        .all() as {
        id: string;
        account_id: string;
        conversation_kind: string;
        peer_id: string;
        agent_id: string;
      }[]) {
        const c = this.ensureOneBot(b.id)!;
        if (c.bindingEpoch === 1) this.backfillOneBot(b, c, false);
      }
    })();
  }
  private backfillOneBot(
    b: OneBotBindingSource,
    c: ConversationSummary,
    historical: boolean,
  ): void {
    const events = this.db
      .query(
        "SELECT event_key AS id,occurred_at_seconds AS time,recorded_at FROM qq_events WHERE account_id=? AND conversation_kind=? AND peer_id=? AND agent_id=?",
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id) as {
      id: string;
      time: number;
      recorded_at: string;
    }[];
    const speeches = this.db
      .query(
        "SELECT id,spoke_at_seconds AS time,kind,expires_at,recorded_at FROM qq_speech_log WHERE account_id=? AND conversation_kind=? AND peer_id=? AND agent_id=? ORDER BY recorded_at,id",
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id) as {
      id: string;
      time: number;
      kind: string;
      expires_at: string;
      recorded_at: string;
    }[];
    const sends = this.db
      .query(
        "SELECT l.*,EXISTS(SELECT 1 FROM qq_send_part p WHERE p.send_id=l.id AND p.result='confirmed') AS confirmed FROM qq_send_log l WHERE l.account_id=? AND l.conversation_kind=? AND l.peer_id=? AND l.agent_id=? ORDER BY l.recorded_at,l.id",
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id) as {
      id: string;
      sent_at_seconds: number;
      kind: string;
      expires_at: string;
      recorded_at: string;
      confirmed: number;
    }[];
    // The old schema has no send->speech FK. Match one-to-one within the same scope,
    // timestamp and speech kind in original recording order; preserve unmatched speech.
    const matched = new Set<string>();
    const sendSpeech = new Map<string, (typeof speeches)[number]>();
    for (const send of sends) {
      if (!send.confirmed) continue;
      const speech = speeches.find(
        (s) => !matched.has(s.id) && s.time === send.sent_at_seconds && s.kind === send.kind,
      );
      if (speech) {
        matched.add(speech.id);
        sendSpeech.set(send.id, speech);
      }
    }
    const media = this.db
      .query(
        "SELECT n.id,n.updated_at AS recorded_at FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key WHERE e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?",
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id) as {
      id: string;
      recorded_at: string;
    }[];
    const ordered = [
      ...events.map((e) => ({ ...e, priority: 0, type: "event" })),
      ...sends.map((e) => ({ ...e, time: e.sent_at_seconds, priority: 1, type: "send" })),
      ...speeches
        .filter((e) => !matched.has(e.id))
        .map((e) => ({ ...e, priority: 2, type: "speech" })),
      ...media.map((e) => ({
        ...e,
        time: Date.parse(e.recorded_at) / 1000,
        priority: 3,
        type: "media",
      })),
    ].sort((a, b) => a.time - b.time || a.priority - b.priority || a.id.localeCompare(b.id));
    for (const r of ordered) {
      if (r.type === "event") {
        this.ingestOneBotReference(r.id, b.id, c, undefined, historical);
        continue;
      }
      if (r.type === "media") {
        this.ingestMediaReference(r.id, b.id, c, historical);
        continue;
      }
      if (r.type === "send") {
        const send = sends.find((s) => s.id === r.id)!;
        const speech = sendSpeech.get(r.id);
        const source: SourceRef = {
          kind: "qq_send",
          id: r.id,
          revision: send.recorded_at,
          expiresAt: send.expires_at,
        };
        this.append({
          conversationId: c.id,
          eventKey: `send:${r.id}`,
          kind: send.confirmed ? "outbound" : "delivery",
          source,
          sources: [
            source,
            ...(speech
              ? [
                  {
                    kind: "qq_speech",
                    id: speech.id,
                    revision: String(speech.time),
                    expiresAt: speech.expires_at,
                  },
                ]
              : []),
          ],
          participant: send.confirmed
            ? { id: c.agentId, label: c.participants[0]!.label, role: "agent" }
            : null,
          occurredAt: new Date(r.time * 1000).toISOString(),
          recordedAt: r.recorded_at,
          outputId: r.id,
        });
        continue;
      }
      const speech = speeches.find((s) => s.id === r.id)!;
      this.append({
        conversationId: c.id,
        eventKey: `speech:${r.id}`,
        kind: "outbound",
        source: {
          kind: "qq_speech",
          id: r.id,
          revision: String(r.time),
          expiresAt: speech.expires_at,
        },
        participant: { id: c.agentId, label: c.participants[0]!.label, role: "agent" },
        occurredAt: new Date(r.time * 1000).toISOString(),
        recordedAt: r.recorded_at,
      });
    }
  }
}
