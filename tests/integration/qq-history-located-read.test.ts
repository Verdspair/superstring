// createBotConversationEvidence 的 locateHistory 小片（T05 接力）：宿主用平台消息 ID
// 定位本会话内一条已 journal 的入站消息，返回带 tagged `qq-message:<eventKey>` key 的
// Evidence，经 registerEvidence 种进运行、history.read 分页读原文。定位只走
// readQqMessageFactsByPlatformMessageId 的 SQL 范围过滤（不复制权限 SQL）；候选 0 或
// 多条、跨 scope、封闭/变权/取消/正文或事实到期/正文改写/删除/跨 run 伪造 ref 一律拒。
// Tagged loader 语义（null 语义、原文字面、来源复验）由 qq-history-raw-body.test.ts
// 已验；本文件只证 locate→seed→read 的接线。
import type { SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  type ActionContext,
  createEvidenceActionSet,
  type EvidenceQueryModule,
} from "../../src/server/agent/built-in-actions";
import { sourceAccess } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqBinding, saveQqBinding } from "../../src/server/db/qq-binding-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID as AGENT,
  ensureDefaults,
  DEFAULT_USER_ID as USER,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  conversationEvidenceSourceAccess,
  createBotConversationEvidence,
} from "../../src/server/modules/conversation-evidence";
import { createAgent } from "../../src/server/services/agent-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { updateQqBinding } from "../../src/server/services/qq-binding-contract";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const at = "2026-10-02T00:00:00.000Z",
  later = "2026-10-03T00:00:00.000Z",
  epochSeconds = Math.floor(Date.parse(at) / 1000);
/** Real UUIDs: the binding contract parses its own rows, so these ids must be UUIDs. */
const scheme = "00000000-0000-4000-8000-0000000000a1",
  binding = "00000000-0000-4000-8000-0000000000b1",
  binding2 = "00000000-0000-4000-8000-0000000000b2";
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const exec = (sql: string, ...args: SQLQueryBindings[]) => h.db.query(sql).run(...args);
  exec(
    "INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES(?,?,?,?)",
    scheme,
    "scheme",
    at,
    at,
  );
  for (const [id, peer] of [
    [binding, "200"],
    [binding2, "999"],
  ])
    exec(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?, '100','group',?,?,?,?,?)",
      id,
      peer,
      AGENT,
      scheme,
      at,
      at,
    );
  const journal = new ConversationEventRepository(h.db);
  for (const id of [binding, binding2])
    if (!journal.ensureOneBot(id)) throw new Error("conversation missing");
  const owner = { kind: "qq_binding" as const, id: binding, userId: USER, agentId: AGENT };
  let clock = at;
  function assertSources(sources: readonly SourceRef[], sourceOwner: RunOwner = owner) {
    for (const s of sources)
      if (
        (conversationEvidenceSourceAccess(h, s, sourceOwner, clock) ??
          sourceAccess(h.db, s, sourceOwner, { userId: USER }, clock)) !== "available"
      )
        throw new Error("CONTEXT_SOURCE_INVALID");
  }
  function context(
    runId: string = crypto.randomUUID(),
    bindingId = binding,
    agentId = AGENT,
  ): ActionContext {
    return {
      owner: { ...owner, id: bindingId, agentId },
      runId,
      signal: new AbortController().signal,
    };
  }
  /** 真实换绑：契约产出新绑定、仓储 CAS 落库，助手与 authority 代次一起推进。 */
  function rebind(bindingId: string, agentId: string): void {
    const current = readQqBinding(h.orm, bindingId);
    if (!current) throw new Error("binding missing");
    const changed = updateQqBinding(current, { agentId }, current.revision);
    if (changed.kind !== "saved") throw new Error(`rebind refused: ${changed.kind}`);
    saveQqBinding(h.orm, { binding: changed.binding, expectedRevision: current.revision });
  }
  /** 生产链：recordObservation 真实落 facts+正文，journal ingest 进 timeline。 */
  function ingest(messageId: number, text: string | null, append = true, agentId = AGENT) {
    const result = normalizeOneBotMessage(
      {
        time: epochSeconds,
        self_id: 100,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: messageId,
        user_id: 300,
        group_id: 200,
        sender: { card: "阿林", nickname: "林某" },
        message: text === null ? [] : [{ type: "text", data: { text } }],
      },
      "100",
    );
    if (result.kind !== "message") throw new Error("message expected");
    recordObservation(h.orm, result.observation, agentId);
    if (append) journal.ingestOneBotEvent(result.observation.eventKey, binding);
    return { eventKey: result.observation.eventKey };
  }
  function factory(bindingId = binding, agentId = AGENT) {
    const row = h.db
      .query(
        `SELECT c.id,c.binding_epoch AS bindingEpoch,b.peer_id AS peerId,
        b.authority_revision AS authorityRevision
        FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
        WHERE c.source_id=? AND c.closed_at IS NULL`,
      )
      .get(bindingId) as {
      id: string;
      bindingEpoch: number;
      peerId: string;
      authorityRevision: number;
    } | null;
    if (!row) throw new Error("conversation missing");
    const ctx = context(undefined, bindingId, agentId);
    const scoped: RunOwner = { ...owner, id: bindingId, agentId };
    return {
      context: ctx,
      evidence: createBotConversationEvidence({
        db: h.db,
        orm: h.orm,
        agentId,
        conversationId: row.id,
        bindingId,
        bindingEpoch: row.bindingEpoch,
        authorityRevision: row.authorityRevision,
        scope: {
          kind: "qq" as const,
          accountId: "100",
          conversationKind: "group" as const,
          peerId: row.peerId,
          agentId,
        },
        summaryEnabled: false,
        assertCurrent() {},
        assertSources: (sources) => assertSources(sources, scoped),
        now: () => clock,
      }),
    };
  }
  function actionSet(
    module: EvidenceQueryModule,
    ctx: ActionContext,
    sourceOwner: RunOwner = owner,
  ) {
    const set = createEvidenceActionSet(
      { history: module },
      {
        assertSources: (sources) => assertSources(sources, sourceOwner),
        fit: async () => () => true,
      },
    );
    const action = set.actions.find((entry) => entry.description.name === "history.read");
    if (!action) throw new Error("history.read not advertised");
    return { set, action, ctx };
  }
  return {
    h,
    exec,
    ingest,
    journal,
    factory,
    actionSet,
    context,
    rebind,
    assertSources,
    owner,
    setClock: (v: string) => (clock = v),
  };
}

function readText(observation: unknown): string {
  const value = observation as { value?: { items?: { text?: string }[] } };
  const item = value.value?.items?.[0];
  if (typeof item?.text !== "string") throw new Error("no text page");
  return item.text;
}

describe("bot history locateHistory → seed → read", () => {
  it("locates by negative platform ID and reads the exact raw Unicode body without a query", async () => {
    const f = setup();
    const raw = "阿林 08:00:05\n🦄 第二行";
    const { eventKey } = f.ingest(-102, raw);
    const { evidence, context: ctx } = f.factory();
    const locate = evidence.locateHistory;
    const item = locate("-102", ctx);
    if (!item) throw new Error("locate returned null");
    // ref 形状：tagged key、可读、总长 ≤ 1024；lazy descriptor 不携带正文。
    const parsed = JSON.parse(item.id) as [Record<string, unknown>, string, string];
    expect(parsed[1]).toBe("history");
    expect(parsed[2]).toBe(`qq-message:${eventKey}`);
    expect(parsed[2].length).toBeLessThanOrEqual(1024);
    expect(item.text).toBe("");
    expect(item.preview?.title).toBe("引用消息原文");
    // 来源可复验：fact + observation + 自引用三类都在，before 全 available。
    const kinds = item.sources.map((s) => s.kind);
    expect(kinds).toContain("qq_message_fact");
    expect(kinds).toContain("qq_observation");
    expect(kinds).toContain("conversation_evidence");
    f.assertSources(item.sources);
    const self = item.sources.find((s) => s.kind === "conversation_evidence");
    if (!self) throw new Error("self ref missing");
    expect(conversationEvidenceSourceAccess(f.h, self, ctx.owner, at)).toBe("available");
    // 同一 locate 的 Evidence 经 registerEvidence 种入后直接 read——无需 query。
    const { set, action } = f.actionSet(evidence.history, ctx);
    const ref = set.registerEvidence("history", item, ctx);
    const page = await action.execute({ bodyRef: ref, offset: 0, limit: 4096 }, ctx);
    expect(page.value).toMatchObject({ status: "ok" });
    expect(readText(page)).toBe(raw);
    // 分页：Unicode 点偏移直达尾行。
    const cut = [...raw].indexOf("第");
    const tail = await action.execute({ bodyRef: ref, offset: cut, limit: 4096 }, ctx);
    expect(readText(tail)).toBe("第二行");
    // 同 evidence 再 seed：ref 不透明、各自独立；after 来源仍可复验。
    const ref2 = set.registerEvidence("history", item, ctx);
    expect(ref2).not.toBe(ref);
    f.assertSources(item.sources);
    expect(conversationEvidenceSourceAccess(f.h, self, ctx.owner, at)).toBe("available");
  });

  it("refuses: 0 or multiple candidates, wrong owner/peer, stale authority/epoch, closed", () => {
    const f = setup();
    f.ingest(-103, "本群可见");
    const { evidence, context: ctx } = f.factory();
    const locate = evidence.locateHistory;
    // 未知平台 ID → null（0 候选）。
    expect(locate("-999", ctx)).toBeNull();
    // 跨群消息：别 peer 的事实行不进入本 scope 的 SQL 范围 → null。
    f.ingest(-104, "别群的话", false);
    expect(locate("-104", ctx)).toBeNull();
    // 多候选：同 scope 下第二条同 messageId 的事实行 → ambiguity null。
    f.exec(
      "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('dup-key','100','group','200',?,'-103',100,'member','300',?)",
      AGENT,
      at,
    );
    f.exec(
      "INSERT INTO qq_message_facts(event_key,group_card,group_card_source,personal_nickname,personal_nickname_source,legacy_display_name,name_state,parts,reply_to_message_id,revision,expires_at,recorded_at) VALUES('dup-key',NULL,NULL,NULL,NULL,NULL,'unknown','[]',NULL,1,?,?)",
      later,
      at,
    );
    expect(locate("-103", ctx)).toBeNull();
    // 错 owner → guard 拒（CONTEXT_SOURCE_INVALID），不静默返回 null。
    expect(() => locate("-103", { ...ctx, owner: { ...ctx.owner, id: "other-binding" } })).toThrow(
      expect.objectContaining({ code: "CONTEXT_SOURCE_INVALID" }),
    );
    // abort → 原 reason 穿透（不换成 CONTEXT_*、不吞成 null）。
    const controller = new AbortController();
    const reason = new Error("caller-abort");
    controller.abort(reason);
    try {
      locate("-103", { ...ctx, signal: controller.signal });
      throw new Error("expected abort");
    } catch (error) {
      expect(error).toBe(reason);
    }
    // 另一真实 scope（binding2/peer 999）：本群消息在它的 SQL 范围内不可见 → null。
    const foreign = f.factory(binding2);
    expect(foreign.evidence.locateHistory("-103", foreign.context)).toBeNull();
    // 换绑（authority 推进）→ guard 拒；恢复后封闭会话 → 仍拒。
    f.exec("UPDATE qq_bindings SET revision=2,authority_revision=2 WHERE id=?", binding);
    expect(() => locate("-103", ctx)).toThrow(
      expect.objectContaining({ code: "CONTEXT_SOURCE_INVALID" }),
    );
    f.exec("UPDATE qq_bindings SET revision=1,authority_revision=1 WHERE id=?", binding);
    f.exec("UPDATE conversations SET closed_at=? WHERE source_id=?", at, binding);
    expect(() => locate("-103", ctx)).toThrow(
      expect.objectContaining({ code: "CONTEXT_SOURCE_INVALID" }),
    );
    // epoch 推进 → guard 拒。
    f.exec(
      "UPDATE conversations SET closed_at=NULL,binding_epoch=binding_epoch+1 WHERE source_id=?",
      binding,
    );
    expect(() => locate("-103", ctx)).toThrow(
      expect.objectContaining({ code: "CONTEXT_SOURCE_INVALID" }),
    );
  });

  it("rejects: body/fact expiry, body rewrite, deletion, cross-run forged refs", async () => {
    const f = setup();
    const { eventKey } = f.ingest(-105, "原句");
    const { evidence, context: ctx } = f.factory();
    const locate = evidence.locateHistory;
    const item = locate("-105", ctx);
    if (!item) throw new Error("item");
    const { set, action } = f.actionSet(evidence.history, ctx);
    const ref = set.registerEvidence("history", item, ctx);
    expect(readText(await action.execute({ bodyRef: ref, offset: 0, limit: 4096 }, ctx))).toBe(
      "原句",
    );
    // 正文到期 → 复验拒、定位 null、旧 ref 读取拒。
    f.exec("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?", at, eventKey);
    expect(() => f.assertSources(item.sources)).toThrow(/CONTEXT_SOURCE_INVALID/);
    expect(locate("-105", ctx)).toBeNull();
    await expect(action.execute({ bodyRef: ref, offset: 0, limit: 4096 }, ctx)).rejects.toThrow(
      /CONTEXT_SOURCE_INVALID/,
    );
    // 恢复 → 又可定位（无缓存复活：定位实时过 loader）。
    f.exec("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?", later, eventKey);
    expect(locate("-105", ctx)).not.toBeNull();
    // 事实到期 → 定位 null。
    f.exec("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?", at, eventKey);
    expect(locate("-105", ctx)).toBeNull();
    f.exec("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?", later, eventKey);
    // 正文改写 → 定位 null、旧来源复验拒。
    f.exec("UPDATE qq_observation_text SET body='改写后的句子' WHERE event_key=?", eventKey);
    expect(locate("-105", ctx)).toBeNull();
    expect(() => f.assertSources(item.sources)).toThrow(/CONTEXT_SOURCE_INVALID/);
    f.exec("UPDATE qq_observation_text SET body='原句' WHERE event_key=?", eventKey);
    // 删除正文行 → null；删除事实行 → null。
    f.exec("DELETE FROM qq_observation_text WHERE event_key=?", eventKey);
    expect(locate("-105", ctx)).toBeNull();
    f.exec("DELETE FROM qq_message_facts WHERE event_key=?", eventKey);
    expect(locate("-105", ctx)).toBeNull();
    // 未 journal 的事件：facts 存在、不在 timeline → null（tagged loader 的 inTimeline）。
    f.ingest(-107, "只有事实没有journal", false);
    expect(locate("-107", ctx)).toBeNull();
    // 跨 run 伪造：run A 种下的 ref 不能被 run B 重放；forged ref 同样拒。
    f.ingest(-106, "重建一句");
    const item2 = locate("-106", ctx);
    if (!item2) throw new Error("item2");
    const ref2 = set.registerEvidence("history", item2, ctx);
    const otherRun = f.context("other-run");
    await expect(
      action.execute({ bodyRef: ref2, offset: 0, limit: 4096 }, otherRun),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    await expect(
      action.execute({ bodyRef: "forged-random-ref", offset: 0, limit: 4096 }, ctx),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    // 正例仍可读，证明拒因是 ref 而非数据。
    expect(readText(await action.execute({ bodyRef: ref2, offset: 0, limit: 4096 }, ctx))).toBe(
      "重建一句",
    );
  });

  it("isolates a rebound group: the old owner's ref dies with the epoch, the new one starts empty", async () => {
    const f = setup();
    f.ingest(-108, "旧助手时期的原句");
    const ownerA = f.factory();
    const item = ownerA.evidence.locateHistory("-108", ownerA.context);
    if (!item) throw new Error("locate returned null under A");
    const ownerASet = f.actionSet(ownerA.evidence.history, ownerA.context, ownerA.context.owner);
    const refA = ownerASet.set.registerEvidence("history", item, ownerA.context);
    // 正例：A 自己的轮内 seed→read 走得通，下面每条拒都因此是授权而不是数据。
    expect(
      readText(
        await ownerASet.action.execute({ bodyRef: refA, offset: 0, limit: 4096 }, ownerA.context),
      ),
    ).toBe("旧助手时期的原句");
    // 同一群换绑到真实新建的 B（契约 + 仓储 CAS，不动 epoch、不伪造 scope UUID）。
    const b = createAgent(
      f.h.orm,
      { name: "同群新助手", model_name: "model" },
      {
        core_identity: "",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      },
    );
    const activatedB0 = f.h.db
      .query(
        "SELECT id,binding_epoch AS bindingEpoch FROM conversations WHERE source_id=? AND closed_at IS NULL",
      )
      .get(binding) as { id: string; bindingEpoch: number } | null;
    if (!activatedB0) throw new Error("pre-rebind conversation missing");
    f.rebind(binding, b.id);
    const bindingB = f.h.db
      .query("SELECT authority_revision AS authorityRevision FROM qq_bindings WHERE id=?")
      .get(binding) as { authorityRevision: number };
    expect(bindingB.authorityRevision).toBeGreaterThan(1);
    // A 的授权入口整条关掉：同群、同 epoch、只换 owner，旧的 conversation/observation/fact
    // 三类来源全部复验失败，永久 ref 也不能再取正文。
    expect(() => f.assertSources(item.sources, ownerA.context.owner)).toThrow(
      /CONTEXT_SOURCE_INVALID/,
    );
    await expect(
      ownerASet.action.execute({ bodyRef: refA, offset: 0, limit: 4096 }, ownerA.context),
    ).rejects.toThrow(/CONTEXT_SOURCE_INVALID/);
    // B 首次激活仿真实 beforeRecord 流程：先 ensureOneBot 再 record（不手改 epoch/水位）。
    f.journal.ensureOneBot(binding);
    const activated = f.journal.ingestOneBotEvent(
      f.ingest(-110, "激活期的入站", true, b.id).eventKey,
      binding,
    );
    if (!activated || typeof activated.conversationId !== "string")
      throw new Error("activation ingest failed");
    expect(activated.conversationId).not.toBe(activatedB0.id);
    const oldRow = f.journal.row(activatedB0.id);
    if (!oldRow) throw new Error("old conversation missing");
    expect(oldRow.closed_at).not.toBeNull();
    const newRow = f.journal.row(activated.conversationId);
    if (!newRow) throw new Error("new conversation missing");
    expect(newRow.agent_id).toBe(b.id);
    expect(newRow.binding_epoch).toBeGreaterThan(activatedB0.bindingEpoch);
    const ownerB = f.factory(binding, b.id);
    // B 不能借 A 的永久 event/facts 正文：同一条历史消息在 B 的授权入口下不可定位。
    expect(ownerB.evidence.locateHistory("-108", ownerB.context)).toBeNull();
    // A 的旧轮次 ref 也不能被 B 的轮次重放（跨 run/跨 owner 双重隔离）。
    const ownerBSet = f.actionSet(ownerB.evidence.history, ownerB.context, ownerB.context.owner);
    await expect(
      ownerBSet.action.execute({ bodyRef: refA, offset: 0, limit: 4096 }, ownerB.context),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    // B 的新纪元下新发的消息可正常 seed→read：拒因是旧 owner，不是新 scope 全失效。
    const fresh = f.ingest(-109, "新助手时期的新句", true, b.id);
    const freshItem = ownerB.evidence.locateHistory("-109", ownerB.context);
    if (!freshItem) throw new Error("locate returned null under B");
    const refB = ownerBSet.set.registerEvidence("history", freshItem, ownerB.context);
    expect(
      readText(
        await ownerBSet.action.execute({ bodyRef: refB, offset: 0, limit: 4096 }, ownerB.context),
      ),
    ).toBe("新助手时期的新句");
    expect(JSON.parse(freshItem.id)[2]).toBe(`qq-message:${fresh.eventKey}`);
  });
});
