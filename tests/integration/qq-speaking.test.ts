// P3a: speaking eligibility and in-flight cancellation (ADR0018).
//
// Two halves, and the seam between them is the point.
//
// The eligibility half is checked BEFORE generation, because that is the only moment at
// which "should this be said at all" can be answered. The in-flight half is checked
// before sending, because a trigger switched off while content was being generated must
// still stop that content — and, just as importantly, it must NOT re-apply the no-reply
// rule: by then the silence an opener was born from is still there, and re-checking would
// make every "open a topic into silence" message cancel itself. Two tests below pin that
// asymmetry in both directions.
//
// The records half exists because OneBot drops the assistant's own messages as
// `self_message`, so nothing else in the database knows that the assistant spoke. Without
// it the no-reply rule would silently reset on every restart.

import { describe, expect, it } from "bun:test";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import {
  lastQqInitiativeSeconds,
  lastQqSpeech,
  newestMemberMessageSeconds,
  purgeExpiredQqSpeech,
  recordQqSpeech,
} from "../../src/server/db/qq-speech-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { observationExpiresAt } from "../../src/server/services/qq-retention";
import {
  checkQqSpeechSend,
  checkQqSpeechTrigger,
  isInitiativeSpeech,
  parseQqSpeechKind,
  QQ_SPEECH_KINDS,
} from "../../src/server/services/qq-speaking-contract";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  return { business, orm: business.orm, db: business.db };
}

function scope(overrides: Partial<Extract<QqConversationScope, object>> = {}): QqConversationScope {
  return {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId: "20001",
    agentId: AGENT_ID,
    ...overrides,
  } as QqConversationScope;
}

/** A recorded group message, written directly so the test controls speaker kinds. */
function insertEvent(
  orm: Orm,
  input: {
    scope?: QqConversationScope;
    eventKey: string;
    occurredAtSeconds: number;
    speakerKind?: string;
    speakerId?: string | null;
  },
) {
  const target = input.scope ?? scope();
  const speakerKind = input.speakerKind ?? "member";
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: input.eventKey,
      accountId: target.accountId,
      conversationKind: target.conversationKind,
      peerId: target.peerId,
      agentId: target.agentId,
      messageId: input.eventKey,
      occurredAtSeconds: input.occurredAtSeconds,
      speakerKind,
      speakerId:
        input.speakerId === undefined
          ? speakerKind === "member"
            ? "30001"
            : null
          : input.speakerId,
      recordedAt: nowIso(),
    })
    .run();
}

/** The full trigger input for a conversation, read from storage as the real caller would. */
function triggerFor(
  orm: Orm,
  kind: string,
  overrides: Partial<{
    featureEnabled: boolean;
    conversationPaused: boolean;
    disabledKinds: readonly string[];
    conversation: QqConversationScope;
  }> = {},
) {
  const conversation = overrides.conversation ?? scope();
  return {
    kind,
    featureEnabled: overrides.featureEnabled ?? true,
    conversationPaused: overrides.conversationPaused ?? false,
    disabledKinds: overrides.disabledKinds ?? [],
    lastInitiativeSeconds: lastQqInitiativeSeconds(orm, conversation),
    newestMemberMessageSeconds: newestMemberMessageSeconds(orm, conversation),
  };
}

describe("speech kinds", () => {
  it("treats exactly the unprompted paths as initiative-taking", () => {
    expect([...QQ_SPEECH_KINDS]).toEqual(["direct_reply", "follow_up", "chiming_in", "idle_topic"]);
    expect(isInitiativeSpeech("chiming_in")).toBe(true);
    expect(isInitiativeSpeech("idle_topic")).toBe(true);
    // A reply answers being addressed; a continuation keeps a live conversation going.
    expect(isInitiativeSpeech("direct_reply")).toBe(false);
    expect(isInitiativeSpeech("follow_up")).toBe(false);
    expect(() => isInitiativeSpeech("shout")).toThrow(TypeError);
  });
});

describe("eligibility before generating", () => {
  it("refuses every kind once the feature is off", () => {
    const h = setup();
    try {
      for (const kind of QQ_SPEECH_KINDS) {
        expect(checkQqSpeechTrigger(triggerFor(h.orm, kind, { featureEnabled: false }))).toEqual({
          kind: "blocked",
          reason: "feature_off",
        });
      }
    } finally {
      h.business.close();
    }
  });

  it("honours the conversation pause", () => {
    const h = setup();
    try {
      expect(
        checkQqSpeechTrigger(triggerFor(h.orm, "direct_reply", { conversationPaused: true })),
      ).toEqual({ kind: "blocked", reason: "conversation_paused" });
    } finally {
      h.business.close();
    }
  });

  it("honours a switched-off trigger for the kind it names", () => {
    const h = setup();
    try {
      expect(
        checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic", { disabledKinds: ["idle_topic"] })),
      ).toEqual({ kind: "blocked", reason: "trigger_off" });
      // Only the named kind is stopped.
      expect(
        checkQqSpeechTrigger(triggerFor(h.orm, "chiming_in", { disabledKinds: ["idle_topic"] })),
      ).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });

  it("refuses a second initiative while nobody has answered", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, { scope: scope(), kind: "chiming_in", spokeAtSeconds: 1_000 });
      for (const kind of ["chiming_in", "idle_topic"]) {
        expect(checkQqSpeechTrigger(triggerFor(h.orm, kind))).toEqual({
          kind: "blocked",
          reason: "awaiting_reply",
        });
      }
    } finally {
      h.business.close();
    }
  });

  it("allows an initiative again once a partner speaks, without requiring an answer to us", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, { scope: scope(), kind: "idle_topic", spokeAtSeconds: 1_000 });
      // Somebody said something to the group. It is not addressed to us; that is enough.
      insertEvent(h.orm, { eventKey: "e2", occurredAtSeconds: 1_001 });
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic"))).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });

  it("allows an initiative when there is no record of one", () => {
    const h = setup();
    try {
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "chiming_in"))).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });

  it("never applies the no-reply rule to a reply or a continuation", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, { scope: scope(), kind: "chiming_in", spokeAtSeconds: 1_000 });
      // Being addressed after our own initiative went unanswered must still be answered:
      // the alternative is refusing a direct question, which inverts the rule's purpose.
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "direct_reply"))).toEqual({ kind: "allowed" });
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "follow_up"))).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });

  it("does not treat a same-second message as an answer", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, { scope: scope(), kind: "idle_topic", spokeAtSeconds: 1_000 });
      // Message times have second precision, so a message in the same second may well have
      // been sent before we spoke. Counting it as a reply would let a two-second-old
      // initiative be followed by another one.
      insertEvent(h.orm, { eventKey: "e2", occurredAtSeconds: 1_000 });
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic"))).toEqual({
        kind: "blocked",
        reason: "awaiting_reply",
      });
    } finally {
      h.business.close();
    }
  });

  it("rejects input that does not match the contract", () => {
    const h = setup();
    try {
      expect(() => checkQqSpeechTrigger(triggerFor(h.orm, "shout"))).toThrow(TypeError);
      const full = triggerFor(h.orm, "chiming_in");
      expect(() =>
        checkQqSpeechTrigger({
          kind: full.kind,
          featureEnabled: full.featureEnabled,
          conversationPaused: full.conversationPaused,
          lastInitiativeSeconds: full.lastInitiativeSeconds,
          newestMemberMessageSeconds: full.newestMemberMessageSeconds,
        }),
      ).toThrow(TypeError);
      expect(() =>
        checkQqSpeechTrigger({ ...triggerFor(h.orm, "chiming_in"), extra: true }),
      ).toThrow(TypeError);
      expect(parseQqSpeechKind("idle_topic")).toBe("idle_topic");
      expect(() => parseQqSpeechKind(null)).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });
});

describe("in-flight cancellation before sending", () => {
  it("stops generated content of a kind whose trigger was switched off", () => {
    expect(
      checkQqSpeechSend({
        kind: "idle_topic",
        featureEnabled: true,
        conversationPaused: false,
        disabledKinds: ["idle_topic"],
      }),
    ).toEqual({ kind: "blocked", reason: "trigger_off" });
    expect(
      checkQqSpeechSend({
        kind: "follow_up",
        featureEnabled: true,
        conversationPaused: false,
        disabledKinds: ["idle_topic"],
      }),
    ).toEqual({ kind: "allowed" });
  });

  it("stops generated content when the conversation is paused or the feature is off", () => {
    expect(
      checkQqSpeechSend({
        kind: "direct_reply",
        featureEnabled: true,
        conversationPaused: true,
        disabledKinds: [],
      }),
    ).toEqual({ kind: "blocked", reason: "conversation_paused" });
    expect(
      checkQqSpeechSend({
        kind: "direct_reply",
        featureEnabled: false,
        conversationPaused: false,
        disabledKinds: [],
      }),
    ).toEqual({ kind: "blocked", reason: "feature_off" });
  });

  it("does not re-apply the no-reply rule at send time", () => {
    const h = setup();
    try {
      // An opener is generated precisely BECAUSE the room is silent. If the same rule were
      // re-checked here it would veto the very message it was waiting for, so send-time
      // cancellation deliberately looks only at configuration.
      recordQqSpeech(h.orm, { scope: scope(), kind: "idle_topic", spokeAtSeconds: 1_000 });
      expect(newestMemberMessageSeconds(h.orm, scope())).toBeNull();
      expect(
        checkQqSpeechSend({
          kind: "idle_topic",
          featureEnabled: true,
          conversationPaused: false,
          disabledKinds: [],
        }),
      ).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });
});

describe("speech records", () => {
  it("records a speech on the same retention window as message text", () => {
    const h = setup();
    try {
      const row = recordQqSpeech(h.orm, {
        scope: scope(),
        kind: "chiming_in",
        spokeAtSeconds: 1_700_000_000,
      });
      expect(row.kind).toBe("chiming_in");
      expect(row.spokeAtSeconds).toBe(1_700_000_000);
      expect(row.expiresAt).toBe(observationExpiresAt(1_700_000_000));
      const days = (Date.parse(row.expiresAt) - 1_700_000_000_000) / 86_400_000;
      expect(days).toBe(14);
      // No content is stored: the rule only needs order.
      const columns = h.db
        .query("PRAGMA table_info(qq_speech_log)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(columns).toEqual([
        "id",
        "account_id",
        "conversation_kind",
        "peer_id",
        "agent_id",
        "kind",
        "spoke_at_seconds",
        "expires_at",
        "recorded_at",
      ]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a timestamp that is not a whole non-negative second", () => {
    const h = setup();
    try {
      expect(() =>
        recordQqSpeech(h.orm, { scope: scope(), kind: "follow_up", spokeAtSeconds: -1 }),
      ).toThrow(TypeError);
      expect(() =>
        recordQqSpeech(h.orm, { scope: scope(), kind: "follow_up", spokeAtSeconds: 1.5 }),
      ).toThrow(TypeError);
      expect(() =>
        recordQqSpeech(h.orm, { scope: scope(), kind: "shout" as never, spokeAtSeconds: 10 }),
      ).toThrow(TypeError);
      expect(h.orm.select().from(schema.qqSpeechLog).all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("remembers the last initiative only, ignoring replies and continuations", () => {
    const h = setup();
    try {
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBeNull();
      recordQqSpeech(h.orm, { scope: scope(), kind: "direct_reply", spokeAtSeconds: 500 });
      // Answering is not taking the initiative, so the no-reply rule stays untouched.
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBeNull();
      recordQqSpeech(h.orm, { scope: scope(), kind: "idle_topic", spokeAtSeconds: 700 });
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBe(700);
      // A later reply does not erase the initiative.
      recordQqSpeech(h.orm, { scope: scope(), kind: "follow_up", spokeAtSeconds: 900 });
      expect(lastQqInitiativeSeconds(h.orm, scope())).toBe(700);
      expect(lastQqSpeech(h.orm, scope())).toEqual({ kind: "follow_up", spokeAtSeconds: 900 });
    } finally {
      h.business.close();
    }
  });

  it("counts a partner and an anonymous member, but not a system notice", () => {
    const h = setup();
    try {
      insertEvent(h.orm, {
        eventKey: "sys",
        occurredAtSeconds: 100,
        speakerKind: "system",
        speakerId: null,
      });
      // A group's own bookkeeping is not somebody answering.
      expect(newestMemberMessageSeconds(h.orm, scope())).toBeNull();
      insertEvent(h.orm, {
        eventKey: "anon",
        occurredAtSeconds: 200,
        speakerKind: "anonymous",
        speakerId: null,
      });
      insertEvent(h.orm, { eventKey: "member", occurredAtSeconds: 300 });
      expect(newestMemberMessageSeconds(h.orm, scope())).toBe(300);
    } finally {
      h.business.close();
    }
  });

  it("keeps conversations and assistants apart", () => {
    const h = setup();
    try {
      const here = scope();
      const otherPeer = scope({ peerId: "20002" });
      const otherKind = scope({ conversationKind: "private" });
      recordQqSpeech(h.orm, { scope: here, kind: "chiming_in", spokeAtSeconds: 1_000 });
      insertEvent(h.orm, { eventKey: "elsewhere", occurredAtSeconds: 2_000, scope: otherPeer });
      expect(lastQqInitiativeSeconds(h.orm, otherPeer)).toBeNull();
      expect(lastQqInitiativeSeconds(h.orm, otherKind)).toBeNull();
      // Another conversation's chatter must not release this one's rule either.
      expect(newestMemberMessageSeconds(h.orm, here)).toBeNull();
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "chiming_in"))).toEqual({
        kind: "blocked",
        reason: "awaiting_reply",
      });
    } finally {
      h.business.close();
    }
  });

  it("sweeps only the expired records", () => {
    const h = setup();
    try {
      const now = Math.floor(Date.parse(nowIso()) / 1000);
      recordQqSpeech(h.orm, { scope: scope(), kind: "chiming_in", spokeAtSeconds: 1_000 });
      recordQqSpeech(h.orm, { scope: scope(), kind: "idle_topic", spokeAtSeconds: now - 10 });
      expect(purgeExpiredQqSpeech(h.orm)).toBe(1);
      expect(h.orm.select().from(schema.qqSpeechLog).all()).toHaveLength(1);
      expect(purgeExpiredQqSpeech(h.orm)).toBe(0);
    } finally {
      h.business.close();
    }
  });

  it("carries a whole turn: an opener waits until a partner speaks", () => {
    const h = setup();
    try {
      const target = scope();
      // Nothing said yet, and we have never spoken: opening a topic is allowed.
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic"))).toEqual({ kind: "allowed" });
      recordQqSpeech(h.orm, { scope: target, kind: "idle_topic", spokeAtSeconds: 1_000 });
      // We spoke into silence, so we do not speak again.
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic"))).toEqual({
        kind: "blocked",
        reason: "awaiting_reply",
      });
      // A partner finally speaks: the rule is released, without anyone answering us.
      insertEvent(h.orm, { eventKey: "later", occurredAtSeconds: 1_200 });
      expect(checkQqSpeechTrigger(triggerFor(h.orm, "idle_topic"))).toEqual({ kind: "allowed" });
    } finally {
      h.business.close();
    }
  });
});
