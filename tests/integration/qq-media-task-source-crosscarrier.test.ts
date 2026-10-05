import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
  findServableMediaReadTaskByIdentity,
  type MediaTaskSourceGuard,
  normalizeQuestionKey,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_USER_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  createQqMediaReadTaskSourceRef,
  qqMediaReadTaskSourceAccess,
} from "../../src/server/services/qq-media-task-sources";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const AGENT = "00000000-0000-0000-0000-000000000001";
const ACCOUNT = "90002";
const PEER = "31001";
const BINDING_ID = "bd-cross-carrier";
const AT = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const EXPIRES_AT = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

interface Fixture {
  h: ReturnType<typeof openBusinessDb>;
  db: ReturnType<typeof openBusinessDb>["db"];
  conversationId: string;
  scope: QqConversationScope;
  /** A real carrier media row with a real asset/link, and (withTask) a real succeeded task on it. */
  carrier(input?: {
    /** Reuse the EXACT content of an earlier carrier (its returned tag). */
    sameContentAs?: string;
    purpose?: "baseline" | "detail";
    question?: string | null;
    note?: string;
    model?: string;
    /** No task, carrier row only (default: creates a real succeeded task). */
    noTask?: boolean;
  }): Promise<{ taskId: string; mediaNoteId: string; sha: string; tag: string } | null>;
}

let contentSeq = 1;

function setup(): Fixture {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme-xc','scheme-xc',?,?)",
    )
    .run(nowIso(), nowIso());
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,'scheme-xc',0,0,1,1,?,?)",
    )
    .run(BINDING_ID, ACCOUNT, "group", PEER, AGENT, nowIso(), nowIso());
  const journal = new ConversationEventRepository(h.db);
  const opened = journal.ensureOneBot(BINDING_ID);
  if (!opened) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: opened.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: BINDING_ID,
    bindingEpoch: opened.bindingEpoch,
    authorityRevision: 1,
  };
  const guard: MediaTaskSourceGuard = (tx) => {
    const binding = tx
      .select({
        agentId: schema.qqBindings.agentId,
        authorityRevision: schema.qqBindings.authorityRevision,
      })
      .from(schema.qqBindings)
      .where(eq(schema.qqBindings.id, BINDING_ID))
      .get();
    if (!binding || binding.agentId !== AGENT || binding.authorityRevision !== 1) {
      throw new Error("CONTEXT_SOURCE_INVALID: binding moved");
    }
  };
  const carrier: Fixture["carrier"] = async (input = {}) => {
    const messageId = -20000 - Math.floor(Math.random() * 100000);
    const observation = normalizeOneBotMessage(
      {
        time: AT,
        self_id: Number(ACCOUNT),
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 10001,
        group_id: Number(PEER),
        sender: { card: "阿林", nickname: "阿林" },
        message: [{ type: "image", data: { file: "picture.png", url: "https://example.test/p" } }],
      },
      ACCOUNT,
    );
    if (observation.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, observation.observation, AGENT);
    if (!journal.ingestOneBotEvent(observation.observation.eventKey, BINDING_ID)) return null;
    const media = h.db
      .query("SELECT id FROM qq_media_notes WHERE event_key=?")
      .get(observation.observation.eventKey) as { id: string } | null;
    if (!media) return null;
    // The controlled bytes DERIVE the content sha (real repo behavior): two
    // carriers with the same bytes share one content identity, different bytes
    // never do.
    if (input.sameContentAs === undefined) contentSeq += 1;
    const tag = input.sameContentAs ?? `c${contentSeq}`;
    const bytes = new Uint8Array([137, 80, 78, 71, ...new TextEncoder().encode(tag)]);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const { asset } = recordMediaAsset(h.orm, {
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      bytes,
      mimeType: "image/png",
      expiresAt: EXPIRES_AT,
    });
    linkMediaAssetSource(h.orm, {
      assetId: asset.id,
      mediaNoteId: media.id,
      scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
      expiresAt: EXPIRES_AT,
    });
    if (input.noTask === true) {
      return { taskId: "", mediaNoteId: media.id, sha: contentSha256, tag };
    }
    const purpose = input.purpose ?? (input.question ? "detail" : "baseline");
    const questionKey = input.question ? normalizeQuestionKey(input.question) : undefined;
    const claimed = await attemptMediaReadTask(h.orm, {
      mediaNoteId: media.id,
      purpose,
      questionKey,
      modelName: input.model ?? "vision-synthetic",
      policy: "p1",
      contentSha256,
      assertCurrent: guard,
    });
    recordMediaReadTaskResult(h.orm, {
      mediaNoteId: media.id,
      purpose,
      questionKey,
      note: input.note ?? "橘猫在沙发上睡觉",
      modelName: input.model ?? "vision-synthetic",
      expectedAttempts: claimed.attempt,
      claimToken: claimed.claimToken,
      assertCurrent: guard,
    });
    const task = h.db
      .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
      .get(media.id) as { id: string } | null;
    if (!task) return null;
    return { taskId: task.id, mediaNoteId: media.id, sha: contentSha256, tag };
  };
  return { h, db: h.db, conversationId: opened.id, scope, carrier };
}

const principal = { userId: DEFAULT_USER_ID };
const ownerOf = (f: Fixture) => ({
  kind: "conversation" as const,
  id: f.conversationId,
  userId: DEFAULT_USER_ID,
  agentId: AGENT,
});

describe("cross-carrier read-only task consumption (identity-proven)", () => {
  it("same bytes on a new carrier mint an available composite ref whose id stays the ledger taskId; attempts untouched", async () => {
    const f = setup();
    try {
      const first = await f.carrier({ note: "一只橘猫" });
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      expect(second.mediaNoteId).not.toBe(first.mediaNoteId);
      const before = (
        f.db.query("SELECT attempts FROM qq_media_read_tasks WHERE id=?").get(first.taskId) as {
          attempts: number;
        }
      ).attempts;
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(ref.id).toBe(first.taskId);
      expect(ref.revision.startsWith(`c1:${second.mediaNoteId}:`)).toBe(true);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, ownerOf(f), principal, nowIso())).toBe(
        "available",
      );
      expect(sourceAccess(f.db, ref, ownerOf(f), principal, nowIso())).toBe("available");
      const after = (
        f.db.query("SELECT attempts FROM qq_media_read_tasks WHERE id=?").get(first.taskId) as {
          attempts: number;
        }
      ).attempts;
      expect(after).toBe(before);
      // Zero writes: no new task row appeared for the second carrier.
      const rows = f.db.query("SELECT COUNT(*) AS n FROM qq_media_read_tasks").get() as {
        n: number;
      };
      expect(rows.n).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("same scope but DIFFERENT image content: the composite ref is refused — scope equality never proves content", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      // A second carrier with genuinely DIFFERENT bytes (different sha, no task).
      const other = await f.carrier();
      if (!other) throw new Error("fixture missing");
      expect(other.sha).not.toBe(first.sha);
      expect(
        createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
          carrierMediaNoteId: other.mediaNoteId,
        }),
      ).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("forged or malformed c1 revisions fail closed; the carrier id is parsed, never trusted", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      if (!ref) throw new Error("mint failed");
      const owner = ownerOf(f);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("available");
      // Tampered hash.
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:${second.mediaNoteId}:${"0".repeat(64)}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // Malformed: wrong tag / wrong field count / bad uuid / bad hash shape.
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c2:${second.mediaNoteId}:${"a".repeat(64)}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:${second.mediaNoteId}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:not-a-uuid:${"a".repeat(64)}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:${second.mediaNoteId}:zz` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // A REAL composite payload pointed at a carrier that never existed.
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:${crypto.randomUUID()}:${"a".repeat(64)}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // Pointing the payload at the WRONG real carrier of the same scope (different content) → revoked.
      const other = await f.carrier();
      if (!other) throw new Error("fixture missing");
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, revision: `c1:${other.mediaNoteId}:${"a".repeat(64)}` },
          owner,
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("every ledger result dimension change revokes the composite ref: note / model / policy / attempts / status / revision / expiry", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      if (!ref) throw new Error("mint failed");
      const owner = ownerOf(f);
      const check = () => qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso());
      expect(check()).toBe("available");
      f.db.query("UPDATE qq_media_read_tasks SET note='被改写' WHERE id=?").run(first.taskId);
      expect(check()).toBe("revoked");
      f.db
        .query("UPDATE qq_media_read_tasks SET note=? WHERE id=?")
        .run("橘猫在沙发上睡觉", first.taskId);
      f.db
        .query("UPDATE qq_media_read_tasks SET model_name='vision-b' WHERE id=?")
        .run(first.taskId);
      expect(check()).toBe("revoked");
      f.db
        .query("UPDATE qq_media_read_tasks SET model_name='vision-synthetic' WHERE id=?")
        .run(first.taskId);
      f.db.query("UPDATE qq_media_read_tasks SET policy='p2' WHERE id=?").run(first.taskId);
      expect(check()).toBe("revoked");
      f.db.query("UPDATE qq_media_read_tasks SET policy='p1' WHERE id=?").run(first.taskId);
      f.db.query("UPDATE qq_media_read_tasks SET attempts=2 WHERE id=?").run(first.taskId);
      expect(check()).toBe("revoked");
      f.db.query("UPDATE qq_media_read_tasks SET attempts=1 WHERE id=?").run(first.taskId);
      f.db.query("UPDATE qq_media_read_tasks SET status='failed' WHERE id=?").run(first.taskId);
      expect(check()).toBe("revoked");
      f.db.query("UPDATE qq_media_read_tasks SET status='succeeded' WHERE id=?").run(first.taskId);
      f.db.query("UPDATE qq_media_read_tasks SET revision=revision+1 WHERE id=?").run(first.taskId);
      expect(check()).toBe("revoked");
      f.db.query("UPDATE qq_media_read_tasks SET revision=revision-1 WHERE id=?").run(first.taskId);
      f.db
        .query("UPDATE qq_media_read_tasks SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), first.taskId);
      expect(check()).toBe("expired");
    } finally {
      f.h.close();
    }
  });

  it("the CURRENT carrier's chain is frozen: its link/asset death or expiry kills the ref even though the ledger row is fine", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      if (!ref) throw new Error("mint failed");
      const owner = ownerOf(f);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("available");
      // Carrier link expiry → expired (cap is the true min).
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), second.mediaNoteId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("expired");
      // Restore, then delete the carrier link: SET NULL on the ledger row keeps the budget, but the CURRENT carrier chain is dead → revoked.
      f.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE media_note_id=?")
        .run(EXPIRES_AT, second.mediaNoteId);
      f.db
        .query("DELETE FROM qq_media_asset_sources WHERE media_note_id=?")
        .run(second.mediaNoteId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
      // Mint refuses a carrier without a live chain.
      expect(
        createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
          carrierMediaNoteId: second.mediaNoteId,
        }),
      ).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("identity_key NULL (legacy history) never mints the composite form; the no-options factory regression stays real", async () => {
    const f = setup();
    try {
      const plain = await f.carrier({ noTask: true });
      if (!plain) throw new Error("fixture missing");
      // A hand-shaped legacy row is NOT a production path: make a real NULL-identity row by inserting one
      // directly through the same DDL constraints the migration uses (no network backfill existed then).
      f.db
        .query(
          "INSERT INTO qq_media_read_tasks(id,media_note_id,asset_source_id,account_id,conversation_kind,peer_id,agent_id,identity_key,purpose,question_key,model_name,policy,attempts,status,note,revision,expires_at,recorded_at) VALUES(?,?,NULL,?,?,?,?,NULL,'baseline',NULL,?,'legacy',1,'succeeded',?,1,?,?)",
        )
        .run(
          `legacy-${plain.mediaNoteId}`,
          plain.mediaNoteId,
          ACCOUNT,
          "group",
          PEER,
          AGENT,
          "vision-synthetic",
          "旧迁移描述",
          new Date(Date.parse(nowIso()) + 86400000).toISOString(),
          nowIso(),
        );
      const legacyId = `legacy-${plain.mediaNoteId}`;
      // The no-options factory keeps its original behavior for this real legacy row (policy='legacy').
      const single = createQqMediaReadTaskSourceRef(f.h, f.scope, legacyId, nowIso());
      expect(single).not.toBeNull();
      // The composite form refuses NULL identity: no same-content proof exists.
      expect(
        createQqMediaReadTaskSourceRef(f.h, f.scope, legacyId, nowIso(), {
          carrierMediaNoteId: plain.mediaNoteId,
        }),
      ).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("detail reuse stays bound to its question: a different questionKey is a different identity and never reuses", async () => {
    const f = setup();
    try {
      const first = await f.carrier({
        purpose: "detail",
        question: "这只猫在做什么",
        note: "它在睡觉",
      });
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      // Same question → composite ref available.
      const sameQuestion = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      expect(sameQuestion).not.toBeNull();
      // A DIFFERENT question's task on the same bytes is a DIFFERENT identity:
      // it is its own ledger row and never merges with the first question's.
      const otherTask = await f.carrier({
        sameContentAs: first.tag,
        purpose: "detail",
        question: "图里是什么动物",
      });
      if (!otherTask) throw new Error("fixture missing");
      expect(otherTask.taskId).not.toBe(first.taskId);
      // The ref factory proves CONTENT identity (same bytes, same scope, the
      // ledger row's own purpose/question); WHICH question the consuming call
      // serves is re-verified at consumption time by the host's question-anchor
      // guard (assertQuestionCurrent) — the ref itself stays identity-scoped.
      const otherCarrierRef = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: otherTask.mediaNoteId,
      });
      expect(otherCarrierRef).not.toBeNull();
      // And the servable lookup separates the two questions: the second
      // question's content returns ITS OWN row, never the first question's.
      const otherServed = findServableMediaReadTaskByIdentity(f.h.orm, {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        segmentKind: "image",
        purpose: "detail",
        questionKey: normalizeQuestionKey("图里是什么动物"),
        contentSha256: first.sha,
        modelName: "vision-synthetic",
        policy: "p1",
        now: nowIso(),
      });
      expect(otherServed?.id).toBe(otherTask.taskId);
      expect(otherServed?.id).not.toBe(first.taskId);
    } finally {
      f.h.close();
    }
  });

  it("the controlled servable-cache lookup decides taskId/model/policy/window in one place and never writes", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      const base = {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        segmentKind: "image",
        purpose: "baseline" as const,
        questionKey: null,
      };
      // Wrong model / wrong policy → null (the ledger row IS the taskId returned).
      expect(
        findServableMediaReadTaskByIdentity(f.h.orm, {
          ...base,
          contentSha256: first.sha,
          modelName: "vision-b",
          policy: "p1",
          now: nowIso(),
        }),
      ).toBeNull();
      expect(
        findServableMediaReadTaskByIdentity(f.h.orm, {
          ...base,
          contentSha256: first.sha,
          modelName: "vision-synthetic",
          policy: "p2",
          now: nowIso(),
        }),
      ).toBeNull();
      // Right everything → the exact ledger row.
      const served = findServableMediaReadTaskByIdentity(f.h.orm, {
        ...base,
        contentSha256: first.sha,
        modelName: "vision-synthetic",
        policy: "p1",
        now: nowIso(),
      });
      expect(served?.id).toBe(first.taskId);
      // Cross group/agent: a different agentId's lookup never sees this budget.
      expect(
        findServableMediaReadTaskByIdentity(f.h.orm, {
          ...base,
          agentId: "00000000-0000-0000-0000-000000000009",
          contentSha256: first.sha,
          modelName: "vision-synthetic",
          policy: "p1",
          now: nowIso(),
        }),
      ).toBeNull();
      // Expired window is not servable.
      f.db
        .query("UPDATE qq_media_read_tasks SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), first.taskId);
      expect(
        findServableMediaReadTaskByIdentity(f.h.orm, {
          ...base,
          contentSha256: first.sha,
          modelName: "vision-synthetic",
          policy: "p1",
          now: nowIso(),
        }),
      ).toBeNull();
      // And the lookup wrote nothing.
      const rows = f.db.query("SELECT COUNT(*) AS n FROM qq_media_read_tasks").get() as {
        n: number;
      };
      expect(rows.n).toBe(1);
    } finally {
      f.h.close();
    }
  });

  it("the composite cap is the true min of ledger window and the CURRENT carrier's media/link/asset windows", async () => {
    const f = setup();
    try {
      const first = await f.carrier();
      if (!first) throw new Error("fixture missing");
      const second = await f.carrier({ sameContentAs: first.tag, noTask: true });
      if (!second) throw new Error("fixture missing");
      // Tighten the FIRST carrier's media window far beyond: it must NOT matter.
      f.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) + 60_000).toISOString(), first.mediaNoteId);
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, first.taskId, nowIso(), {
        carrierMediaNoteId: second.mediaNoteId,
      });
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(Date.parse(ref.expiresAt ?? "")).toBeGreaterThan(Date.parse(nowIso()));
      // The first carrier's media row dying does not revoke the ref (its window is not consumed).
      expect(qqMediaReadTaskSourceAccess(f.db, ref, ownerOf(f), principal, nowIso())).toBe(
        "available",
      );
    } finally {
      f.h.close();
    }
  });
});
