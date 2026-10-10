// Conversation legacy-send projection: canonical read view over the journal (2026-10-10
// restart-history batch). Normative requirements proven here:
//   1. A confirmed outbound output is journaled once through the real OutboundDelivery
//      chain; a cold reopen + startup backfill must not re-import it as send:/speech:
//      alias rows, must not touch physical rows/seq/next_seq, and must not resend.
//   2. Legacy alias rows already stored stay on disk; history reads hide them only while
//      the exact intent link + same-conversation canonical delivery witness hold.
//   3. The speech alias is hidden only through the real producer shape (send alias row
//      carrying sources[0]=qq_send / sources[1]=qq_speech aligned with the log rows and a
//      confirmed part) — never by time/text guessing.
//   4. Lifetime domination: a canonical chain that expires earlier keeps longer-lived
//      alias sources readable; unknown (NULL) expiry is never treated as covered.
//   5. Filtering runs before LIMIT+1: pages stay full, hasMore stays correct, global
//      cursor coordinates and execution watermarks are preserved across sealed epochs.
// Synthetic fixtures only; no real data, services, QQ or model calls.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qqDeliveryAuthorize } from "../../src/server/channels/onebot11/delivery-authority";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { type QqSendPartInput, recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { createQqBinding, type QqBinding } from "../../src/server/services/qq-binding-contract";

import type { ConversationEvent } from "../../src/shared/contracts/conversation";

type Handle = ReturnType<typeof openBusinessDb>;

const handles: Handle[] = [];
const dirs: string[] = [];
const future = "2099-01-01T00:00:00.000Z";
const at = "2026-10-10T00:00:00.000Z";

/** Windows can hold the SQLite -wal/-shm files for a moment after close(); retry briefly.
 * Matches the repo-wide fixture cleanup contract (refactor-upgrade-restore.test.ts): a residual
 * temp dir under the OS temp root is reported, never silently ignored. */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
  const leftover = existsSync(dir) ? readdirSync(dir).join(",") : "(gone)";
  console.warn(`fixture temp dir retained after bounded retries: ${dir} (leftover: ${leftover})`);
}

afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

function memoryDb(): Handle {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  updateQqSettings(h.orm, { enabled: true, accountId: "100", expectedRevision: 1 });
  return h;
}

function fileDb(name: string): { h: Handle; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ss-legacy-projection-"));
  dirs.push(dir);
  const dbPath = join(dir, name);
  const h = openBusinessDb({ path: dbPath });
  handles.push(h);
  ensureDefaults(h.orm, "fixture");
  updateQqSettings(h.orm, { enabled: true, accountId: "100", expectedRevision: 1 });
  return { h, dbPath };
}

/** Real contract path for a private binding, so the revisions the authority checks are live. */
function addPrivateBinding(
  h: Handle,
  journal: ConversationEventRepository,
  key: string,
): {
  binding: QqBinding;
  scheme: ReturnType<typeof createQqScheme>;
  conversation: NonNullable<ReturnType<ConversationEventRepository["ensureOneBot"]>>;
} {
  const scheme = createQqScheme(h.orm, {
    name: `history-${key}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
  });
  // The binding contract requires a UUID id; `key` only labels the fixture scheme.
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "100",
    kind: "private",
    peerId: "200",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved")
    throw new Error(`fixture: createQqBinding returned ${created.kind}`);
  const binding = insertQqBinding(h.orm, created.binding);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error(`fixture: ensureOneBot(${binding.id}) returned null`);
  return { binding, scheme, conversation };
}

function deliveryTarget(
  h: Handle,
  binding: QqBinding,
  scheme: { id: string; revision: number },
  conversation: { bindingEpoch: number },
): OutboundTarget {
  const agent = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("fixture: default agent row missing");
  return {
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
    bindingId: binding.id,
    bindingEpoch: conversation.bindingEpoch,
    bindingRevision: binding.revision,
    authorityRevision: binding.authorityRevision,
    ownerIdentityRevision: binding.ownerIdentityRevision,
    schemeId: scheme.id,
    schemeRevision: scheme.revision,
    agentConfigVersion: agent.configVersion,
    sources: [],
  };
}

function commitIntent(
  h: Handle,
  journal: ConversationEventRepository,
  conversationId: string,
  target: OutboundTarget,
  id: string,
): OutboundIntentRepository {
  new AgentRunRepository(h.db).createRun({
    runId: `run-${id}`,
    specId: "fixture",
    specVersion: "1",
    owner: {
      kind: "conversation",
      id: conversationId,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    },
    at,
  });
  const outbox = new OutboundIntentRepository(h.db);
  outbox.commit({
    id,
    runId: `run-${id}`,
    conversationId,
    ordinal: 0,
    target,
    speechKind: "direct_reply",
    sourceThroughSeq: journal.sourceThroughSeq(conversationId),
    deliverBy: future,
    createdAt: at,
    expiresAt: future,
    parts: [{ kind: "text", text: `speech ${id}` }],
  });
  return outbox;
}

type SendFact = {
  id: string;
  recorded_at: string;
  expires_at: string;
  sent_at_seconds: number;
  kind: string;
};
function sendFact(h: Handle, id: string): SendFact {
  const row = h.db
    .query("SELECT id,recorded_at,expires_at,sent_at_seconds,kind FROM qq_send_log WHERE id=?")
    .get(id) as SendFact | undefined;
  if (!row) throw new Error(`fixture: qq_send_log row ${id} missing`);
  return row;
}
type SpeechFact = { id: string; recorded_at: string; expires_at: string; spoke_at_seconds: number };
function speechFact(h: Handle, id: string): SpeechFact {
  const row = h.db
    .query("SELECT id,recorded_at,expires_at,spoke_at_seconds FROM qq_speech_log WHERE id=?")
    .get(id) as SpeechFact | undefined;
  if (!row) throw new Error(`fixture: qq_speech_log row ${id} missing`);
  return row;
}

function appendCanonicalDelivery(
  journal: ConversationEventRepository,
  conversationId: string,
  intentId: string,
  sourceExpiresAt: string,
): void {
  journal.append({
    conversationId,
    eventKey: `output:${intentId}`,
    kind: "delivery",
    source: {
      kind: "outbound_intent",
      id: intentId,
      revision: "planned",
      expiresAt: sourceExpiresAt,
    },
    occurredAt: at,
    recordedAt: at,
    outputId: intentId,
  });
}

/** Alias row in the exact producer shape; `rowExpiresAt` overrides only the row's own lifetime stamp. */
function appendSendAlias(
  journal: ConversationEventRepository,
  h: Handle,
  conversationId: string,
  sendId: string,
  speechId: string | null,
  options: { suffix?: string; rowExpiresAt?: string | null; revision?: string } = {},
): ConversationEvent {
  const send = sendFact(h, sendId);
  const speech = speechId ? speechFact(h, speechId) : null;
  const rowExpiresAt = options.rowExpiresAt === undefined ? send.expires_at : options.rowExpiresAt;
  return journal.append({
    conversationId,
    eventKey: `send:${sendId}${options.suffix ? `:${options.suffix}` : ""}`,
    kind: "outbound",
    source: {
      kind: "qq_send",
      id: sendId,
      revision: options.revision ?? send.recorded_at,
      ...(rowExpiresAt === null ? {} : { expiresAt: rowExpiresAt }),
    },
    sources: [
      { kind: "qq_send", id: sendId, revision: send.recorded_at, expiresAt: send.expires_at },
      ...(speech
        ? [
            {
              kind: "qq_speech",
              id: speech.id,
              revision: String(speech.spoke_at_seconds),
              expiresAt: speech.expires_at,
            },
          ]
        : []),
    ],
    occurredAt: new Date(send.sent_at_seconds * 1000).toISOString(),
    recordedAt: send.recorded_at,
    outputId: sendId,
  });
}

function appendSpeechAlias(
  journal: ConversationEventRepository,
  h: Handle,
  conversationId: string,
  speechId: string,
  options: { suffix?: string; rowExpiresAt?: string | null } = {},
): void {
  const speech = speechFact(h, speechId);
  const rowExpiresAt =
    options.rowExpiresAt === undefined ? speech.expires_at : options.rowExpiresAt;
  journal.append({
    conversationId,
    eventKey: `speech:${speechId}${options.suffix ? `:${options.suffix}` : ""}`,
    kind: "outbound",
    source: {
      kind: "qq_speech",
      id: speechId,
      revision: String(speech.spoke_at_seconds),
      ...(rowExpiresAt === null ? {} : { expiresAt: rowExpiresAt }),
    },
    occurredAt: new Date(speech.spoke_at_seconds * 1000).toISOString(),
    recordedAt: speech.recorded_at,
  });
}

function appendInbound(
  journal: ConversationEventRepository,
  conversationId: string,
  key: string,
): void {
  journal.append({
    conversationId,
    eventKey: key,
    kind: "inbound",
    source: { kind: "fixture", id: key, revision: "r1" },
    occurredAt: at,
    recordedAt: at,
  });
}

const confirmedPart = (messageId: string): QqSendPartInput => ({
  kind: "text",
  result: "confirmed",
  messageId,
});

function recordSend(h: Handle, parts: QqSendPartInput[], atSeconds: number): SendFact {
  const log = recordQqSend(h.orm, {
    scope: {
      kind: "qq",
      accountId: "100",
      conversationKind: "private",
      peerId: "200",
      agentId: DEFAULT_AGENT_ID,
    },
    kind: "direct_reply",
    parts,
    sentAtSeconds: atSeconds,
    text: parts.some((part) => part.result === "confirmed") ? "recorded send" : null,
    sourceExpiresAt: future,
  }).log;
  return sendFact(h, log.id);
}

function recordStandaloneSpeech(h: Handle, id: string, atSeconds: number): void {
  recordQqSpeech(h.orm, {
    scope: {
      kind: "qq",
      accountId: "100",
      conversationKind: "private",
      peerId: "200",
      agentId: DEFAULT_AGENT_ID,
    },
    id,
    kind: "direct_reply",
    spokeAtSeconds: atSeconds,
    text: `standalone ${id}`,
    sourceExpiresAt: future,
  });
}

/** Historical send row written before the journal existed; creates no speech record of its own. */
function insertHistoricalSend(
  h: Handle,
  input: { id: string; atSeconds: number; recordedAt: string; expiresAt: string },
): void {
  h.db
    .query(
      `INSERT INTO qq_send_log(id,account_id,conversation_kind,peer_id,agent_id,kind,outcome,delivery_message_id,sent_at_seconds,expires_at,recorded_at)
       VALUES(?,'100','private','200',?,'direct_reply','sent',?,?,?,?)`,
    )
    .run(
      input.id,
      DEFAULT_AGENT_ID,
      `receipt-${input.id}`,
      input.atSeconds,
      input.expiresAt,
      input.recordedAt,
    );
  h.db
    .query(
      "INSERT INTO qq_send_part(send_id,part_index,part_kind,result,platform_message_id,sticker_id) VALUES(?,0,'text','confirmed',?,NULL)",
    )
    .run(input.id, `receipt-${input.id}`);
}

type JournalRow = {
  conversation_id: string;
  seq: number;
  event_key: string;
  kind: string;
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
function journalRows(h: Handle): JournalRow[] {
  return h.db
    .query(
      `SELECT conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id
       FROM conversation_events ORDER BY conversation_id,seq`,
    )
    .all() as JournalRow[];
}
function nextSeqOf(h: Handle, conversationId: string): number {
  return (
    h.db.query("SELECT next_seq FROM conversations WHERE id=?").get(conversationId) as {
      next_seq: number;
    }
  ).next_seq;
}
function physicalCount(h: Handle, conversationId: string): number {
  return (
    h.db
      .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
      .get(conversationId) as {
      n: number;
    }
  ).n;
}
function allEventKeys(journal: ConversationEventRepository, conversationId: string): string[] {
  return journal
    .historyBefore(conversationId, Number.MAX_SAFE_INTEGER, 100_000)
    .items.map(({ event }) => event.eventKey);
}

/** One canonical unit: intent-linked confirmed send + canonical delivery row + alias rows + one visible event. */
function seedHistoricalUnit(
  h: Handle,
  journal: ConversationEventRepository,
  conversationId: string,
  index: number,
  aliasCount: number,
): void {
  const sendId = `send-unit-${index}`;
  const intentId = `intent-unit-${index}`;
  const runId = `run-unit-${index}`;
  const sentAtSeconds = 1_700_000_000 + index;
  h.db
    .query(
      `INSERT INTO agent_runs(run_id,spec_id,spec_version,owner_kind,owner_id,user_id,agent_id,status,started_at,ended_at,error_code)
       VALUES(?,'fixture','1','conversation',?,?,?,'completed',?,NULL,NULL)`,
    )
    .run(runId, conversationId, DEFAULT_USER_ID, DEFAULT_AGENT_ID, at);
  h.db
    .query(
      `INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,source_through_seq,deliver_by,status,created_at,expires_at,legacy_send_id)
       VALUES(?,?,?,0,'{}','direct_reply',0,?,'confirmed',?,?,?)`,
    )
    .run(intentId, runId, conversationId, future, at, future, sendId);
  h.db
    .query(
      `INSERT INTO qq_send_log(id,account_id,conversation_kind,peer_id,agent_id,kind,outcome,delivery_message_id,sent_at_seconds,expires_at,recorded_at)
       VALUES(?,'100','private','200',?,'direct_reply','sent',?,?,?,?)`,
    )
    .run(sendId, DEFAULT_AGENT_ID, `receipt-${sendId}`, sentAtSeconds, future, at);
  h.db
    .query(
      "INSERT INTO qq_send_part(send_id,part_index,part_kind,result,platform_message_id,sticker_id) VALUES(?,0,'text','confirmed',?,NULL)",
    )
    .run(sendId, `receipt-${sendId}`);
  h.db
    .query(
      `INSERT INTO qq_speech_log(id,account_id,conversation_kind,peer_id,agent_id,kind,spoke_at_seconds,expires_at,recorded_at)
       VALUES(?,'100','private','200',?,'direct_reply',?,?,?)`,
    )
    .run(sendId, DEFAULT_AGENT_ID, sentAtSeconds, future, at);
  journal.append({
    conversationId,
    eventKey: `output:${intentId}`,
    kind: "delivery",
    source: { kind: "outbound_intent", id: intentId, revision: "planned", expiresAt: future },
    occurredAt: at,
    recordedAt: at,
    outputId: intentId,
  });
  // Alias rows in the old-data shape: the dedup identity (conversation_id, source_kind,
  // source_id, source_revision) needs distinct revisions (alias-0/-1), so the second and
  // later alias rows carry it directly instead of being appended with the send's revision.
  for (let alias = 0; alias < aliasCount; alias += 1) {
    appendSendAlias(journal, h, conversationId, sendId, sendId, {
      suffix: alias === 0 ? undefined : `extra-${alias}`,
      revision: alias === 0 ? undefined : `alias-${alias}`,
    });
  }
  appendSpeechAlias(journal, h, conversationId, sendId);
  appendInbound(journal, conversationId, `visible-unit-${index}`);
}

describe("canonical legacy-send dedup: real delivery chain", () => {
  it("cold reopen backfill adds nothing: prefix rows/seq/next_seq unchanged, one logical output, port never resends", async () => {
    const { h, dbPath } = fileDb("normative-green.sqlite");
    const sent: unknown[] = [];
    const journal = new ConversationEventRepository(h.db);
    const { binding, scheme, conversation } = addPrivateBinding(h, journal, "binding-real");
    h.db
      .query(
        `INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
         VALUES('evt-real','100','private','200',?,'msg-real',100,'member','200',?,1)`,
      )
      .run(DEFAULT_AGENT_ID, at);
    h.db
      .query("INSERT INTO qq_observation_text VALUES(?,?,?,?,?)")
      .run("evt-real", "hello", 100, future, at);
    journal.ingestOneBotEvent("evt-real", binding.id);

    const outbox = commitIntent(
      h,
      journal,
      conversation.id,
      deliveryTarget(h, binding, scheme, conversation),
      "intent-real",
    );
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => null,
      // Real production authority: the full factory with its current deps contract.
      authorize: qqDeliveryAuthorize({
        orm: h.orm,
        db: h.db,
        journal,
        outbox,
        guard: new QqGroupCapabilityGuard(h.orm),
      }),
      // Synthetic clock: stale checks (deliver_by, source expiry) run against the fixture's
      // own timeline, never the wall clock.
      now: () => at,
      port: {
        send: async (request) => {
          sent.push(request);
          return { kind: "confirmed", messageId: "receipt-real" };
        },
      },
    });
    await delivery.deliver("intent-real");
    expect(sent).toHaveLength(1);
    const intentRow = h.db
      .query("SELECT status,legacy_send_id FROM outbound_intents WHERE id='intent-real'")
      .get() as { status: string; legacy_send_id: string | null };
    expect(intentRow.status).toBe("confirmed");
    expect(intentRow.legacy_send_id).not.toBeNull();

    const before = journalRows(h);
    const beforeNextSeq = nextSeqOf(h, conversation.id);
    delivery.stop();
    await delivery.waitForIdle();
    h.close();
    const reopened = openBusinessDb({ path: dbPath });
    handles.splice(handles.indexOf(h), 1, reopened);
    const journal2 = new ConversationEventRepository(reopened.db);
    journal2.backfill();

    const after = journalRows(reopened);
    expect(after).toEqual(before);
    expect(after.map((row) => row.event_key)).toEqual(before.map((row) => row.event_key));
    expect(nextSeqOf(reopened, conversation.id)).toBe(beforeNextSeq);
    expect(
      after.some((row) => row.event_key.startsWith("send:") || row.event_key.startsWith("speech:")),
    ).toBe(false);
    const projections = after.filter(
      (row) => row.output_id === "intent-real" || row.output_id === intentRow.legacy_send_id,
    );
    expect(projections.length).toBeGreaterThanOrEqual(1);
    expect(projections.every((row) => row.source_kind === "outbound_intent")).toBe(true);
    expect(sent).toHaveLength(1);
    const summary = journal2.historySummary(conversation.id);
    expect(summary?.lastSeq).toBe(after.length);
    expect(
      (
        reopened.db
          .query("SELECT consumed_seq FROM conversations WHERE id=?")
          .get(conversation.id) as {
          consumed_seq: number;
        }
      ).consumed_seq,
    ).toBe(0);
  });
});

describe("canonical read view: witness, identity and retention discipline", () => {
  it("hides already-stored same-intent alias rows from reads while every journal row stays on disk", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { binding, scheme, conversation } = addPrivateBinding(h, journal, "binding-stored");
    const send = recordSend(h, [confirmedPart("receipt-stored")], 200);
    const outbox = commitIntent(
      h,
      journal,
      conversation.id,
      deliveryTarget(h, binding, scheme, conversation),
      "intent-stored",
    );
    outbox.markLegacyProjection("intent-stored", send.id);
    appendCanonicalDelivery(journal, conversation.id, "intent-stored", send.expires_at);
    appendSendAlias(journal, h, conversation.id, send.id, send.id);
    appendSpeechAlias(journal, h, conversation.id, send.id);
    const stored = journalRows(h);
    journal.backfill();
    expect(journalRows(h)).toEqual(stored);
    const read = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 1000);
    expect(read.items.some(({ event }) => event.source.kind === "qq_send")).toBe(false);
    expect(read.items.some(({ event }) => event.source.kind === "qq_speech")).toBe(false);
    expect(read.items.filter(({ event }) => event.source.kind === "outbound_intent")).toHaveLength(
      1,
    );
    expect(physicalCount(h, conversation.id)).toBe(stored.length);
    expect(journal.historySummary(conversation.id)?.lastSeq).toBe(stored.length);
    journal.backfill();
    // Physical rows are untouched and the read view is idempotent across repeated backfills.
    expect(journalRows(h)).toEqual(stored);
    expect(allEventKeys(journal, conversation.id)).toEqual(
      read.items.map(({ event }) => event.eventKey),
    );
  });

  it("needs link AND same-conversation canonical witness; renamed witness reveals, output_id mismatch is not guessed", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { binding, scheme, conversation } = addPrivateBinding(h, journal, "binding-witness");
    const send = recordSend(h, [confirmedPart("receipt-witness")], 300);
    const outbox = commitIntent(
      h,
      journal,
      conversation.id,
      deliveryTarget(h, binding, scheme, conversation),
      "intent-witness",
    );
    outbox.markLegacyProjection("intent-witness", send.id);
    appendSendAlias(journal, h, conversation.id, send.id, send.id);
    appendSpeechAlias(journal, h, conversation.id, send.id);
    const aliasesVisible = () => {
      const items = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 1000).items;
      return {
        send: items.some(
          ({ event }) => event.source.kind === "qq_send" && event.source.id === send.id,
        ),
        speech: items.some(
          ({ event }) => event.source.kind === "qq_speech" && event.source.id === send.id,
        ),
      };
    };
    // The speech alias hides through the producer-shaped send alias row alone; the send
    // alias itself stays until the intent link gains a same-conversation canonical witness.
    expect(aliasesVisible()).toEqual({ send: true, speech: false });
    appendCanonicalDelivery(journal, conversation.id, "intent-witness", send.expires_at);
    expect(aliasesVisible()).toEqual({ send: false, speech: false });
    h.db
      .query(
        "UPDATE conversation_events SET source_id='intent-renamed' WHERE event_key='output:intent-witness'",
      )
      .run();
    expect(aliasesVisible()).toEqual({ send: true, speech: false });
    h.db
      .query(
        "UPDATE conversation_events SET source_id='intent-witness',output_id='different-intent' WHERE event_key='output:intent-witness'",
      )
      .run();
    expect(aliasesVisible()).toEqual({ send: false, speech: false });
  });

  it("keeps failed, unknown, partial and unlinked delivery history plus unmatched standalone speech", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { conversation } = addPrivateBinding(h, journal, "binding-history");
    const failed = recordSend(h, [{ kind: "text", result: "failed", messageId: null }], 400);
    const unknown = recordSend(h, [{ kind: "text", result: "unknown", messageId: null }], 401);
    const partial = recordSend(
      h,
      [confirmedPart("receipt-partial"), { kind: "text", result: "failed", messageId: null }],
      402,
    );
    const unlinked = recordSend(h, [confirmedPart("receipt-unlinked")], 403);
    recordStandaloneSpeech(h, "speech-unmatched", 404);
    journal.backfill();
    journal.backfill();
    const items = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 1000).items;
    const idsOf = (kind: string) =>
      items.filter(({ event }) => event.source.kind === kind).map(({ event }) => event.source.id);
    expect(idsOf("qq_send")).toEqual([failed.id, unknown.id, partial.id, unlinked.id]);
    expect(idsOf("qq_speech")).toEqual(["speech-unmatched"]);
    for (const send of [failed, unknown, partial, unlinked]) {
      expect(items.filter(({ event }) => event.source.id === send.id)).toHaveLength(1);
    }
    expect(items.find(({ event }) => event.source.id === failed.id)?.event.kind).toBe("delivery");
    const stored = journalRows(h);
    journal.backfill();
    expect(journalRows(h)).toEqual(stored);
  });

  it("pairs a later different-ID legacy send with the already-indexed standalone speech by producer shape and hides only that speech", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { conversation } = addPrivateBinding(h, journal, "binding-pair");
    recordStandaloneSpeech(h, "speech-pair-a", 500);
    recordStandaloneSpeech(h, "speech-pair-b", 500);
    journal.backfill();
    expect(allEventKeys(journal, conversation.id).sort()).toEqual([
      "speech:speech-pair-a",
      "speech:speech-pair-b",
    ]);
    insertHistoricalSend(h, {
      id: "send-pair-late",
      atSeconds: 500,
      recordedAt: "2026-10-10T00:05:00.000Z",
      expiresAt: future,
    });
    journal.backfill();
    const aliasRow = h.db
      .query("SELECT sources FROM conversation_events WHERE event_key='send:send-pair-late'")
      .get() as { sources: string } | undefined;
    expect(aliasRow).toBeDefined();
    const aliasRowSource = aliasRow?.sources ?? null;
    expect(aliasRowSource).not.toBeNull();
    const sources = JSON.parse(aliasRowSource as string) as { kind: string; id: string }[];
    expect(sources[0]).toMatchObject({ kind: "qq_send", id: "send-pair-late" });
    expect(sources[1]).toMatchObject({ kind: "qq_speech", id: "speech-pair-a" });
    const items = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 1000).items;
    expect(
      items.some(
        ({ event }) => event.source.kind === "qq_speech" && event.source.id === "speech-pair-a",
      ),
    ).toBe(false);
    expect(
      items.some(
        ({ event }) => event.source.kind === "qq_speech" && event.source.id === "speech-pair-b",
      ),
    ).toBe(true);
    expect(items.filter(({ event }) => event.source.id === "send-pair-late")).toHaveLength(1);
    const stored = journalRows(h);
    journal.backfill();
    expect(journalRows(h)).toEqual(stored);
    const send = sendFact(h, "send-pair-late");
    h.db
      .query("UPDATE conversation_events SET sources=? WHERE event_key='send:send-pair-late'")
      .run(
        JSON.stringify([
          { kind: "qq_send", id: send.id, revision: send.recorded_at, expiresAt: send.expires_at },
        ]),
      );
    const after = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 1000).items;
    expect(
      after.some(
        ({ event }) => event.source.kind === "qq_speech" && event.source.id === "speech-pair-a",
      ),
    ).toBe(true);
  });

  it("applies lifetime domination: earlier-expiring canonical chains keep aliases readable and NULL expiry is never covered", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { binding, scheme, conversation } = addPrivateBinding(h, journal, "binding-retention");
    const send = recordSend(h, [confirmedPart("receipt-retention")], 600);
    const outbox = commitIntent(
      h,
      journal,
      conversation.id,
      deliveryTarget(h, binding, scheme, conversation),
      "intent-retention",
    );
    outbox.markLegacyProjection("intent-retention", send.id);
    appendCanonicalDelivery(journal, conversation.id, "intent-retention", send.expires_at);
    const laterThanSend = new Date(Date.parse(send.expires_at) + 86_400_000).toISOString();
    // Same logical send stored three times: old-data shape differed in source_revision
    // (alias-N), and the journal dedup identity needs that difference.
    // The witness must be the producer's canonical alias row (event_key `send:<id>` exactly);
    // suffixed historical variants can never witness the speech alias.
    appendSendAlias(journal, h, conversation.id, send.id, send.id, {
      rowExpiresAt: send.expires_at,
    });
    appendSendAlias(journal, h, conversation.id, send.id, send.id, {
      suffix: "later",
      rowExpiresAt: laterThanSend,
      revision: "alias-later",
    });
    appendSendAlias(journal, h, conversation.id, send.id, null, {
      suffix: "nullstamp",
      rowExpiresAt: null,
      revision: "alias-nullstamp",
    });
    appendSpeechAlias(journal, h, conversation.id, send.id);
    const keys = allEventKeys(journal, conversation.id);
    expect(keys).not.toContain(`send:${send.id}:covered`);
    expect(keys).not.toContain(`speech:${send.id}`);
    expect(keys).toContain(`send:${send.id}:later`);
    expect(keys).toContain(`send:${send.id}:nullstamp`);
    expect(keys).toContain("output:intent-retention");

    // Canonical send expires before the longer-lived speech: the speech stays readable.
    const longSpeechId = "speech-retention-long";
    recordStandaloneSpeech(h, longSpeechId, 1_800_000_000);
    journal.backfill();
    const speechExpiry = speechFact(h, longSpeechId).expires_at;
    const earlyExpiry = new Date(Date.parse(speechExpiry) - 86_400_000).toISOString();
    insertHistoricalSend(h, {
      id: "send-retention-early",
      atSeconds: 1_800_000_000,
      recordedAt: "2026-10-10T00:06:00.000Z",
      expiresAt: earlyExpiry,
    });
    journal.backfill();
    // The earlier-expiring send stays readable beside the longer-lived speech (lifetime
    // domination never hides a lawful active alias behind an expired canonical send).
    const earlyKeys = allEventKeys(journal, conversation.id);
    const earlyPhysical = journalRows(h)
      .filter((row) => row.conversation_id === conversation.id)
      .map((row) => row.event_key);
    const earlyLog = h.db
      .query(
        "SELECT id,sent_at_seconds,expires_at,recorded_at FROM qq_send_log WHERE id='send-retention-early'",
      )
      .get() as { id: string } | undefined;
    expect(earlyLog).toBeDefined();
    expect(earlyPhysical).toContain("send:send-retention-early");
    expect(earlyKeys).toContain("send:send-retention-early");
    expect(earlyKeys).toContain(`speech:${longSpeechId}`);

    // Standalone speech first: its journal row must exist BEFORE the paired send arrives.
    const nullSpeechId = "speech-retention-null";
    recordStandaloneSpeech(h, nullSpeechId, 1_900_000_000);
    journal.backfill();
    const speechAliasRows = journalRows(h).filter(
      (row) =>
        row.conversation_id === conversation.id && row.event_key === `speech:${nullSpeechId}`,
    );
    expect(speechAliasRows).toHaveLength(1);

    // The paired send arrives afterwards; the read view hides the speech through the
    // producer-shaped alias while every physical row (including the speech alias) stays.
    insertHistoricalSend(h, {
      id: "send-retention-nullw",
      atSeconds: 1_900_000_000,
      recordedAt: "2026-10-10T00:07:00.000Z",
      expiresAt: future,
    });
    journal.backfill();
    expect(allEventKeys(journal, conversation.id)).not.toContain(`speech:${nullSpeechId}`);
    expect(
      journalRows(h).filter(
        (row) =>
          row.conversation_id === conversation.id && row.event_key === `speech:${nullSpeechId}`,
      ),
    ).toHaveLength(1);

    // A NULL lifetime stamp on the speech alias row itself is never treated as covered:
    // unknown keeps the source readable instead of being guessed against the canonical chain.
    const nullStamp = h.db
      .query("UPDATE conversation_events SET source_expires_at=NULL WHERE event_key=?")
      .run(`speech:${nullSpeechId}`);
    expect(nullStamp.changes).toBe(1);
    expect(allEventKeys(journal, conversation.id)).toContain(`speech:${nullSpeechId}`);

    // Independent small negative: a NULL stamp on the paired send alias row also keeps that
    // source readable; the row is proven to physically exist before the update.
    const sendAliasBefore = journalRows(h).filter(
      (row) =>
        row.conversation_id === conversation.id && row.event_key === "send:send-retention-nullw",
    );
    expect(sendAliasBefore).toHaveLength(1);
    const sendStamp = h.db
      .query("UPDATE conversation_events SET source_expires_at=NULL WHERE event_key=?")
      .run("send:send-retention-nullw");
    expect(sendStamp.changes).toBe(1);
    expect(allEventKeys(journal, conversation.id)).toContain("send:send-retention-nullw");
  });
});

describe("canonical read view: pagination and sealed-epoch coordinates", () => {
  it("filters aliases before LIMIT+1: pages stay full, hasMore stays correct, physical coordinates preserved", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const { conversation } = addPrivateBinding(h, journal, "binding-pages");
    for (let index = 0; index < 101; index += 1) {
      seedHistoricalUnit(h, journal, conversation.id, index, index % 5 === 0 ? 2 : 1);
    }
    const totalVisible = 202;
    const totalPhysical = 101 * 4 + 21;
    const full = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 100_000);
    expect(full.items).toHaveLength(totalVisible);
    expect(full.hasMore).toBe(false);
    expect(
      full.items.every(
        ({ event }) => event.source.kind !== "qq_send" && event.source.kind !== "qq_speech",
      ),
    ).toBe(true);
    const latest = journal.historyBefore(conversation.id, Number.MAX_SAFE_INTEGER, 100);
    expect(latest.items).toEqual(full.items.slice(-100));
    expect(latest.hasMore).toBe(true);
    const older = journal.historyBefore(conversation.id, latest.firstSeq, 100);
    expect(older.items).toEqual(full.items.slice(-200, -100));
    expect(older.hasMore).toBe(true);
    const oldest = journal.historyBefore(conversation.id, older.firstSeq, 100);
    expect(oldest.items).toEqual(full.items.slice(0, -200));
    expect(oldest.hasMore).toBe(false);
    const first = journal.historyAfter(conversation.id, 0, 100);
    expect(first.items).toEqual(full.items.slice(0, 100));
    expect(first.hasMore).toBe(true);
    const second = journal.historyAfter(conversation.id, first.nextSeq, 100);
    expect(second.items).toEqual(full.items.slice(100, 200));
    expect(second.hasMore).toBe(true);
    const third = journal.historyAfter(conversation.id, second.nextSeq, 100);
    expect(third.items).toEqual(full.items.slice(200));
    expect(third.hasMore).toBe(false);
    expect(physicalCount(h, conversation.id)).toBe(totalPhysical);
    expect(journal.historySummary(conversation.id)?.lastSeq).toBe(totalPhysical);
  });

  it("keeps global cursor continuity across sealed A→B→A epochs and excludes the foreign-agent epoch", () => {
    const h = memoryDb();
    const journal = new ConversationEventRepository(h.db);
    const {
      binding,
      scheme,
      conversation: epoch1,
    } = addPrivateBinding(h, journal, "binding-epochs");
    h.db
      .query(
        `INSERT INTO agents(id,name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at)
         SELECT 'agent-history-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?`,
      )
      .run(DEFAULT_AGENT_ID);
    appendInbound(journal, epoch1.id, "a-1");
    appendInbound(journal, epoch1.id, "a-2");
    appendInbound(journal, epoch1.id, "a-3");
    seedHistoricalUnit(h, journal, epoch1.id, 0, 1);
    void binding;
    void scheme;
    h.db
      .query("UPDATE qq_bindings SET agent_id='agent-history-b',revision=revision+1 WHERE id=?")
      .run(binding.id);
    const epoch2 = journal.ensureOneBot(binding.id);
    if (!epoch2) throw new Error("fixture: rebinding to agent B failed");
    appendInbound(journal, epoch2.id, "b-1");
    appendInbound(journal, epoch2.id, "b-2");
    h.db
      .query("UPDATE qq_bindings SET agent_id=?,revision=revision+1 WHERE id=?")
      .run(DEFAULT_AGENT_ID, binding.id);
    const epoch3 = journal.ensureOneBot(binding.id);
    if (!epoch3) throw new Error("fixture: rebinding back to agent A failed");
    appendInbound(journal, epoch3.id, "a-4");
    appendInbound(journal, epoch3.id, "a-5");

    const page = journal.historyBefore(epoch3.id, Number.MAX_SAFE_INTEGER, 100);
    expect(page.items.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 7, 8, 9]);
    expect(page.hasMore).toBe(false);
    expect(page.items.every(({ event }) => event.conversationId !== epoch2.id)).toBe(true);
    expect(page.items.some(({ event }) => event.eventKey.startsWith("b-"))).toBe(false);
    expect(journal.historyBefore(epoch3.id, 8, 3).items.map(({ seq }) => seq)).toEqual([3, 4, 7]);
    expect(journal.historyAfter(epoch3.id, 6, 100).items.map(({ seq }) => seq)).toEqual([7, 8, 9]);
    expect(
      h.db.query("SELECT id,next_seq,consumed_seq FROM conversations ORDER BY binding_epoch").all(),
    ).toEqual([
      { id: epoch1.id, next_seq: 8, consumed_seq: 0 },
      { id: epoch2.id, next_seq: 3, consumed_seq: 0 },
      { id: epoch3.id, next_seq: 3, consumed_seq: 0 },
    ]);
    const summary = journal.historySummary(epoch3.id);
    expect(summary?.id).toBe(epoch1.id);
    expect(summary?.lastSeq).toBe(9);
  });
});
