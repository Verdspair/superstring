// The configurable retention window (migration 0050): one setting on the single
// `qq_settings` row, stamped into new rows only.
//
// The directed facts this file pins, because each is a rule the wiring could silently break:
//   * the storage settings read/save share the SAME revision as enable/account and transport
//     saves, so two surfaces cannot overwrite each other (CAS);
//   * saving a window never rewrites existing expiry stamps — a shortened window must not
//     orphan rows the user could still read — and a new row stamps the window in effect;
//   * expiry is "unreadable": an expired body/note/speech is absent from reads (and from the
//     sources a reader would re-read) even though the physical row is still there, because
//     physical deletion is the explicit manual cleanup and nothing purges in the background;
//   * the production write points (observation intake, speech, send — the shape
//     `outbound-delivery` uses) all pick up the stored window.

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mediaNoteRow, recordMediaNote } from "../../src/server/db/qq-media-repository";
import { qqMemberLabels } from "../../src/server/db/qq-member-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  conversationMessagesSince,
  observationText,
} from "../../src/server/db/qq-observation-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  readQqRetentionDays,
  readQqSettings,
  readQqStorageSettings,
  updateQqStorageSettings,
  updateQqTransportConfig,
} from "../../src/server/db/qq-settings-repository";
import { ownSpeechSince, recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const NOW_SECONDS = Math.floor(Date.parse("2026-09-22T12:00:00.000Z") / 1000);
const DAY_SECONDS = 24 * 60 * 60;
const SCOPE = {
  kind: "qq",
  accountId: "10001",
  conversationKind: "group",
  peerId: "30003",
  agentId: AGENT_ID,
} as const;

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm };
}

/** The fixed-width stamp shape (`nowIso()`/`observationExpiresAt`) the DB comparisons rely on. */
function stamp(seconds: number, days: number): string {
  const d = new Date((seconds + days * DAY_SECONDS) * 1000);
  const base = d.toISOString().slice(0, 19);
  return `${base}.${String(d.getUTCMilliseconds()).padStart(3, "0")}000Z`;
}

function fixedIso(seconds: number): string {
  const d = new Date(seconds * 1000);
  const base = d.toISOString().slice(0, 19);
  return `${base}.${String(d.getUTCMilliseconds()).padStart(3, "0")}000Z`;
}

function observation(
  patch: {
    eventKey?: string;
    text?: string;
    occurredAtSeconds?: number;
    segments?: QqObservation["segments"];
  } = {},
): QqObservation {
  const eventKey = patch.eventKey ?? "evt_1";
  return {
    accountId: "10001",
    conversation: { kind: "group", peerId: "30003", key: '["qq","10001","group","30003"]' },
    eventKey,
    messageId: eventKey,
    occurredAtSeconds: patch.occurredAtSeconds ?? NOW_SECONDS,
    subType: "normal",
    speaker: { kind: "member", id: "20002", displayName: "群友" },
    segments: patch.segments ?? [{ kind: "text", text: patch.text ?? "你好" }],
    text: patch.text ?? "你好",
    mentionsSelf: false,
  };
}

/** The machine-readable code of the AppError a call throws, or `undefined` if it does not. */
function errorCodeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("the storage settings surface", () => {
  it("reads the seeded window and saves a new one on the shared revision", () => {
    const h = setup();
    try {
      expect(readQqStorageSettings(h.orm)).toEqual({
        revision: 1,
        retention_days: 14,
        cleanup_mode: "manual",
      });
      expect(readQqRetentionDays(h.orm)).toBe(14);
      expect(updateQqStorageSettings(h.orm, { retentionDays: 30, expectedRevision: 1 })).toEqual({
        revision: 2,
        retention_days: 30,
        cleanup_mode: "manual",
      });
      expect(readQqRetentionDays(h.orm)).toBe(30);
    } finally {
      h.business.close();
    }
  });

  it("validates the window strictly and rejects a stale revision", () => {
    const h = setup();
    try {
      // Out-of-range and non-integer values never reach the row; the table CHECK is a
      // backstop, not the validation.
      for (const retentionDays of [0, 3651, 1.5, Number.NaN]) {
        expect(
          errorCodeOf(() => updateQqStorageSettings(h.orm, { retentionDays, expectedRevision: 1 })),
        ).toBe("MEMORY_SOURCE_INVALID");
      }
      expect(readQqStorageSettings(h.orm).revision).toBe(1);
      // A stale revision is a conflict (the caller must reload and re-save), not a validation error.
      updateQqStorageSettings(h.orm, { retentionDays: 30, expectedRevision: 1 });
      expect(
        errorCodeOf(() =>
          updateQqStorageSettings(h.orm, { retentionDays: 20, expectedRevision: 1 }),
        ),
      ).toBe("MEMORY_STATE_CONFLICT");
      // Saving the value that is already there is a no-op: no revision bump, so a second tab
      // saving an unrelated field is not invalidated by a click that changed nothing.
      expect(updateQqStorageSettings(h.orm, { retentionDays: 30, expectedRevision: 2 })).toEqual({
        revision: 2,
        retention_days: 30,
        cleanup_mode: "manual",
      });
      expect(readQqStorageSettings(h.orm).revision).toBe(2);
    } finally {
      h.business.close();
    }
  });

  it("shares one revision with the transport save, in both directions", () => {
    const h = setup();
    try {
      // Transport first: the storage save that still carries revision 1 must conflict.
      updateQqTransportConfig(h.orm, {
        endpoint: "ws://127.0.0.1:3000/",
        expectedRevision: 1,
      });
      expect(readQqStorageSettings(h.orm).revision).toBe(2);
      expect(
        errorCodeOf(() =>
          updateQqStorageSettings(h.orm, { retentionDays: 20, expectedRevision: 1 }),
        ),
      ).toBe("MEMORY_STATE_CONFLICT");
      updateQqStorageSettings(h.orm, { retentionDays: 20, expectedRevision: 2 });
      // And the reverse: a transport save holding the pre-settings revision must conflict too.
      expect(readQqSettings(h.orm).revision).toBe(3);
      expect(
        errorCodeOf(() => updateQqTransportConfig(h.orm, { endpoint: null, expectedRevision: 2 })),
      ).toBe("MEMORY_STATE_CONFLICT");
      updateQqTransportConfig(h.orm, { endpoint: null, expectedRevision: 3 });
      expect(readQqStorageSettings(h.orm)).toEqual({
        revision: 4,
        retention_days: 20,
        cleanup_mode: "manual",
      });
    } finally {
      h.business.close();
    }
  });
});

describe("the window applies to new rows only", () => {
  it("leaves an existing row's expiry and source hash untouched when the window changes", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation({ eventKey: "evt_old", text: "旧句子" }), AGENT_ID);
      const before = conversationMessagesSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        includeSources: true,
        now: fixedIso(NOW_SECONDS + 60),
      });
      expect(before).toHaveLength(1);
      const oldSource = before[0]!.sources![0]!;
      expect(oldSource).toMatchObject({ kind: "qq_observation", id: "evt_old" });
      expect(oldSource.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(oldSource.revision).toBe(createHash("sha256").update("旧句子").digest("hex"));

      // Lengthen the window to 30 days, then write a new message.
      updateQqStorageSettings(h.orm, {
        retentionDays: 30,
        expectedRevision: readQqSettings(h.orm).revision,
      });
      recordObservation(h.orm, observation({ eventKey: "evt_new", text: "新句子" }), AGENT_ID);

      // The old row was not rewritten: same expiry, same hash.
      const rows = h.orm.select().from(schema.qqObservationText).all();
      const oldText = rows.find((row) => row.eventKey === "evt_old")!;
      expect(oldText.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(oldText.body).toBe("旧句子");

      const after = conversationMessagesSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        includeSources: true,
        now: fixedIso(NOW_SECONDS + 121),
      });
      const byKey = new Map(after.map((row) => [row.eventKey, row]));
      // The old message is still readable under its own (shorter) window…
      expect(byKey.get("evt_old")!.text).toBe("旧句子");
      expect(byKey.get("evt_old")!.sources![0]!.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(byKey.get("evt_old")!.sources![0]!.revision).toBe(
        createHash("sha256").update("旧句子").digest("hex"),
      );
      // …and each source's expiry is its own row's stamp: the new message carries the new window.
      expect(byKey.get("evt_new")!.text).toBe("新句子");
      expect(byKey.get("evt_new")!.sources![0]!.expiresAt).toBe(stamp(NOW_SECONDS, 30));
    } finally {
      h.business.close();
    }
  });

  it("leaves every kind of existing row on its own stamp when the window changes", () => {
    const h = setup();
    try {
      // One row of every kind, written under the seeded 14-day window. The message carries
      // text, a nickname and a media segment, so all three of its parts are visible too.
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_old",
          text: "旧句子",
          segments: [
            { kind: "text", text: "旧句子" },
            { kind: "image", file: "file://synthetic-old.png" },
          ],
        }),
        AGENT_ID,
      );
      recordQqSpeech(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        spokeAtSeconds: NOW_SECONDS,
        text: "旧发言",
      });
      recordQqSend(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "9000" }],
        sentAtSeconds: NOW_SECONDS + 2,
        text: "旧回答",
      });
      expect(h.orm.select().from(schema.qqObservationText).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 14),
      );
      expect(h.orm.select().from(schema.qqMembers).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 14),
      );
      expect(mediaNoteRow(h.orm, "evt_old", 1)!.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(h.orm.select().from(schema.qqSpeechText).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 14),
      );
      expect(h.orm.select().from(schema.qqSendLog).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS + 2, 14),
      );

      // The save rewrites none of them: the old message keeps its body and its source keeps the
      // shorter stamp and the same content hash, and every other kind keeps its stamp too.
      updateQqStorageSettings(h.orm, {
        retentionDays: 30,
        expectedRevision: readQqSettings(h.orm).revision,
      });
      const unchanged = h.orm.select().from(schema.qqObservationText).all()[0]!;
      expect(unchanged.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(unchanged.body).toBe("旧句子");
      expect(mediaNoteRow(h.orm, "evt_old", 1)!.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(h.orm.select().from(schema.qqSpeechText).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 14),
      );
      expect(h.orm.select().from(schema.qqSendLog).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS + 2, 14),
      );
      const before = conversationMessagesSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        includeSources: true,
        now: fixedIso(NOW_SECONDS + 60),
      })[0]!;
      expect(before.sources![0]!).toMatchObject({
        kind: "qq_observation",
        id: "evt_old",
        expiresAt: stamp(NOW_SECONDS, 14),
        revision: createHash("sha256").update("旧句子").digest("hex"),
      });

      // A new row of every kind meanwhile stamps the new window. The member row follows its
      // speaker — being seen again refreshes a nickname — not the save, and the re-sighting must
      // be strictly newer (a tied delivery cannot prove a rename), hence the +1s.
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_new",
          text: "新句子",
          occurredAtSeconds: NOW_SECONDS + 1,
          segments: [
            { kind: "text", text: "新句子" },
            { kind: "image", file: "file://synthetic-new.png" },
          ],
        }),
        AGENT_ID,
      );
      recordQqSpeech(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        spokeAtSeconds: NOW_SECONDS + 1,
        text: "新发言",
      });
      recordQqSend(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "9001" }],
        sentAtSeconds: NOW_SECONDS + 3,
        text: "新回答",
      });
      const texts = new Map(
        h.orm
          .select()
          .from(schema.qqObservationText)
          .all()
          .map((row) => [row.eventKey, row] as const),
      );
      expect(texts.get("evt_old")!.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(texts.get("evt_new")!.expiresAt).toBe(stamp(NOW_SECONDS + 1, 30));
      expect(mediaNoteRow(h.orm, "evt_old", 1)!.expiresAt).toBe(stamp(NOW_SECONDS, 14));
      expect(mediaNoteRow(h.orm, "evt_new", 1)!.expiresAt).toBe(stamp(NOW_SECONDS + 1, 30));
      const members = h.orm.select().from(schema.qqMembers).all();
      expect(members).toHaveLength(1);
      expect(members[0]!.expiresAt).toBe(stamp(NOW_SECONDS + 1, 30));
      const speechStamps = new Map(
        h.orm
          .select()
          .from(schema.qqSpeechText)
          .all()
          .map((row) => [row.spokeAtSeconds, row.expiresAt] as const),
      );
      expect(speechStamps.get(NOW_SECONDS)).toBe(stamp(NOW_SECONDS, 14));
      expect(speechStamps.get(NOW_SECONDS + 1)).toBe(stamp(NOW_SECONDS + 1, 30));
      const sendStamps = new Map(
        h.orm
          .select()
          .from(schema.qqSendLog)
          .all()
          .map((row) => [row.sentAtSeconds, row.expiresAt] as const),
      );
      expect(sendStamps.get(NOW_SECONDS + 2)).toBe(stamp(NOW_SECONDS + 2, 14));
      expect(sendStamps.get(NOW_SECONDS + 3)).toBe(stamp(NOW_SECONDS + 3, 30));
    } finally {
      h.business.close();
    }
  });

  it("stamps the new window into every kind of new row (observation, speech, send)", () => {
    const h = setup();
    try {
      updateQqStorageSettings(h.orm, {
        retentionDays: 30,
        expectedRevision: readQqSettings(h.orm).revision,
      });

      // One observation with text, a nickname and a media segment: all three stamps come from
      // the single settings read inside `writeObservation`.
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_new",
          text: "带图的话",
          segments: [
            { kind: "text", text: "带图的话" },
            { kind: "image", file: "file://synthetic.png" },
          ],
        }),
        AGENT_ID,
      );
      expect(h.orm.select().from(schema.qqObservationText).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 30),
      );
      expect(h.orm.select().from(schema.qqMembers).all()[0]!.expiresAt).toBe(
        stamp(NOW_SECONDS, 30),
      );
      expect(mediaNoteRow(h.orm, "evt_new", 1)!.expiresAt).toBe(stamp(NOW_SECONDS, 30));
      expect(
        qqMemberLabels(h.orm, {
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
        }).get("20002"),
      ).toBe("群友");

      // Speech written without an explicit window — the default must be the stored one.
      recordQqSpeech(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        spokeAtSeconds: NOW_SECONDS,
        text: "我说话了",
      });
      // A send without an explicit window — this is the shape `outbound-delivery` calls with.
      const send = recordQqSend(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "9001" }],
        sentAtSeconds: NOW_SECONDS + 5,
        text: "回答",
      });
      expect(send.unrespondedRecord).toEqual({ kind: "recorded" });
      expect(send.log.expiresAt).toBe(stamp(NOW_SECONDS + 5, 30));
      const speechTexts = h.orm.select().from(schema.qqSpeechText).all();
      expect(speechTexts).toHaveLength(2);
      for (const row of speechTexts) expect(row.expiresAt).toBe(stamp(row.spokeAtSeconds, 30));
    } finally {
      h.business.close();
    }
  });
});

describe("expiry is unreadable, not deleted", () => {
  it("returns no text, no media notes and no sources once the window has passed", () => {
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_secret",
          text: "过期的话",
          segments: [
            { kind: "text", text: "过期的话" },
            { kind: "image", file: "file://synthetic.png" },
          ],
        }),
        AGENT_ID,
      );
      recordMediaNote(h.orm, {
        eventKey: "evt_secret",
        segmentIndex: 1,
        note: "一只猫",
        noteModel: "vision",
      });

      // Inside the window the same query returns everything.
      const readable = conversationMessagesSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        includeSources: true,
        now: fixedIso(NOW_SECONDS + DAY_SECONDS),
      });
      expect(readable[0]!.text).toBe("过期的话");
      expect(readable[0]!.mediaNotes).toEqual(["[vision] 一只猫"]);
      expect(readable[0]!.sources).toHaveLength(2);

      // Past it, nothing readable comes back — even though the rows are still on disk.
      const expiredAt = fixedIso(NOW_SECONDS + 15 * DAY_SECONDS);
      const expired = conversationMessagesSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        includeSources: true,
        now: expiredAt,
      });
      expect(expired).toHaveLength(1);
      expect(expired[0]!.text).toBeNull();
      expect(expired[0]!.mediaNotes).toEqual([]);
      expect(expired[0]!.mediaUnread).toBe(0);
      expect(expired[0]!.sources).toEqual([]);
      expect(observationText(h.orm, ["evt_secret"], expiredAt).size).toBe(0);
      // The row survives: only the manual cleanup deletes, and it was never asked to.
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(1);
      expect(mediaNoteRow(h.orm, "evt_secret", 1)!.note).toBe("一只猫");
    } finally {
      h.business.close();
    }
  });

  it("omits the assistant's own expired speech from the context read", () => {
    const h = setup();
    try {
      recordQqSpeech(h.orm, {
        scope: SCOPE,
        kind: "direct_reply",
        spokeAtSeconds: NOW_SECONDS,
        text: "旧发言",
      });
      const readable = ownSpeechSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        now: fixedIso(NOW_SECONDS + DAY_SECONDS),
      });
      expect(readable.map((row) => row.text)).toEqual(["旧发言"]);
      const expired = ownSpeechSince(h.orm, SCOPE, {
        sinceSeconds: NOW_SECONDS - 60,
        limit: 10,
        now: fixedIso(NOW_SECONDS + 15 * DAY_SECONDS),
      });
      expect(expired).toEqual([]);
      // The record itself is untouched; only its body became unreadable.
      expect(h.orm.select().from(schema.qqSpeechLog).all()).toHaveLength(1);
      expect(h.orm.select().from(schema.qqSpeechText).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });
});
