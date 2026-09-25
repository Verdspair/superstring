import { describe, expect, it } from "bun:test";
import {
  attemptedUnreadMediaCount,
  recordMediaAttempt,
  recordMediaNote,
  recordMediaSegment,
} from "../../src/server/db/qq-media-repository";
import {
  createQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import {
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_PROMPT_DEFAULTS,
} from "../../src/server/services/qq-prompt-contract";
import {
  QQ_REVIEW_RESPONSE_SCHEMA,
  qqReviewVerdict,
} from "../../src/server/services/qq-review-contract";
import { runQqInitiativeCycle } from "../fixtures/legacy-qq/qq-initiative-cycle";
import { runQqJudgement } from "../fixtures/legacy-qq/qq-judgement-runner";
import { recomputeQqReply } from "../fixtures/legacy-qq/qq-recompute-runner";
import { generateQqTextReply } from "../fixtures/legacy-qq/qq-reply-runner";
import { pendingQqReview, reviewQqSupplement } from "../fixtures/legacy-qq/qq-review-runner";
import { checkQqTextPreflight } from "../fixtures/legacy-qq/qq-send-preflight";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

// The sticker stage's two seams, pinned to "no library copies": every expectation in this file is
// about the text path, so no sticker call may appear here (P4i). `counts` is explicit because U13
// has no default.
const noStickers = { counts: ["confirmed"] as const, isAvailable: () => false };
/** 0037：判断按人各一次，生成也按人各一次。本文件每个夹具只有一个发言人在说话，取第一个 opening。 */
function firstOpening(run: Awaited<ReturnType<typeof runQqJudgement>>) {
  if (run.kind !== "candidate") throw new Error(`not a candidate: ${run.kind}`);
  const opening = run.openings[0];
  if (opening === undefined) throw new Error("no opening");
  return opening;
}
const generateFirst = (
  orm: Orm,
  gateway: Parameters<typeof generateQqTextReply>[1],
  judgement: Parameters<typeof generateQqTextReply>[2],
  nowSeconds: number,
) => generateQqTextReply(orm, gateway, judgement, firstOpening(judgement), nowSeconds);
function setup(
  options: {
    enabled?: boolean;
    paused?: boolean;
    chiming?: boolean;
    nickname?: boolean;
    /** 0038: the QQ-global judgement model, unset = follow the assistant's conversation model. */
    judgementModel?: string;
  } = {},
) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: options.enabled ?? true,
    ...(options.judgementModel === undefined ? {} : { judgementModelName: options.judgementModel }),
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: {
      direct_reply: false,
      follow_up: false,
      chiming_in: options.chiming ?? true,
      idle_topic: true,
    },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      schemeId: scheme.id,
      paused: options.paused ? 1 : 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  event(h.orm, "old", now - 90, "旧消息");
  event(h.orm, "latest", now - 40, "新消息");
  if (options.nickname) {
    h.orm
      .insert(schema.qqMembers)
      .values({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        userId: "20002",
        nickname: "小明",
        firstSeenAtSeconds: now - 40,
        lastSeenAtSeconds: now - 40,
        expiresAt: new Date((now + 3600) * 1000).toISOString(),
      })
      .run();
  }
  return h;
}
function event(orm: Orm, key: string, at: number, text: string, speakerId = "20002") {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId,
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
const request = (path = "chiming_in", seconds = now) => ({
  bindingId,
  path,
  nowSeconds: seconds,
});
describe("offline QQ judgement preparation", () => {
  it("joins stored scheme, scoped context and nickname without invoking a model", () => {
    const h = setup({ nickname: true });
    try {
      const result = prepareQqJudgement(h.orm, request());
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") return;
      expect(result.selection.included).toBe(2);
      const first = result.judgementPrompts[0];
      expect(first?.messages).toHaveLength(2);
      expect(first?.messages[0]?.role).toBe("system");
      expect(first?.messages[0]?.content).toContain("自定义判断任务");
      expect(first?.messages[1]?.role).toBe("user");
      expect(first?.messages[1]?.content).toContain("小明(20002)");
      expect(first?.messages[1]?.content).toContain("新消息");
      expect(result.bindingRevision).toBe(1);
      // 未设置 QQ 全局判断模型时跟随绑定助手的对话模型（0038 之前的行为）。
      expect(result.modelName).toBe("synthetic-model");
    } finally {
      h.close();
    }
  });
  it("judges with the QQ-global model when one is chosen (0038)", () => {
    const h = setup({ judgementModel: "judge-model" });
    try {
      const result = prepareQqJudgement(h.orm, request());
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") return;
      // 判断模型是 QQ 全局的一份设置（用户 2026-09-25）：选了就用它，所有会话共用同一个；
      // 判断预备把它带给判断器，容量预检与真跑判断用的都是它。
      expect(result.modelName).toBe("judge-model");
    } finally {
      h.close();
    }
  });
  it("blocks when switch, binding pause or path switch is off", () => {
    for (const options of [{ enabled: false }, { paused: true }, { chiming: false }]) {
      const h = setup(options);
      try {
        const result = prepareQqJudgement(h.orm, request());
        expect(result).toEqual({
          kind: "blocked",
          reason:
            !options.enabled && options.enabled !== undefined
              ? "feature_off"
              : options.paused
                ? "conversation_paused"
                : "trigger_off",
        });
      } finally {
        h.close();
      }
    }
  });
  it("waits for the merge window and enforces the initiative cooldown", () => {
    const h = setup();
    try {
      expect(prepareQqJudgement(h.orm, request("chiming_in", now - 25))).toEqual({
        kind: "blocked",
        reason: "waiting_for_batch",
        readyAtSeconds: now - 10,
      });
      // 0037: 冷却要在自主接话里**真的**挡得住，就得比合并窗口长。理由是个算术事实：一个"值得回"
      // 的人必须是在她上次开口之后说过话（eligible）**并且**自己那一条已经过了合并窗口（ripe），
      // 于是 `他的消息 ≤ now − 合并窗口`；而冷却要求 `她的开口 > now − 冷却`。冷却 ≤ 合并窗口时这两条
      // 不可能同时成立——所以默认的 10 秒冷却在这条路径上永远不会单独生效（它被合并窗口盖住了）。
      // 这里把冷却调到 600 秒，场景就是"她刚回过、有人又说了话、她还在冷却里"。
      const row = h.orm.select().from(schema.qqSchemes).all()[0];
      if (!row) throw new Error("synthetic scheme missing");
      updateQqScheme(h.orm, row.id, {
        name: "synthetic",
        rhythm: { ...schemeRhythm(row), reply_cooldown_seconds: 600 },
        expectedRevision: row.revision,
      });
      h.orm
        .insert(schema.qqSpeechLog)
        .values({
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          kind: "direct_reply",
          spokeAtSeconds: now - 60,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "cooling_down",
        readyAtSeconds: now + 540,
      });
    } finally {
      h.close();
    }
  });
  it("does not repeat an unanswered initiative even when its cooldown elapsed", () => {
    const h = setup();
    try {
      h.orm
        .insert(schema.qqSpeechLog)
        .values({
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          kind: "chiming_in",
          spokeAtSeconds: now - 35,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "awaiting_reply",
      });
    } finally {
      h.close();
    }
  });
  it("prepares all four paths, and still refuses a path that does not exist", () => {
    const h = setup();
    try {
      // P5s: the two REPLY paths prepare here too — they share the switch/pause/agent gates and
      // skip the initiative-only ones (merge window, cooldown, hourly cap). This fixture starts
      // with both reply triggers OFF (a new scheme is quiet by design), so they are turned on
      // first; the point is that the paths are ACCEPTED here at all.
      h.orm.update(schema.qqSchemes).set({ triggerDirectReply: 1, triggerFollowUp: 1 }).run();
      // A minute later the merge window has passed, so the three paths whose remaining gates are
      // satisfied prepare; the difference between reply and initiative paths is pinned in the next
      // test.
      for (const path of ["direct_reply", "follow_up", "chiming_in"])
        expect(prepareQqJudgement(h.orm, request(path, now + 60)).kind).toBe("prepared");
      // An opener additionally needs the room to have gone quiet, so it prepares a quarter of an
      // hour later — through the same entry.
      expect(prepareQqJudgement(h.orm, request("idle_topic", now + 16 * 60)).kind).toBe("prepared");
      expect(() => prepareQqJudgement(h.orm, request("wrong"))).toThrow(TypeError);
    } finally {
      h.close();
    }
  });

  it("prepares a reply inside the merge window that holds an initiative back", () => {
    const h = setup();
    try {
      // The batch window exists to collect messages before JUDGING an initiative. Someone talking
      // TO the assistant is not that case: an @ must prepare (and be answered) right away, which is
      // exactly why the immediate paths run through this entry with the initiative gates skipped.
      h.orm.update(schema.qqSchemes).set({ triggerDirectReply: 1, triggerFollowUp: 1 }).run();
      h.orm.update(schema.qqEvents).set({ occurredAtSeconds: now }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "waiting_for_batch",
        readyAtSeconds: expect.any(Number),
      });
      expect(prepareQqJudgement(h.orm, request("direct_reply")).kind).toBe("prepared");
      expect(prepareQqJudgement(h.orm, request("follow_up")).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });
  it("rejects missing binding, invalid shape, disabled assistant and account mismatch", () => {
    const h = setup();
    try {
      expect(
        prepareQqJudgement(h.orm, {
          ...request(),
          bindingId: "33333333-3333-4333-8333-333333333333",
        }),
      ).toEqual({ kind: "blocked", reason: "binding_missing" });
      expect(() => prepareQqJudgement(h.orm, { ...request(), extra: true })).toThrow(TypeError);
      h.orm.update(schema.agents).set({ isActive: 0 }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "agent_unavailable",
      });
      h.orm.update(schema.qqSettings).set({ accountId: "99999" }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "account_mismatch",
      });
    } finally {
      h.close();
    }
  });
  it("calls an injected model once with scoped, role-separated input and schema", async () => {
    const h = setup({ nickname: true });
    const calls: unknown[] = [];
    try {
      const gateway = {
        loadedContextCapacity: async () => 65536,
        complete: async (args: unknown) => {
          calls.push(args);
          return '{"score":8}';
        },
      };
      const result = await runQqJudgement(h.orm, gateway, request());
      expect(result.kind).toBe("candidate");
      expect(calls).toHaveLength(1);
      const call = calls[0] as {
        model: string;
        messages: { role: string; content: string }[];
        responseSchema: unknown;
      };
      expect(call.model).toBe("synthetic-model");
      expect(call.responseSchema).toEqual(QQ_JUDGEMENT_RESPONSE_SCHEMA);
      expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(call.messages[1]?.content).toContain("小明(20002)");
      if (result.kind === "candidate") expect(result.prepared.bindingRevision).toBe(1);
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("uses the saved scheme reserves for judgement and reply capacity", async () => {
    const h = setup();
    try {
      h.orm
        .update(schema.qqSchemes)
        .set({ judgementOutputReserved: 4096, replyOutputReserved: 8192 })
        .run();
      let calls = 0;
      const probe = {
        loadedContextCapacity: async () => 4000,
        complete: async () => {
          calls++;
          return '{"score":8}';
        },
      };
      expect((await runQqJudgement(h.orm, probe, request())).kind).toBe("capacity_exceeded");
      expect(calls).toBe(0);
      const candidate = await runQqJudgement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => '{"score":8}',
        },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      expect(
        (
          await generateFirst(
            h.orm,
            {
              loadedContextCapacity: async () => 8000,
              complete: async () => {
                calls++;
                return "不应发生";
              },
            },
            candidate,
            now,
          )
        ).kind,
      ).toBe("capacity_exceeded");
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });
  it("treats no, invalid output and model failures as no candidate", async () => {
    const h = setup();
    try {
      // 2026-09-25：判断每次都是真跑一遍（用户取消了间隔与复用），所以这里每次回答都会真的被问到。
      let fresh = 0;
      const nextMessage = () => {
        fresh += 1;
        const at = now - 2000 + fresh * 60;
        h.orm
          .insert(schema.qqEvents)
          .values({
            eventKey: `fresh-${fresh}`,
            accountId: "10001",
            conversationKind: "group",
            peerId: "30003",
            agentId,
            messageId: `fresh-${fresh}`,
            occurredAtSeconds: at,
            speakerKind: "member",
            speakerId: "20002",
            recordedAt: nowIso(),
          })
          .run();
        h.orm
          .insert(schema.qqObservationText)
          .values({
            eventKey: `fresh-${fresh}`,
            body: `新消息 ${fresh}`,
            occurredAtSeconds: at,
            expiresAt: new Date((at + 3600) * 1000).toISOString(),
            recordedAt: nowIso(),
          })
          .run();
      };
      for (const [raw, expected] of [
        ['{"score":3}', "silent"],
        ['{"score":8,"text":"send it"}', "unreadable"],
        ["not-json", "unreadable"],
      ] as const) {
        nextMessage();
        let called = 0;
        expect(
          (
            await runQqJudgement(
              h.orm,
              {
                loadedContextCapacity: async () => 65536,
                complete: async () => {
                  called++;
                  return raw;
                },
              },
              request(),
            )
          ).kind,
        ).toBe(expected);
        expect(called).toBe(1);
      }
      nextMessage();
      expect(
        (
          await runQqJudgement(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => {
                throw new Error("synthetic network error");
              },
            },
            request(),
          )
        ).kind,
      ).toBe("model_error");
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("lets the scheme's own threshold decide what an interest score means (0034)", async () => {
    const h = setup();
    try {
      const scheme = () => h.orm.select().from(schema.qqSchemes).all()[0];
      const setThreshold = (initiative_min_score: number) => {
        const row = scheme();
        if (!row) throw new Error("synthetic scheme missing");
        updateQqScheme(h.orm, row.id, {
          name: "synthetic",
          // 2026-09-25：判断每次真跑，所以这里读到的分数一定是模型这一轮刚给的那个。
          rhythm: { ...schemeRhythm(row), initiative_min_score },
          expectedRevision: row.revision,
        });
      };
      const verdictFor = async (raw: string) =>
        (
          await runQqJudgement(
            h.orm,
            { loadedContextCapacity: async () => 65536, complete: async () => raw },
            request(),
          )
        ).kind;
      // 8 clears the default threshold (6), and the same answer stops clearing it once the
      // scheme asks for more: the score is the model's, the number is the user's.
      expect(await verdictFor('{"score":8}')).toBe("candidate");
      setThreshold(9);
      expect(await verdictFor('{"score":8}')).toBe("silent");
      // And a lower threshold admits what the default refused.
      setThreshold(2);
      expect(await verdictFor('{"score":3}')).toBe("candidate");
      // Still never a send: a candidate is a recommendation, not permission.
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("does not spend a model call when blocked or invalid", async () => {
    const h = setup({ paused: true });
    let called = 0;
    const gateway = {
      loadedContextCapacity: async () => 65536,
      complete: async () => {
        called++;
        return '{"score":8}';
      },
    };
    try {
      expect(await runQqJudgement(h.orm, gateway, request())).toEqual({
        kind: "blocked",
        reason: "conversation_paused",
      });
      expect(called).toBe(0);
      // A reply path is prepared here too now, so what this checks is that the judgement MODEL call
      // still never happens for a blocked conversation — the reply path's own decision is the
      // preparation's, not a judgement's (P5s).
      expect(await runQqJudgement(h.orm, gateway, request("direct_reply"))).toEqual({
        kind: "blocked",
        reason: "conversation_paused",
      });
      expect(called).toBe(0);
    } finally {
      h.close();
    }
  });
  it("creates a text-only draft using the reply tier, never sends", async () => {
    const h = setup({ nickname: true });
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      expect(candidate.kind).toBe("candidate");
      if (candidate.kind !== "candidate") return;
      const calls: unknown[] = [];
      const draft = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async (options: unknown) => {
            calls.push(options);
            return "合成纯文字回复";
          },
        },
        candidate,
        now,
      );
      expect(draft.kind).toBe("draft");
      if (draft.kind !== "draft") return;
      expect(draft.text).toBe("合成纯文字回复");
      expect(draft.selection.included).toBe(2);
      expect(draft.snapshot.bindingId).toBe(bindingId);
      const call = calls[0] as { model: string; messages: { role: string; content: string }[] };
      expect(calls).toHaveLength(1);
      expect(call.model).toBe("synthetic-model");
      expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(call.messages[0]?.content).toContain("## 本阶段任务");
      expect(call.messages[1]?.content).toContain("小明(20002)");
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
      expect(h.orm.select().from(schema.qqSpeechLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("blocks a stale or paused candidate before a reply model call", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      let calls = 0;
      const gateway = {
        loadedContextCapacity: async () => 65536,
        complete: async () => {
          calls++;
          return "must not run";
        },
      };
      h.orm.update(schema.qqBindings).set({ paused: 1, revision: 2 }).run();
      expect(await generateFirst(h.orm, gateway, candidate, now)).toEqual({
        kind: "blocked",
        reason: "binding_changed",
      });
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });
  it("does not release a draft when the feature turns off during generation", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      let calls = 0;
      const gateway = {
        loadedContextCapacity: async () => 65536,
        complete: async () => {
          calls++;
          h.orm.update(schema.qqSettings).set({ enabled: 0 }).run();
          return "should be discarded";
        },
      };
      expect(await generateFirst(h.orm, gateway, candidate, now)).toEqual({
        kind: "blocked",
        reason: "feature_off",
      });
      expect(calls).toBe(1);
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("keeps a blank sentence as a draft with no text and reports model errors", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      // §8.1-2 (P4i): writing no sentence is not yet "nothing to send" — the sticker stage, which
      // runs on the draft, is what decides whether a picture can carry the reply. Whether the
      // assembled output has content at all is checked at the preflight.
      const blank = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => " \n " },
        candidate,
        now,
      );
      expect(blank.kind).toBe("draft");
      if (blank.kind !== "draft") return;
      expect(blank.text).toBeNull();
      expect(blank.selection.included).toBeGreaterThan(0);
      expect(
        (
          await generateFirst(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => {
                throw new Error("synthetic");
              },
            },
            candidate,
            now,
          )
        ).kind,
      ).toBe("model_error");
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("does not call the reply model if a message arrives after judgement", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      event(h.orm, "after-judge", now - 38, "判断后的新消息");
      let calls = 0;
      expect(
        await generateFirst(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              return "not called";
            },
          },
          candidate,
          now,
        ),
      ).toMatchObject({ kind: "review_required" });
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });
  it("does not demand a review for an unrelated new message from someone else", async () => {
    // 用户 2026-09-25：活跃群里任何一句闲话都触发一次复核模型调用太慢也太费——只有"冲着她来的"
    // 或"她正在回的那个人"的新消息才值得重来一式。
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      const result = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            // 另一个群友（不是她正在回的那位）在她写句子的时候插了一句，而且没有叫到她。
            event(h.orm, "unrelated-aside", now - 35, "别人插的一句", "40004");
            return "照发不误";
          },
        },
        candidate,
        now,
      );
      expect(result.kind).toBe("draft");
      if (result.kind !== "draft") return;
      expect(result.text).toBe("照发不误");
    } finally {
      h.close();
    }
  });

  it("marks a new same-second message for review rather than releasing stale text", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      const result = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            event(h.orm, "same-second", now - 40, "新到的同秒补充");
            return "stale reply";
          },
        },
        candidate,
        now,
      );
      expect(result).toMatchObject({ kind: "review_required" });
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("marks newly arrived media-only messages for review", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      const result = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            h.orm
              .insert(schema.qqEvents)
              .values({
                eventKey: "media-extra",
                accountId: "10001",
                conversationKind: "group",
                peerId: "30003",
                agentId,
                messageId: "media-extra",
                occurredAtSeconds: now - 39,
                speakerKind: "member",
                speakerId: "20002",
                recordedAt: nowIso(),
              })
              .run();
            return "stale reply";
          },
        },
        candidate,
        now,
      );
      expect(result).toMatchObject({ kind: "review_required" });
    } finally {
      h.close();
    }
  });
  it("ignores other groups and system notices during review detection", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      const result = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            h.orm
              .insert(schema.qqEvents)
              .values({
                eventKey: "system-extra",
                accountId: "10001",
                conversationKind: "group",
                peerId: "30003",
                agentId,
                messageId: "system-extra",
                occurredAtSeconds: now - 39,
                speakerKind: "system",
                speakerId: null,
                recordedAt: nowIso(),
              })
              .run();
            h.orm
              .insert(schema.qqEvents)
              .values({
                eventKey: "other-extra",
                accountId: "10001",
                conversationKind: "group",
                peerId: "99999",
                agentId,
                messageId: "other-extra",
                occurredAtSeconds: now - 39,
                speakerKind: "member",
                speakerId: "20002",
                recordedAt: nowIso(),
              })
              .run();
            return "仍可作为草稿";
          },
        },
        candidate,
        now,
      );
      expect(result.kind).toBe("draft");
      if (result.kind === "draft") expect(result.text).toBe("仍可作为草稿");
    } finally {
      h.close();
    }
  });
  it("rejects a scheme edit after the judgement before invoking reply model", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      let calls = 0;
      h.orm.update(schema.qqSchemes).set({ revision: 2 }).run();
      expect(
        await generateFirst(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              return "stale";
            },
          },
          candidate,
          now,
        ),
      ).toEqual({ kind: "blocked", reason: "scheme_changed" });
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });
  it("rejects assistant configuration changes before and during generation", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      let calls = 0;
      h.orm.update(schema.agents).set({ configVersion: 2 }).run();
      expect(
        await generateFirst(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              return "stale";
            },
          },
          candidate,
          now,
        ),
      ).toEqual({ kind: "blocked", reason: "agent_changed" });
      expect(calls).toBe(0);
      h.orm.update(schema.agents).set({ configVersion: 1 }).run();
      expect(
        await generateFirst(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              h.orm.update(schema.agents).set({ configVersion: 2 }).run();
              return "changed midflight";
            },
          },
          candidate,
          now,
        ),
      ).toEqual({ kind: "blocked", reason: "agent_changed" });
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });
  it("strictly parses the review verdict without granting send permission", () => {
    expect(qqReviewVerdict('{"needs_recompute":false}')).toEqual({ kind: "keep" });
    expect(qqReviewVerdict('{"needs_recompute":true}')).toEqual({ kind: "recompute" });
    for (const raw of ["bad", '{"needs_recompute":"yes"}', '{"needs_recompute":false,"send":true}'])
      expect(qqReviewVerdict(raw)).toEqual({ kind: "unreadable" });
  });
  it("reviews a new same-second message with draft as user data, then keeps only a provisional result", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("expected candidate");
      const reply = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            event(h.orm, "review-new", now - 40, "新补充");
            return "旧草稿";
          },
        },
        candidate,
        now,
      );
      if (reply.kind !== "review_required") throw new Error("expected pending review");
      const calls: unknown[] = [];
      const result = await reviewQqSupplement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async (options: unknown) => {
            calls.push(options);
            return '{"needs_recompute":false}';
          },
        },
        reply.draft,
        now,
      );
      expect(result).toEqual({ kind: "unchanged", text: "旧草稿", eventCount: 3 });
      expect(calls).toHaveLength(1);
      const call = calls[0] as {
        responseSchema: unknown;
        messages: { role: string; content: string }[];
      };
      expect(call.responseSchema).toEqual(QQ_REVIEW_RESPONSE_SCHEMA);
      expect(call.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(call.messages[1]?.content).toContain("旧草稿");
      expect(call.messages[0]?.content).toContain("## 本阶段任务");
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("recompute requests respect the stored maximum, never run more model calls", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "later-review", now - 10, "补充");
      const pending = pendingQqReview(reply);
      expect(
        (
          await reviewQqSupplement(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => '{"needs_recompute":true}',
            },
            pending,
            now,
          )
        ).kind,
      ).toBe("recompute_needed");
      expect(
        (
          await reviewQqSupplement(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => '{"needs_recompute":true}',
            },
            { ...pending, recomputesUsed: 1 },
            now,
          )
        ).kind,
      ).toBe("recompute_budget");
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("fails closed on malformed review or model error", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "bad-review", now - 11, "新的群友话");
      expect(
        (
          await reviewQqSupplement(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => '{"needs_recompute":false,"send":true}',
            },
            pendingQqReview(reply),
            now,
          )
        ).kind,
      ).toBe("unreadable");
      expect(
        (
          await reviewQqSupplement(
            h.orm,
            {
              loadedContextCapacity: async () => 65536,
              complete: async () => {
                throw new Error("synthetic");
              },
            },
            pendingQqReview(reply),
            now,
          )
        ).kind,
      ).toBe("model_error");
    } finally {
      h.close();
    }
  });
  it("invalidates review when a speech switch closes during the model call", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "switch-review", now - 10, "补充");
      const result = await reviewQqSupplement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            h.orm.update(schema.qqSchemes).set({ triggerChimingIn: 0 }).run();
            return '{"needs_recompute":false}';
          },
        },
        pendingQqReview(reply),
        now,
      );
      expect(result).toEqual({ kind: "blocked", reason: "trigger_off" });
    } finally {
      h.close();
    }
  });
  it("regenerates one draft only after review and increments the used budget", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "recompute-event", now - 10, "补充的新事实");
      const pending = pendingQqReview(reply);
      const verdict = await reviewQqSupplement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => '{"needs_recompute":true}',
        },
        pending,
        now,
      );
      if (verdict.kind !== "recompute_needed") throw new Error("recompute verdict");
      let calls = 0;
      const regenerated = await recomputeQqReply(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async (options: unknown) => {
            calls++;
            expect(JSON.stringify(options)).toContain("补充的新事实");
            return "新草稿";
          },
        },
        pending,
        verdict,
        now,
      );
      expect(regenerated.kind).toBe("draft");
      if (regenerated.kind === "draft") {
        expect(regenerated.draft.text).toBe("新草稿");
        expect(regenerated.draft.recomputesUsed).toBe(1);
        expect(regenerated.draft.memberEventCount).toBe(3);
      }
      expect(calls).toBe(1);
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("refuses a second recompute at the default one-call budget", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "budget-event", now - 10, "补充");
      const pending = { ...pendingQqReview(reply), recomputesUsed: 1 };
      let calls = 0;
      expect(
        await recomputeQqReply(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              return "不应生成";
            },
          },
          pending,
          { kind: "recompute_needed", used: 1, eventCount: 3 },
          now,
        ),
      ).toEqual({ kind: "recompute_budget" });
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });
  it("discards a recompute if yet another message arrives during generation", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "旧草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      event(h.orm, "during-recompute-first", now - 10, "补充一");
      const pending = pendingQqReview(reply);
      const verdict = await reviewQqSupplement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => '{"needs_recompute":true}',
        },
        pending,
        now,
      );
      if (verdict.kind !== "recompute_needed") throw new Error("verdict");
      const result = await recomputeQqReply(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            event(h.orm, "during-recompute-second", now - 9, "补充二");
            return "过期草稿";
          },
        },
        pending,
        verdict,
        now,
      );
      expect(result).toEqual({ kind: "review_required" });
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("preflights only a current draft, never submits it", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "准备发送的文字" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      expect(checkQqTextPreflight(h.orm, pendingQqReview(reply), noStickers)).toEqual({
        kind: "checks_passed",
      });
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
      event(h.orm, "preflight-later", now - 10, "新到消息");
      expect(checkQqTextPreflight(h.orm, pendingQqReview(reply), noStickers)).toEqual({
        kind: "review_required",
      });
    } finally {
      h.close();
    }
  });
  it("blocks preflight on live switch closure or binding revision change", async () => {
    const h = setup();
    try {
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const reply = await generateFirst(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => "草稿" },
        candidate,
        now,
      );
      if (reply.kind !== "draft") throw new Error("draft");
      const draft = pendingQqReview(reply);
      h.orm.update(schema.qqSchemes).set({ triggerChimingIn: 0 }).run();
      expect(checkQqTextPreflight(h.orm, draft, noStickers)).toEqual({
        kind: "blocked",
        reason: "trigger_off",
      });
      h.orm.update(schema.qqSchemes).set({ triggerChimingIn: 1 }).run();
      h.orm.update(schema.qqBindings).set({ revision: 2 }).run();
      expect(checkQqTextPreflight(h.orm, draft, noStickers)).toEqual({
        kind: "blocked",
        reason: "binding_changed",
      });
    } finally {
      h.close();
    }
  });
  it("composes a synthetic judgement and reply but exposes no send instruction", async () => {
    const h = setup();
    let calls = 0;
    try {
      const result = await runQqInitiativeCycle(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            calls++;
            return calls === 1 ? '{"score":8}' : "纯文字草稿";
          },
        },
        request(),
        noStickers,
      );
      // 0037: 这一轮只回一个人，所以恰好一条；`drafts` 是新的返回形状。
      expect(result).toMatchObject({ kind: "prepared_only", recomputesUsed: 0 });
      expect(result.kind === "prepared_only" ? result.drafts : []).toHaveLength(1);
      expect(calls).toBe(2);
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("holds a silent judgement without generating a reply", async () => {
    const h = setup();
    let calls = 0;
    try {
      expect(
        await runQqInitiativeCycle(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async () => {
              calls++;
              return '{"score":3}';
            },
          },
          request(),
          noStickers,
        ),
      ).toEqual({ kind: "held", reason: "silent" });
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });
  it("permits only one in-flight cycle per conversation and releases after completion", async () => {
    const h = setup();
    try {
      let release: (value: string) => void = () => {
        throw new Error("not started");
      };
      const gateway = {
        loadedContextCapacity: async () => 65536,
        complete: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      };
      const first = runQqInitiativeCycle(h.orm, gateway, request(), noStickers);
      expect(
        await runQqInitiativeCycle(
          h.orm,
          { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
          request(),
          noStickers,
        ),
      ).toEqual({ kind: "held", reason: "conversation_busy" });
      await Promise.resolve();
      release('{"score":3}');
      expect(await first).toEqual({ kind: "held", reason: "silent" });
      expect(
        await runQqInitiativeCycle(
          h.orm,
          { loadedContextCapacity: async () => 65536, complete: async () => '{"score":3}' },
          request(),
          noStickers,
        ),
      ).toEqual({ kind: "held", reason: "silent" });
    } finally {
      h.close();
    }
  });
  it("releases the in-flight key after a thrown exception", async () => {
    const h = setup();
    try {
      await expect(
        runQqInitiativeCycle(
          h.orm,
          { loadedContextCapacity: async () => 65536, complete: async () => '{"score":8}' },
          { ...request(), path: "bad" },
          noStickers,
        ),
      ).rejects.toThrow(TypeError);
      expect(
        await runQqInitiativeCycle(
          h.orm,
          { loadedContextCapacity: async () => 65536, complete: async () => '{"score":3}' },
          request(),
          noStickers,
        ),
      ).toEqual({ kind: "held", reason: "silent" });
    } finally {
      h.close();
    }
  });
  it("does not include another group or assistant history", () => {
    const h = setup();
    try {
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "other",
          accountId: "10001",
          conversationKind: "group",
          peerId: "99999",
          agentId,
          messageId: "other",
          occurredAtSeconds: now - 30,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey: "other",
          body: "隔壁群秘密",
          occurredAtSeconds: now - 30,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      const result = prepareQqJudgement(h.orm, request());
      expect(result.kind).toBe("prepared");
      if (result.kind === "prepared")
        expect(JSON.stringify(result.judgementPrompts)).not.toContain("隔壁群秘密");
    } finally {
      h.close();
    }
  });
});

// 用户 2026-09-25：读过了却没读出（在途或失败）就不要自主接话。"读取失败"的口径是
// 「花过尝试、仍没有描述」——不是"任何未读"（还没试过的不拦，否则没接视觉通道时她会永久闭嘴），
// 也不是"两次都失败"（第一张读不出来的图就已经是"没读懂还硬要说话"）。
// 用户 2026-09-25：回复任务文案由方案的「按发言人分开回答」开关选，两套都是程序文案。
describe("the reply task text follows the scheme switch", () => {
  async function replyPrompt(splitBySpeaker: boolean): Promise<string> {
    const h = setup();
    try {
      h.orm
        .update(schema.qqSchemes)
        .set({ splitReplyBySpeaker: splitBySpeaker ? 1 : 0 })
        .run();
      let sent: { role: string; content: string }[] = [];
      const candidate = await runQqJudgement(
        h.orm,
        { loadedContextCapacity: async () => 65536, complete: async () => '{"score":9}' },
        request(),
      );
      if (candidate.kind !== "candidate") throw new Error("candidate");
      const generated = await generateFirst(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async (args: unknown) => {
            sent = (args as { messages: { role: string; content: string }[] }).messages;
            return "好呀";
          },
        },
        candidate,
        now,
      );
      expect(generated.kind).toBe("draft");
      return sent.map((message) => message.content).join("\n");
    } finally {
      h.close();
    }
  }

  it("uses the single-person text when the switch is on", async () => {
    const prompt = await replyPrompt(true);
    // 0037: 开着开关时，一次调用只回**一个人**，所以文案要的是"只写一条"，`@` 由程序加。
    expect(prompt).toContain("只写一条消息");
    expect(prompt).toContain("开头会由程序 @ 他");
    expect(prompt).not.toContain("[CQ:at,qq=");
    expect(prompt).not.toContain(QQ_PROMPT_DEFAULTS.reply);
    // 程序自己写的场景行：这一轮回的是谁，由服务端按发言人分好，模型不需要猜。
    expect(prompt).toContain("这一轮你要回的是");
  });

  it("uses the program's default text when the switch is off", async () => {
    const prompt = await replyPrompt(false);
    expect(prompt).toContain(QQ_PROMPT_DEFAULTS.reply);
    expect(prompt).not.toContain("[CQ:at,qq=");
  });
});

describe("media that was attempted and never read (用户 2026-09-25)", () => {
  /** One picture on a message, with a spent read attempt: attempted, still no description. */
  function attemptedImage(orm: Orm, eventKey: string) {
    recordMediaSegment(orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: "qq-media://synthetic",
      occurredAtSeconds: now - 40,
      addressed: false,
    });
    recordMediaAttempt(orm, { eventKey, segmentIndex: 0 });
  }

  it("refuses to chime in, and never asks the model", async () => {
    const h = setup();
    let calls = 0;
    try {
      attemptedImage(h.orm, "latest");
      const result = await runQqJudgement(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => {
            calls++;
            return '{"score":9}';
          },
        },
        request(),
      );
      // No retry either: the candidate is spent, and the next ticket has to come from a real event.
      expect(result).toEqual({ kind: "blocked", reason: "media_read_failed" });
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });

  it("also refuses an idle opener, which speaks about the same conversation", () => {
    const h = setup();
    try {
      attemptedImage(h.orm, "latest");
      expect(prepareQqJudgement(h.orm, request("idle_topic", now + 16 * 60))).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("still answers when it is the one being addressed", () => {
    const h = setup();
    try {
      h.orm.update(schema.qqSchemes).set({ triggerDirectReply: 1, triggerFollowUp: 1 }).run();
      attemptedImage(h.orm, "latest");
      // Being called is someone else's question, not her initiative: a picture she could not read
      // must not turn an @ into silence.
      for (const path of ["direct_reply", "follow_up"])
        expect(prepareQqJudgement(h.orm, request(path)).kind).toBe("prepared");
      expect(prepareQqJudgement(h.orm, request("chiming_in"))).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("does not pre-empt media nothing has tried yet, nor media already read", async () => {
    const h = setup();
    try {
      recordMediaSegment(h.orm, {
        eventKey: "latest",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "qq-media://synthetic",
        occurredAtSeconds: now - 40,
        addressed: false,
      });
      // A picture waiting for its turn is not a failure. Blocking here would silence every
      // initiative for as long as a read is queued, which is not what "读取失败" means.
      expect((await runQqJudgement(h.orm, gateway(), request())).kind).toBe("candidate");
      recordMediaAttempt(h.orm, { eventKey: "latest", segmentIndex: 0 });
      recordMediaNote(h.orm, {
        eventKey: "latest",
        segmentIndex: 0,
        note: "一只橘猫趴在键盘上",
        noteModel: "vision-local",
      });
      expect((await runQqJudgement(h.orm, gateway(), request())).kind).toBe("candidate");
    } finally {
      h.close();
    }
  });

  it("counts spent attempts only, and only for the messages it was handed", () => {
    const h = setup();
    try {
      recordMediaSegment(h.orm, {
        eventKey: "old",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "qq-media://synthetic",
        occurredAtSeconds: now - 90,
        addressed: false,
      });
      // Waiting its turn is not a failure.
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(0);
      recordMediaAttempt(h.orm, { eventKey: "old", segmentIndex: 0 });
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(1);
      // The gate asks about the messages of ITS conversation; a key it was not given is not its
      // business, which is what keeps one group's broken picture out of another group's turn.
      expect(attemptedUnreadMediaCount(h.orm, ["latest"])).toBe(0);
      recordMediaNote(h.orm, {
        eventKey: "old",
        segmentIndex: 0,
        note: "一只橘猫趴在键盘上",
        noteModel: "vision-local",
      });
      // Once the attempt has an answer it stops being a failure, whatever it took.
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(0);
      expect(attemptedUnreadMediaCount(h.orm, [])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not let another conversation's unreadable picture silence this one", () => {
    const h = setup();
    try {
      attemptedImage(h.orm, "latest");
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "elsewhere",
          accountId: "10001",
          conversationKind: "group",
          peerId: "40004",
          agentId,
          messageId: "elsewhere",
          occurredAtSeconds: now - 40,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      attemptedImage(h.orm, "elsewhere");
      expect(prepareQqJudgement(h.orm, request("chiming_in"))).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
      // The other group's read belongs to the other group's turn only.
      expect(attemptedUnreadMediaCount(h.orm, ["elsewhere"])).toBe(1);
    } finally {
      h.close();
    }
  });
});

/** A model that always says "worth speaking", so only the gates can hold a turn back. */
function gateway() {
  return {
    loadedContextCapacity: async () => 65536,
    complete: async () => '{"score":9}',
  };
}
