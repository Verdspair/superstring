// 判断调用看到的记忆与资料（用户 2026-09-25，ADR0018 §6.1）。
//
// 这两段此前在 QQ 侧**根本不存在**：网页的读链分别绑在 web 会话与 web 轮次上。这一段钉的是
// 它们接进来的三条纪律：读范围来自绑定（不是网页会话）、知识库按助手授权、取不到就不注入
// （绝不因此不判断），以及"资料永远是 user 段"。

import { describe, expect, it } from "bun:test";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  type QqBinding,
  qqConversationKey,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { qqJudgementMaterial } from "../../src/server/services/qq-judgement-material";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;
const peerId = "30003";

function setup(options: { shareWebMemory?: boolean } = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: { direct_reply: false, follow_up: false, chiming_in: true, idle_topic: true },
    prompts: QQ_PROMPT_DEFAULTS,
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: options.shareWebMemory ? 1 : 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  event(h.orm, "old", now - 90, "旧消息");
  event(h.orm, "latest", now - 40, "今天降温了，空调还开吗");
  return h;
}

function event(orm: Orm, key: string, at: number, text: string) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: key,
      body: text,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}

/** A QQ-scope memory backed by an observation, which is the only kind a QQ read may use. */
function seedMemory(orm: Orm, id: string, body: string) {
  const scopeKey = qqMemoryScopeKey({
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId,
    agentId,
  });
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId,
      userId: DEFAULT_USER_ID,
      name: `记忆 ${id}`,
      summary: "简介",
      tags: JSON.stringify(["t"]),
      kinds: JSON.stringify(["episodic"]),
      body,
      scope: "reality_user",
      scopeKey,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqMemorySources)
    .values({
      memoryId: id,
      eventKey: "latest",
      scopeKey,
      conversationKey: qqConversationKey({ accountId: "10001", kind: "group", peerId }),
      messageId: "latest",
      occurredAtSeconds: now - 40,
      speakerKind: "member",
      speakerId: "20002",
    })
    .run();
}

function knowledge(h: ReturnType<typeof setup>, text: string, grant = true) {
  const repo = new KnowledgeRepository(h.db);
  const doc = repo.importDocument({
    name: "设备规程",
    category_id: "default",
    original_text: text,
  });
  if (grant) repo.replaceGrants(doc.id, doc.revision, [agentId]);
  return doc;
}

const request = () => ({ bindingId, path: "chiming_in", nowSeconds: now });

/** 0037：判断是按人各一份提示词的，这里看的是**第一份**（本文件里只有一个发言人在说话）。 */
function prompt(result: ReturnType<typeof prepareQqJudgement>) {
  if (result.kind !== "prepared") throw new Error(`blocked: ${result.reason}`);
  const first = result.judgementPrompts[0];
  if (first === undefined) throw new Error("no judgement prompt");
  return {
    system: first.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n"),
    user: first.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
  };
}

describe("the judgement call can see memory and reference material", () => {
  it("reads the conversation's own memory and the assistant's knowledge, as user data", () => {
    const h = setup();
    try {
      seedMemory(h.orm, "memory-1", "这位群友住在北方，冬天怕冷。");
      knowledge(h, "低于10°C时禁止启动空调。");
      const { system, user } = prompt(prepareQqJudgement(h.orm, request()));
      expect(user).toContain("这位群友住在北方");
      expect(user).toContain("低于10°C时禁止启动空调");
      // §6.1: material never becomes system authority, whatever it contains.
      expect(system).not.toContain("这位群友住在北方");
      expect(system).not.toContain("低于10°C时禁止启动空调");
      // The sections are labelled so the model knows what it is reading.
      expect(user).toContain("你记得的事");
      expect(user).toContain("参考资料");
    } finally {
      h.close();
    }
  });

  it("injects nothing when there is nothing to read, and still prepares", () => {
    const h = setup();
    try {
      const { user } = prompt(prepareQqJudgement(h.orm, request()));
      expect(user).not.toContain("你记得的事");
      expect(user).not.toContain("参考资料");
    } finally {
      h.close();
    }
  });

  it("reads no knowledge that the assistant is not granted", () => {
    const h = setup();
    try {
      knowledge(h, "低于10°C时禁止启动空调。", false);
      const { user } = prompt(prepareQqJudgement(h.orm, request()));
      expect(user).not.toContain("低于10°C时禁止启动空调");
    } finally {
      h.close();
    }
  });

  it("keeps a conversation's memory out of another conversation's judgement", () => {
    const h = setup();
    try {
      seedMemory(h.orm, "memory-1", "这位群友住在北方，冬天怕冷。");
      const schemeId = h.orm.select({ id: schema.qqSchemes.id }).from(schema.qqSchemes).get()?.id;
      const other = "33333333-3333-4333-8333-333333333333";
      h.orm
        .insert(schema.qqBindings)
        .values({
          id: other,
          accountId: "10001",
          conversationKind: "group",
          // A different group: the memory's scope key names peer 30003, so this read must match
          // nothing — the read scope comes from the binding, not from the assistant.
          peerId: "40004",
          agentId,
          schemeId: schemeId ?? "",
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
      // That group has to have a member message of its own, or the turn never reaches the read
      // stages at all and the assertion would prove nothing.
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "other-latest",
          accountId: "10001",
          conversationKind: "group",
          peerId: "40004",
          agentId,
          messageId: "other-latest",
          occurredAtSeconds: now - 40,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      const result = prepareQqJudgement(h.orm, {
        bindingId: other,
        path: "chiming_in",
        nowSeconds: now,
      });
      expect(result.kind).toBe("prepared");
      expect(prompt(result).user).not.toContain("这位群友住在北方");
    } finally {
      h.close();
    }
  });

  it("skips memory when the read scope cannot be resolved", () => {
    const h = setup();
    try {
      seedMemory(h.orm, "memory-1", "这位群友住在北方，冬天怕冷。");
      const stored = readQqBinding(h.orm, bindingId);
      if (!stored) throw new Error("binding");
      // Sharing web memory requires the owner identity to match the binding's revision; with no
      // identity on record the read scope is denied. A denied scope must mean "no memory", not an
      // exception and certainly not "stop judging".
      const sharing: QqBinding = {
        ...stored,
        kind: "private",
        shareWebMemory: true,
        ownerIdentityRevision: 7,
      };
      expect(qqJudgementMaterial(h.orm, { binding: sharing, question: "今天降温了" })).toEqual([]);
    } finally {
      h.close();
    }
  });
});
