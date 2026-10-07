// 触发器互斥的读写边界、批量节奏字段的本群覆盖、自主观察边界的持久与单调：
// 全部走真实迁移库与真实仓储入口，不手造 schema。

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  insertQqBinding,
  readQqBinding,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { createQqScheme, effectiveQqTriggers } from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, nowIso } from "../../src/server/db/repositories";
import { AppError } from "../../src/server/errors";
import { createQqBinding, updateQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { resolveQqInteractionPair } from "../../src/shared/contracts/qq-group-config";
import { cloneBusinessDb } from "../harness/business-db";

const handles: BusinessDbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  return business;
}

function rhythm(x: number, y: number) {
  return {
    ...QQ_RHYTHM_DEFAULT,
    initiative_batch_target_count: x,
    initiative_batch_jitter_count: y,
  };
}

function groupBinding(h: BusinessDbHandle, schemeId: string, peerId: string) {
  const id = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group',?,?,?,?,?)",
    )
    .run(id, peerId, DEFAULT_AGENT_ID, schemeId, nowIso(), nowIso());
  return id;
}

/** 历史存量夹具：绕过保存边界直接写库，只有读侧解释它。 */
function legacyBothTrueBinding(h: BusinessDbHandle, schemeId: string, peerId: string) {
  const id = crypto.randomUUID();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,trigger_follow_up,trigger_chiming_in,created_at,updated_at) VALUES(?,'10001','group',?,?,?,1,1,?,?)",
    )
    .run(id, peerId, DEFAULT_AGENT_ID, schemeId, nowIso(), nowIso());
  return id;
}

function saveOverrides(h: BusinessDbHandle, bindingId: string, overrides: Record<string, unknown>) {
  const config = readQqGroupConfig(h.orm, bindingId);
  const scheme = h.db
    .query("SELECT scheme_id,revision FROM qq_bindings WHERE id=?")
    .get(bindingId) as { scheme_id: string; revision: number };
  const schemeRow = h.db
    .query("SELECT revision FROM qq_schemes WHERE id=?")
    .get(scheme.scheme_id) as { revision: number };
  return updateQqGroupConfig(h.orm, {
    bindingId,
    payload: {
      agent_id: DEFAULT_AGENT_ID,
      expected_binding_revision: config.binding.revision,
      expected_scheme_revision: schemeRow.revision,
      expected_revision: config.revision,
      overrides,
      disabled_capabilities: [],
    },
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("expected the save to be rejected");
}

describe("触发器互斥：旧双真读侧解释与新写入拒绝", () => {
  it("存量双真读作自主优先（continuous 不生效），成对解析不报错不改写", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "旧双真方案" });
    const bindingId = legacyBothTrueBinding(h, scheme.id, "20010");
    const binding = readQqBinding(h.orm, bindingId);
    if (binding === null) throw new Error("legacy binding fixture missing");
    const triggers = effectiveQqTriggers(binding, scheme);
    // 历史存量按自主优先解释，不要求用户先改配置。
    expect(triggers.chiming_in).toBe(true);
    expect(triggers.follow_up).toBe(false);
    const pair = resolveQqInteractionPair({
      scheme: { follow_up: true, chiming_in: true },
      binding: { follow_up: true, chiming_in: true },
    });
    expect(pair).toEqual({ continuous: false, chimingIn: true });
  });

  it("新显式写入双真被保存边界拒绝；partial true+null 继承组合出双真同样拒绝", () => {
    const h = setup();
    const base = createQqScheme(h.orm, { name: "互斥方案" });
    const id1 = groupBinding(h, base.id, "20011");
    expect(
      codeOf(() => saveOverrides(h, id1, { triggers: { follow_up: true, chiming_in: true } })),
    ).toBe("MEMORY_SOURCE_INVALID");
    // 基础方案 continuous 开、本群只写 chiming_in=true（follow_up 走 null 跟随）→ 生效双真。
    const followUpScheme = createQqScheme(h.orm, {
      name: "连续开启方案",
      triggers: { direct_reply: true, follow_up: true, chiming_in: false, idle_topic: true },
    });
    const id2 = groupBinding(h, followUpScheme.id, "20012");
    expect(codeOf(() => saveOverrides(h, id2, { triggers: { chiming_in: true } }))).toBe(
      "MEMORY_SOURCE_INVALID",
    );
  });

  it("a legacy double-true row keeps its raw columns through an unrelated binding save", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "legacy raw preservation" });
    const legacyId = legacyBothTrueBinding(h, scheme.id, "20013");
    const before = readQqBinding(h.orm, legacyId);
    if (before === null) throw new Error("legacy binding fixture missing");

    // Triggers are not touched, so the stored columns must survive as they are.
    const patchStep = updateQqBinding(before, { paused: true }, before.revision);
    if (patchStep.kind !== "saved") throw new Error("unrelated patch rejected");
    const saved = saveQqBinding(h.orm, {
      binding: patchStep.binding,
      expectedRevision: before.revision,
    });
    expect(saved.paused).toBe(true);
    const rawRow = h.db
      .query("SELECT trigger_follow_up AS f, trigger_chiming_in AS c FROM qq_bindings WHERE id=?")
      .get(legacyId) as { f: number; c: number };
    expect(rawRow).toEqual({ f: 1, c: 1 });
  });

  it("an explicit double-true write through the binding save entry is rejected", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "binding pair rejection" });
    const fresh = createQqBinding({
      id: crypto.randomUUID(),
      accountId: "10001",
      kind: "group",
      peerId: "20013",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      paused: false,
      shareWebMemory: false,
    });
    if (fresh.kind !== "saved") throw new Error("binding seed rejected");
    const inserted = insertQqBinding(h.orm, fresh.binding);
    // 合同合并边界同步拒绝显式双 true 补丁（TypeError），不等到保存边界才报。
    expect(() =>
      updateQqBinding(
        inserted,
        { triggers: { direct_reply: null, follow_up: true, chiming_in: true, idle_topic: null } },
        inserted.revision,
      ),
    ).toThrow(TypeError);
  });
});

describe("批量节奏字段的本群覆盖", () => {
  it("base X10/Y3 + 本群只写 Y12 组合出 Y>=X，保存被拒绝", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, {
      name: "窄窗方案",
      rhythm: rhythm(10, 3),
    });
    const bindingId = groupBinding(h, scheme.id, "20020");
    expect(
      codeOf(() =>
        saveOverrides(h, bindingId, {
          rhythm: { initiative_batch_jitter_count: 12 },
        }),
      ),
    ).toBe("MEMORY_SOURCE_INVALID");
  });

  it("base X30 + 本群 Y20 合法保存，生效节奏为 30/20", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, {
      name: "宽窗方案",
      rhythm: rhythm(30, 5),
    });
    const bindingId = groupBinding(h, scheme.id, "20021");
    const saved = saveOverrides(h, bindingId, {
      rhythm: { initiative_batch_jitter_count: 20 },
    });
    expect(saved.effective_scheme.rhythm.initiative_batch_target_count).toBe(30);
    expect(saved.effective_scheme.rhythm.initiative_batch_jitter_count).toBe(20);
    expect(saved.effective_scheme.rhythm.initiative_queue_on_busy).toBe(true);
  });

  it("sparse 缺三字段不注入默认值：生效节奏跟基础方案，差异行不出现三个键", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, {
      name: "自定义节奏方案",
      rhythm: rhythm(12, 4),
    });
    const bindingId = groupBinding(h, scheme.id, "20022");
    const saved = saveOverrides(h, bindingId, {
      rhythm: { merge_window_seconds: 60 },
    });
    expect(saved.effective_scheme.rhythm.initiative_batch_target_count).toBe(12);
    expect(saved.effective_scheme.rhythm.initiative_batch_jitter_count).toBe(4);
    expect(saved.effective_scheme.rhythm.initiative_queue_on_busy).toBe(true);
    expect(saved.overrides.rhythm).toEqual({ merge_window_seconds: 60 });
  });
});

describe("自主观察边界（chiming_in_observed_seq）", () => {
  it("推进持久且单调（MAX），跨库重开保留；与 direct 的 consumed_seq 互不吞并", () => {
    const h = setup();
    const scheme = createQqScheme(h.orm, { name: "游标方案" });
    const bindingId = groupBinding(h, scheme.id, "20030");
    const journal = new ConversationEventRepository(h.db);
    const conversation = journal.ensureOneBot(bindingId);
    if (conversation === null) throw new Error("conversation fixture missing");

    const ev = (key: string) =>
      journal.append({
        conversationId: conversation.id,
        eventKey: key,
        kind: "inbound",
        source: { kind: "qq_observation", id: key, revision: "1" },
        occurredAt: nowIso(),
        participant: { id: "20030", label: "群友", role: "member" },
      });
    const e1 = ev("t-cursor-1");
    const e2 = ev("t-cursor-2");

    journal.advanceChimingInObservedSeq(conversation.id, e1.seq);
    // 旧 seq 不回退。
    journal.advanceChimingInObservedSeq(conversation.id, 1);
    expect(journal.chimingInObservedSeq(conversation.id)).toBe(e1.seq);

    // direct 路径推进 consumed_seq，不动自主边界。
    journal.acknowledge(conversation.id, e2.seq);
    expect(journal.chimingInObservedSeq(conversation.id)).toBe(e1.seq);

    // 单调推进到 e2 后再重开库：两个边界都持久。
    journal.advanceChimingInObservedSeq(conversation.id, e2.seq);
    const image = h.db.serialize();
    h.close();
    handles.splice(handles.indexOf(h), 1);
    const db2 = Database.deserialize(image);
    db2.run("PRAGMA foreign_keys = ON");
    const reopened = toOrmHandle(db2);
    handles.push(reopened);
    const journal2 = new ConversationEventRepository(db2);
    expect(journal2.chimingInObservedSeq(conversation.id)).toBe(e2.seq);
  });
});
