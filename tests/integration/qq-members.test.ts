import { describe, expect, it } from "bun:test";
import {
  purgeExpiredQqMembers,
  qqMemberLabels,
  rememberQqMember,
} from "../../src/server/db/qq-member-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { qqIntakeCycle, recordInbound } from "../../src/server/services/qq-intake";
import { buildQqPrompt, QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { memberExpiresAt } from "../../src/server/services/qq-retention";

const scope = { accountId: "10001", conversationKind: "group", peerId: "30003" };
const at = Math.floor(Date.parse("2026-09-23T00:00:00Z") / 1000);
const now = "2026-09-23T00:00:00.000000Z";
const agent = "00000000-0000-0000-0000-000000000001";
function observation(patch: Partial<QqObservation> = {}): QqObservation {
  return {
    accountId: scope.accountId,
    conversation: { kind: "group", peerId: scope.peerId, key: "group-key" },
    eventKey: "event1",
    messageId: "m1",
    occurredAtSeconds: at,
    subType: "normal",
    speaker: { kind: "member", id: "20002", displayName: "昵称" },
    segments: [],
    text: "合成正文",
    mentionsSelf: false,
    ...patch,
  };
}
function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

describe("QQ latest member labels", () => {
  it("keeps one current nickname, stable identity and first-seen time", () => {
    const h = setup();
    try {
      rememberQqMember(h.orm, { scope, userId: "20002", nickname: "  旧名  ", seenAtSeconds: at });
      const row = rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "新名",
        seenAtSeconds: at + 10,
      });
      expect(row.firstSeenAtSeconds).toBe(at);
      expect(row.lastSeenAtSeconds).toBe(at + 10);
      expect(row.expiresAt).toBe(memberExpiresAt(at + 10));
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("新名");
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it("does not rewind the name or extend expiry on an older or same-second replay", () => {
    const h = setup();
    try {
      const latest = rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "新名",
        seenAtSeconds: at + 10,
      });
      for (const seenAtSeconds of [at, at + 10])
        expect(
          rememberQqMember(h.orm, { scope, userId: "20002", nickname: "旧名", seenAtSeconds }),
        ).toEqual(latest);
    } finally {
      h.close();
    }
  });
  it("isolates accounts, group/private kind and peers, but is not assistant-scoped", () => {
    const h = setup();
    try {
      const scopes = [
        scope,
        { ...scope, accountId: "10002" },
        { ...scope, conversationKind: "private" },
        { ...scope, peerId: "30004" },
      ];
      for (const [i, s] of scopes.entries()) {
        rememberQqMember(h.orm, {
          scope: s,
          userId: "20002",
          nickname: `name${i}`,
          seenAtSeconds: at,
        });
        expect([...qqMemberLabels(h.orm, s, now)]).toEqual([["20002", `name${i}`]]);
      }
      expect(
        h.db
          .query("PRAGMA table_info(qq_members)")
          .all()
          .map((x) => (x as { name: string }).name),
      ).not.toContain("agent_id");
    } finally {
      h.close();
    }
  });
  it("hides expired names before sweep, and sweep leaves event identities intact", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), agent);
      const expired = memberExpiresAt(at);
      expect(qqMemberLabels(h.orm, scope, expired).size).toBe(0);
      expect(purgeExpiredQqMembers(h.orm, expired)).toBe(1);
      expect(purgeExpiredQqMembers(h.orm, expired)).toBe(0);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it("rejects bad names and clocks, counts Unicode code points like SQLite", () => {
    const h = setup();
    try {
      for (const nickname of ["", " \t ", "x".repeat(65)])
        expect(() =>
          rememberQqMember(h.orm, { scope, userId: "20002", nickname, seenAtSeconds: at }),
        ).toThrow(TypeError);
      for (const seenAtSeconds of [-1, 1.5])
        expect(() =>
          rememberQqMember(h.orm, { scope, userId: "20002", nickname: "name", seenAtSeconds }),
        ).toThrow(TypeError);
      rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "𠮷".repeat(64),
        seenAtSeconds: at,
      });
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("𠮷".repeat(64));
      expect(() => h.db.exec("UPDATE qq_members SET nickname=' '")).toThrow();
      expect(() => h.db.exec("UPDATE qq_members SET last_seen_at_seconds=0")).toThrow();
    } finally {
      h.close();
    }
  });
});

describe("member labels in the observation chain", () => {
  it("records a name even for media-only messages, never anonymous/system", () => {
    const h = setup();
    try {
      expect(recordObservation(h.orm, observation({ text: "" }), agent).hasText).toBe(false);
      for (const kind of ["anonymous", "system"] as const)
        recordObservation(
          h.orm,
          observation({
            eventKey: kind,
            messageId: kind,
            speaker: { kind, id: null, displayName: "not-member" },
          }),
          agent,
        );
      expect([...qqMemberLabels(h.orm, scope, now)]).toEqual([["20002", "昵称"]]);
    } finally {
      h.close();
    }
  });
  it("ignores oversized/blank metadata without losing a valid message", () => {
    const h = setup();
    try {
      for (const displayName of [null, " ", "x".repeat(65)]) {
        const eventKey = String(displayName);
        expect(
          recordObservation(
            h.orm,
            observation({
              eventKey,
              messageId: eventKey,
              speaker: { kind: "member", id: "20002", displayName },
            }),
            agent,
          ).recorded,
        ).toBe(true);
      }
      expect(qqMemberLabels(h.orm, scope, now).size).toBe(0);
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(3);
    } finally {
      h.close();
    }
  });
  it("duplicate deliveries neither rewrite a name nor resurrect it after expiry", () => {
    const h = setup();
    try {
      const o = observation();
      recordObservation(h.orm, o, agent);
      const duplicate = { ...o, speaker: { ...o.speaker, displayName: "forged" } };
      expect(recordObservation(h.orm, duplicate, agent).recorded).toBe(false);
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("昵称");
      purgeExpiredQqMembers(h.orm, memberExpiresAt(at));
      recordObservation(h.orm, duplicate, agent);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("rolls back event, member and body together when a write fails", () => {
    const h = setup();
    try {
      h.db.exec(
        "CREATE TRIGGER reject_test_body BEFORE INSERT ON qq_observation_text BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      );
      expect(() => recordObservation(h.orm, observation(), agent)).toThrow();
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(0);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("paused intake still records names; cleanup runs without scheduling a model", () => {
    const h = setup();
    try {
      updateQqSettings(h.orm, { enabled: true, accountId: scope.accountId, expectedRevision: 1 });
      const scheme = createQqScheme(h.orm, { name: "test" });
      h.orm
        .insert(schema.qqBindings)
        .values({
          id: "00000000-0000-0000-0000-000000000002",
          accountId: scope.accountId,
          conversationKind: "group",
          peerId: scope.peerId,
          agentId: agent,
          schemeId: scheme.id,
          paused: 1,
          shareWebMemory: 0,
          revision: 1,
          authorityRevision: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();
      expect(
        recordInbound(
          h.orm,
          { kind: "message", observation: observation() },
          { accountId: scope.accountId },
        ).kind,
      ).toBe("recorded");
      const labels = qqMemberLabels(h.orm, scope, now);
      const sections = buildQqPrompt({
        tier: "reply",
        path: "direct_reply",
        persona: "",
        prompts: QQ_PROMPT_DEFAULTS,
        nowSeconds: at,
        labels,
        timeline: [
          {
            occurredAtSeconds: at,
            speaker: "member",
            speakerId: "20002",
            text: "合成正文",
            mediaNotes: [],
            mediaUnread: 0,
          },
        ],
      });
      expect(sections.find((s) => s.origin === "timeline")?.body).toContain("昵称(20002)");
      expect(qqIntakeCycle(h.orm, memberExpiresAt(at)).enqueued).toBe(0);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("unbound intake stores neither messages nor nicknames", () => {
    const h = setup();
    try {
      updateQqSettings(h.orm, { enabled: true, accountId: scope.accountId, expectedRevision: 1 });
      expect(
        recordInbound(
          h.orm,
          { kind: "message", observation: observation() },
          { accountId: scope.accountId },
        ),
      ).toEqual({ kind: "ignored", reason: "unbound_conversation" });
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});
