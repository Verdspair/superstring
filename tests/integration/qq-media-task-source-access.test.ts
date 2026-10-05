import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
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
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const AGENT = "00000000-0000-0000-0000-000000000001";
const OTHER_AGENT = "00000000-0000-0000-0000-000000000002";
const ACCOUNT = "90001";
const GROUP = 30003;
const PEER = String(GROUP);
const OTHER_PEER = "30009";
const BINDING_ID = "bd-task-source";
const AT = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const EXPIRES_AT = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

interface Fixture {
  h: ReturnType<typeof openBusinessDb>;
  db: ReturnType<typeof openBusinessDb>["db"];
  conversationId: string;
  scope: QqConversationScope;
  /** 真实生产链：recordObservation + journal ingest + link + atomic claim/result 成功任务。 */
  successTask(input?: {
    eventKey?: string;
    messageId?: number;
    asset?: boolean;
    note?: string;
    model?: string;
    question?: string | null;
    /** 指向另一真实绑定/会话（跨群用例）：默认本 fixture 的绑定。 */
    bindingId?: string;
    agentId?: string;
  }): Promise<{ taskId: string; mediaNoteId: string; eventKey: string } | null>;
  /** 注册一条额外真实绑定 + 活会话（跨群/跨 agent 用例）。 */
  createBinding(id: string, agentId: string, peerId: string): void;
}

function setup(): Fixture {
  let linkedLinkId: string | null = null;
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme-task','scheme-task',?,?)",
    )
    .run(nowIso(), nowIso());
  const mkBinding = (id: string, agentId: string, peerId: string) => {
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,'scheme-task',0,0,1,1,?,?)",
      )
      .run(id, ACCOUNT, "group", peerId, agentId, nowIso(), nowIso());
    return new ConversationEventRepository(h.db).ensureOneBot(id);
  };
  const conversation = mkBinding(BINDING_ID, AGENT, PEER);
  if (!conversation) throw new Error("conversation fixture missing");
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId: BINDING_ID,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  // The trusted synthetic checkpoint re-reads the binding state it froze (the
  // same shape as qq-media-read-tasks.test.ts) — only a seam the fixture owns,
  // never a claim about the real host.
  const guardFor =
    (bindingId: string, agentId: string): MediaTaskSourceGuard =>
    (tx) => {
      const binding = tx
        .select({
          agentId: schema.qqBindings.agentId,
          authorityRevision: schema.qqBindings.authorityRevision,
        })
        .from(schema.qqBindings)
        .where(eq(schema.qqBindings.id, bindingId))
        .get();
      if (!binding || binding.agentId !== agentId || binding.authorityRevision !== 1) {
        throw new Error("CONTEXT_SOURCE_INVALID: binding moved");
      }
    };
  const successTask: Fixture["successTask"] = async (input = {}) => {
    const bindingId = input.bindingId ?? BINDING_ID;
    const binding = h.db
      .query("SELECT peer_id,agent_id FROM qq_bindings WHERE id=?")
      .get(bindingId) as { peer_id: string; agent_id: string } | null;
    if (!binding) throw new Error("fixture binding missing");
    const groupId = Number(binding.peer_id);
    const eventKey = input.eventKey ?? `onebot:-task-${crypto.randomUUID()}`;
    if (!eventKey) throw new Error("eventKey required");
    const messageId = input.messageId ?? -9000 - Math.floor(Math.random() * 100000);
    linkedLinkId = null;
    const observation = normalizeOneBotMessage(
      {
        time: AT,
        self_id: Number(ACCOUNT),
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 10001,
        group_id: groupId,
        sender: { card: "阿林", nickname: "阿林" },
        message: [{ type: "image", data: { file: "picture.png", url: "https://example.test/p" } }],
      },
      ACCOUNT,
    );
    if (observation.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, observation.observation, binding.agent_id);
    const ingested = new ConversationEventRepository(h.db).ingestOneBotEvent(
      observation.observation.eventKey,
      bindingId,
    );
    if (!ingested) return null;
    const media = h.db
      .query("SELECT id FROM qq_media_notes WHERE event_key=?")
      .get(observation.observation.eventKey) as { id: string } | null;
    if (!media) return null;
    if (input.asset ?? true) {
      const { asset } = recordMediaAsset(h.orm, {
        scope: {
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: binding.peer_id,
          agentId: binding.agent_id,
        },
        bytes: new Uint8Array([137, 80, 78, 71, 3]),
        mimeType: "image/png",
        expiresAt: EXPIRES_AT,
      });
      const link = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId: media.id,
        scope: {
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: binding.peer_id,
          agentId: binding.agent_id,
        },
        expiresAt: EXPIRES_AT,
      });
      linkedLinkId = link.id;
    }
    // Atomic claim + result with a REQUIRED guard: the real production protocol
    // (no fake statuses written by hand, no real model call).
    const purpose = input.question ? ("detail" as const) : ("baseline" as const);
    const questionKey = input.question ? normalizeQuestionKey(input.question) : undefined;
    const guard = guardFor(bindingId, binding.agent_id);
    const claimed = await attemptMediaReadTask(h.orm, {
      mediaNoteId: media.id,
      purpose,
      questionKey,
      modelName: input.model ?? "vision-synthetic",
      policy: "p1",
      contentSha256: shaOfMedia(media.id),
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
    // The fixture binds the task to the EXACT link it consumed (real FK, the
    // production repo wires this when a read carries bytes — this seam belongs
    // to the fixture, not a production change): with a link present the task
    // row's asset_source_id must name it, otherwise the projection cannot lock.
    if (linkedLinkId !== null) {
      h.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
        .run(linkedLinkId, media.id);
    }
    const task = h.db
      .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
      .get(media.id) as { id: string } | null;
    if (!task) return null;
    return { taskId: task.id, mediaNoteId: media.id, eventKey: observation.observation.eventKey };
  };
  return {
    h,
    db: h.db,
    conversationId: conversation.id,
    scope,
    successTask,
    createBinding: (id, agentId, peerId) => {
      mkBinding(id, agentId, peerId);
    },
  };
}

function ownerFor(
  f: Fixture,
  kind: "conversation" | "qq_binding",
  overrides: Partial<RunOwner> = {},
): RunOwner {
  return {
    kind,
    id: kind === "conversation" ? f.conversationId : BINDING_ID,
    userId: DEFAULT_USER_ID,
    agentId: AGENT,
    ...overrides,
  };
}

const principal = { userId: DEFAULT_USER_ID };

/** Per-media deterministic controlled-bytes sha: distinct media rows are distinct
 * content identities; the same row keeps the same identity across claims. */
const shaOfMedia = (id: string): string =>
  Array.from(id)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

describe("qq_media_read_task source mint + access", () => {
  it("a real succeeded task mints an available ref for both owner shapes through the service and the unified entry", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      expect(created).not.toBeNull();
      if (!created) return;
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(ref.kind).toBe("qq_media_read_task");
      expect(ref.id).toBe(created.taskId);
      // The ref carries no note/model/question text: only kind/id/revision/cap.
      expect(JSON.stringify(ref)).not.toContain("橘猫");
      expect(ref.expiresAt).toBeDefined();
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("available");
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "qq_binding"), principal, nowIso()),
      ).toBe("available");
      expect(sourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso())).toBe(
        "available",
      );
    } finally {
      f.h.close();
    }
  });

  it("owner authorization is four-dimensional: wrong user / no agent / wrong agent / foreign owner kind / unknown task revoked", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      // 无显式 agentId → revoked。
      const noAgent = ownerFor(f, "conversation");
      delete (noAgent as { agentId?: string }).agentId;
      expect(qqMediaReadTaskSourceAccess(f.db, ref, noAgent, principal, nowIso())).toBe("revoked");
      // 错 agentId → revoked。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation", { agentId: "other-agent" }),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // owner 指向别间会话 → revoked。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation", { id: "other-conv" }),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 非 DEFAULT_USER_ID principal → revoked。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation"),
          { userId: "u2" },
          nowIso(),
        ),
      ).toBe("revoked");
      // owner.userId 与 principal 不一致 → revoked。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          ownerFor(f, "conversation", { userId: "u2" }),
          { userId: "u2" },
          nowIso(),
        ),
      ).toBe("revoked");
      // userId 缺失 → revoked。
      const noUser = ownerFor(f, "conversation");
      delete (noUser as { userId?: string }).userId;
      expect(qqMediaReadTaskSourceAccess(f.db, ref, noUser, principal, nowIso())).toBe("revoked");
      // 未认识的 owner kind → revoked。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 陌生（不存在）task id 的伪造 ref：revoked，不泄露存在性。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...ref, id: "missing-task" },
          ownerFor(f, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("cross-group / cross-agent: the media row of another scope never mints and forged refs stay revoked", async () => {
    const f = setup();
    try {
      // 另一群的真实任务（同 agent、不同 peer、独立真实绑定/会话）。
      f.h.db
        .query(
          "INSERT INTO agents(id,name,system_prompt,description,additional_instructions,p5_config,model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_prompt,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          OTHER_AGENT,
          "另一助手",
          "",
          "",
          "",
          "{}",
          "synthetic-model",
          "",
          "",
          "",
          nowIso(),
          nowIso(),
        );
      f.createBinding("bd-task-other-peer", AGENT, OTHER_PEER);
      const foreign = await f.successTask({
        bindingId: "bd-task-other-peer",
        eventKey: `onebot:-task-foreign-${crypto.randomUUID()}`,
      });
      expect(foreign).not.toBeNull();
      if (!foreign) return;
      // 本 scope mint 不存在（任务行存在但 SQL scope 谓词读不到）。
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, foreign.taskId, nowIso())).toBeNull();
      // 伪造 ref：外群任务在本 owner 下恒 revoked。
      const forged: SourceRef = {
        kind: "qq_media_read_task",
        id: foreign.taskId,
        revision: "0".repeat(64),
        expiresAt: EXPIRES_AT,
      };
      expect(
        qqMediaReadTaskSourceAccess(f.db, forged, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("revoked");
      // 另一 agent 的任务（独立真实绑定/会话；同账号同 peer 只有一条绑定，
      // 跨 agent 用例用另一 peer——隔离语义等价：scope 四维须整体匹配）。
      f.createBinding("bd-task-other-agent", OTHER_AGENT, "30010");
      const otherAgentTask = await f.successTask({
        bindingId: "bd-task-other-agent",
        agentId: OTHER_AGENT,
        eventKey: `onebot:-task-otheragent-${crypto.randomUUID()}`,
      });
      expect(otherAgentTask).not.toBeNull();
      if (!otherAgentTask) return;
      // 另一 agent 的真实任务 ref 对本 owner 恒 revoked（scope SQL 全过滤）。
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...forged, id: otherAgentTask.taskId },
          ownerFor(f, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("epoch/authority change, closed conversation and rebind revoke old refs; mint at the new epoch refuses", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("available");
      // 权限纪元前进：scope 现值变化 → revoked。
      f.h.orm
        .update(schema.qqBindings)
        .set({ revision: 2, authorityRevision: 2 })
        .where(eq(schema.qqBindings.id, BINDING_ID))
        .run();
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("revoked");
      // mint 侧同样按当前 scope 拒绝。
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso())).toBeNull();
      // 关会话：owner 定位失败 → revoked；重开新会话（新纪元行）不复活旧 ref。
      f.h.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), f.conversationId);
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("revoked");
      const reopened = new ConversationEventRepository(f.db).ensureOneBot(BINDING_ID);
      expect(reopened).not.toBeNull();
      if (!reopened) return;
      expect(reopened.id).not.toBe(f.conversationId);
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          ref,
          { kind: "conversation", id: reopened.id, userId: DEFAULT_USER_ID, agentId: AGENT },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("every revision dimension change revokes: note / model / policy / attempts / status / task revision / expiry", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      const owner = ownerFor(f, "conversation");
      const check = () => qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso());
      expect(check()).toBe("available");
      // claim (+1) 与 result (+1) 各推进一次 revision，原值从这里读，不做字面假设。
      const originalRevision = (
        f.db.query("SELECT revision FROM qq_media_read_tasks WHERE id=?").get(created.taskId) as {
          revision: number;
        }
      ).revision;
      const move = (sql: string, ...args: SQLQueryBindings[]) => f.h.db.query(sql).run(...args);
      // note 修改 → revoked。
      move("UPDATE qq_media_read_tasks SET note=? WHERE id=?", "被改写的描述", created.taskId);
      expect(check()).toBe("revoked");
      move("UPDATE qq_media_read_tasks SET note=? WHERE id=?", "橘猫在沙发上睡觉", created.taskId);
      // model 修改 → revoked。
      move("UPDATE qq_media_read_tasks SET model_name=? WHERE id=?", "vision-b", created.taskId);
      expect(check()).toBe("revoked");
      move(
        "UPDATE qq_media_read_tasks SET model_name=? WHERE id=?",
        "vision-synthetic",
        created.taskId,
      );
      // policy 修改 → revoked。
      move("UPDATE qq_media_read_tasks SET policy=? WHERE id=?", "p2", created.taskId);
      expect(check()).toBe("revoked");
      move("UPDATE qq_media_read_tasks SET policy=? WHERE id=?", "p1", created.taskId);
      // attempts 修改（不归零语义，这里仅证明 hash 冻结 attempts）→ revoked。
      move("UPDATE qq_media_read_tasks SET attempts=? WHERE id=?", 2, created.taskId);
      expect(check()).toBe("revoked");
      move("UPDATE qq_media_read_tasks SET attempts=? WHERE id=?", 1, created.taskId);
      // status 离开 succeeded（模拟撤销/失败路径）→ revoked，不得翻 available。
      move("UPDATE qq_media_read_tasks SET status=? WHERE id=?", "failed", created.taskId);
      expect(check()).toBe("revoked");
      move("UPDATE qq_media_read_tasks SET status=? WHERE id=?", "succeeded", created.taskId);
      // revision 前进 → revoked。
      move(
        "UPDATE qq_media_read_tasks SET revision=? WHERE id=?",
        originalRevision + 1,
        created.taskId,
      );
      expect(check()).toBe("revoked");
      move(
        "UPDATE qq_media_read_tasks SET revision=? WHERE id=?",
        originalRevision,
        created.taskId,
      );
      expect(check()).toBe("available");
      // task 窗口真实流逝 → expired（对正确 owner 可区分）。
      // （任务行窗口在创建时被真实仓储收紧到媒体行窗口，原值从行里读，不假设字面值。）
      const originalTaskExpiry = (
        f.db.query("SELECT expires_at FROM qq_media_read_tasks WHERE id=?").get(created.taskId) as {
          expires_at: string;
        }
      ).expires_at;
      move(
        "UPDATE qq_media_read_tasks SET expires_at=? WHERE id=?",
        new Date(Date.parse(nowIso()) - 1000).toISOString(),
        created.taskId,
      );
      expect(check()).toBe("expired");
      move(
        "UPDATE qq_media_read_tasks SET expires_at=? WHERE id=?",
        originalTaskExpiry,
        created.taskId,
      );
      expect(check()).toBe("available");
    } finally {
      f.h.close();
    }
  });

  it("the original media state is frozen too: media expiry, carrying event scope, timeline membership and journal unlinking", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      const owner = ownerFor(f, "conversation");
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("available");
      // 原 media 行窗口过期 → expired（消费帽的真实组成）。
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), created.mediaNoteId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("expired");
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(EXPIRES_AT, created.mediaNoteId);
      // 携带 event 被改 scope（归属它者）→ revoked。
      // （FK 生效：外键被引用的行不能指向未建好的 agent 行，先建另一 agent。）
      f.h.db
        .query(
          "INSERT OR IGNORE INTO agents(id,name,system_prompt,description,additional_instructions,p5_config,model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_prompt,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          OTHER_AGENT,
          "另一助手",
          "",
          "",
          "",
          "{}",
          "synthetic-model",
          "",
          "",
          "",
          nowIso(),
          nowIso(),
        );
      f.h.db
        .query("UPDATE qq_events SET agent_id=? WHERE event_key=?")
        .run(OTHER_AGENT, created.eventKey);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
      f.h.db
        .query("UPDATE qq_events SET agent_id=? WHERE event_key=?")
        .run(AGENT, created.eventKey);
      // timeline 除名（inbound sources 里的 qq_media 引用被剥）→ revoked。
      f.h.db
        .query(
          "UPDATE conversation_events SET sources='[]' WHERE kind='inbound' AND EXISTS(SELECT 1 FROM json_each(sources) s WHERE json_extract(s.value,'$.kind')='qq_media' AND json_extract(s.value,'$.id')=?)",
        )
        .run(created.mediaNoteId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
      // 一个从不进 journal 的任务：mint 拒绝，伪造 ref revoked。
      const unjournaled = await f.successTask({
        eventKey: `onebot:-task-unjournaled-${crypto.randomUUID()}`,
      });
      if (!unjournaled) throw new Error("fixture task missing");
      f.h.db
        .query("DELETE FROM conversation_events WHERE kind='inbound' AND source_id=?")
        .run(unjournaled.eventKey);
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, unjournaled.taskId, nowIso())).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("assetSourceId NULL is a legal legacy/description-only task; a non-NULL task is locked to ITS exact link only", async () => {
    const f = setup();
    try {
      // 1) NULL assetSourceId（无 link 描述型 legacy）：合法 mint，且可用；
      //    media 行后来挂上一条真实 link，NULL 身份不漂移（帽仍只含 task/media）。
      const noAsset = await f.successTask({
        asset: false,
        eventKey: `onebot:-task-noasset-${crypto.randomUUID()}`,
      });
      if (!noAsset) throw new Error("fixture task missing");
      const refNoAsset = createQqMediaReadTaskSourceRef(f.h, f.scope, noAsset.taskId, nowIso());
      expect(refNoAsset).not.toBeNull();
      if (!refNoAsset) return;
      const noAssetOwner = ownerFor(f, "conversation");
      expect(qqMediaReadTaskSourceAccess(f.db, refNoAsset, noAssetOwner, principal, nowIso())).toBe(
        "available",
      );
      // 同一 mediaNoteId 落上真实 link（真实 FK 允许）：NULL 任务的帽/身份只含
      // task/media，不随 link 漂移，也不借它续命——access 仍 available。
      const noAssetRecorded = recordMediaAsset(f.h.orm, {
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        bytes: new Uint8Array([137, 80, 78, 71, 9]),
        mimeType: "image/png",
        expiresAt: EXPIRES_AT,
      });
      linkMediaAssetSource(f.h.orm, {
        assetId: noAssetRecorded.asset.id,
        mediaNoteId: noAsset.mediaNoteId,
        scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
        expiresAt: EXPIRES_AT,
      });
      expect(
        f.db
          .query("SELECT id FROM qq_media_asset_sources WHERE media_note_id=?")
          .get(noAsset.mediaNoteId),
      ).not.toBeNull();
      expect(qqMediaReadTaskSourceAccess(f.db, refNoAsset, noAssetOwner, principal, nowIso())).toBe(
        "available",
      );
      // 2) non-NULL：精确锁本任务 asset_source_id 指向的 link。
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      const owner = ownerFor(f, "conversation");
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("available");
      const linkId = (
        f.db
          .query("SELECT id FROM qq_media_asset_sources WHERE media_note_id=?")
          .get(created.mediaNoteId) as { id: string }
      ).id;
      // 该任务锁的 link 窗口过期 → expired（帽的真实组成；不借他 link 续命）。
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), linkId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("expired");
      // 别处现挂一条 live link（另一 media 行）：本 ref 不复活。
      const other = await f.successTask({
        eventKey: `onebot:-task-other-${crypto.randomUUID()}`,
      });
      if (!other) throw new Error("fixture task missing");
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("expired");
      // 3) link 行被删：0052 载体 FK 为 ON DELETE SET NULL——任务账本存活（预算不丢），
      //    asset_source_id 置 NULL 后其消费帽不再存在 → 旧 ref 恒 revoked，且 mint 拒绝
      //    （succeeded 行的 note/model 仍在但 link 消费链不完整，fail closed）。
      f.h.db.query("DELETE FROM qq_media_asset_sources WHERE id=?").run(linkId);
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
      const taskKept = f.db
        .query("SELECT asset_source_id, attempts, status FROM qq_media_read_tasks WHERE id=?")
        .get(created.taskId) as
        | { asset_source_id: string | null; attempts: number; status: string }
        | undefined;
      expect(taskKept).toMatchObject({ asset_source_id: null, attempts: 1, status: "succeeded" });
      // asset_source_id NULL 后任务退化为纯描述型（帽 = task+media）：旧 ref（含 link 帽）
      // 恒 revoked，但任务本身仍可重新 mint（帽只含 task/media）。
      const reminted = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      expect(reminted).not.toBeNull();
      expect(reminted?.id).toBe(created.taskId);
      expect(
        qqMediaReadTaskSourceAccess(f.db, reminted as SourceRef, owner, principal, nowIso()),
      ).toBe("available");
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("a non-NULL task never borrows a foreign-scope link: a link to another scope's asset fails the projection", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const owner = ownerFor(f, "conversation");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      expect(ref).not.toBeNull();
      if (!ref) return;
      // 另一群的真实绑定 + 真实任务（携带自己的真实 link/asset）。
      f.createBinding("bd-task-other-peer", AGENT, OTHER_PEER);
      const foreign = await f.successTask({
        bindingId: "bd-task-other-peer",
        eventKey: `onebot:-task-foreign-asset-${crypto.randomUUID()}`,
      });
      if (!foreign) throw new Error("foreign fixture missing");
      const foreignLink = (
        f.db
          .query("SELECT id,asset_id FROM qq_media_asset_sources WHERE media_note_id=?")
          .get(foreign.mediaNoteId) as { id: string; asset_id: string }
      ).id;
      // 把本任务的 link 指到另一 scope 的真实 link/asset（真实 FK 允许写入，
      // projection 的 asset scope 谓词拒绝）：mint 拒绝、旧 ref revoked，
      // 不跨 scope 借资产授权。
      f.h.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE id=?")
        .run(foreignLink, created.taskId);
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso())).toBeNull();
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("a non-NULL task is locked to the same media row: a legal link of ANOTHER media never passes as the task's own", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const owner = ownerFor(f, "conversation");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("available");
      // 同 scope 下另一条真实 media 行的合法 link（真实 FK 允许）：把本任务的
      // asset_source_id 指过去——authorization 边界必须拒绝，不因 link 合法
      // 存活且同 scope 就被借走。
      const other = await f.successTask({
        eventKey: `onebot:-task-samemediawrong-${crypto.randomUUID()}`,
      });
      if (!other) throw new Error("fixture task missing");
      const otherLink = (
        f.db
          .query("SELECT id FROM qq_media_asset_sources WHERE media_note_id=?")
          .get(other.mediaNoteId) as { id: string }
      ).id;
      expect(otherLink).not.toBe(
        (
          f.db
            .query("SELECT id FROM qq_media_asset_sources WHERE media_note_id=?")
            .get(created.mediaNoteId) as { id: string }
        ).id,
      );
      f.h.db
        .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE id=?")
        .run(otherLink, created.taskId);
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso())).toBeNull();
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, nowIso())).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("caps are the earliest of task / media / consumed link / asset; mint refuses dead windows and never delays", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      // link/asset 期限显著更早 → mint 帽取最早值（numericDate 比较取行值原文）。
      const early = new Date(Date.parse(nowIso()) + 60 * 1000).toISOString();
      f.h.db.query("UPDATE qq_media_asset_sources SET expires_at=?").run(early);
      f.h.db.query("UPDATE qq_media_assets SET expires_at=?").run(early);
      f.h.db
        .query("UPDATE qq_media_read_tasks SET expires_at=?")
        .run(new Date(Date.parse(nowIso()) + 60 * 60 * 1000).toISOString());
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(Date.parse(ref.expiresAt ?? "")).toBeLessThanOrEqual(Date.parse(early));
      // 消费窗口真实流逝到过去：mint 拒绝（死窗不铸 ref，帽不为过去值）。
      f.h.db
        .query("UPDATE qq_media_asset_sources SET expires_at=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString());
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso())).toBeNull();
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("expired");
      // 一个把 ref 帽伪造到未来的合成 ref：真实行帽先尽 → expired，不 available。
      const forged = await f.successTask({ eventKey: `onebot:-task-cap-${crypto.randomUUID()}` });
      if (!forged) throw new Error("fixture task missing");
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(new Date(Date.parse(nowIso()) - 1000).toISOString(), forged.mediaNoteId);
      const forgedRef: SourceRef = {
        kind: "qq_media_read_task",
        id: forged.taskId,
        revision: "0".repeat(64),
        expiresAt: new Date(Date.parse(nowIso()) + 60 * 60 * 1000).toISOString(),
      };
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          forgedRef,
          ownerFor(f, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("expired");
      // 伪造帽 + 未知 task：跨所有帽以后也只 expired/revoked，不 available。
      const futureNow = new Date(Date.parse(nowIso()) + 120 * 60 * 1000).toISOString();
      expect(
        qqMediaReadTaskSourceAccess(
          f.db,
          { ...forgedRef, id: "no-such-task" },
          ownerFor(f, "conversation"),
          principal,
          futureNow,
        ),
      ).toBe("revoked");
    } finally {
      f.h.close();
    }
  });

  it("invalid `now` fails closed; mint with an invalid now returns null; unified entries redact, never leak", async () => {
    const f = setup();
    try {
      const created = await f.successTask();
      if (!created) throw new Error("fixture task missing");
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!ref) throw new Error("mint failed");
      const owner = ownerFor(f, "conversation");
      // 非法 now（不可解析）→ access fail closed（revoked），mint 返回 null。
      expect(qqMediaReadTaskSourceAccess(f.db, ref, owner, principal, "not-a-date")).toBe(
        "revoked",
      );
      expect(createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, "not-a-date")).toBeNull();
      // NaN 时间也不 mint。
      expect(
        createQqMediaReadTaskSourceRef(
          f.h,
          f.scope,
          created.taskId,
          Number.NaN as unknown as string,
        ),
      ).toBeNull();
      // assertContextSources：任务 ref 被改坏后，外部 resolver 返回 available 也不可翻。
      f.h.db
        .query("UPDATE qq_media_read_tasks SET revision=revision+1 WHERE id=?")
        .run(created.taskId);
      expect(() =>
        assertContextSources({
          db: f.db,
          sources: [ref],
          owner,
          now: nowIso(),
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory changed", other: "source invalid" },
        }),
      ).toThrow("source invalid");
      // inspectContext：真实持久 run 里新 ref 可 exact；结果被改后 redact 为 revoked，
      // 上下文（含描述正文）不再可读，无私文泄漏。
      const repository = new AgentRunRepository(f.db);
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const handle = { runId, stepId };
      repository.createRun({ runId, specId: "test", specVersion: "1", owner, at: nowIso() });
      const fresh = createQqMediaReadTaskSourceRef(f.h, f.scope, created.taskId, nowIso());
      if (!fresh) throw new Error("fresh mint failed");
      repository.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: nowIso(),
        messages: [{ role: "user", content: [{ kind: "text", text: "图里有什么" }] }],
        sources: [fresh],
      });
      expect(inspectContext(f.db, repository, handle, principal)?.status).toBe("exact");
      f.h.db
        .query("UPDATE qq_media_read_tasks SET note=? WHERE id=?")
        .run("被改写的描述", created.taskId);
      const inspected = inspectContext(f.db, repository, handle, principal);
      expect(inspected?.status).toBe("revoked");
      expect(JSON.stringify(inspected ?? {})).not.toContain("橘猫");
      expect(repository.getContext(handle)?.messages).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("unsupported media kinds keep description tasks readable: a record note's task is not forced into image semantics", async () => {
    const f = setup();
    try {
      // record（语音）任务：kind 链路只按真实 segmentKind 记录，不把任务改判 image。
      const observation = normalizeOneBotMessage(
        {
          time: AT,
          self_id: Number(ACCOUNT),
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -424242,
          user_id: 10001,
          group_id: GROUP,
          sender: { card: "阿林", nickname: "阿林" },
          message: [{ type: "record", data: { file: "voice.mp3" } }],
        },
        ACCOUNT,
      );
      if (observation.kind !== "message") throw new Error("message expected");
      recordObservation(f.h.orm, observation.observation, AGENT);
      const journal = new ConversationEventRepository(f.db);
      const ingested = journal.ingestOneBotEvent(observation.observation.eventKey, BINDING_ID);
      expect(ingested).not.toBeNull();
      const media = f.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=?")
        .get(observation.observation.eventKey) as { id: string } | null;
      if (!media) throw new Error("record media missing");
      f.h.db
        .query("UPDATE qq_media_notes SET segment_kind='record', source_ref='voice.mp3' WHERE id=?")
        .run(media.id);
      // record 任务同样有真实身份（同 claim/result 协议；fixture 直接按真实协议建）。
      const guard: MediaTaskSourceGuard = (tx) => {
        const binding = tx
          .select({ agentId: schema.qqBindings.agentId })
          .from(schema.qqBindings)
          .where(eq(schema.qqBindings.id, BINDING_ID))
          .get();
        if (!binding || binding.agentId !== AGENT) throw new Error("binding moved");
      };
      const claimed = await attemptMediaReadTask(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        modelName: "asr-synthetic",
        policy: "p1",
        contentSha256: shaOfMedia(media.id),
        assertCurrent: guard,
      });
      recordMediaReadTaskResult(f.h.orm, {
        mediaNoteId: media.id,
        purpose: "baseline",
        note: "语音内容转录",
        modelName: "asr-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: guard,
      });
      const task = f.db
        .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
        .get(media.id) as { id: string };
      const ref = createQqMediaReadTaskSourceRef(f.h, f.scope, task.id, nowIso());
      expect(ref).not.toBeNull();
      if (!ref) return;
      expect(
        qqMediaReadTaskSourceAccess(f.db, ref, ownerFor(f, "conversation"), principal, nowIso()),
      ).toBe("available");
      // 任务 ref 不含媒体 kind 语义改写：record 描述仍按 record 读取，不冒 image。
      const kindRow = f.db
        .query("SELECT segment_kind FROM qq_media_notes WHERE id=?")
        .get(media.id) as { segment_kind: string };
      expect(kindRow.segment_kind).toBe("record");
    } finally {
      f.h.close();
    }
  });
});
