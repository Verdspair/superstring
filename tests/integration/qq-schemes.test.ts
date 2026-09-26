// P2i/P5a/P3b-1: named chat schemes (ADR0018).
//
// The point of the first stage was what it does NOT store: the plan labels the scheme's
// field groups "design labels, not frozen API fields", so 0010 carried no parameter column
// at all. Three groups have since been decided — the four speech switches (P5a), the rhythm
// parameters (P3b-1) and the judgement/reply context budgets (P3b-2) — and those are frozen.
// The rest (prompt text, relevance thresholds, and the remaining §5.2 values) still have no
// column, and the column test below pins that both ways: the decided ones are there, nothing
// else is.
//
// These tests also pin the two integrity rules that a naive implementation would miss:
// a binding may only name a scheme that exists, and an in-use scheme cannot be deleted.
//
// The integrity rules live in SQLite triggers rather than a foreign key, because
// `scheme_id` was already an opaque reference before schemes existed. The tests below
// exercise them through raw SQL as well as through the repository, so a broken trigger
// cannot hide behind the repository's own pre-checks.

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  createQqScheme,
  deleteQqScheme,
  qqSchemeUsage,
  readQqScheme,
  readQqSchemes,
  schemeContext,
  schemeReply,
  schemeRhythm,
  schemeStickers,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import {
  BUSINESS_MIGRATION_FILES,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QQ_STICKER_DEDUP_DEFAULT } from "../../src/shared/contracts/qq";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  return { business, orm: business.orm, db: business.db };
}
const MODEL = "qwen/qwen3-4b-2507";

/** Write a binding by hand so the trigger is exercised without the contract in the way. */
function insertBinding(orm: Orm, schemeId: string, id = BINDING_ID) {
  orm
    .insert(schema.qqBindings)
    .values({
      id,
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: AGENT_ID,
      schemeId,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
}

/**
 * 0016 把两档「最近条数」的 CHECK 上限写死在 200/500，契约放宽到 1 万之后写库才会被
 * 拒绝（用户看到的是一句原生约束错误）。0047 重建这两列并把上限抬到 1 万——**旧值必须原样搬回**，
 * 用户可能已经把判断设成 200、回复设成 300。
 */
describe("context limit caps (0047)", () => {
  it("keeps the stored values while raising the caps, and still refuses out-of-range writes", () => {
    const db = new Database(":memory:");
    try {
      for (const file of BUSINESS_MIGRATION_FILES.slice(0, 46))
        db.exec(
          readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
        );
      db.exec("PRAGMA user_version = 46");
      db.exec(
        "INSERT INTO qq_schemes (id,name,revision,created_at,updated_at,judgement_message_limit,reply_message_limit) VALUES ('old','旧方案',3,'then','then',137,321)",
      );
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 47 });
      expect(
        db
          .query(
            "SELECT name, revision, judgement_message_limit AS j, reply_message_limit AS r FROM qq_schemes",
          )
          .get(),
      ).toEqual({ name: "旧方案", revision: 3, j: 137, r: 321 });
      // 新上限（契约那一侧）真的写得进去，越界仍旧被拒。
      db.exec("UPDATE qq_schemes SET judgement_message_limit = 10000, reply_message_limit = 10000");
      expect(() => db.exec("UPDATE qq_schemes SET judgement_message_limit = 10001")).toThrow();
      expect(() => db.exec("UPDATE qq_schemes SET reply_message_limit = 0")).toThrow();
    } finally {
      db.close();
    }
  });
});

describe("scheme identity", () => {
  it("stores exactly the two decided parameter groups, and nothing still pending", () => {
    const h = setup();
    try {
      const created = createQqScheme(h.orm, { name: "默认方案" });
      const columns = h.db
        .query("PRAGMA table_info(qq_schemes)")
        .all()
        .map((row) => (row as { name: string }).name);
      // The decided groups are frozen here; the undecided ones (prompts, relevance
      // thresholds, the remaining §5.2 values) must NOT be — hence the exact list rather
      // than a "contains" check. The parameter columns sit after the switch columns because
      // SQLite can only append a column, so this is the table's real order.
      expect(columns).toEqual([
        "id",
        "name",
        "description",
        "revision",
        "created_at",
        "updated_at",
        "trigger_direct_reply",
        "trigger_follow_up",
        "trigger_chiming_in",
        "trigger_idle_topic",
        "merge_window_seconds",
        "reply_cooldown_seconds",
        "hourly_speech_limit",
        "idle_quiet_minutes",
        "active_hours_enabled",
        "active_hours_start_minutes",
        "active_hours_end_minutes",
        "max_recompute_count",
        "max_sticker_count",
        "judgement_window_minutes",
        "judgement_token_budget",
        "reply_window_minutes",
        "reply_token_budget",
        "prompt_scene",
        "prompt_judge",
        "prompt_reply",
        "prompt_review",
        "prompt_sticker",
        "prompt_media",
        "judgement_output_reserved",
        "reply_output_reserved",
        "sticker_min_repeat_minutes",
        "sticker_recent_avoid_count",
        "media_supplement_window_minutes",
        "media_frame_count",
        "media_max_dimension",
        "initiative_min_score",
        "split_reply_by_speaker",
        "judgement_interval_turns",
        // 0046：压缩与装配（水位触发条数、包上限、装配冗余 + 水位压缩提示词）。
        "summary_watermark_trigger",
        "summary_package_limit",
        "headroom_ratio",
        "prompt_compress",
        // 0047 为抬高上限重建过这两列，SQLite 只能追加，所以它们排在表尾。
        "judgement_message_limit",
        "reply_message_limit",
      ]);
      expect(created.name).toBe("默认方案");
      expect(created.description).toBeNull();
      expect(created.revision).toBe(1);
      // A scheme is a QQ-global resource: nothing ties it to an assistant.
      expect(columns).not.toContain("agent_id");
      expect(readQqScheme(h.orm, created.id)?.name).toBe("默认方案");
      expect(readQqSchemes(h.orm)).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("starts a new scheme on the defaults the user fixed, not on zeroes", () => {
    const h = setup();
    try {
      const created = createQqScheme(h.orm, { name: "默认方案" });
      expect(schemeRhythm(created)).toEqual(QQ_RHYTHM_DEFAULT);
      // Spelled out, so a change to the defaults has to be a deliberate edit of this test
      // rather than something that slides through with the constant.
      expect(schemeRhythm(created)).toEqual({
        merge_window_seconds: 30,
        reply_cooldown_seconds: 10,
        hourly_speech_limit: 200,
        initiative_min_score: 6,
        // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
        judgement_interval_turns: 3,
        idle_quiet_minutes: 15,
        active_hours_enabled: false,
        active_hours_start_minutes: 0,
        active_hours_end_minutes: 1439,
        max_recompute_count: 1,
        max_sticker_count: 1,
        media_supplement_window_minutes: 10,
        media_frame_count: 3,
        media_max_dimension: 512,
      });
      // The context tiers are the third decided group (P3b-2), on the same terms.
      expect(schemeContext(created)).toEqual(QQ_CONTEXT_DEFAULT);
      expect(schemeContext(created)).toEqual({
        judgement_message_limit: 20,
        judgement_window_minutes: 60,
        judgement_token_budget: 2000,
        reply_message_limit: 60,
        reply_window_minutes: 360,
        reply_token_budget: 6000,
      });
      // §9.3's repetition rules are the newest decided group (P4d).
      expect(schemeStickers(created)).toEqual(QQ_STICKER_DEDUP_DEFAULT);
      expect(schemeStickers(created)).toEqual({
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
      });
    } finally {
      h.business.close();
    }
  });

  it("round-trips the repetition rules and treats a no-op save as no change", () => {
    const h = setup();
    try {
      const created = createQqScheme(h.orm, { name: "默认方案" });
      const saved = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        stickers: { sticker_min_repeat_minutes: 0, sticker_recent_avoid_count: 0 },
        expectedRevision: created.revision,
      });
      // 0 must survive as 0 on both columns: the group's "no limit" settings are values, so a
      // `??`-style merge that treated them as absent would silently restore the defaults.
      expect(schemeStickers(saved)).toEqual({
        sticker_min_repeat_minutes: 0,
        sticker_recent_avoid_count: 0,
      });
      expect(saved.revision).toBe(2);
      const noop = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        stickers: { sticker_min_repeat_minutes: 0, sticker_recent_avoid_count: 0 },
        expectedRevision: saved.revision,
      });
      expect(noop.revision).toBe(2);
      // Omitting the group leaves it alone rather than resetting it to the project defaults.
      const renamed = updateQqScheme(h.orm, created.id, {
        name: "改个名",
        expectedRevision: noop.revision,
      });
      expect(schemeStickers(renamed)).toEqual({
        sticker_min_repeat_minutes: 0,
        sticker_recent_avoid_count: 0,
      });
      expect(() =>
        updateQqScheme(h.orm, created.id, {
          name: "改个名",
          stickers: { sticker_min_repeat_minutes: 1441, sticker_recent_avoid_count: 5 },
          expectedRevision: renamed.revision,
        }),
      ).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("round-trips the reply shape and treats a no-op save as no change", () => {
    const h = setup();
    try {
      // 新建默认开着。
      const created = createQqScheme(h.orm, { name: "默认方案" });
      expect(schemeReply(created)).toEqual({ split_by_speaker: true });
      const off = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        reply: { split_by_speaker: false },
        expectedRevision: created.revision,
      });
      expect(schemeReply(off)).toEqual({ split_by_speaker: false });
      expect(off.revision).toBe(2);
      // A save that changes nothing must not look like a change — including "already off".
      const noop = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        reply: { split_by_speaker: false },
        expectedRevision: off.revision,
      });
      expect(noop.revision).toBe(2);
      // Omitting the group leaves it alone rather than resetting it to the default.
      const renamed = updateQqScheme(h.orm, created.id, {
        name: "改个名",
        expectedRevision: noop.revision,
      });
      expect(schemeReply(renamed)).toEqual({ split_by_speaker: false });
      expect(() =>
        updateQqScheme(h.orm, created.id, {
          name: "改个名",
          reply: { split_by_speaker: "yes" } as never,
          expectedRevision: renamed.revision,
        }),
      ).toThrow(TypeError);
    } finally {
      h.business.close();
    }
  });

  it("counts a change to the media wait window as a change", () => {
    const h = setup();
    try {
      // P5o's browser check found this the hard way: the field was accepted, rendered and sent,
      // and then silently dropped because the no-op comparison did not know it existed — the page
      // reported "saved" over a write that never happened. So the group's equality now has a test
      // that fails if a future field is added to the contract but forgotten here.
      const created = createQqScheme(h.orm, { name: "默认方案" });
      expect(schemeRhythm(created).media_supplement_window_minutes).toBe(10);
      const changed = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        rhythm: { ...schemeRhythm(created), media_supplement_window_minutes: 25 },
        expectedRevision: created.revision,
      });
      expect(changed.revision).toBe(2);
      expect(schemeRhythm(changed).media_supplement_window_minutes).toBe(25);
      // And the same value again is still a no-op.
      const noop = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        rhythm: { ...schemeRhythm(changed), media_supplement_window_minutes: 25 },
        expectedRevision: changed.revision,
      });
      expect(noop.revision).toBe(2);
    } finally {
      h.business.close();
    }
  });

  it("refuses a rhythm value outside its range, and keeps the revision on a no-op save", () => {
    const h = setup();
    try {
      const created = createQqScheme(h.orm, { name: "默认方案" });
      // The contract and the table's CHECK enforce the same bounds; this is the contract
      // half, so an out-of-range value never reaches SQLite.
      expect(() =>
        updateQqScheme(h.orm, created.id, {
          name: "默认方案",
          rhythm: { ...QQ_RHYTHM_DEFAULT, reply_cooldown_seconds: 0 },
          expectedRevision: created.revision,
        }),
      ).toThrow(TypeError);
      // A no-op save of the whole group must not look like a change.
      const saved = updateQqScheme(h.orm, created.id, {
        name: "默认方案",
        rhythm: { ...QQ_RHYTHM_DEFAULT },
        expectedRevision: created.revision,
      });
      expect(saved.revision).toBe(created.revision);
    } finally {
      h.business.close();
    }
  });

  it("trims names, refuses blanks, and refuses an empty description alike", () => {
    const h = setup();
    try {
      expect(createQqScheme(h.orm, { name: "  方案A  " }).name).toBe("方案A");
      expect(() => createQqScheme(h.orm, { name: "   " })).toThrow();
      expect(() => createQqScheme(h.orm, { name: "" })).toThrow();
      // The table CHECK refuses a blank name written directly too.
      expect(() =>
        h.orm
          .insert(schema.qqSchemes)
          .values({ id: "x", name: " ", revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
          .run(),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("keeps names unique, since the name is how a human identifies the resource", () => {
    const h = setup();
    try {
      createQqScheme(h.orm, { name: "同名" });
      expect(() => createQqScheme(h.orm, { name: "同名" })).toThrow();
      expect(() => createQqScheme(h.orm, { name: " 同名 " })).toThrow();
      // The unique index refuses it even when the repository check is bypassed.
      expect(() =>
        h.orm
          .insert(schema.qqSchemes)
          .values({ id: "y", name: "同名", revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
          .run(),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("renames and re-describes with compare-and-swap, and a no-op keeps the revision", () => {
    const h = setup();
    try {
      const created = createQqScheme(h.orm, { name: "旧名", description: "旧说明" });
      expect(() =>
        updateQqScheme(h.orm, created.id, { name: "新名", expectedRevision: created.revision - 1 }),
      ).toThrow();
      const renamed = updateQqScheme(h.orm, created.id, {
        name: "新名",
        description: "新说明",
        expectedRevision: created.revision,
      });
      expect(renamed.name).toBe("新名");
      expect(renamed.description).toBe("新说明");
      expect(renamed.revision).toBe(created.revision + 1);
      // Saving the same values again is not a change.
      const again = updateQqScheme(h.orm, renamed.id, {
        name: "新名",
        description: "新说明",
        expectedRevision: renamed.revision,
      });
      expect(again.revision).toBe(renamed.revision);
      // Omitting the description leaves it alone.
      const kept = updateQqScheme(h.orm, renamed.id, {
        name: "再改名",
        expectedRevision: renamed.revision,
      });
      expect(kept.description).toBe("新说明");
      expect(() =>
        updateQqScheme(h.orm, "00000000-0000-4000-8000-000000000000", {
          name: "x",
          expectedRevision: 1,
        }),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("refuses to rename a scheme onto another scheme's name", () => {
    const h = setup();
    try {
      const first = createQqScheme(h.orm, { name: "甲" });
      const second = createQqScheme(h.orm, { name: "乙" });
      expect(() =>
        updateQqScheme(h.orm, second.id, { name: "甲", expectedRevision: second.revision }),
      ).toThrow();
      // Renaming it to its own name is fine.
      expect(
        updateQqScheme(h.orm, second.id, { name: "乙", expectedRevision: second.revision }).name,
      ).toBe("乙");
      expect(readQqScheme(h.orm, first.id)?.name).toBe("甲");
    } finally {
      h.business.close();
    }
  });
});

describe("binding integrity", () => {
  it("refuses a binding that names a scheme which does not exist", () => {
    const h = setup();
    try {
      // Through the repository-facing path and through raw SQL, since the rule lives in
      // the table trigger.
      expect(() => insertBinding(h.orm, "missing-scheme")).toThrow();
      expect(h.orm.select().from(schema.qqBindings).all()).toEqual([]);
      // A real scheme makes it work.
      const scheme = createQqScheme(h.orm, { name: "可用方案" });
      insertBinding(h.orm, scheme.id);
      expect(h.orm.select().from(schema.qqBindings).all()).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });

  it("refuses to re-point a binding at a scheme that does not exist", () => {
    const h = setup();
    try {
      const scheme = createQqScheme(h.orm, { name: "方案" });
      insertBinding(h.orm, scheme.id);
      expect(() =>
        h.orm
          .update(schema.qqBindings)
          .set({ schemeId: "missing-scheme" })
          .where(eq(schema.qqBindings.id, BINDING_ID))
          .run(),
      ).toThrow();
      // The existing binding is untouched.
      expect(h.orm.select().from(schema.qqBindings).get()?.schemeId).toBe(scheme.id);
    } finally {
      h.business.close();
    }
  });

  it("refuses to delete a scheme that a binding still uses", () => {
    const h = setup();
    try {
      const scheme = createQqScheme(h.orm, { name: "在用的方案" });
      insertBinding(h.orm, scheme.id);
      expect(qqSchemeUsage(h.orm, scheme.id)).toBe(1);
      // The repository says what to do first...
      expect(() => deleteQqScheme(h.orm, scheme.id)).toThrow();
      // ...and the trigger refuses it even when the repository is bypassed.
      expect(() =>
        h.orm.delete(schema.qqSchemes).where(eq(schema.qqSchemes.id, scheme.id)).run(),
      ).toThrow();
      expect(readQqScheme(h.orm, scheme.id)).not.toBeNull();
      // Once nothing refers to it, it can go.
      h.orm.delete(schema.qqBindings).where(eq(schema.qqBindings.id, BINDING_ID)).run();
      expect(qqSchemeUsage(h.orm, scheme.id)).toBe(0);
      deleteQqScheme(h.orm, scheme.id);
      expect(readQqScheme(h.orm, scheme.id)).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("reports a missing scheme as not found rather than silently succeeding", () => {
    const h = setup();
    try {
      expect(() => deleteQqScheme(h.orm, "00000000-0000-4000-8000-000000000000")).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("works with a binding created through the contract, which is the real path", () => {
    const h = setup();
    try {
      const scheme = createQqScheme(h.orm, { name: "契约方案" });
      const created = createQqBinding({
        id: BINDING_ID,
        accountId: "10001",
        kind: "group",
        peerId: "20001",
        agentId: AGENT_ID,
        schemeId: scheme.id,
        paused: false,
        shareWebMemory: false,
      });
      if (created.kind !== "saved") throw new Error("expected a saved binding");
      insertBinding(h.orm, created.binding.schemeId);
      expect(qqSchemeUsage(h.orm, scheme.id)).toBe(1);
    } finally {
      h.business.close();
    }
  });
});
