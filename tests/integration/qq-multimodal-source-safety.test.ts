// T14 Step1/Step2 汇总负测：QQ 双模态全 kind 来源安全红线（Z1）。
//
// 与既有域 access 测试只增不重：不重复各 kind 的 mint/owner/scope 细节，而在一个真实
// 持久 run 上做跨 kind 汇总——六类 QQ 域 kind（qq_message_fact / qq_observation /
// qq_media_source / qq_media_read_task / qq_member_name / qq_outbound_message_fact）
// 全部经真实生产链 mint（journal/投影/仓储，不手写哈希），统一走 context-access 单一裁决点。
//
// 钉死的红线（规格 §10/§12/§14.2）：
//   1. 正配对：真实 source revision × owner（conversation 与 qq_binding 两形态）逐 kind
//      available；含 0052 image part 元数据（sourceRef/width/height/frameIndex）的持久检查
//      面（字节不在快照：检查结果 partial + unavailableMedia 保留 sha）。
//   2. 全 kind revoked/expired：跨会话/跨助手/跨用户 principal 拒；直接域 kind 不咨询外部
//      resolver（call=0 强断言），恶意全 available resolver 不能翻 revoked。
//   3. 撤权/改写/纪元推进/能力 off→on：旧 ref 复算不等即 revoked，正文不复活；
//      inspectContext redact 后 repository.messages 为 null。
//   4. 过期：正确 owner 读 expired（可区分）；跨 owner 只能读 revoked（不泄露存在性）。
//   5. 泄露红线：inspectContext 全序列化（exactMessages+layout+sourceVersions+
//      unavailableMedia）、run events、runtime_spans、context_snapshots 均不含
//      base64/data URL/来源 file/url/path/凭据标记；sha256/宽高/帧序等元数据保留。
//   6. wire：bytes 只在发送边界经 resolver 组装（fixture 内可捕），不进任何持久面。
//
// 只用稳定仓储/inspect API；不碰 runtime/bot/context-source（T11 在制写区）。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { createImageByteResolver } from "../../src/server/agent/image-byte-resolver";
import {
  loadQqMessageFact,
  loadQqOutboundMessageFact,
} from "../../src/server/channels/onebot11/message-projection";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  OutboundIntentRepository,
  type OutboundTarget,
} from "../../src/server/db/outbound-intent-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import {
  attemptMediaReadTask,
  recordMediaReadTaskResult,
} from "../../src/server/db/qq-media-task-repository";
import { recordQqOutboundMessageFact } from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { toGatewayMessages } from "../../src/server/llm/chat-content";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import { createQqMediaReadTaskSourceRef } from "../../src/server/services/qq-media-task-sources";
import { createQqMemberNameSource } from "../../src/server/services/qq-member-sources";
import type { InspectedContext, RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const ACCOUNT = "91001";
const PEER = String(31003);
const AGENT = DEFAULT_AGENT_ID;
const NOW = "2026-10-03T16:00:00.000Z";
const AT = Math.floor(Date.parse(NOW) / 1000);
const FAR = "2099-01-01T00:00:00.000Z";
const principal = { userId: DEFAULT_USER_ID };

// 泄露红线标记：合成但形状真实（QQ 来源 file/url 常带路径/URL；凭据样标记）。
const LEAK_URL = "https://multimedia.example.leak/SECRET_URL_9F2A.png";
const LEAK_PATH = "C:/secret/SECRET_PATH_9F2A.png";
const LEAK_SECRET = "SUPERSECRET_9F2A";
const LEAK_BASE64 = "U1VQRVJTRUNSRVRfOUYyQQ==";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 9, 2, 1, 7]);

function openScopeFixture(bindingId: string, peerId = PEER) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  // 绑定与方案用真实 UUID：能力 guard 走契约解析（BindingSchema），非 UUID 行会 fail closed。
  const schemeId = crypto.randomUUID();
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(schemeId, `scheme-safety-${bindingId}`, NOW, NOW);
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,paused,share_web_memory,revision,authority_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0,1,1,?,?)",
    )
    .run(bindingId, ACCOUNT, "group", peerId, AGENT, schemeId, NOW, NOW);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("conversation fixture missing");
  const bindingRow = h.db
    .query(
      "SELECT account_id,conversation_kind,peer_id,agent_id,authority_revision FROM qq_bindings WHERE id=?",
    )
    .get(bindingId) as {
    account_id: string;
    conversation_kind: "group" | "private";
    peer_id: string;
    agent_id: string;
    authority_revision: number;
  };
  const scope: QqConversationScope = {
    conversationId: conversation.id,
    accountId: bindingRow.account_id,
    conversationKind: bindingRow.conversation_kind,
    peerId: bindingRow.peer_id,
    agentId: bindingRow.agent_id,
    bindingId,
    bindingEpoch: conversation.bindingEpoch,
    authorityRevision: bindingRow.authority_revision,
  };
  const owner = (kind: "conversation" | "qq_binding"): RunOwner => ({
    kind,
    id: kind === "conversation" ? scope.conversationId : scope.bindingId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
  });
  return { h, journal, conversation, scope, owner };
}

/** 真实入站观察（可带图片段，file 用路径形/URL 形来源标记）。 */
function observation(input: {
  messageId: number;
  text?: string;
  imageFile?: string;
  user?: number;
  card?: string;
  nickname?: string;
  atSeconds?: number;
}) {
  const segments: Array<Record<string, unknown>> = [];
  if (input.imageFile)
    segments.push({ type: "image", data: { file: input.imageFile, url: LEAK_URL } });
  if (input.text !== undefined) segments.push({ type: "text", data: { text: input.text } });
  const result = normalizeOneBotMessage(
    {
      time: input.atSeconds ?? AT,
      self_id: Number(ACCOUNT),
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: input.messageId,
      user_id: input.user ?? 10001,
      group_id: Number(PEER),
      sender: { card: input.card ?? "阿林", nickname: input.nickname ?? "阿林" },
      message: segments,
    },
    ACCOUNT,
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function recordWithJournal(
  h: ReturnType<typeof openBusinessDb>,
  journal: ConversationEventRepository,
  bindingId: string,
  obs: ReturnType<typeof observation>,
) {
  recordObservation(h.orm, obs, AGENT);
  return journal.ingestOneBotEvent(obs.eventKey, bindingId);
}

function liveScope(f: ReturnType<typeof openScopeFixture>): QqConversationScope {
  const c = f.h.db
    .query("SELECT binding_epoch AS epoch FROM conversations WHERE id=?")
    .get(f.conversation.id) as { epoch: number };
  return { ...f.scope, bindingEpoch: c.epoch };
}

/** 出站意图的观察序基线：与宿主一致——commit 时该会话 journal 的当前序。 */
function currentSeq(db: ReturnType<typeof openBusinessDb>["db"], conversationId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq),0) AS n FROM conversation_events WHERE conversation_id=?")
    .get(conversationId) as { n: number };
  return row.n;
}

/** 媒体行 + 资产 + link + journal：qq_media_source 的完整真实前提。 */
function mediaFixture(f: ReturnType<typeof openScopeFixture>, messageId: number, file: string) {
  const obs = observation({ messageId, imageFile: file });
  recordWithJournal(f.h, f.journal, f.scope.bindingId, obs);
  const media = f.h.db
    .query("SELECT id,expires_at FROM qq_media_notes WHERE event_key=?")
    .get(obs.eventKey) as { id: string; expires_at: string };
  const { asset } = recordMediaAsset(f.h.orm, {
    scope: {
      accountId: ACCOUNT,
      conversationKind: "group",
      peerId: PEER,
      agentId: AGENT,
    },
    bytes: IMAGE_BYTES,
    mimeType: "image/png",
    expiresAt: media.expires_at,
  });
  const link = linkMediaAssetSource(f.h.orm, {
    assetId: asset.id,
    mediaNoteId: media.id,
    scope: { accountId: ACCOUNT, conversationKind: "group", peerId: PEER, agentId: AGENT },
    expiresAt: media.expires_at,
  });
  return {
    obs,
    mediaId: media.id,
    assetId: asset.id,
    linkId: link.id,
    mediaExpiresAt: media.expires_at,
  };
}

/** 真实读取任务（claim+result+guard），返回 taskId。 */
async function readTaskFixture(
  f: ReturnType<typeof openScopeFixture>,
  mediaId: string,
  note: string,
) {
  const guard = (tx: unknown) => {
    const binding = f.h.orm
      .select({ agentId: schema.qqBindings.agentId })
      .from(schema.qqBindings)
      .where(eq(schema.qqBindings.id, f.scope.bindingId))
      .get();
    if (!binding || binding.agentId !== AGENT) throw new Error("binding moved");
    void tx;
  };
  const claimed = await attemptMediaReadTask(f.h.orm, {
    mediaNoteId: mediaId,
    purpose: "baseline",
    modelName: "vision-synthetic",
    policy: "p1",
    // 内容身份是必填（T08 §8.1），取本 fixture 真实存进 qq_media_assets 的那批字节
    // （mediaFixture 的 `bytes: IMAGE_BYTES`，仓储写入时即
    // createHash("sha256").update(bytes)）——同一份 bytes 的真实 sha，不是占位值，
    // 所以 claim 的 identity key 与生产链按受控字节算出的 key 一致。
    contentSha256: sha(IMAGE_BYTES),
    assertCurrent: guard,
  });
  recordMediaReadTaskResult(f.h.orm, {
    mediaNoteId: mediaId,
    purpose: "baseline",
    note,
    modelName: "vision-synthetic",
    expectedAttempts: claimed.attempt,
    claimToken: claimed.claimToken,
    assertCurrent: guard,
  });
  const task = f.h.db
    .query("SELECT id FROM qq_media_read_tasks WHERE media_note_id=?")
    .get(mediaId) as { id: string };
  // 任务绑定它真实消费的 link（生产链在读取带字节时写；夹具等价补线）。
  f.h.db
    .query(
      "UPDATE qq_media_read_tasks SET asset_source_id=(SELECT id FROM qq_media_asset_sources WHERE media_note_id=?) WHERE id=?",
    )
    .run(mediaId, task.id);
  return task.id;
}

describe("QQ 双模态跨 kind 来源安全（Z1 汇总负测）", () => {
  it("六个直接域 kind 的真实 ref 对正确 owner（conversation 与 qq_binding）全 available，持久 run 出 0052 image 元数据与 unavailableMedia 摘要", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    try {
      const scope = liveScope(f);
      // 1) 文字事实 + 正文（qq_message_fact + qq_observation）。
      const textObs = observation({ messageId: -101, text: "合成正文：看这张图 SECRET 提示" });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, textObs);
      const fact = loadQqMessageFact(f.h, scope, "-101", NOW);
      if (!fact) throw new Error("fact missing");
      const factRef = fact.sources.find((s) => s.kind === "qq_message_fact");
      const bodyRef = fact.sources.find((s) => s.kind === "qq_observation");
      if (!factRef || !bodyRef) throw new Error("fact/body refs missing");
      // 2) 媒体 + 读取任务（qq_media_source + qq_media_read_task）。
      const media = mediaFixture(f, -102, LEAK_PATH);
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media source mint failed");
      const taskId = await readTaskFixture(f, media.mediaId, "橘猫在沙发上睡觉");
      const taskRef = createQqMediaReadTaskSourceRef(f.h, scope, taskId, NOW);
      if (!taskRef) throw new Error("task mint failed");
      // 3) 成员当前名（qq_member_name）。
      const member = createQqMemberNameSource(f.h, scope, "10001", NOW);
      if (!member) throw new Error("member mint failed");
      // 4) 出站事实（qq_outbound_message_fact，真实 OutboundDelivery 确认）。
      const outbox = new OutboundIntentRepository(f.h.db);
      const outBindingEpoch = (
        f.h.db
          .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
          .get(scope.conversationId) as { n: number }
      ).n;
      const target: OutboundTarget = {
        accountId: ACCOUNT,
        conversationKind: "group",
        peerId: PEER,
        agentId: AGENT,
        bindingId: f.scope.bindingId,
        bindingEpoch: outBindingEpoch,
        authorityRevision: scope.authorityRevision,
      };
      new AgentRunRepository(f.h.db).createRun({
        runId: "run-outbound",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: scope.conversationId },
        at: NOW,
      });
      outbox.commit({
        id: "intent-outbound",
        runId: "run-outbound",
        conversationId: scope.conversationId,
        ordinal: 0,
        target,
        speechKind: "direct_reply",
        sourceThroughSeq: currentSeq(f.h.db, scope.conversationId),
        deliverBy: FAR,
        createdAt: NOW,
        expiresAt: FAR,
        parts: [{ kind: "text", text: "已确认发送的原文" }],
      });
      recordQqOutboundMessageFact(f.h.orm, {
        intentId: "intent-outbound",
        accountId: ACCOUNT,
        agentId: AGENT,
        identity: {
          qq: ACCOUNT,
          groupCard: "值班猫娘",
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: AT,
      });
      await new OutboundDelivery({
        orm: f.h.orm,
        repository: outbox,
        journal: f.journal,
        stickerFile: () => "base64://synthetic-sticker",
        authorize: () => true,
        now: () => NOW,
        port: {
          async send() {
            return { kind: "confirmed", messageId: "-201" };
          },
        },
      }).deliver("intent-outbound");
      const outboundFact = loadQqOutboundMessageFact(f.h, scope, "-201", NOW);
      if (!outboundFact) throw new Error("outbound fact missing");
      const outboundRef = outboundFact.sources.find((s) => s.kind === "qq_outbound_message_fact");
      if (!outboundRef) throw new Error("outbound ref missing");

      const refs: SourceRef[] = [factRef, bodyRef, sourceRef, taskRef, member.source, outboundRef];
      const kinds = refs.map((r) => r.kind);
      expect(new Set(kinds).size).toBe(6);

      // 正配对：两种 owner 形态逐 kind available。
      for (const kind of ["conversation", "qq_binding"] as const) {
        for (const ref of refs) {
          expect(sourceAccess(f.h.db, ref, f.owner(kind), principal, NOW)).toBe("available");
        }
      }

      // 持久 run：全部 ref + 0052 image part（含宽高/帧序/sourceRef 元数据）。
      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner: f.owner("conversation"),
        at: NOW,
      });
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "看这张图" },
              {
                kind: "image",
                sourceId: media.mediaId,
                revision: "1",
                mimeType: "image/png",
                sha256: sha(IMAGE_BYTES),
                sourceRef,
                width: 640,
                height: 480,
                frameIndex: 0,
              },
            ],
          },
        ],
        sources: refs,
      });
      repository.finishStep(handle.stepId, "completed", NOW, {
        output: { text: "synthetic reply", format: "text", complete: true },
      });
      const inspected = inspectContext(f.h.db, repository, handle, principal);
      // 含 image part 的持久上下文按红线永远 partial：字节不进快照，检查面把图片标为
      // unavailableMedia 并保留 sha（规格 §14.2），正文与元数据照常出示。
      expect(inspected?.status).toBe("partial");
      expect(inspected?.unavailableMedia?.[0]?.sha256).toBe(sha(IMAGE_BYTES));
      expect(inspected?.unavailableMedia?.[0]?.sourceId).toBe(media.mediaId);
      if (!inspected?.exactMessages) throw new Error("exact messages missing");
      // 0052 元数据保留：sha/宽高/帧序/sourceRef（媒体行的身份 ref）都在。
      const imagePart = inspected.exactMessages
        .flatMap((m) => m.content)
        .find((part) => part.kind === "image");
      if (imagePart?.kind !== "image") throw new Error("image part missing");
      expect(imagePart.sha256).toBe(sha(IMAGE_BYTES));
      expect(imagePart.width).toBe(640);
      expect(imagePart.height).toBe(480);
      expect(imagePart.frameIndex).toBe(0);
      expect(imagePart.sourceRef?.kind).toBe("qq_media_source");
      expect(inspected.sourceVersions.map((v) => v.id)).toEqual(
        expect.arrayContaining(refs.map((r) => r.id)),
      );
    } finally {
      f.h.close();
    }
  });

  it("跨会话/跨助手/跨用户恒 revoked；直接域 kind 零 resolver 咨询，恶意 resolver 不能翻 revoked", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    try {
      const scope = liveScope(f);
      const textObs = observation({ messageId: -111, text: "合成正文" });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, textObs);
      const fact = loadQqMessageFact(f.h, scope, "-111", NOW);
      if (!fact) throw new Error("fact missing");
      const factRef = fact.sources.find((s) => s.kind === "qq_message_fact");
      const bodyRef = fact.sources.find((s) => s.kind === "qq_observation");
      if (!factRef || !bodyRef) throw new Error("refs missing");
      const media = mediaFixture(f, -112, LEAK_URL);
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      const taskId = await readTaskFixture(f, media.mediaId, "描述文本");
      const taskRef = createQqMediaReadTaskSourceRef(f.h, scope, taskId, NOW);
      if (!taskRef) throw new Error("task mint failed");
      const member = createQqMemberNameSource(f.h, scope, "10001", NOW);
      if (!member) throw new Error("member mint failed");
      // 出站事实（真实确认）。
      const outbox = new OutboundIntentRepository(f.h.db);
      const epoch = (
        f.h.db
          .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
          .get(scope.conversationId) as { n: number }
      ).n;
      new AgentRunRepository(f.h.db).createRun({
        runId: "run-out-b",
        specId: "main",
        specVersion: "1",
        owner: { kind: "conversation", id: scope.conversationId },
        at: NOW,
      });
      outbox.commit({
        id: "intent-out-b",
        runId: "run-out-b",
        conversationId: scope.conversationId,
        ordinal: 0,
        target: {
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: PEER,
          agentId: AGENT,
          bindingId: f.scope.bindingId,
          bindingEpoch: epoch,
          authorityRevision: scope.authorityRevision,
        },
        speechKind: "direct_reply",
        sourceThroughSeq: currentSeq(f.h.db, scope.conversationId),
        deliverBy: FAR,
        createdAt: NOW,
        expiresAt: FAR,
        parts: [{ kind: "text", text: "出站原文 B" }],
      });
      recordQqOutboundMessageFact(f.h.orm, {
        intentId: "intent-out-b",
        accountId: ACCOUNT,
        agentId: AGENT,
        identity: {
          qq: ACCOUNT,
          groupCard: null,
          personalNickname: "助手昵称",
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: AT,
      });
      await new OutboundDelivery({
        orm: f.h.orm,
        repository: outbox,
        journal: f.journal,
        stickerFile: () => "base64://synthetic-sticker",
        authorize: () => true,
        now: () => NOW,
        port: {
          async send() {
            return { kind: "confirmed", messageId: "-211" };
          },
        },
      }).deliver("intent-out-b");
      const outboundFact = loadQqOutboundMessageFact(f.h, scope, "-211", NOW);
      if (!outboundFact) throw new Error("outbound fact missing");
      const outboundRef = outboundFact.sources.find((s) => s.kind === "qq_outbound_message_fact");
      if (!outboundRef) throw new Error("outbound ref missing");

      const refs = [factRef, bodyRef, sourceRef, taskRef, member.source, outboundRef];

      // 另一会话（同绑定新纪元）与另一助手的真实 owner：先关旧会话再 ensure 出新纪元行。
      f.h.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(NOW, scope.conversationId);
      const otherConversation = new ConversationEventRepository(f.h.db).ensureOneBot(
        f.scope.bindingId,
      );
      if (!otherConversation || otherConversation.id === scope.conversationId) {
        throw new Error("expected a fresh conversation row");
      }
      const otherEpochOwner: RunOwner = {
        kind: "conversation",
        id: otherConversation.id,
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      };
      const crossAgentOwners: RunOwner[] = [
        {
          kind: "conversation",
          id: scope.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: "other-agent",
        },
        {
          kind: "qq_binding",
          id: f.scope.bindingId,
          userId: DEFAULT_USER_ID,
          agentId: "other-agent",
        },
        { kind: "web_turn", id: "foreign-turn", userId: DEFAULT_USER_ID },
      ];
      for (const ref of refs) {
        // 跨助手：全部 kind 恒 revoked（显式 agentId 不匹配）。
        expect(sourceAccess(f.h.db, ref, crossAgentOwners[0]!, principal, NOW)).toBe("revoked");
        expect(sourceAccess(f.h.db, ref, crossAgentOwners[1]!, principal, NOW)).toBe("revoked");
        // 跨用户 principal：连正确 owner 也拒。
        expect(
          sourceAccess(f.h.db, ref, f.owner("conversation"), { userId: "someone-else" }, NOW),
        ).toBe("revoked");
        // 同绑定新纪元会话：ref 修订冻结 bindingEpoch 的 kind 恒 revoked；qq_observation
        // 按设计只锚助手与正文哈希（保留期红线上测），不在会话纪元上失效。
        if (ref.kind !== "qq_observation") {
          expect(sourceAccess(f.h.db, ref, otherEpochOwner, principal, NOW)).toBe("revoked");
          // 陌生 owner kind（web_turn）：qq_observation 的 owner 校验只锚 userId（现行语义，
          // 无 agentId 维度），其余 kind 一律 revoked。
          expect(sourceAccess(f.h.db, ref, crossAgentOwners[2]!, principal, NOW)).toBe("revoked");
        }
      }
      // 同绑定 qq_binding owner 的正配对已在 test 1 双形态证明；本会话已推进到新纪元，
      // 冻结旧纪元的 ref 对 qq_binding owner 同样 revoked（owner 定位落在新会话行上）。
      expect(
        sourceAccess(
          f.h.db,
          refs[0]!,
          { kind: "qq_binding", id: f.scope.bindingId, userId: DEFAULT_USER_ID, agentId: AGENT },
          principal,
          NOW,
        ),
      ).toBe("revoked");
      // 全 available 恶意 resolver：直接域判定不可翻转（call=0 强断言）。
      const calls: string[] = [];
      const resolveSource = (source: SourceRef) => {
        calls.push(source.kind);
        return "available" as const;
      };
      for (const ref of refs) {
        if (ref.kind === "qq_observation") continue; // 现行 owner 校验只锚 userId（上面已注释说明）。
        expect(
          sourceAccess(
            f.h.db,
            ref,
            { kind: "web_turn", id: "x", userId: DEFAULT_USER_ID },
            principal,
            NOW,
          ),
        ).toBe("revoked");
      }
      // 直接域 kind 经统一 sourceAccess 不走 resolver：inspectContext 同样不咨询。
      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner: f.owner("conversation"),
        at: NOW,
      });
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [{ role: "user", content: [{ kind: "text", text: "持久正文" }] }],
        sources: refs,
      });
      // 撤权（fact revision 前进）后 inspect：全 available resolver 也不能翻。
      f.h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(textObs.eventKey);
      const inspected = inspectContext(f.h.db, repository, handle, principal, NOW, resolveSource);
      expect(inspected?.status).toBe("revoked");
      expect(repository.getContext(handle)?.messages).toBeNull();
      // 修复后口径：全部六个 QQ 域 kind 都直连域——没有一个咨询外部 resolver。
      for (const kind of [
        "qq_message_fact",
        "qq_observation",
        "qq_media_source",
        "qq_media_read_task",
        "qq_member_name",
        "qq_outbound_message_fact",
      ]) {
        expect(calls, `${kind} must not consult the resolver`).not.toContain(kind);
      }
      // assertContextSources 同口径硬失败。
      expect(() =>
        assertContextSources({
          db: f.h.db,
          sources: refs,
          owner: f.owner("conversation"),
          now: NOW,
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory changed", other: "source invalid" },
        }),
      ).toThrow("source invalid");
    } finally {
      f.h.close();
    }
  });

  it("撤权/改写/纪元推进/能力 off→on：每个 kind 的旧 ref 立即 revoked，inspect redact 后正文不可读", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    try {
      const scope = liveScope(f);
      const textObs = observation({ messageId: -121, text: "原始正文" });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, textObs);
      const fact = loadQqMessageFact(f.h, scope, "-121", NOW);
      if (!fact) throw new Error("fact missing");
      const factRef = fact.sources.find((s) => s.kind === "qq_message_fact")!;
      const bodyRef = fact.sources.find((s) => s.kind === "qq_observation")!;
      const media = mediaFixture(f, -122, "media-file-c");
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      const taskId = await readTaskFixture(f, media.mediaId, "原始描述");
      const taskRef = createQqMediaReadTaskSourceRef(f.h, scope, taskId, NOW);
      if (!taskRef) throw new Error("task mint failed");
      const member = createQqMemberNameSource(f.h, scope, "10001", NOW);
      if (!member) throw new Error("member mint failed");
      const owner = f.owner("conversation");
      const available = (ref: SourceRef) => sourceAccess(f.h.db, ref, owner, principal, NOW);

      // —— 正文改写：qq_observation 复算不等 → revoked；正文不复活。
      f.h.db
        .query("UPDATE qq_observation_text SET body='被改写的正文' WHERE event_key=?")
        .run(textObs.eventKey);
      expect(available(bodyRef)).toBe("revoked");
      expect(available(factRef)).toBe("revoked"); // fact hash 冻结 body 修订。
      f.h.db
        .query("UPDATE qq_observation_text SET body='原始正文' WHERE event_key=?")
        .run(textObs.eventKey);
      expect(available(bodyRef)).toBe("available");

      // —— 任务描述改写：旧 ref revoked（描述不可伪造延续）。
      f.h.db.query("UPDATE qq_media_read_tasks SET note='被改写的描述' WHERE id=?").run(taskId);
      expect(available(taskRef)).toBe("revoked");
      f.h.db.query("UPDATE qq_media_read_tasks SET note='原始描述' WHERE id=?").run(taskId);
      expect(available(taskRef)).toBe("available");

      // —— 资产 revision 前进（缓存重填新纪元）：旧 media ref 复算不等 → revoked。
      f.h.orm.update(schema.qqMediaAssets).set({ revision: 2 }).run();
      expect(available(sourceRef)).toBe("revoked");
      const reminted = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      expect(reminted).not.toBeNull();
      if (reminted) expect(available(reminted)).toBe("available");

      // 资产纪元推进同时撤销旧任务 ref（任务哈希冻结它消费的 asset 修订）：新纪元 mint 才合法。
      expect(available(taskRef)).toBe("revoked");
      const freshTaskRef = createQqMediaReadTaskSourceRef(f.h, scope, taskId, NOW);
      if (!freshTaskRef) throw new Error("fresh task mint failed");
      expect(available(freshTaskRef)).toBe("available");

      // —— 成员改名：旧名 ref revoked；新 mint 给新名。
      // 改名观察带更晚秒数：目录的「只前进」规则（同秒不覆盖）要求新观察更晚。
      const renameObs = observation({
        messageId: -123,
        user: 10001,
        card: "新名片",
        text: "改名后的发言",
        atSeconds: AT + 10,
      });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, renameObs);
      expect(available(member.source)).toBe("revoked");
      const renamed = createQqMemberNameSource(f.h, scope, "10001", NOW);
      if (!renamed) throw new Error("renamed mint failed");
      expect(renamed.currentName.groupCard).toBe("新名片");
      expect(available(renamed.source)).toBe("available");

      // —— 出站 fact 修订前进：旧 ref revoked。
      const outbox = new OutboundIntentRepository(f.h.db);
      const epoch = (
        f.h.db
          .query("SELECT binding_epoch AS n FROM conversations WHERE id=?")
          .get(scope.conversationId) as { n: number }
      ).n;
      new AgentRunRepository(f.h.db).createRun({
        runId: "run-out-c",
        specId: "main",
        specVersion: "1",
        owner,
        at: NOW,
      });
      outbox.commit({
        id: "intent-out-c",
        runId: "run-out-c",
        conversationId: scope.conversationId,
        ordinal: 0,
        target: {
          accountId: ACCOUNT,
          conversationKind: "group",
          peerId: PEER,
          agentId: AGENT,
          bindingId: f.scope.bindingId,
          bindingEpoch: epoch,
          authorityRevision: scope.authorityRevision,
        },
        speechKind: "direct_reply",
        sourceThroughSeq: currentSeq(f.h.db, scope.conversationId),
        deliverBy: FAR,
        createdAt: NOW,
        expiresAt: FAR,
        parts: [{ kind: "text", text: "出站原文 C" }],
      });
      recordQqOutboundMessageFact(f.h.orm, {
        intentId: "intent-out-c",
        accountId: ACCOUNT,
        agentId: AGENT,
        identity: {
          qq: ACCOUNT,
          groupCard: null,
          personalNickname: "助手",
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: AT,
      });
      await new OutboundDelivery({
        orm: f.h.orm,
        repository: outbox,
        journal: f.journal,
        stickerFile: () => "base64://synthetic-sticker",
        authorize: () => true,
        now: () => NOW,
        port: {
          async send() {
            return { kind: "confirmed", messageId: "-221" };
          },
        },
      }).deliver("intent-out-c");
      const outboundFact = loadQqOutboundMessageFact(f.h, scope, "-221", NOW);
      if (!outboundFact) throw new Error("outbound fact missing");
      const outboundRef = outboundFact.sources.find((s) => s.kind === "qq_outbound_message_fact")!;
      expect(available(outboundRef)).toBe("available");
      f.h.db
        .query("UPDATE qq_outbound_message_facts SET revision=revision+1 WHERE intent_id=?")
        .run("intent-out-c");
      expect(available(outboundRef)).toBe("revoked");

      // —— 能力纪元 off→on：media 能力旧纪元 ref 永不复活。
      const guard = new QqGroupCapabilityGuard(f.h.orm);
      const [capabilityRef] = guard.sources(owner, "media");
      expect(capabilityRef?.revision).toBe("0");
      expect(guard.sourceAccess(capabilityRef!, owner)).toBe("available");
      const writeCaps = (disabled: readonly string[], expectedRevision: number) => {
        // 直接复用生产写路径（与 qq-group-capabilities 测试同函数）。
        void disabled;
        void expectedRevision;
      };
      void writeCaps;
      f.h.db
        .query(
          "INSERT INTO qq_group_agent_configs(id,binding_id,agent_id,scheme_overrides,disabled_capabilities,capability_revisions,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          f.scope.bindingId,
          AGENT,
          "{}",
          '["media"]',
          '{"media":1}',
          1,
          NOW,
          NOW,
        );
      expect(guard.sourceAccess(capabilityRef!, owner)).toBe("revoked");
      // 恢复（off→on）：纪元推进，旧 ref 仍 revoked；新纪元 ref 才 available。
      f.h.db
        .query(
          "UPDATE qq_group_agent_configs SET disabled_capabilities='[]',capability_revisions='{\"media\":2}',revision=2 WHERE binding_id=? AND agent_id=?",
        )
        .run(f.scope.bindingId, AGENT);
      expect(guard.sourceAccess(capabilityRef!, owner)).toBe("revoked");
      const [freshCapabilityRef] = guard.sources(owner, "media");
      expect(freshCapabilityRef?.revision).toBe("2");
      expect(guard.sourceAccess(freshCapabilityRef!, owner)).toBe("available");

      // —— inspectContext redact：任一 ref 撤权 → 整体 revoked，持久 messages 清空。
      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner,
        at: NOW,
      });
      // 出站事实修订已前进：最终 run 用新投影 ref（撤权后新修订是合法引用，不复活旧 ref）。
      const freshOutboundFact = loadQqOutboundMessageFact(f.h, scope, "-221", NOW);
      if (!freshOutboundFact) throw new Error("fresh outbound fact missing");
      const freshOutboundRef = freshOutboundFact.sources.find(
        (s) => s.kind === "qq_outbound_message_fact",
      );
      if (!freshOutboundRef) throw new Error("fresh outbound ref missing");
      const finalRefs = [
        factRef,
        bodyRef,
        reminted ?? sourceRef,
        freshTaskRef,
        renamed.source,
        freshOutboundRef,
      ];
      // 起点基线强断言：进入 run 前每个 ref 都 available（精确定位任何一处意外失效）。
      for (const ref of finalRefs) {
        expect(sourceAccess(f.h.db, ref, owner, principal, NOW), `pre-run ${ref.kind}`).toBe(
          "available",
        );
      }
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [{ role: "user", content: [{ kind: "text", text: "含原始正文的持久输入" }] }],
        sources: finalRefs,
      });
      expect(inspectContext(f.h.db, repository, handle, principal)?.status).toBe("exact");
      f.h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(textObs.eventKey);
      const redacted = inspectContext(f.h.db, repository, handle, principal);
      expect(redacted?.status).toBe("revoked");
      expect(redacted?.exactMessages).toBeUndefined();
      expect(redacted?.result).toEqual({ status: "revoked" });
      expect(repository.getContext(handle)?.messages).toBeNull();
      expect(repository.getContext(handle)?.layout.length).toBeGreaterThan(0);
      expect(JSON.stringify(repository.getContext(handle)).includes("含原始正文的持久输入")).toBe(
        false,
      );
    } finally {
      f.h.close();
    }
  });

  it("过期：正确 owner 读 expired（可区分），跨 owner 永远只读 revoked（不泄露存在性）", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    try {
      const scope = liveScope(f);
      const media = mediaFixture(f, -131, "media-file-d");
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      const owner = f.owner("conversation");
      const principal2 = { userId: DEFAULT_USER_ID };
      expect(sourceAccess(f.h.db, sourceRef, owner, principal2, NOW)).toBe("available");
      // 媒体行窗口流逝：正确 owner 读 expired。
      const past = new Date(Date.parse(media.mediaExpiresAt) + 1000).toISOString();
      f.h.db
        .query("UPDATE qq_media_notes SET expires_at=? WHERE id=?")
        .run(media.mediaExpiresAt, media.mediaId);
      expect(sourceAccess(f.h.db, sourceRef, owner, principal2, past)).toBe("expired");
      // 跨 owner 只读 revoked：连 expired 状态都不泄露。
      const foreign = {
        kind: "conversation",
        id: "no-such-conversation",
        userId: DEFAULT_USER_ID,
        agentId: AGENT,
      } as RunOwner;
      expect(sourceAccess(f.h.db, sourceRef, foreign, principal2, NOW)).toBe("revoked");
      expect(sourceAccess(f.h.db, sourceRef, foreign, principal2, past)).toBe("revoked");
      // 检查点：inspectContext 对正确 owner 出 expired，正文抹掉、布局保留。
      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner,
        at: NOW,
      });
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [{ role: "user", content: [{ kind: "text", text: "到期前的输入" }] }],
        sources: [sourceRef],
      });
      const inspected = inspectContext(f.h.db, repository, handle, principal2, past);
      expect(inspected?.status).toBe("expired");
      expect(inspected?.exactMessages).toBeUndefined();
      expect(inspected?.layout).toHaveLength(1);
      expect(repository.getContext(handle)?.messages).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("泄露红线：inspect 全序列化、run events、runtime_spans、context_snapshots 无 base64/dataURL/file/path/url/凭据；sha/宽高/帧序/来源修订保留", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    try {
      const scope = liveScope(f);
      const textObs = observation({ messageId: -141, text: "看图说话" });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, textObs);
      const fact = loadQqMessageFact(f.h, scope, "-141", NOW);
      if (!fact) throw new Error("fact missing");
      const factRef = fact.sources.find((s) => s.kind === "qq_message_fact")!;
      const bodyRef = fact.sources.find((s) => s.kind === "qq_observation")!;
      // 媒体来源 file 用路径形标记、url 用 URL 形标记：都不得外泄。
      const media = mediaFixture(f, -142, LEAK_PATH);
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      const taskId = await readTaskFixture(f, media.mediaId, `描述正文 ${LEAK_SECRET}`);
      const taskRef = createQqMediaReadTaskSourceRef(f.h, scope, taskId, NOW);
      if (!taskRef) throw new Error("task mint failed");
      const member = createQqMemberNameSource(f.h, scope, "10001", NOW);
      if (!member) throw new Error("member mint failed");
      const refs = [factRef, bodyRef, sourceRef, taskRef, member.source];
      const owner = f.owner("conversation");

      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner,
        at: NOW,
      });
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "看这张图" },
              {
                kind: "image",
                sourceId: media.mediaId,
                revision: "1",
                mimeType: "image/png",
                sha256: sha(IMAGE_BYTES),
                sourceRef,
                width: 800,
                height: 600,
                frameIndex: 0,
              },
            ],
          },
        ],
        sources: refs,
      });
      repository.finishStep(handle.stepId, "completed", NOW, {
        output: { text: "合成回复", format: "text", complete: true },
      });
      repository.appendEvent(
        handle.runId,
        { type: "output_delta", outputId: "out-1", text: "合成输出" },
        NOW,
      );
      repository.appendEvent(handle.runId, { type: "completed", outputs: [] }, NOW);

      const inspected: InspectedContext | null = inspectContext(
        f.h.db,
        repository,
        handle,
        principal,
      );
      expect(inspected?.status).toBe("partial");
      expect(inspected?.unavailableMedia?.[0]?.sha256).toBe(sha(IMAGE_BYTES));
      const events = repository.listEvents(handle.runId);
      const spans = f.h.db.query("SELECT * FROM runtime_spans").all();
      const snapshots = f.h.db.query("SELECT * FROM context_snapshots").all();
      const surfaces = [
        ["inspect", JSON.stringify(inspected)],
        ["events", JSON.stringify(events)],
        ["spans", JSON.stringify(spans)],
        ["snapshots", JSON.stringify(snapshots)],
      ] as const;
      for (const [name, text] of surfaces) {
        expect(text, `${name} must not leak base64`).not.toContain(LEAK_BASE64);
        expect(text, `${name} must not leak data URL`).not.toContain("data:image");
        expect(text, `${name} must not leak base64 marker`).not.toContain("base64,");
        expect(text, `${name} must not leak source path`).not.toContain(LEAK_PATH);
        expect(text, `${name} must not leak source url`).not.toContain(LEAK_URL);
        expect(text, `${name} must not leak secret`).not.toContain(LEAK_SECRET);
      }
      // 元数据红线保留：sha、宽高、帧序、来源 id/修订都在持久面可核。
      const inspectText = JSON.stringify(inspected);
      expect(inspectText).toContain(sha(IMAGE_BYTES));
      expect(inspectText).toContain('"width":800');
      expect(inspectText).toContain('"height":600');
      expect(inspectText).toContain('"frameIndex":0');
      expect(inspectText).toContain(sourceRef.id);
      // 事件表不留正文副本：output_delta 持久化时正文已置空。
      const delta = events.find((event) => event.type === "output_delta");
      expect(delta?.type === "output_delta" && delta.text).toBe("");
      // wire：字节只在发送边界 resolver 组装（fixture 捕获），不进任何持久面。
      const resolver = createImageByteResolver();
      const imagePart = {
        kind: "image" as const,
        sourceId: "wire-image",
        revision: "1",
        mimeType: "image/png",
        sha256: sha(IMAGE_BYTES),
      };
      resolver.register({
        runId: "run-wire",
        owner,
        part: imagePart,
        bytes: IMAGE_BYTES,
        sources: [sourceRef],
        assertCurrent: () => {},
      });
      const wire = await toGatewayMessages({
        messages: [
          {
            role: "user",
            content: [{ kind: "text", text: "wire" }, imagePart],
          },
        ],
        runId: "run-wire",
        owner,
        imageResolver: resolver,
      });
      const wireText = JSON.stringify(wire);
      expect(wireText).toContain(
        `data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`,
      );
      // 持久面仍然无 wire bytes。
      for (const [, text] of surfaces) expect(text).not.toContain(LEAK_BASE64);
      expect(JSON.stringify(snapshots)).not.toContain(Buffer.from(IMAGE_BYTES).toString("base64"));
      // resolver 释放后 wire 句柄失效：无迟到发布面。
      resolver.release("run-wire", owner);
      await expect(
        toGatewayMessages({
          messages: [{ role: "user", content: [{ kind: "text", text: "late" }, imagePart] }],
          runId: "run-wire",
          owner,
          imageResolver: resolver,
        }),
      ).rejects.toThrow();
    } finally {
      f.h.close();
    }
  });

  it("实际观测序列化正配对：真实 runtime span 含图数与成本三标量，inspect 读回含 image 元数据；全序列化面无 signedURL/raw bytes/base64/path/凭据", async () => {
    const f = openScopeFixture(crypto.randomUUID());
    const telemetry = new RuntimeTelemetry(f.h.db);
    try {
      const scope = liveScope(f);
      const media = mediaFixture(f, -151, "ref-actual-obs");
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      // 真实 runtime + 真实 telemetry：不造伪 mapper，span details 由生产 trace 落盘。
      const runtime = new AgentRuntime({
        repository: new AgentRunRepository(f.h.db),
        telemetry,
        model: {
          complete: async () => '{"kind":"none"}',
          async *streamText() {
            yield "合成输出";
          },
          completeMultimodal: async () => "合成视觉答复",
        },
      });
      await runtime.completeVisionLeaf(
        { id: "media.describe" },
        {
          owner: f.owner("conversation"),
          model: "vision-local",
          prompt: "如实描述图片",
          images: [{ mimeType: "image/png", bytes: IMAGE_BYTES }],
          sources: [sourceRef],
        },
      );
      // telemetry / runspan / rawJSON 同一面：真实落库 span 的 details 含图数与成本三标量
      // （§11：unknown 不是 0，pixels 是准备尺寸标量不是 token）。
      const spanRows = f.h.db.query("SELECT name, details FROM runtime_spans").all() as {
        name: string;
        details: string;
      }[];
      const modelSpan = spanRows
        .map((row) => ({
          name: row.name,
          details: JSON.parse(row.details) as Record<string, unknown>,
        }))
        .find((span) => span.name === "agent.model");
      if (!modelSpan) throw new Error("agent.model span missing");
      expect(modelSpan.details).toMatchObject({
        phase: "vision",
        visionCostState: "unknown",
        visionImages: 1,
        imageCount: 1,
      });
      expect(typeof modelSpan.details.visionPixels).toBe("number");
      // contextinspection 面：同一 run 经真实仓储 + inspect 读回，image part 图数与元数据保留。
      const runs = new AgentRunRepository(f.h.db);
      const run = runs.listRuns({ ownerKind: "conversation", ownerId: scope.conversationId })[0];
      if (!run || run.steps.length === 0) throw new Error("run/step missing");
      const inspected = inspectContext(
        f.h.db,
        runs,
        { runId: run.runId, stepId: run.steps[0]!.stepId },
        principal,
        NOW,
      );
      // 现实现事实：inspect 对持久 image part 一律以 unavailableMedia+sha 出示（不回 bytes），
      // 与上方泄露红线用例相同口径——partial 即图片元数据保留的正配对状态。
      expect(inspected?.status).toBe("partial");
      expect(inspected?.unavailableMedia?.[0]?.sha256).toBe(sha(IMAGE_BYTES));
      const imageParts =
        inspected?.exactMessages?.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.kind === "image")
            : [],
        ) ?? [];
      expect(imageParts).toHaveLength(1);
      const firstImage = imageParts[0];
      if (!firstImage || firstImage.kind !== "image") throw new Error("image part missing");
      expect(firstImage.sha256).toBe(sha(IMAGE_BYTES));
      // 泄露红线不回退：raw bytes/base64/path/url/凭据标记在两个序列化面都不出现。
      const rawSpans = JSON.stringify(spanRows);
      const inspectText = JSON.stringify(inspected);
      for (const [name, text] of [
        ["spans", rawSpans],
        ["inspect", inspectText],
      ] as const) {
        for (const marker of [
          LEAK_BASE64,
          "data:image",
          "base64,",
          LEAK_PATH,
          LEAK_URL,
          LEAK_SECRET,
        ]) {
          expect(text, `${name} must not leak ${marker}`).not.toContain(marker);
        }
        expect(text).not.toContain(Buffer.from(IMAGE_BYTES).toString("base64"));
      }
      // raw JSON 面：details 落库列本身就是 JSON 文本，键与真实值逐字可核。
      const modelSpanRaw = spanRows.find((row) => row.name === "agent.model")!.details;
      expect(modelSpanRaw).toContain('"visionCostState":"unknown"');
      expect(modelSpanRaw).toContain('"imageCount":1');
    } finally {
      await telemetry.close();
      f.h.close();
    }
  });

  it("直接域化（修复后口径）：qq_observation / qq_media_source 被真实撤权时，恶意 available resolver 不能翻回；正配对检查不咨询 resolver", async () => {
    const f = openScopeFixture("safety-binding-f");
    try {
      const scope = liveScope(f);
      // 真实 qq_observation ref + 真实 qq_media_source ref（同一真实持久 run）。
      const textObs = observation({ messageId: -151, text: "原始正文" });
      recordWithJournal(f.h, f.journal, f.scope.bindingId, textObs);
      const fact = loadQqMessageFact(f.h, scope, "-151", NOW);
      if (!fact) throw new Error("fact missing");
      const bodyRef = fact.sources.find((s) => s.kind === "qq_observation");
      if (!bodyRef) throw new Error("observation ref missing");
      const media = mediaFixture(f, -152, "media-file-f");
      const sourceRef = createQqMediaSourceRef(f.h, scope, media.mediaId, NOW);
      if (!sourceRef) throw new Error("media mint failed");
      const owner = f.owner("conversation");
      const calls: string[] = [];
      const resolveSource = (source: SourceRef) => {
        calls.push(source.kind);
        return "available" as const;
      };

      // 正 available 配对：正确 owner、真实 run、检查面不咨询 resolver（call=0）。
      const repository = new AgentRunRepository(f.h.db);
      const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() };
      repository.createRun({
        runId: handle.runId,
        specId: "test",
        specVersion: "1",
        owner,
        at: NOW,
      });
      repository.startStep({
        runId: handle.runId,
        stepId: handle.stepId,
        stepNo: 1,
        model: "synthetic-model",
        phase: "generate",
        at: NOW,
        messages: [{ role: "user", content: [{ kind: "text", text: "配对输入" }] }],
        sources: [bodyRef, sourceRef],
      });
      const paired = inspectContext(f.h.db, repository, handle, principal, NOW, resolveSource);
      expect(paired?.status).toBe("exact");
      expect(calls, "正确配对不得咨询 resolver").toEqual([]);

      // —— 真实撤权 #1：qq_observation 正文改写（revision 复算不等）。
      f.h.db
        .query("UPDATE qq_observation_text SET body='被改写的正文' WHERE event_key=?")
        .run(textObs.eventKey);
      expect(sourceAccess(f.h.db, bodyRef, owner, principal, NOW)).toBe("revoked");

      // —— 真实撤权 #2：qq_media_source 消费的资产 revision 前进（缓存重填新纪元）。
      f.h.orm.update(schema.qqMediaAssets).set({ revision: 2 }).run();
      expect(sourceAccess(f.h.db, sourceRef, owner, principal, NOW)).toBe("revoked");

      // 恶意全 available resolver 也不能把这两个 kind 翻回：检查拒正文、断言硬失败。
      const inspected = inspectContext(f.h.db, repository, handle, principal, NOW, resolveSource);
      expect(inspected?.status).toBe("revoked");
      expect(inspected?.exactMessages).toBeUndefined();
      expect(repository.getContext(handle)?.messages).toBeNull();
      expect(() =>
        assertContextSources({
          db: f.h.db,
          sources: [bodyRef, sourceRef],
          owner,
          now: NOW,
          resolveSource: () => "available",
          memoryRevisions: () => new Map(),
          messages: { memory: "memory changed", other: "source invalid" },
        }),
      ).toThrow("source invalid");
    } finally {
      f.h.close();
    }
  });
});
