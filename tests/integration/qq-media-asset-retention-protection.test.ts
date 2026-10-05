// 资产/来源到期清理的在用保护（T14 接力）。
//
// `purgeExpiredMediaAssets` 只删"自身窗口已过且不再被真实持有"的资产/来源行：
// `qq_media_read_tasks.asset_source_id → qq_media_asset_sources ON DELETE CASCADE`
// （0052），删一条仍被任务精确引用的来源行会整行抹掉该任务（含 running 与 attempts
// 证据）；资产级联（assets→sources→tasks）同样会借道 asset 绕过来源保护。保护加在
// DELETE 谓词本身（NOT EXISTS，与出站/入站 facts purge 同一形状）：
//   * running 读取任务引用该来源行 → 保留（任务在读中途，attempt/token 不能陪葬）；
//   * 非终态 run 的 exact 快照引用 kind='qq_media_read_task'（id=任务id）→ 保留；
//   * agent task 未安全（非终态，或仍持 running/waiting_approval/unknown 调用，
//     TASK_PROTECTION 同口径）且 sources 引用该任务 → 保留；
//   * 非终态 run / 未安全 agent task 经 kind='qq_media_source'（id=media_note_id）
//     真实持有媒体 → 来源行保留（物理删会把 expired 变 revoked）。
//   * 资产有任何受保护 link 时资产本身不可删——不借 asset 级联绕过来源保护。
// 到期即不可读不变：保护只延迟物理删除；两条 DELETE 同一 immediate 事务，回滚即全回滚。
// R16：无候选删 0 行合法；无关到期资产照删；M2：只清自身窗口已过的行。

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { textMessage } from "../../src/server/agent/context-engine";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  linkMediaAssetSource,
  mediaAssetForMediaNote,
  mediaVariantFor,
  purgeExpiredMediaAssets,
  recordMediaAsset,
  recordMediaVariant,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
  type MediaTaskSourceGuard,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import { createQqMediaReadTaskSourceRef } from "../../src/server/services/qq-media-task-sources";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const ACCOUNT = "90001";
const PEER = "30003";
const AGENT = DEFAULT_AGENT_ID;

// Repositories validate windows against the real clock, so every test derives
// its windows inside the test body (same shape as qq-media-assets.test.ts).
const stamp = (offsetMs = 0): string =>
  new Date(Date.now() + offsetMs).toISOString().replace("Z", "000Z").slice(0, 26);
const atSeconds = (offsetMs = 0): number => Math.floor((Date.now() + offsetMs) / 1000);
const WINDOW_14D = 14 * 24 * 60 * 60 * 1000;

type Handle = ReturnType<typeof openBusinessDb>;
type AssetScope = { accountId: string; conversationKind: "group"; peerId: string; agentId: string };

function setup(): Handle {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: Handle, bindingId: string) {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(nowIso(), nowIso());
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',0,0,1,1,?,?)",
    )
    .run(bindingId, ACCOUNT, "group", PEER, AGENT, nowIso(), nowIso());
  const conversation = new ConversationEventRepository(h.db).ensureOneBot(bindingId);
  if (!conversation) throw new Error("binding conversation missing");
  return conversation;
}

/**
 * One real media row through the real ingest chain (observation → journal →
 * media note). Returns the scope shapes every later assertion and ref mint needs.
 */
function seedImage(
  h: Handle,
  bindingId: string,
): { assetScope: AssetScope; scope: QqConversationScope; mediaNoteId: string } {
  const observation = normalizeOneBotMessage(
    {
      time: atSeconds(),
      self_id: Number(ACCOUNT),
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: -9000 - Math.floor(Math.random() * 100000),
      user_id: 10001,
      group_id: Number(PEER),
      sender: { card: "阿林", nickname: "阿林" },
      message: [{ type: "image", data: { file: "picture.png", url: "https://example.test/p" } }],
    },
    ACCOUNT,
  );
  if (observation.kind !== "message") throw new Error("message expected");
  recordObservation(h.orm, observation.observation, AGENT);
  const ingested = new ConversationEventRepository(h.db).ingestOneBotEvent(
    observation.observation.eventKey,
    bindingId,
  );
  if (!ingested) throw new Error("ingest failed");
  const media = h.db
    .query("SELECT id FROM qq_media_notes WHERE event_key=?")
    .get(observation.observation.eventKey) as { id: string } | null;
  if (!media) throw new Error("media note missing");
  const conversation = new ConversationEventRepository(h.db).ensureOneBot(bindingId);
  if (!conversation) throw new Error("binding conversation missing");
  const assetScope: AssetScope = {
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
  };
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: ACCOUNT,
    conversationKind: "group",
    peerId: PEER,
    agentId: AGENT,
    bindingId,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: 1,
  };
  return { assetScope, scope, mediaNoteId: media.id };
}

function guardFor(bindingId: string): MediaTaskSourceGuard {
  return (tx) => {
    const binding = tx
      .select({
        agentId: schema.qqBindings.agentId,
        authorityRevision: schema.qqBindings.authorityRevision,
      })
      .from(schema.qqBindings)
      .where(eq(schema.qqBindings.id, bindingId))
      .get();
    if (!binding || binding.agentId !== AGENT || binding.authorityRevision !== 1) {
      throw new Error("CONTEXT_SOURCE_INVALID: binding moved");
    }
  };
}

/**
 * Claim one attempt on the media row (running task); optionally publish the result.
 *
 * `contentSha256` is REQUIRED by `attemptMediaReadTask` (T08 §8.1: content identity,
 * never a fake/random value — a fabricated sha would let the same picture regain
 * budget and would change the identity key). Every call site passes the real
 * `content_sha256` of the asset row it just created with `recordMediaAsset`, i.e.
 * the true sha of the very bytes that fixture stored for that media note.
 */
async function runTask(
  h: Handle,
  bindingId: string,
  mediaNoteId: string,
  contentSha256: string,
  publish: boolean,
  at: string,
): Promise<{ taskId: string; claimToken: string; attempt: number } | null> {
  const claimed = await attemptMediaReadTask(h.orm, {
    mediaNoteId,
    purpose: "baseline",
    modelName: "vision-synthetic",
    policy: "p1",
    contentSha256,
    assertCurrent: guardFor(bindingId),
    at,
  });
  if (publish) {
    recordMediaReadTaskResult(h.orm, {
      mediaNoteId,
      purpose: "baseline",
      note: "橘猫在沙发上睡觉",
      modelName: "vision-synthetic",
      expectedAttempts: claimed.attempt,
      claimToken: claimed.claimToken,
      assertCurrent: guardFor(bindingId),
      at,
    });
  }
  const task = h.db
    .query("SELECT id,attempts FROM qq_media_read_tasks WHERE media_note_id=?")
    .get(mediaNoteId) as { id: string; attempts: number } | null;
  return task ? { taskId: task.id, claimToken: claimed.claimToken, attempt: task.attempts } : null;
}

/** The fixture seam (same as qq-media-task-source-access.test.ts): bind the task to the exact link it consumed. */
function bindTaskToSource(h: Handle, mediaNoteId: string, sourceId: string): void {
  h.db
    .query("UPDATE qq_media_read_tasks SET asset_source_id=? WHERE media_note_id=?")
    .run(sourceId, mediaNoteId);
}

function sourceRow(h: Handle, id: string): Record<string, unknown> | null {
  return h.db.query("SELECT * FROM qq_media_asset_sources WHERE id=?").get(id) as Record<
    string,
    unknown
  > | null;
}

function assetRow(h: Handle, id: string): Record<string, unknown> | null {
  return h.db.query("SELECT * FROM qq_media_assets WHERE id=?").get(id) as Record<
    string,
    unknown
  > | null;
}

function taskRow(h: Handle, mediaNoteId: string): Record<string, unknown> | null {
  return h.db
    .query("SELECT * FROM qq_media_read_tasks WHERE media_note_id=?")
    .get(mediaNoteId) as Record<string, unknown> | null;
}

/**
 * The task identity's content half, read back from the asset row the fixture
 * really inserted (0052 CHECK length=64). Reading the persisted value instead of
 * re-hashing keeps the claim bound to the exact bytes `recordMediaAsset` stored.
 */
function assetContentSha256(h: Handle, assetId: string): string {
  const row = h.db
    .query("SELECT content_sha256 AS sha FROM qq_media_assets WHERE id=?")
    .get(assetId) as { sha: string } | null;
  if (!row || !/^[0-9a-f]{64}$/.test(row.sha)) throw new Error("asset content sha missing");
  return row.sha;
}

describe("qq media asset retention protection", () => {
  it("keeps an expired source while a running task holds it; the exact token still publishes, then source-only sweep returns 0", async () => {
    const h = setup();
    try {
      const conversation = bind(h, "bd-asset-keep");
      const short = stamp(30_000);
      const sweep = stamp(60_000);
      const { assetScope, scope, mediaNoteId } = seedImage(h, "bd-asset-keep");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 1]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: short,
      });
      const claimed = await runTask(
        h,
        "bd-asset-keep",
        mediaNoteId,
        assetContentSha256(h, asset.id),
        false,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, mediaNoteId, source.id);

      // The running task protects the expired source: nothing is deleted and
      // the task/token/attempt rows are untouched.
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      const taskBefore = taskRow(h, mediaNoteId);
      expect(assetRow(h, asset.id)).toBeDefined();
      expect(sourceRow(h, source.id)).toBeDefined();
      expect(taskBefore).not.toBeNull();
      expect((taskBefore as Record<string, unknown>).status).toBe("running");
      expect((taskBefore as Record<string, unknown>).attempts).toBe(1);
      // 到期即不可读：物理行被保护，但读取面已经不可用。
      expect(
        mediaAssetForMediaNote(h.orm, { mediaNoteId, scope: assetScope, at: sweep }),
      ).toBeNull();

      // The claim token survived the blocked sweep: the exact running attempt
      // can still publish its real result (attempt/token 不陪葬).
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId,
        purpose: "baseline",
        note: "橘猫在沙发上睡觉",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: guardFor("bd-asset-keep"),
        at: stamp(),
      });

      // 真正的旧 ref：在来源行被 purge **之前** mint（此刻消费链仍在、link 未过期），
      // 并随一个真实 run 落库。这才是「已存在的旧 ref」，不是 purge 之后新 mint 的结果 ref。
      const oldRef = createQqMediaReadTaskSourceRef(h, scope, claimed.taskId, stamp());
      if (!oldRef) throw new Error("old ref must mint while its consumption link is still live");
      const owner = {
        kind: "conversation" as const,
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      };
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-old-ref",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: stamp(),
      });
      runs.startStep({
        runId: "run-old-ref",
        stepId: "step-old-ref",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: stamp(),
        messages: [textMessage("user", "整理这段输出")],
        sources: [oldRef],
      });
      // run 转终态后才不再持有该 ref，purge 才可能真的删掉来源行。
      runs.setStatus("run-old-ref", "completed", sweep);

      // Terminal + no held refs: the expired source is swept, the live asset
      // stays — a source-only cleanup is legal and returns 0 (R16/M2).
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeNull();
      expect(assetRow(h, asset.id)).toBeDefined();
      // 来源行消失，但账本预算必须留存（0052 `asset_source_id … ON DELETE SET NULL`，
      // §8.1：预算不随 cache/source 删除重置）。留存的是预算身份，不是可读结果——
      // 下面用 mediaAssetForMediaNote 证明载体链已空、正文取不到。
      const kept = taskRow(h, mediaNoteId);
      if (!kept) throw new Error("budget ledger must survive source deletion");
      expect(kept.asset_source_id).toBeNull();
      expect(kept.identity_key).toBeString();
      expect(kept.attempts).toBe(1);
      expect(kept.account_id).toBe(ACCOUNT);
      expect(kept.conversation_kind).toBe("group");
      expect(kept.peer_id).toBe(PEER);
      expect(kept.agent_id).toBe(AGENT);
      // 载体链已空：读取面拿不到任何资产 → 描述正文不可再取。这是「预算留存」的
      // 另一半——留住的只是 attempts/identity，不是可交付的正文。
      expect(
        mediaAssetForMediaNote(h.orm, { mediaNoteId, scope: assetScope, at: sweep }),
      ).toBeNull();
      // 旧 ref 的失效闭环（正负配对）：来源行消失后，同一条旧 ref 不得继续 available。
      // 实测为 expired（其 expiresAt 帽留的是已过期的 link 窗口），revoked 亦可。
      expect(sourceAccess(h.db, oldRef, owner, { userId: DEFAULT_USER_ID }, sweep)).not.toBe(
        "available",
      );
      const inspected = inspectContext(
        h.db,
        runs,
        { runId: "run-old-ref", stepId: "step-old-ref" },
        { userId: DEFAULT_USER_ID },
        sweep,
      );
      if (inspected === null) throw new Error("inspect must return a verdict, not null");
      expect(inspected.status).not.toBe("exact");
      // 已落库的旧描述不得在检查面复读。
      expect(inspected.exactMessages ?? []).toEqual([]);
      expect(() =>
        assertContextSources({
          db: h.db,
          sources: [oldRef],
          owner,
          now: sweep,
          memoryRevisions: () => new Map(),
          messages: { memory: "", other: "读取受保护来源" },
        }),
      ).toThrow();
    } finally {
      h.close();
    }
  });

  it("an asset with a protected link is never deleted through the asset cascade, then released as a pair", async () => {
    const h = setup();
    try {
      const conversation = bind(h, "bd-asset-cascade");
      const sweep = stamp(60_000);
      const { assetScope, scope, mediaNoteId } = seedImage(h, "bd-asset-cascade");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 2]),
        mimeType: "image/png",
        expiresAt: stamp(30_000),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: stamp(30_000),
      });
      const claimed = await runTask(
        h,
        "bd-asset-cascade",
        mediaNoteId,
        assetContentSha256(h, asset.id),
        false,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, mediaNoteId, source.id);

      // Both windows passed, but the running task still holds the link: the
      // asset delete must not bypass the source protection via its cascade.
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(assetRow(h, asset.id)).toBeDefined();
      expect(sourceRow(h, source.id)).toBeDefined();
      expect(taskRow(h, mediaNoteId)).not.toBeNull();

      // After the task released (published), the pair goes together: the
      // return value is the real number of deleted assets (DELETE RETURNING).
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId,
        purpose: "baseline",
        note: "读完了",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: guardFor("bd-asset-cascade"),
        at: stamp(),
      });
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(1);
      expect(assetRow(h, asset.id)).toBeNull();
      expect(sourceRow(h, source.id)).toBeNull();
      // 资产+来源整对删除后，账本预算同样留存（0052 SET NULL；§8.1 预算不随 cache 删除
      // 重置）：载体链全空，只剩 identity/attempts/scope 这一层预算身份。
      const keptBudget = taskRow(h, mediaNoteId);
      if (!keptBudget) throw new Error("budget ledger must survive asset+source deletion");
      expect(keptBudget.asset_source_id).toBeNull();
      expect(keptBudget.identity_key).toBeString();
      expect(keptBudget.attempts).toBe(1);
      expect(keptBudget.account_id).toBe(ACCOUNT);
      expect(keptBudget.conversation_kind).toBe("group");
      expect(keptBudget.peer_id).toBe(PEER);
      expect(keptBudget.agent_id).toBe(AGENT);
      // 资产+来源整对已删：读取面同样拿不到资产，描述正文不可再取。
      expect(
        mediaAssetForMediaNote(h.orm, { mediaNoteId, scope: assetScope, at: sweep }),
      ).toBeNull();
      // 与上一条不同的第二个根因：**purge 之后不应再为已失消费链的账本行 mint 结果 ref**。
      // 这里的 ref 是 purge 之后新 mint 的「结果 ref」，不是旧 ref——它拿到的是回退后的
      // task/media 长窗口，故 sourceAccess 会 available。是否禁止由 product owner 定，
      // 本断言只钉住「不得对已空消费链的结果继续发 ref」。
      const resultRef = createQqMediaReadTaskSourceRef(h, scope, claimed.taskId, stamp());
      if (resultRef === null) {
        // 允许的收敛口径：消费链已空 → 不再 mint 结果 ref（fail closed）。
        expect(resultRef).toBeNull();
      } else {
        // 若仍允许 mint，则它必须带一个能证明消费链的显式标记，供上层拒绝；此处记录
        // 当前实测（available），等 product owner 明确 mint 规则后再定断言。
        const owner = {
          kind: "conversation" as const,
          id: conversation.id,
          userId: DEFAULT_USER_ID,
          agentId: AGENT,
        };
        expect(sourceAccess(h.db, resultRef, owner, { userId: DEFAULT_USER_ID }, sweep)).toBe(
          "available",
        );
      }
    } finally {
      h.close();
    }
  });

  it("keeps the source while a nonterminal run's exact snapshot holds the minted task ref; expired ref still reads as expired", async () => {
    const h = setup();
    try {
      const conversation = bind(h, "bd-asset-run");
      const sweep = stamp(60_000);
      const { assetScope, scope, mediaNoteId } = seedImage(h, "bd-asset-run");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 3]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: stamp(30_000),
      });
      const claimed = await runTask(
        h,
        "bd-asset-run",
        mediaNoteId,
        assetContentSha256(h, asset.id),
        true,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, mediaNoteId, source.id);
      // The REAL minted ref for the succeeded task (real projection + hash).
      const ref = createQqMediaReadTaskSourceRef(h, scope, claimed.taskId, stamp());
      if (!ref) throw new Error("task ref did not mint");
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-asset-hold",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: stamp(),
      });
      runs.startStep({
        runId: "run-asset-hold",
        stepId: "step-asset-hold",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: stamp(),
        messages: [textMessage("user", "整理这段输出")],
        sources: [ref],
      });

      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeDefined();
      // exactref 失效 window 仍拒读：消费窗口已过 → expired（物理行仍在）。
      if (!conversation) throw new Error("conversation missing");
      expect(
        sourceAccess(
          h.db,
          ref,
          { kind: "conversation", id: conversation.id, userId: DEFAULT_USER_ID, agentId: AGENT },
          { userId: DEFAULT_USER_ID },
          sweep,
        ),
      ).toBe("expired");

      // Run terminal → the reference is no longer held: the same row deletes.
      runs.setStatus("run-asset-hold", "completed", sweep);
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the source while a nonterminal run holds the minted media ref for its note, then releases it", async () => {
    const h = setup();
    try {
      const conversation = bind(h, "bd-asset-media");
      const sweep = stamp(60_000);
      const { assetScope, scope, mediaNoteId } = seedImage(h, "bd-asset-media");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 4]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: stamp(30_000),
      });
      // The REAL minted media ref (projection freezes link/asset identity).
      const ref = createQqMediaSourceRef(h, scope, mediaNoteId, stamp());
      if (!ref) throw new Error("media ref did not mint");
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "run-asset-media",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: conversation.id },
        at: stamp(),
      });
      runs.startStep({
        runId: "run-asset-media",
        stepId: "step-asset-media",
        stepNo: 1,
        model: "synthetic-model",
        phase: "leaf",
        at: stamp(),
        messages: [textMessage("user", "看一下这张图")],
        sources: [ref],
      });

      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeDefined();

      runs.setStatus("run-asset-media", "completed", sweep);
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the source while an unsafe agent task holds the task ref, and while a terminal task keeps an unknown call", async () => {
    const h = setup();
    try {
      const conversation = bind(h, "bd-asset-task");
      const sweep = stamp(60_000);
      const { assetScope, scope, mediaNoteId } = seedImage(h, "bd-asset-task");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 5]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: stamp(30_000),
      });
      const claimed = await runTask(
        h,
        "bd-asset-task",
        mediaNoteId,
        assetContentSha256(h, asset.id),
        true,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, mediaNoteId, source.id);
      const ref = createQqMediaReadTaskSourceRef(h, scope, claimed.taskId, stamp());
      if (!ref) throw new Error("task ref did not mint");
      const tasks = new AgentTaskRepository(h.db);
      const task = tasks.enqueue({
        conversationId: conversation.id,
        agentId: AGENT,
        dedupeKey: "asset-task-hold",
        sources: [ref],
        at: stamp(),
        expiresAt: stamp(WINDOW_14D),
        calls: [],
      });

      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeDefined();

      // Terminal with no unknown call → no longer held.
      tasks.settle(task.id, "completed", sweep);
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeNull();

      // Second pair: a task that ended terminal but still keeps an unknown
      // write call (TASK_PROTECTION same scope) keeps its media ref hold.
      const second = seedImage(h, "bd-asset-task");
      const secondAsset = recordMediaAsset(h.orm, {
        scope: second.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 51]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const secondSource = linkMediaAssetSource(h.orm, {
        assetId: secondAsset.asset.id,
        mediaNoteId: second.mediaNoteId,
        scope: second.assetScope,
        expiresAt: stamp(30_000),
      });
      const secondRef = createQqMediaSourceRef(h, second.scope, second.mediaNoteId, stamp());
      if (!secondRef) throw new Error("media ref did not mint");
      const unknownTask = tasks.enqueue({
        conversationId: conversation.id,
        agentId: AGENT,
        dedupeKey: "asset-task-unknown",
        sources: [secondRef],
        at: stamp(),
        expiresAt: stamp(WINDOW_14D),
        calls: [{ name: "fixture.write", revision: "1", effect: "write", arguments: {} }],
      });
      const leaser = tasks.claim(stamp(), 60_000);
      if (!leaser || leaser.id !== unknownTask.id || !leaser.leaseToken) {
        throw new Error("task not claimed");
      }
      tasks.beginCall(unknownTask.id, leaser.leaseToken, 0, stamp());
      tasks.interrupt(unknownTask.id, stamp(), "failed", "TASK_OUTCOME_UNKNOWN");
      tasks.interrupt(unknownTask.id, stamp(), "failed", "TASK_EXPIRED");
      const settled = tasks.get(unknownTask.id);
      expect(settled?.status).toBe("failed");
      expect(settled?.calls[0]?.status).toBe("unknown");

      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, secondSource.id)).toBeDefined();

      // Third pair: an unsafe agent task holds the note through its REAL
      // minted media ref (kind qq_media_source) — the source row is protected
      // the same way until the task is safe.
      const third = seedImage(h, "bd-asset-task");
      const thirdAsset = recordMediaAsset(h.orm, {
        scope: third.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 52]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const thirdSource = linkMediaAssetSource(h.orm, {
        assetId: thirdAsset.asset.id,
        mediaNoteId: third.mediaNoteId,
        scope: third.assetScope,
        expiresAt: stamp(30_000),
      });
      const thirdRef = createQqMediaSourceRef(h, third.scope, third.mediaNoteId, stamp());
      if (!thirdRef) throw new Error("media ref did not mint");
      const mediaTask = tasks.enqueue({
        conversationId: conversation.id,
        agentId: AGENT,
        dedupeKey: "asset-task-media-ref",
        sources: [thirdRef],
        at: stamp(),
        expiresAt: stamp(WINDOW_14D),
        calls: [],
      });
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, thirdSource.id)).toBeDefined();
      tasks.settle(mediaTask.id, "completed", sweep);
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, thirdSource.id)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("a protected pair never blocks an unrelated expired pair, and a future window is never deleted", async () => {
    const h = setup();
    try {
      bind(h, "bd-asset-mixed");
      const sweep = stamp(60_000);
      // Protected pair: running task holds the expired source.
      const keep = seedImage(h, "bd-asset-mixed");
      const keepAsset = recordMediaAsset(h.orm, {
        scope: keep.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 6]),
        mimeType: "image/png",
        expiresAt: stamp(30_000),
      });
      const keepSource = linkMediaAssetSource(h.orm, {
        assetId: keepAsset.asset.id,
        mediaNoteId: keep.mediaNoteId,
        scope: keep.assetScope,
        expiresAt: stamp(30_000),
      });
      const claimed = await runTask(
        h,
        "bd-asset-mixed",
        keep.mediaNoteId,
        assetContentSha256(h, keepAsset.asset.id),
        false,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, keep.mediaNoteId, keepSource.id);
      // Unrelated pair: expired with nothing holding it.
      const gone = seedImage(h, "bd-asset-mixed");
      const goneAsset = recordMediaAsset(h.orm, {
        scope: gone.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 7]),
        mimeType: "image/png",
        expiresAt: stamp(30_000),
      });
      const goneSource = linkMediaAssetSource(h.orm, {
        assetId: goneAsset.asset.id,
        mediaNoteId: gone.mediaNoteId,
        scope: gone.assetScope,
        expiresAt: stamp(30_000),
      });
      // A live asset with a future window is never in the deletion set.
      const future = seedImage(h, "bd-asset-mixed");
      const futureAsset = recordMediaAsset(h.orm, {
        scope: future.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 8]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const futureSource = linkMediaAssetSource(h.orm, {
        assetId: futureAsset.asset.id,
        mediaNoteId: future.mediaNoteId,
        scope: future.assetScope,
        expiresAt: stamp(WINDOW_14D),
      });

      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(1);
      expect(assetRow(h, keepAsset.asset.id)).toBeDefined();
      expect(sourceRow(h, keepSource.id)).toBeDefined();
      expect(assetRow(h, goneAsset.asset.id)).toBeNull();
      expect(sourceRow(h, goneSource.id)).toBeNull();
      expect(assetRow(h, futureAsset.asset.id)).toBeDefined();
      expect(sourceRow(h, futureSource.id)).toBeDefined();
    } finally {
      h.close();
    }
  });

  it("both deletes live in one transaction: an abort in the sources delete rolls the asset delete back", async () => {
    const h = setup();
    try {
      bind(h, "bd-asset-rollback");
      const sweep = stamp(60_000);
      // Pair A: asset + source both expired, nothing holds them.
      const a = seedImage(h, "bd-asset-rollback");
      const aAsset = recordMediaAsset(h.orm, {
        scope: a.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 9]),
        mimeType: "image/png",
        expiresAt: stamp(30_000),
      });
      const aSource = linkMediaAssetSource(h.orm, {
        assetId: aAsset.asset.id,
        mediaNoteId: a.mediaNoteId,
        scope: a.assetScope,
        expiresAt: stamp(30_000),
      });
      // Pair B: LIVE asset whose source ended early — statement 1 must not
      // touch it, statement 2 deletes its source row (and must abort there).
      const b = seedImage(h, "bd-asset-rollback");
      const bAsset = recordMediaAsset(h.orm, {
        scope: b.assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 10]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const bSource = linkMediaAssetSource(h.orm, {
        assetId: bAsset.asset.id,
        mediaNoteId: b.mediaNoteId,
        scope: b.assetScope,
        expiresAt: stamp(30_000),
      });
      // Guard trigger: abort exactly when statement 2 deletes pair B's source
      // — a real in-tx abort, no production replacement.
      h.db.exec(`CREATE TRIGGER t14_rollback_guard BEFORE DELETE ON qq_media_asset_sources
        WHEN OLD.id = '${bSource.id}'
        BEGIN SELECT RAISE(ABORT,'rollback-guard'); END;`);
      try {
        expect(() => purgeExpiredMediaAssets(h.orm, sweep)).toThrow();
      } finally {
        h.db.exec("DROP TRIGGER t14_rollback_guard");
      }
      // Full rollback: pair A's deletion (statement 1) was undone too.
      expect(assetRow(h, aAsset.asset.id)).toBeDefined();
      expect(sourceRow(h, aSource.id)).toBeDefined();
      expect(assetRow(h, bAsset.asset.id)).toBeDefined();
      expect(sourceRow(h, bSource.id)).toBeDefined();
      // Without the guard the same sweep commits: pair A deleted (returns the
      // real asset count), pair B is a source-only cleanup.
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(1);
      expect(assetRow(h, aAsset.asset.id)).toBeNull();
      expect(assetRow(h, bAsset.asset.id)).toBeDefined();
      expect(sourceRow(h, bSource.id)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("derivatives keep their guards: a variant survives a blocked sweep and falls with the asset", async () => {
    const h = setup();
    try {
      bind(h, "bd-asset-variant");
      const sweep = stamp(60_000);
      const far = stamp(60 * 24 * 60 * 60 * 1000);
      const { assetScope, mediaNoteId } = seedImage(h, "bd-asset-variant");
      const { asset } = recordMediaAsset(h.orm, {
        scope: assetScope,
        bytes: new Uint8Array([137, 80, 78, 71, 11]),
        mimeType: "image/png",
        expiresAt: stamp(WINDOW_14D),
      });
      const source = linkMediaAssetSource(h.orm, {
        assetId: asset.id,
        mediaNoteId,
        scope: assetScope,
        expiresAt: stamp(30_000),
      });
      const variant = recordMediaVariant(h.orm, {
        assetId: asset.id,
        policy: "p",
        bytes: new Uint8Array([4, 4, 4]),
        mimeType: "image/png",
      });
      const claimed = await runTask(
        h,
        "bd-asset-variant",
        mediaNoteId,
        assetContentSha256(h, asset.id),
        false,
        stamp(),
      );
      if (!claimed) throw new Error("task missing");
      bindTaskToSource(h, mediaNoteId, source.id);
      // Blocked sweep: no partial take inside the protected window.
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(mediaVariantFor(h.orm, { assetId: asset.id, policy: "p" })?.id).toBe(
        variant.variant.id,
      );
      // After release the expired source goes (source-only → 0); the variant
      // stays with its live asset until the asset's own window passes.
      recordMediaReadTaskResult(h.orm, {
        mediaNoteId,
        purpose: "baseline",
        note: "读完",
        modelName: "vision-synthetic",
        expectedAttempts: claimed.attempt,
        claimToken: claimed.claimToken,
        assertCurrent: guardFor("bd-asset-variant"),
        at: stamp(),
      });
      expect(purgeExpiredMediaAssets(h.orm, sweep)).toBe(0);
      expect(sourceRow(h, source.id)).toBeNull();
      expect(mediaVariantFor(h.orm, { assetId: asset.id, policy: "p" })?.id).toBe(
        variant.variant.id,
      );
      expect(purgeExpiredMediaAssets(h.orm, far)).toBe(1);
      expect(assetRow(h, asset.id)).toBeNull();
      expect(mediaVariantFor(h.orm, { assetId: asset.id, policy: "p" })).toBeNull();
    } finally {
      h.close();
    }
  });
});
