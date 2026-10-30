import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ConversationAddressing,
  ConversationEvent,
  ConversationSummary,
} from "../../shared/contracts/conversation";
import type { SourceRef } from "../../shared/contracts/evidence";
import { publishConversationChange } from "../conversation/conversation-changes";
import {
  type ConversationRow,
  ensureConversationIdentity,
  ensureWebConversationIdentity,
} from "./conversation-identity-repository";
import { DEFAULT_USER_ID } from "./repositories";

type SummaryRow = ConversationRow & {
  web_title?: string | null;
  peer_id?: string | null;
  agent_name?: string | null;
  qq_name?: string | null;
  custom_name?: string | null;
};
type HistoryProjection = SummaryRow & {
  requested_id: string;
  history_id: string;
  last_seq: number;
  history_consumed: number;
};
export type ConversationActivation = Pick<
  ConversationRow,
  "id" | "topology" | "agent_id" | "binding_epoch" | "next_seq" | "consumed_seq"
>;
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

const canonicalLegacySend = (
  conversationId: string,
  sendId: string,
  aliasExpiresAt: string,
) => `EXISTS (
  SELECT 1 FROM outbound_intents intent INDEXED BY ix_outbound_legacy_send_conversation
  JOIN conversations conv ON conv.id=intent.conversation_id
  JOIN qq_bindings binding ON binding.id=conv.source_id
  JOIN qq_send_log legacy_send ON legacy_send.id=intent.legacy_send_id
  JOIN conversation_events canonical
    ON canonical.conversation_id=intent.conversation_id
    AND canonical.kind='delivery'
    AND canonical.source_kind='outbound_intent'
    AND canonical.source_id=intent.id
  WHERE intent.conversation_id=${conversationId}
    AND intent.legacy_send_id=${sendId}
    AND conv.channel='onebot11'
    AND legacy_send.account_id=binding.account_id
    AND legacy_send.conversation_kind=binding.conversation_kind
    AND legacy_send.peer_id=binding.peer_id
    AND legacy_send.agent_id=conv.agent_id
    AND ${aliasExpiresAt} IS NOT NULL
    AND legacy_send.expires_at>=${aliasExpiresAt}
    AND intent.expires_at>=${aliasExpiresAt}
    AND canonical.source_expires_at>=${aliasExpiresAt}
)`;
const canonicalSpeechAlias = (eventAlias: string) => `EXISTS (
  SELECT 1 FROM conversation_events send_alias INDEXED BY ix_conversation_send_speech_source
  JOIN conversations conv ON conv.id=send_alias.conversation_id
  JOIN qq_bindings binding ON binding.id=conv.source_id
  JOIN qq_send_log send ON send.id=send_alias.source_id
  JOIN qq_speech_log speech ON speech.id=json_extract(send_alias.sources,'$[1].id')
  WHERE send_alias.conversation_id=${eventAlias}.conversation_id
    AND send_alias.kind='outbound'
    AND send_alias.source_kind='qq_send'
    AND send_alias.event_key='send:'||send.id
    AND send_alias.source_revision=send.recorded_at
    AND json_extract(send_alias.sources,'$[0].kind')='qq_send'
    AND json_extract(send_alias.sources,'$[0].id')=send.id
    AND json_extract(send_alias.sources,'$[0].revision')=send.recorded_at
    AND json_extract(send_alias.sources,'$[0].expiresAt')=send.expires_at
    AND json_extract(send_alias.sources,'$[1].kind')='qq_speech'
    -- Unary + removes RHS column affinity while preserving the indexed JSON expression.
    AND json_extract(send_alias.sources,'$[1].id')=+${eventAlias}.source_id
    AND json_extract(send_alias.sources,'$[1].revision')=CAST(speech.spoke_at_seconds AS TEXT)
    AND json_extract(send_alias.sources,'$[1].expiresAt')=speech.expires_at
    AND ${eventAlias}.source_id=speech.id
    AND ${eventAlias}.source_revision=CAST(speech.spoke_at_seconds AS TEXT)
    AND ${eventAlias}.source_expires_at=speech.expires_at
    AND send_alias.source_expires_at>=${eventAlias}.source_expires_at
    AND send.expires_at>=${eventAlias}.source_expires_at
    AND conv.channel='onebot11'
    AND send.account_id=binding.account_id
    AND send.conversation_kind=binding.conversation_kind
    AND send.peer_id=binding.peer_id
    AND send.agent_id=conv.agent_id
    AND speech.account_id=binding.account_id
    AND speech.conversation_kind=binding.conversation_kind
    AND speech.peer_id=binding.peer_id
    AND speech.agent_id=conv.agent_id
    AND EXISTS (
      SELECT 1 FROM qq_send_part part
      WHERE part.send_id=send.id AND part.result='confirmed'
    )
)`;

/**
 * History-display eligibility for one row. The legacy send/speech rules are unchanged;
 * the media rule is a read-only display filter over already-stored rows: a media_revision
 * shows only while it is the note's current revision (same rule the projection owner
 * applies in conversation-view) AND that revision carries a display fact — a real
 * description, or a consumed attempt (a meaningful failure the timeline can offer to
 * re-read). The initial 0-attempt, no-note state has no fact to show: the parent inbound
 * row already carries the media source refs, so the revision row does not crowd the
 * latest page. Purged notes keep their raw rows (fail closed; the projection reports
 * expiry). Cursor and epoch arithmetic never depend on this filter.
 */
const historyDisplayEligible = `(
  (e.source_kind='qq_send' AND NOT ${canonicalLegacySend("e.conversation_id", "e.source_id", "e.source_expires_at")})
  OR (e.source_kind='qq_speech' AND NOT ${canonicalSpeechAlias("e")})
  OR (e.source_kind='qq_media' AND (
    e.kind!='media_revision'
    OR NOT EXISTS (SELECT 1 FROM qq_media_notes n WHERE n.id=e.source_id)
    OR EXISTS (SELECT 1 FROM qq_media_notes n
      WHERE n.id=e.source_id
        AND e.source_revision=CAST(n.attempts AS TEXT)
        AND (n.note IS NOT NULL OR n.attempts>0))
  ))
  OR e.source_kind NOT IN('qq_send','qq_speech','qq_media')
)`;

/** Source-reference journal. SQLite allocates seq inside the same transaction as dedup. */
export class ConversationEventRepository {
  constructor(readonly db: Database) {}
  row(id: string): ConversationRow | null {
    return this.db
      .query("SELECT * FROM conversations WHERE id=?")
      .get(id) as ConversationRow | null;
  }
  activeHistoryIdentity(id: string, userId: string): ConversationRow | null {
    const anchor = this.row(id);
    if (!anchor || anchor.user_id !== userId) return null;
    const rows = this.db
      .query(`SELECT * FROM conversations WHERE channel=? AND source_id=?
      AND agent_id=? AND user_id=? AND closed_at IS NULL LIMIT 2`)
      .all(anchor.channel, anchor.source_id, anchor.agent_id, userId) as ConversationRow[];
    return rows.length === 1 ? rows[0]! : null;
  }
  inspectionSources(
    targets: readonly {
      conversationId: string;
      kind: "web_message" | "qq_observation";
      id: string;
      turnId?: string | null;
      role?: "user" | "assistant" | null;
    }[],
  ) {
    if (!targets.length) return [];
    return this.db
      .query(`SELECT selected.key AS ordinal,c.binding_epoch AS bindingEpoch,b.authority_revision AS authorityRevision,
      ce.*, CASE WHEN json_extract(selected.value,'$.kind')<>'web_message' THEN 1 ELSE EXISTS (
        SELECT 1 FROM messages m JOIN turns t ON t.id=m.turn_id JOIN sessions s ON s.id=t.session_id
        WHERE m.id=ce.source_id AND m.turn_id=json_extract(selected.value,'$.turnId')
          AND m.role=json_extract(selected.value,'$.role') AND m.session_id=s.id AND s.id=c.source_id
          AND s.agent_id=c.agent_id AND s.user_id=c.user_id AND m.status='completed') END AS member
      FROM json_each(?) selected JOIN conversations c ON c.id=json_extract(selected.value,'$.conversationId')
      LEFT JOIN qq_bindings b ON c.channel='onebot11' AND b.id=c.source_id
      JOIN conversation_events ce ON ce.conversation_id=c.id AND ce.source_id=json_extract(selected.value,'$.id')
        AND ce.source_kind=CASE WHEN json_extract(selected.value,'$.kind')='qq_observation' THEN 'qq_event' ELSE 'web_message' END
        AND ce.kind IN ('inbound','outbound')`)
      .all(JSON.stringify(targets)) as Array<
      EventRow & {
        ordinal: number;
        bindingEpoch: number;
        authorityRevision: number | null;
        member: number;
      }
    >;
  }
  inspectionEvent(row: EventRow): ConversationEvent {
    return eventFromRow(row);
  }
  memoryReadMode(
    id: string,
    userId: string,
  ): { mode: "current_conversation" | "agent_shared"; revision: number } | null {
    const row = this.row(id);
    if (!row || row.user_id !== userId || row.closed_at !== null) return null;
    return { mode: row.memory_read_mode, revision: row.memory_config_revision };
  }
  setMemoryReadMode(
    id: string,
    userId: string,
    mode: "current_conversation" | "agent_shared",
    expectedRevision: number,
  ):
    | { kind: "saved"; mode: "current_conversation" | "agent_shared"; revision: number }
    | { kind: "conflict" }
    | null {
    return this.db
      .transaction(() => {
        const row = this.row(id);
        if (!row || row.user_id !== userId || row.closed_at !== null) return null;
        if (row.memory_config_revision !== expectedRevision) return { kind: "conflict" } as const;
        if (row.memory_read_mode === mode)
          return { kind: "saved", mode, revision: row.memory_config_revision } as const;
        const saved = this.db
          .query(
            "UPDATE conversations SET memory_read_mode=?, memory_config_revision=memory_config_revision+1, updated_at=? WHERE id=? AND user_id=? AND closed_at IS NULL AND memory_config_revision=? RETURNING memory_read_mode, memory_config_revision",
          )
          .get(mode, new Date().toISOString(), id, userId, expectedRevision) as {
          memory_read_mode: "current_conversation" | "agent_shared";
          memory_config_revision: number;
        } | null;
        if (!saved) return { kind: "conflict" } as const;
        publishConversationChange(this.db, id);
        return {
          kind: "saved",
          mode: saved.memory_read_mode,
          revision: saved.memory_config_revision,
        } as const;
      })
      .immediate();
  }
  ensureWeb(sessionId: string, userId?: string): ConversationSummary | null {
    const row = ensureWebConversationIdentity(this.db, sessionId, userId);
    return row ? this.summary(row) : null;
  }
  ensureOneBot(bindingId: string): ConversationSummary | null {
    const row = this.ensureOneBotRow(bindingId);
    return row ? this.summary(row) : null;
  }
  ensureOneBotActivation(bindingId: string): ConversationActivation | null {
    const row = this.ensureOneBotRow(bindingId);
    return row
      ? {
          id: row.id,
          topology: row.topology,
          agent_id: row.agent_id,
          binding_epoch: row.binding_epoch,
          next_seq: row.next_seq,
          consumed_seq: row.consumed_seq,
        }
      : null;
  }
  private ensureOneBotRow(bindingId: string): ConversationRow | null {
    return this.db.transaction(() => {
      const binding = this.db.query("SELECT * FROM qq_bindings WHERE id=?").get(bindingId) as
        | (OneBotBindingSource & { created_at: string })
        | null;
      if (!binding) return null;
      const ensured = ensureConversationIdentity(this.db, {
        channel: "onebot11",
        topology: binding.conversation_kind === "private" ? "direct" : "shared",
        sourceId: binding.id,
        agentId: binding.agent_id,
        userId: DEFAULT_USER_ID,
        at: binding.created_at,
      });
      let row = ensured.row;
      if (ensured.created && row.binding_epoch > 1 && this.historyRows(row.id).length === 1) {
        // A returning Agent may have retained legacy sources but no indexed activation.
        // Import them as consumed history; the activation watermark still rejects fresh work.
        this.backfillOneBot(binding, row, this.agentName(row.agent_id), true);
        row = this.row(row.id)!;
        this.acknowledge(row.id, row.next_seq - 1);
        row = this.row(row.id)!;
      }
      return row;
    })();
  }
  get(id: string, userId?: string): ConversationSummary | null {
    const r = this.row(id);
    return r && (!userId || r.user_id === userId) ? this.summary(r) : null;
  }
  /** Bootstrap repair for legacy source writers; ordinary GETs never reconcile or write. */
  reconcileSources(userId: string): void {
    this.db.transaction(() => {
      const sessions = this.db
        .query(`SELECT s.id FROM sessions s WHERE s.user_id=? AND NOT EXISTS (
          SELECT 1 FROM conversations c WHERE c.channel='web' AND c.source_id=s.id
            AND c.closed_at IS NULL AND c.agent_id=s.agent_id
        )`)
        .all(userId) as { id: string }[];
      for (const session of sessions) ensureWebConversationIdentity(this.db, session.id, userId);
      // Source edits can advance Web activity without a new journal event. Probe first
      // so an unchanged directory does not even attempt a write on a read-only handle.
      const changed = this.db
        .query(`SELECT c.id,s.updated_at FROM sessions s JOIN conversations c
          ON c.channel='web' AND c.source_id=s.id AND c.closed_at IS NULL
          WHERE s.user_id=? AND s.updated_at>c.updated_at`)
        .all(userId) as { id: string; updated_at: string }[];
      for (const row of changed) {
        this.db
          .query(
            "UPDATE conversations SET updated_at=MAX(updated_at,?) WHERE id=? AND updated_at<?",
          )
          .run(row.updated_at, row.id, row.updated_at);
      }
      if (userId === DEFAULT_USER_ID) {
        const bindings = this.db
          .query(`SELECT b.id FROM qq_bindings b WHERE NOT EXISTS (
            SELECT 1 FROM conversations c WHERE c.channel='onebot11' AND c.source_id=b.id
              AND c.closed_at IS NULL AND c.agent_id=b.agent_id
          )`)
          .all() as { id: string }[];
        for (const binding of bindings) this.ensureOneBotRow(binding.id);
      }
    })();
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
  /** One selected-identity projection, shared by directory, exact reads and notifications. */
  historyMetadataMany(
    ids: readonly string[],
    access?: { userId: string; includeShared: boolean },
  ): Map<string, Pick<ConversationSummary, "id" | "lastSeq" | "bindingEpoch">> {
    return new Map(
      this.historyProjection(ids, false, access).map((row) => [
        row.requested_id,
        {
          id: row.history_id,
          lastSeq: row.last_seq,
          bindingEpoch: row.binding_epoch,
        },
      ]),
    );
  }

  historySummaries(
    ids: readonly string[],
    access?: { userId: string; includeShared: boolean },
  ): Map<string, ConversationSummary> {
    return new Map(
      this.historyProjection(ids, true, access).map((row) => [
        row.requested_id,
        {
          ...this.projectSummary(row),
          id: row.history_id,
          lastSeq: row.last_seq,
          consumedSeq: row.history_consumed,
        },
      ]),
    );
  }

  private historyProjection(
    ids: readonly string[],
    display: boolean,
    access?: { userId: string; includeShared: boolean },
  ): HistoryProjection[] {
    if (!ids.length) return [];
    const guard = access
      ? `AND anchor.user_id=? AND (? OR anchor.topology<>'shared')
      AND CASE WHEN anchor.channel='web' THEN EXISTS (
        SELECT 1 FROM sessions s WHERE s.id=anchor.source_id AND s.user_id=anchor.user_id AND s.agent_id=anchor.agent_id
      ) ELSE EXISTS (
        SELECT 1 FROM qq_bindings b JOIN agents a ON a.id=b.agent_id
        WHERE b.id=anchor.source_id AND b.agent_id=anchor.agent_id
      ) END`
      : "";
    const displayFields = display
      ? `,session.title AS web_title,binding.peer_id,
      agent.name AS agent_name,group_name.qq_name,group_name.custom_name`
      : "";
    const displayJoins = display
      ? `LEFT JOIN sessions session ON latest.channel='web' AND session.id=latest.source_id
      LEFT JOIN qq_bindings binding ON latest.channel='onebot11' AND binding.id=latest.source_id
      LEFT JOIN agents agent ON agent.id=latest.agent_id
      LEFT JOIN qq_group_names group_name ON latest.topology='shared'
        AND group_name.account_id=binding.account_id AND group_name.group_id=binding.peer_id`
      : "";
    return this.db
      .query(`WITH epochs AS (
      SELECT selected.value AS requested_id,c.*,
        first_value(c.id) OVER (PARTITION BY selected.key ORDER BY c.binding_epoch) AS history_id,
        sum(c.next_seq-1) OVER (PARTITION BY selected.key) AS last_seq,
        row_number() OVER (PARTITION BY selected.key ORDER BY c.binding_epoch DESC) AS position
      FROM json_each(?) selected CROSS JOIN conversations anchor ON anchor.id=selected.value
      JOIN conversations c ON c.channel=anchor.channel AND c.source_id=anchor.source_id
        AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id
      WHERE 1=1 ${guard}
    ) SELECT latest.*,latest.last_seq-latest.next_seq+1+latest.consumed_seq AS history_consumed
      ${displayFields} FROM epochs latest ${displayJoins}
      WHERE latest.position=1 AND latest.closed_at IS NULL`)
      .all(
        JSON.stringify([...new Set(ids)]),
        ...(access ? [access.userId, access.includeShared ? 1 : 0] : []),
      ) as HistoryProjection[];
  }

  historyMetadata(id: string): Pick<ConversationSummary, "id" | "lastSeq" | "bindingEpoch"> | null {
    return this.historyMetadataMany([id]).get(id) ?? null;
  }
  historySummary(id: string): ConversationSummary | null {
    return this.historySummaries([id]).get(id) ?? null;
  }
  /**
   * Stable history cursor: sealed epochs cannot append, so their seq ranges never move.
   * Keep the physical event identity until projection (wake/run joins require that ID).
   * Do not call this from an Agent host, scheduler or delivery authorization path.
   */
  private historyPage(
    id: string,
    cursor: number,
    direction: "after" | "before",
    limit = 100,
  ): {
    items: { event: ConversationEvent; seq: number }[];
    nextSeq: number;
    firstSeq: number;
    hasMore: boolean;
  } {
    // Translate the global history cursor into per-epoch local seq bounds so each
    // epoch page is an indexed (conversation_id, seq) range read.
    const before = direction === "before";
    let offset = 0;
    const epochs = this.historyRows(id).map((row) => {
      const epoch = { ...row, offset };
      offset += row.next_seq - 1;
      return epoch;
    });
    const found: { event: ConversationEvent; seq: number }[] = [];
    for (const epoch of before ? [...epochs].reverse() : epochs) {
      const remaining = limit + 1 - found.length;
      if (remaining <= 0) break;
      const local = cursor - epoch.offset;
      const query = before
        ? `SELECT e.* FROM conversation_events e
          WHERE e.conversation_id=? AND e.seq<? AND ${historyDisplayEligible}
          ORDER BY e.seq DESC LIMIT ?`
        : `SELECT e.* FROM conversation_events e
          WHERE e.conversation_id=? AND e.seq>? AND ${historyDisplayEligible}
          ORDER BY e.seq ASC LIMIT ?`;
      const rows = this.db.query(query).all(epoch.id, local, remaining) as EventRow[];
      found.push(...rows.map((row) => ({ event: eventFromRow(row), seq: row.seq + epoch.offset })));
    }
    const hasMore = found.length > limit;
    const items = before ? found.slice(0, limit).reverse() : found.slice(0, limit);
    return {
      items,
      firstSeq: items[0]?.seq ?? 0,
      nextSeq: items.at(-1)?.seq ?? 0,
      hasMore,
    };
  }

  historyAfter(id: string, after = 0, limit = 100) {
    return this.historyPage(id, after, "after", limit);
  }
  historyBefore(id: string, before = Number.MAX_SAFE_INTEGER, limit = 100) {
    return this.historyPage(id, before, "before", limit);
  }

  private agentName(agentId: string): string {
    const agent = this.db.query("SELECT name FROM agents WHERE id=?").get(agentId) as {
      name: string;
    } | null;
    return agent?.name ?? agentId;
  }
  private summary(row: ConversationRow): ConversationSummary {
    return this.summaries([row.id]).get(row.id)!;
  }
  private summaries(ids: readonly string[]): Map<string, ConversationSummary> {
    if (!ids.length) return new Map();
    const selected = this.db
      .query(`SELECT c.*,s.title AS web_title,b.peer_id,a.name AS agent_name,
      g.qq_name,g.custom_name FROM json_each(?) selected CROSS JOIN conversations c ON c.id=selected.value
      LEFT JOIN sessions s ON c.channel='web' AND s.id=c.source_id
      LEFT JOIN qq_bindings b ON c.channel='onebot11' AND b.id=c.source_id
      LEFT JOIN agents a ON a.id=c.agent_id
      LEFT JOIN qq_group_names g ON c.topology='shared' AND g.account_id=b.account_id AND g.group_id=b.peer_id`)
      .all(JSON.stringify([...new Set(ids)])) as SummaryRow[];
    return new Map(selected.map((row) => [row.id, this.projectSummary(row)]));
  }
  private projectSummary(r: SummaryRow): ConversationSummary {
    const peerId = r.channel === "web" ? r.user_id : (r.peer_id ?? r.source_id);
    const hasBinding = r.peer_id !== null && r.peer_id !== undefined;
    const title =
      r.channel === "web"
        ? (r.web_title ?? "")
        : r.topology === "shared"
          ? (r.custom_name ?? r.qq_name ?? `群聊 ${peerId}`)
          : `私聊 ${peerId}`;
    return {
      id: r.id,
      channel: r.channel,
      topology: r.topology,
      sourceId: r.source_id,
      agentId: r.agent_id,
      bindingEpoch: r.binding_epoch,
      title,
      ...(r.channel === "onebot11" && r.topology === "shared" && hasBinding
        ? {
            qqGroup: {
              number: peerId,
              originalName: r.qq_name ?? null,
              customName: r.custom_name ?? null,
            },
          }
        : {}),
      participants: [
        { id: r.agent_id, label: r.agent_name ?? r.agent_id, role: "agent" },
        ...(r.topology === "direct" ? [{ id: peerId, label: peerId, role: "user" as const }] : []),
      ],
      updatedAt: r.updated_at,
      lastSeq: r.next_seq - 1,
      consumedSeq: r.consumed_seq,
    };
  }
  directoryPage(input: {
    userId: string;
    channel?: ConversationRow["channel"];
    sourceId?: string;
    cursor?: string;
    limit?: number;
  }): { ids: string[]; nextCursor: string | null } {
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
    const ids = rows.slice(0, limit).map((row) => row.id);
    const last = rows[limit - 1];
    return {
      ids,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString("base64url")
          : null,
    };
  }
  list(input: Parameters<ConversationEventRepository["directoryPage"]>[0]): {
    items: ConversationSummary[];
    nextCursor: string | null;
  } {
    const page = this.directoryPage(input);
    const summaries = this.summaries(page.ids);
    return {
      items: page.ids.flatMap((id) => {
        const item = summaries.get(id);
        return item ? [item] : [];
      }),
      nextCursor: page.nextCursor,
    };
  }
  /**
   * 自主接话的持久观察边界（0054）。direct 推进的 consumed_seq 不能代替它：两条路径
   * 各自推进、互不吞并，自主批次的条数从这个边界与事件事实派生。单调推进，不回退。
   */
  chimingInObservedSeq(conversationId: string): number {
    const row = this.db
      .query("SELECT chiming_in_observed_seq AS seq FROM conversations WHERE id=?")
      .get(conversationId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  chimingInJudgedAt(conversationId: string): string | null {
    const row = this.db
      .query("SELECT chiming_in_judged_at AS at FROM conversations WHERE id=?")
      .get(conversationId) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /** Record a complete, valid autonomous judgement with its source boundary. */
  markChimingInJudged(conversationId: string, throughSeq: number, at: string): void {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
      throw new Error("CONVERSATION_SEQUENCE_INVALID");
    }
    if (!Number.isFinite(Date.parse(at))) throw new Error("CONVERSATION_TIMESTAMP_INVALID");
    this.db
      .query(
        "UPDATE conversations SET chiming_in_observed_seq=MAX(chiming_in_observed_seq,?),chiming_in_judged_at=CASE WHEN ? > chiming_in_observed_seq THEN ? ELSE chiming_in_judged_at END WHERE id=?",
      )
      .run(throughSeq, throughSeq, at, conversationId);
  }

  /**
   * Advance the source boundary when an opportunity is intentionally skipped without judgement.
   * The caller keeps this in the same IMMEDIATE transaction as wake settlement.
   */
  advanceChimingInObservedSeq(conversationId: string, throughSeq: number): void {
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
      throw new Error("CONVERSATION_SEQUENCE_INVALID");
    }
    this.db
      .query(
        "UPDATE conversations SET chiming_in_observed_seq=MAX(chiming_in_observed_seq,?) WHERE id=?",
      )
      .run(throughSeq, conversationId);
  }

  /** Internal wake/delivery activity cannot advance an Agent's source observation bound. */
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
      publishConversationChange(this.db, row.id);
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
  /** Existing source identities and whether ingestion must still merge media references. */
  oneBotRecoverySources(
    conversationId: string,
    eventKeys: readonly string[],
  ): Map<string, { seq: number; missingMediaRefs: boolean }> {
    if (!eventKeys.length) return new Map();
    const rows = this.db
      .query(
        `SELECT ce.source_id AS event_key,ce.seq,
          EXISTS(SELECT 1 FROM qq_media_notes n
            WHERE n.event_key=ce.source_id AND NOT EXISTS(
              SELECT 1 FROM json_each(ce.sources) s
              WHERE json_extract(s.value,'$.kind')='qq_media'
                AND json_type(s.value,'$.id')='text'
                AND json_extract(s.value,'$.id')=n.id
            )) AS missing_media_refs
        FROM json_each(?) requested
        JOIN conversation_events ce ON ce.conversation_id=?
          AND ce.event_key='onebot:'||requested.value
          AND ce.source_kind='qq_event' AND ce.source_id=requested.value`,
      )
      .all(JSON.stringify(eventKeys), conversationId) as {
      event_key: string;
      seq: number;
      missing_media_refs: number;
    }[];
    return new Map(
      rows.map((row) => [
        row.event_key,
        { seq: row.seq, missingMediaRefs: row.missing_media_refs === 1 },
      ]),
    );
  }
  ingestOneBotEvent(
    eventKey: string,
    bindingId: string,
    addressing?: ConversationAddressing,
  ): ConversationEvent | null {
    const c = this.ensureOneBotRow(bindingId);
    return c ? this.ingestOneBotReference(eventKey, bindingId, c, addressing) : null;
  }
  private ingestOneBotReference(
    eventKey: string,
    bindingId: string,
    c: ConversationActivation,
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
      (!historical && c.binding_epoch > 1 && e.source_rowid <= this.row(c.id)!.source_watermark)
    )
      return null;
    const media = this.db
      .query(
        `SELECT n.id,n.attempts,n.expires_at FROM qq_media_notes n
        WHERE n.event_key=? ORDER BY n.segment_index`,
      )
      .all(eventKey) as { id: string; attempts: number; expires_at: string }[];
    const mediaRefs: SourceRef[] = media.map((n) => ({
      kind: "qq_media",
      id: n.id,
      revision: String(n.attempts),
      expiresAt: n.expires_at,
    }));
    const source: SourceRef = { kind: "qq_event", id: eventKey, revision: e.recorded_at };
    const sources: SourceRef[] = [source];
    if (e.body && e.expires_at)
      sources.push({
        kind: "qq_observation",
        id: eventKey,
        revision: bodyRevision(e.body),
        expiresAt: e.expires_at,
      });
    sources.push(...mediaRefs);
    const appended = this.append({
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
    if (!mediaRefs.length) return appended;
    return this.mergeMissingMediaSources(c.id, `onebot:${eventKey}`, mediaRefs);
  }
  private mergeMissingMediaSources(
    conversationId: string,
    eventKey: string,
    mediaRefs: SourceRef[],
  ): ConversationEvent | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_key=?")
          .get(conversationId, eventKey) as EventRow | null;
        if (!row) return null;
        // A sealed journal is a read-only reference; backfill never reopens a closed row.
        const conversation = this.row(conversationId);
        if (!conversation || conversation.closed_at) return eventFromRow(row);
        const live = JSON.parse(row.sources) as SourceRef[];
        const absent = mediaRefs.filter(
          (ref) => !live.some((s) => s.kind === ref.kind && s.id === ref.id),
        );
        if (!absent.length) return eventFromRow(row);
        const sources = JSON.stringify([...live, ...absent]);
        const updated = this.db
          .query(
            "UPDATE conversation_events SET sources=? WHERE conversation_id=? AND event_key=? AND sources=? RETURNING *",
          )
          .get(sources, conversationId, eventKey, row.sources) as EventRow | null;
        if (updated) {
          publishConversationChange(this.db, conversationId);
          return eventFromRow(updated);
        }
        const fresh = this.db
          .query("SELECT * FROM conversation_events WHERE conversation_id=? AND event_key=?")
          .get(conversationId, eventKey) as EventRow | null;
        return fresh ? eventFromRow(fresh) : null;
      })
      .immediate();
  }
  ingestMedia(noteId: string, bindingId: string): ConversationEvent | null {
    const c = this.ensureOneBotRow(bindingId);
    return c ? this.ingestMediaReference(noteId, bindingId, c) : null;
  }
  private ingestMediaReference(
    noteId: string,
    bindingId: string,
    c: ConversationActivation,
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
    // 初始未理解状态（0 次尝试、无描述）没有展示事实：原文行已携带媒体引用，
    // 这里不发 media_revision；typed 成功不回写 legacy note，也不能伪造 revision。
    // 旧（attempts>0）与 legacy 已描述行仍按修订发布。
    if (n.attempts === 0 && n.note === null) return parent;
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
      const recorded = new Set(
        (
          this.db
            .query(`SELECT e.conversation_id,e.source_id,e.source_revision
            FROM conversation_events e JOIN conversations c ON c.id=e.conversation_id
            WHERE c.channel='web' AND c.closed_at IS NULL AND e.source_kind='web_message'`)
            .all() as { conversation_id: string; source_id: string; source_revision: string }[]
        ).map((e) => `${e.conversation_id}\0${e.source_id}\0${e.source_revision}`),
      );
      for (const m of this.db
        .query(`SELECT m.id,m.status,m.content,c.id AS conversation_id
          FROM messages m
          LEFT JOIN conversations c ON c.channel='web' AND c.source_id=m.session_id AND c.closed_at IS NULL
          WHERE m.status!='pending' AND m.role!='system'
          ORDER BY m.created_at,m.sequence_no,m.id`)
        .all() as { id: string; status: string; content: string; conversation_id: string | null }[])
        if (
          !recorded.has(
            `${m.conversation_id}\0${m.id}\0${bodyRevision(`${m.status}\0${m.content}`)}`,
          )
        )
          this.ingestWebMessage(m.id);
      // All open activations exist before the shared proof; each per-binding call consumes it.
      const bindings = this.db
        .query(
          "SELECT id,account_id,conversation_kind,peer_id,agent_id FROM qq_bindings ORDER BY created_at,id",
        )
        .all() as {
        id: string;
        account_id: string;
        conversation_kind: string;
        peer_id: string;
        agent_id: string;
      }[];
      const activations = new Map(bindings.map((b) => [b.id, this.ensureOneBotRow(b.id)!]));
      // One call-local proof pass for every open epoch-1 binding of this boot.
      const missingParents = this.missingMediaParentsByConversation(
        [...activations.values()].filter((c) => c.binding_epoch === 1).map((c) => c.id),
      );
      for (const b of bindings) {
        const c = activations.get(b.id)!;
        if (c.binding_epoch === 1)
          this.backfillOneBot(b, c, this.agentName(c.agent_id), false, missingParents.get(c.id));
      }
    })();
  }
  /** Startup-only membership proof, computed once for the given open epoch-1 conversations. */
  private missingMediaParentsByConversation(conversationIds: string[]): Map<string, Set<string>> {
    const missing = new Map<string, Set<string>>();
    if (!conversationIds.length) return missing;
    // Every requested conversation is keyed, even with zero missing rows: an empty set is a
    // result, not an absent result.
    for (const conversationId of conversationIds) missing.set(conversationId, new Set<string>());
    for (const row of this.db
      .query(
        `WITH scopes AS MATERIALIZED (
        SELECT c.id AS cid,b.account_id,b.conversation_kind,b.peer_id,b.agent_id
        FROM json_each(?) selected
        CROSS JOIN conversations c ON c.id=selected.value
        CROSS JOIN qq_bindings b ON b.id=c.source_id
      )
      SELECT selected.cid,n.event_key
      FROM qq_media_notes n
      CROSS JOIN qq_events e ON e.event_key=n.event_key
      CROSS JOIN scopes selected
        ON e.account_id=selected.account_id
        AND e.conversation_kind=selected.conversation_kind
        AND e.peer_id=selected.peer_id
        AND e.agent_id=selected.agent_id
      WHERE NOT EXISTS(
        SELECT 1 FROM conversation_events ce,json_each(ce.sources) s
        WHERE ce.conversation_id=selected.cid
          AND ce.event_key='onebot:'||n.event_key
          AND json_extract(s.value,'$.kind')='qq_media'
          AND json_extract(s.value,'$.id')=n.id
      )`,
      )
      .all(JSON.stringify(conversationIds)) as { cid: string; event_key: string }[]) {
      missing.get(row.cid)!.add(row.event_key);
    }
    return missing;
  }
  /** The same predicate scoped to one binding, for non-startup callers. */
  private missingMediaParents(b: OneBotBindingSource, c: ConversationActivation): Set<string> {
    return new Set(
      (
        this.db
          .query(`SELECT n.event_key FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key
        WHERE e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?
        AND NOT EXISTS(SELECT 1 FROM conversation_events ce,json_each(ce.sources) s
          WHERE ce.conversation_id=? AND ce.event_key='onebot:'||n.event_key
          AND json_extract(s.value,'$.kind')='qq_media' AND json_extract(s.value,'$.id')=n.id)`)
          .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id, c.id) as {
          event_key: string;
        }[]
      ).map((n) => n.event_key),
    );
  }
  private backfillOneBot(
    b: OneBotBindingSource,
    c: ConversationActivation,
    agentLabel: string,
    historical: boolean,
    startupMissingParents?: ReadonlySet<string>,
  ): void {
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
    // Direct ID is the live one-to-one relation. Keep the original ordered time/kind
    // compatibility matcher only for old rows with different IDs and no direct match.
    const matched = new Set<string>();
    const sendSpeech = new Map<string, (typeof speeches)[number]>();
    const speechById = new Map(speeches.map((speech) => [speech.id, speech]));
    for (const send of sends) {
      if (!send.confirmed) continue;
      const speech = speechById.get(send.id);
      if (!speech) continue;
      matched.add(speech.id);
      sendSpeech.set(send.id, speech);
    }
    const speechQueues = new Map<string, { items: typeof speeches; next: number }>();
    for (const speech of speeches) {
      if (matched.has(speech.id)) continue;
      const key = `${speech.time}\0${speech.kind}`;
      const queue = speechQueues.get(key);
      if (queue) queue.items.push(speech);
      else speechQueues.set(key, { items: [speech], next: 0 });
    }
    for (const send of sends) {
      if (!send.confirmed || sendSpeech.has(send.id)) continue;
      const queue = speechQueues.get(`${send.sent_at_seconds}\0${send.kind}`);
      const speech = queue?.items[queue.next++];
      if (speech) {
        matched.add(speech.id);
        sendSpeech.set(send.id, speech);
      }
    }
    const recorded = new Set(
      (
        this.db
          .query("SELECT event_key FROM conversation_events WHERE conversation_id=?")
          .all(c.id) as { event_key: string }[]
      ).map((e) => e.event_key),
    );
    const representedLegacySends = new Set(
      (
        this.db
          .query(`SELECT send.id AS send_id FROM qq_send_log send
            WHERE send.account_id=? AND send.conversation_kind=? AND send.peer_id=? AND send.agent_id=?
              AND ${canonicalLegacySend("?", "send.id", "send.expires_at")}`)
          .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id, c.id) as {
          send_id: string;
        }[]
      ).map((send) => send.send_id),
    );
    const missingMediaParents =
      startupMissingParents === undefined ? this.missingMediaParents(b, c) : startupMissingParents;
    const repairParents = JSON.stringify([...missingMediaParents]);
    const events = this.db
      .query(
        `SELECT e.event_key AS id,e.occurred_at_seconds AS time,e.recorded_at
        FROM qq_events e
        WHERE e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?
          AND (NOT EXISTS(SELECT 1 FROM conversation_events ce
            WHERE ce.conversation_id=? AND ce.event_key='onebot:'||e.event_key)
            OR e.event_key IN (SELECT value FROM json_each(?)))`,
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id, c.id, repairParents) as {
      id: string;
      time: number;
      recorded_at: string;
    }[];
    const media = this.db
      .query(
        `SELECT n.id,n.event_key,n.attempts,n.updated_at AS recorded_at
        FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key
        WHERE e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?
          AND (n.event_key IN (SELECT value FROM json_each(?))
            OR ((n.attempts>0 OR n.note IS NOT NULL)
              AND NOT EXISTS(SELECT 1 FROM conversation_events ce
                WHERE ce.conversation_id=? AND ce.event_key='media:'||n.id||':'||n.attempts)))`,
      )
      .all(b.account_id, b.conversation_kind, b.peer_id, b.agent_id, repairParents, c.id) as {
      id: string;
      event_key: string;
      attempts: number;
      recorded_at: string;
    }[];
    const ordered = [
      ...events.map((e) => ({ ...e, priority: 0, type: "event" })),
      ...sends
        .filter((e) => !recorded.has(`send:${e.id}`) && !representedLegacySends.has(e.id))
        .map((e) => ({ ...e, time: e.sent_at_seconds, priority: 1, type: "send" })),
      ...speeches
        .filter((e) => !matched.has(e.id) && !recorded.has(`speech:${e.id}`))
        .map((e) => ({ ...e, priority: 2, type: "speech" })),
      ...media.map((e) => ({
        ...e,
        time: Date.parse(e.recorded_at) / 1000,
        priority: 3,
        type: "media",
      })),
    ].sort((a, b) => a.time - b.time || a.priority - b.priority || a.id.localeCompare(b.id));
    const mediaById = new Map(media.map((n) => [n.id, n]));
    const sendsById = new Map(sends.map((s) => [s.id, s]));
    const speechesById = new Map(speeches.map((s) => [s.id, s]));
    for (const r of ordered) {
      if (r.type === "event") {
        if (recorded.has(`onebot:${r.id}`) && !missingMediaParents.has(r.id)) continue;
        this.ingestOneBotReference(r.id, b.id, c, undefined, historical);
        continue;
      }
      if (r.type === "media") {
        const note = mediaById.get(r.id)!;
        if (
          recorded.has(`media:${note.id}:${note.attempts}`) &&
          !missingMediaParents.has(note.event_key)
        )
          continue;
        this.ingestMediaReference(r.id, b.id, c, historical);
        continue;
      }
      if (r.type === "send") {
        if (recorded.has(`send:${r.id}`) || representedLegacySends.has(r.id)) continue;
        const send = sendsById.get(r.id)!;
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
          participant: send.confirmed ? { id: c.agent_id, label: agentLabel, role: "agent" } : null,
          occurredAt: new Date(r.time * 1000).toISOString(),
          recordedAt: r.recorded_at,
          outputId: r.id,
        });
        continue;
      }
      if (recorded.has(`speech:${r.id}`)) continue;
      const speech = speechesById.get(r.id)!;
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
        participant: { id: c.agent_id, label: agentLabel, role: "agent" },
        occurredAt: new Date(r.time * 1000).toISOString(),
        recordedAt: r.recorded_at,
      });
    }
  }
}
