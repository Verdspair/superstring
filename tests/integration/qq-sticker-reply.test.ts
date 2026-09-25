// P4i: the sticker one reply carries, end to end inside the synthetic cycle (ADR0018 §8.1/§9).
//
// Before this wiring the library was complete and unused: candidates could be assembled and
// outputs could be planned, but the reply chain produced text and nothing joined the two. These
// tests hold the seams that joining them introduces:
//
//   * the model picks (the shipped sticker prompt says so) and the program re-checks — a sticker
//     that stopped being usable downgrades the reply to text (§8.1-6) instead of being swapped;
//   * the presentation is built from what is usable NOW, with §9.3's hard rule excluding and its
//     soft rule merely ordering;
//   * a blank sentence is not the end of the reply: a sticker alone may be the whole message
//     (§8.1-2), and only when neither exists is there nothing to send;
//   * U13 stays the caller's argument — the same library under different `counts` presents
//     differently.
//
// Every case asserts the send ledger and the speech log stay empty: `prepared_only` is not a send.

import { describe, expect, it } from "bun:test";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  editQqSticker,
  importQqSticker,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqOutputPlan } from "../../src/server/services/qq-output-plan";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { qqStickerChoice } from "../../src/server/services/qq-sticker-contract";
import type { QqStickerStage } from "../../src/server/services/qq-sticker-runner";
import { QQ_STICKER_DEDUP_DEFAULT } from "../../src/shared/contracts/qq";
import { runQqInitiativeCycle } from "../fixtures/legacy-qq/qq-initiative-cycle";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
// Fixed ids: the presented numbering is (not recently used, then id), so a deterministic fixture
// is what makes "candidate 2" mean something in an assertion.
const quietSticker = "aaaaaaaa-1111-4111-8111-111111111111";
const loudSticker = "bbbbbbbb-2222-4222-8222-222222222222";
const now = 2_000_000_000;

/** The copy store says the files are there; counts stay explicit because U13 has no default. */
const stage: QqStickerStage = { counts: ["confirmed"], isAvailable: () => true };

type Answer = string | (() => string);

/** A gateway that answers in order and records every request it was given. */
function scripted(answers: readonly Answer[]) {
  const calls: { role: string; content: string }[][] = [];
  return {
    calls,
    gateway: {
      loadedContextCapacity: async () => 65536,
      complete: async (options: unknown) => {
        const { messages } = options as { messages: { role: string; content: string }[] };
        calls.push(messages);
        const answer = answers[calls.length - 1];
        if (answer === undefined) throw new Error("unexpected model call");
        return typeof answer === "function" ? answer() : answer;
      },
    },
  };
}

/** What reached `prepared_only`, captured from the cycle's own hook. */
interface Captured {
  plan: QqOutputPlan | null;
  stickerId: string | null | undefined;
}

function cycle(
  orm: Orm,
  gateway: unknown,
  stickerStage: QqStickerStage = stage,
): Promise<{ result: Awaited<ReturnType<typeof runQqInitiativeCycle>>; captured: Captured }> {
  const captured: Captured = { plan: null, stickerId: undefined };
  // 0037: 这一轮的结果自己带着草稿（原来的 onPrepared 钩子去掉了），本文件的夹具一个发言人，
  // 所以取第一条。
  return runQqInitiativeCycle(
    orm,
    gateway as never,
    {
      bindingId,
      path: "chiming_in",
      nowSeconds: now,
    },
    stickerStage,
  ).then((result) => {
    const first = result.kind === "prepared_only" ? result.drafts[0] : undefined;
    if (first !== undefined) {
      captured.plan = first.plan;
      captured.stickerId = first.pending.stickerId;
    }
    return { result, captured };
  });
}

function event(orm: Orm, key: string, at: number, text: string) {
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

function setup(input: { repeatMinutes?: number; avoidCount?: number } = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const collection = createQqStickerCollection(h.orm, { name: "常用" });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: { direct_reply: false, follow_up: false, chiming_in: true, idle_topic: true },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
    // 0036: 间隔 1，让"来一条新消息"就重新问一次判断——本文件里同一夹具会跑两次回复管线，靠的
    // 就是那一条新消息（否则第二次会复用上一次的分数，脚本化的模型回答就对不上号了）。
    rhythm: { ...QQ_RHYTHM_DEFAULT, judgement_interval_turns: 1 },
    stickers: {
      sticker_min_repeat_minutes:
        input.repeatMinutes ?? QQ_STICKER_DEDUP_DEFAULT.sticker_min_repeat_minutes,
      sticker_recent_avoid_count:
        input.avoidCount ?? QQ_STICKER_DEDUP_DEFAULT.sticker_recent_avoid_count,
    },
    stickerCollections: [collection.id],
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
  event(h.orm, "latest", now - 40, "新消息");
  return { h, collection };
}

function sticker(
  orm: Orm,
  collectionId: string,
  input: { id: string; name: string; about: string },
) {
  importQqSticker(orm, {
    id: input.id,
    copy: { fileName: `${input.id}.png`, byteSize: 64, mediaType: "image" },
    name: input.name,
    width: 64,
    height: 64,
    collectionIds: [collectionId],
  });
  editQqSticker(orm, input.id, { description: input.about });
  setQqStickerEnabled(orm, input.id, true);
}

/** The reply's sticker history, which §9.3 reads. */
function used(orm: Orm, assetId: string, at: number) {
  recordQqSend(orm, {
    scope: {
      kind: "qq",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
    },
    kind: "chiming_in",
    sentAtSeconds: at,
    text: null,
    parts: [{ kind: "sticker", result: "confirmed", messageId: `m${at}`, stickerId: assetId }],
  });
}

describe("the reply picks at most one sticker from what is usable now", () => {
  it("offers the authorized stickers and assembles a mixed reply", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      sticker(h.orm, collection.id, { id: loudSticker, name: "无语", about: "一个人别过脸" });
      const { gateway, calls } = scripted(['{"score":8}', "你好呀", "2"]);
      const { result, captured } = await cycle(h.orm, gateway);
      // 0037: 这一轮只回一个人，所以恰好一条；`drafts` 是新的返回形状。
      expect(result).toMatchObject({ kind: "prepared_only", recomputesUsed: 0 });
      expect(result.kind === "prepared_only" ? result.drafts : []).toHaveLength(1);
      expect(calls).toHaveLength(3);
      // The sticker call is a stage of its own, over the same conversation the sentence was
      // written for, with the candidates as data.
      const stickerCall = calls[2]?.find((message) => message.role === "user");
      expect(stickerCall?.content).toContain("## 可选表情素材");
      expect(stickerCall?.content).toContain("[1] 名称：微笑；说明：一只猫在笑");
      expect(stickerCall?.content).toContain("[2] 名称：无语；说明：一个人别过脸");
      expect(stickerCall?.content).toContain("新消息");
      expect(calls[2]?.find((message) => message.role === "system")?.content).toContain(
        "只输出你选中的候选编号",
      );
      expect(captured.stickerId).toBe(loudSticker);
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "mixed",
        parts: [
          { kind: "text", text: "你好呀" },
          { kind: "sticker", stickerId: loudSticker },
        ],
        requestedStickers: 1,
        chosenStickerIds: [loudSticker],
        rejected: [],
        textOnlyBecauseStickersUnavailable: false,
      });
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
      expect(h.orm.select().from(schema.qqSpeechLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("sends text alone when the model declines with 0", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway, calls } = scripted(['{"score":8}', "只有文字", "0"]);
      const { result, captured } = await cycle(h.orm, gateway);
      expect(result.kind).toBe("prepared_only");
      expect(calls).toHaveLength(3);
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "text_only",
        parts: [{ kind: "text", text: "只有文字" }],
        requestedStickers: 0,
        chosenStickerIds: [],
        rejected: [],
        textOnlyBecauseStickersUnavailable: false,
      });
    } finally {
      h.close();
    }
  });

  it("keeps the text alone when the answer cannot be read as a number", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      for (const answer of ["候选2", "这张最合适", "2."]) {
        const { gateway } = scripted(['{"score":8}', "只有文字", answer]);
        const { result, captured } = await cycle(h.orm, gateway);
        expect(result.kind).toBe("prepared_only");
        expect(captured.plan?.kind === "planned" ? captured.plan.shape : null).toBe("text_only");
      }
    } finally {
      h.close();
    }
  });

  it("refuses a number outside the offered candidates instead of inventing one", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway } = scripted(['{"score":8}', "只有文字", "7"]);
      const { captured } = await cycle(h.orm, gateway);
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "text_only",
        parts: [{ kind: "text", text: "只有文字" }],
        requestedStickers: 0,
        chosenStickerIds: [],
        rejected: [],
        textOnlyBecauseStickersUnavailable: false,
      });
    } finally {
      h.close();
    }
  });

  it("lets a sticker be the whole reply when no sentence was written", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway, calls } = scripted(['{"score":8}', "  \n ", "1"]);
      const { result, captured } = await cycle(h.orm, gateway);
      // 0037: 这一轮只回一个人，所以恰好一条；`drafts` 是新的返回形状。
      expect(result).toMatchObject({ kind: "prepared_only", recomputesUsed: 0 });
      expect(result.kind === "prepared_only" ? result.drafts : []).toHaveLength(1);
      // The sentence and the sticker are the same conversation; the sticker is its own stage.
      expect(calls).toHaveLength(3);
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "sticker_only",
        parts: [{ kind: "sticker", stickerId: quietSticker }],
        requestedStickers: 1,
        chosenStickerIds: [quietSticker],
        rejected: [],
        textOnlyBecauseStickersUnavailable: false,
      });
    } finally {
      h.close();
    }
  });

  it("holds when neither a sentence nor a sticker exists", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway } = scripted(['{"score":8}', "  ", "0"]);
      const { result, captured } = await cycle(h.orm, gateway);
      expect(result).toEqual({ kind: "held", reason: "empty_reply" });
      expect(captured.plan).toBeNull();
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("changes the presentation with the caller's part results, not by itself", async () => {
    const { h, collection } = setup({ repeatMinutes: 0, avoidCount: 5 });
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      sticker(h.orm, collection.id, { id: loudSticker, name: "无语", about: "一个人别过脸" });
      used(h.orm, quietSticker, now - 60);
      // `["confirmed"]`: the recent sticker is offered last and marked.
      const confirmed = scripted(['{"score":8}', "文字", "1"]);
      const first = await cycle(h.orm, confirmed.gateway);
      const confirmedBody = confirmed.calls[2]?.find((m) => m.role === "user")?.content ?? "";
      expect(confirmedBody).toContain("[1] 名称：无语；说明：一个人别过脸");
      expect(confirmedBody).toContain("[2] 名称：微笑；说明：一只猫在笑；最近发过");
      expect(first.captured.plan).toMatchObject({ chosenStickerIds: [loudSticker] });
      // `[]`: the caller says none of those sends count, so nothing is recent and the order falls
      // back to the ids. Whether a failed send "counts" is U13 and is not decided here.
      // A new member message: the second pass must be a fresh judgement rather than a reuse of the
      // first score (0036).
      event(h.orm, "later", now - 40, "又一条");
      const ignored = scripted(['{"score":8}', "文字", "1"]);
      const second = await cycle(h.orm, ignored.gateway, {
        counts: [],
        isAvailable: () => true,
      });
      expect(second.result.kind).toBe("prepared_only");
      const ignoredBody = ignored.calls[2]?.find((m) => m.role === "user")?.content ?? "";
      expect(ignoredBody).toContain("[1] 名称：微笑；说明：一只猫在笑");
      expect(ignoredBody).not.toContain("最近发过");
      expect(second.captured.plan).toMatchObject({ chosenStickerIds: [quietSticker] });
    } finally {
      h.close();
    }
  });

  it("excludes a sticker inside its shortest repeat interval and asks no model at all", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      used(h.orm, quietSticker, now - 60);
      const { gateway, calls } = scripted(['{"score":8}', "只有文字"]);
      const { result, captured } = await cycle(h.orm, gateway);
      // Nothing usable means the stage is skipped: an empty list would only invite an invented
      // number. The reply is still a complete reply.
      expect(result.kind).toBe("prepared_only");
      expect(calls).toHaveLength(2);
      expect(captured.plan).toMatchObject({ shape: "text_only" });
    } finally {
      h.close();
    }
  });

  it("downgrades to text instead of swapping a sticker that stopped being usable", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      sticker(h.orm, collection.id, { id: loudSticker, name: "无语", about: "一个人别过脸" });
      // The pick lands, then the user disables exactly that sticker while the stage is running.
      const { gateway } = scripted([
        '{"score":8}',
        "只有文字",
        () => {
          setQqStickerEnabled(h.orm, quietSticker, false);
          return "1";
        },
      ]);
      const { result, captured } = await cycle(h.orm, gateway);
      expect(result.kind).toBe("prepared_only");
      // §8.1-6: the text stands on its own and the other sticker is NOT substituted for the one
      // the model chose. The plan reports no rejection entry because the library no longer offers
      // that sticker at all — the plan describes the candidates it could consider, and inventing a
      // row for a withdrawn asset would misdescribe the library.
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "text_only",
        parts: [{ kind: "text", text: "只有文字" }],
        requestedStickers: 1,
        chosenStickerIds: [],
        rejected: [],
        textOnlyBecauseStickersUnavailable: true,
      });
      expect(h.orm.select().from(schema.qqSendLog).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("holds a sticker-only reply whose only sticker stopped being usable", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway } = scripted([
        '{"score":8}',
        " ",
        () => {
          setQqStickerEnabled(h.orm, quietSticker, false);
          return "1";
        },
      ]);
      const { result, captured } = await cycle(h.orm, gateway);
      expect(result).toEqual({ kind: "held", reason: "sticker_unavailable_and_no_text" });
      expect(captured.plan).toBeNull();
    } finally {
      h.close();
    }
  });

  it("keeps the text when only the sticker call runs out of capacity", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const messages: unknown[] = [];
      let capacityChecks = 0;
      const gateway = {
        loadedContextCapacity: async () => {
          capacityChecks += 1;
          // Smaller than the reply reserve alone: the stage must refuse before calling the model.
          return capacityChecks === 3 ? 1000 : 65536;
        },
        complete: async () => {
          messages.push(null);
          return messages.length === 1 ? '{"score":8}' : "只有文字";
        },
      };
      const { result, captured } = await cycle(h.orm, gateway);
      // The reply call already passed under the same reserve, so a refusal here can only be the
      // sticker stage's, and the sentence leaves without it.
      expect(result.kind).toBe("prepared_only");
      expect(messages).toHaveLength(2);
      expect(captured.plan).toMatchObject({
        shape: "text_only",
        textOnlyBecauseStickersUnavailable: false,
      });
    } finally {
      h.close();
    }
  });

  it("keeps the chosen sticker across a review that changed nothing", async () => {
    const { h, collection } = setup();
    try {
      sticker(h.orm, collection.id, { id: quietSticker, name: "微笑", about: "一只猫在笑" });
      const { gateway, calls } = scripted([
        '{"score":8}',
        "只有文字",
        () => {
          // A new message lands while the sticker stage is running: the draft must be reviewed.
          event(h.orm, "during-sticker", now - 30, "刚刚又有新消息");
          return "1";
        },
        '{"needs_recompute":false}',
      ]);
      const { result, captured } = await cycle(h.orm, gateway);
      expect(result.kind).toBe("prepared_only");
      expect(calls).toHaveLength(4);
      // The review said the sentence stands, so the sticker chosen for that sentence stands too.
      expect(captured.plan).toEqual({
        kind: "planned",
        shape: "mixed",
        parts: [
          { kind: "text", text: "只有文字" },
          { kind: "sticker", stickerId: quietSticker },
        ],
        requestedStickers: 1,
        chosenStickerIds: [quietSticker],
        rejected: [],
        textOnlyBecauseStickersUnavailable: false,
      });
    } finally {
      h.close();
    }
  });
});

describe("the sticker answer is read as one candidate number", () => {
  it("turns every other shape into \u201cno sticker\u201d rather than a guess", () => {
    expect(qqStickerChoice("2", 3)).toEqual({ kind: "picked", index: 2 });
    expect(qqStickerChoice(" 1 \n", 3)).toEqual({ kind: "picked", index: 1 });
    expect(qqStickerChoice("0", 3)).toEqual({ kind: "none", reason: "declined" });
    expect(qqStickerChoice("", 3)).toEqual({ kind: "none", reason: "empty" });
    expect(qqStickerChoice("   ", 3)).toEqual({ kind: "none", reason: "empty" });
    expect(qqStickerChoice("候选2", 3)).toEqual({ kind: "none", reason: "unreadable" });
    expect(qqStickerChoice("2.", 3)).toEqual({ kind: "none", reason: "unreadable" });
    expect(qqStickerChoice("-1", 3)).toEqual({ kind: "none", reason: "unreadable" });
    expect(qqStickerChoice("4", 3)).toEqual({ kind: "none", reason: "out_of_range" });
    expect(qqStickerChoice(undefined, 3)).toEqual({ kind: "none", reason: "unreadable" });
    // A caller that offers nothing must not read an answer at all.
    expect(() => qqStickerChoice("1", 0)).toThrow(TypeError);
  });
});
