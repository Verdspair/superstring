import { describe, expect, test } from "bun:test";
import {
  type QqMediaOmission,
  selectQqMediaCandidates,
} from "../../src/server/channels/onebot11/media-projection";
import type { QqReplyProjection } from "../../src/server/channels/onebot11/reply-context";
import type {
  QqEffectiveMediaPolicy,
  QqImageCategory,
} from "../../src/shared/contracts/qq-media-input";
import type {
  QqMessageFact,
  QqMessageFocus,
  QqMessagePart,
} from "../../src/shared/contracts/qq-message";

const NOW = "2026-10-02T00:00:00.000Z";
const NOW_S = Date.parse(NOW) / 1000;

const focusOf = (responseMessageIds: string[]): QqMessageFocus => ({
  triggerMessageIds: responseMessageIds,
  responseMessageIds,
  responseQqs: ["10001"],
  assistantQq: "90001",
});

const policy = (over: Partial<QqEffectiveMediaPolicy> = {}): QqEffectiveMediaPolicy => ({
  mode: "native",
  stages: { decision: true, evaluation: true, generation: true },
  max_images: 8,
  ordinary_still_max_dimension: null,
  expression_max_dimension: 512,
  expression_frame_count: 3,
  expression_frame_max_dimension: 512,
  ordinary_frame_count: 3,
  ordinary_frame_max_dimension: 512,
  ...over,
});

let seqCounter = 0;
function factOf(over: Partial<QqMessageFact> & Pick<QqMessageFact, "id">): QqMessageFact {
  seqCounter += 1;
  return {
    platformMessageId: null,
    seq: seqCounter,
    occurredAtSeconds: NOW_S,
    speaker: {
      role: "member",
      qq: "10001",
      groupCard: "阿林",
      personalNickname: "林某",
      legacyDisplayName: null,
      nameState: "known",
    },
    parts: [],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
    ...over,
  };
}

const img = (mediaId: string, category: QqImageCategory): QqMessagePart => ({
  kind: "image",
  mediaId,
  category,
});

function projectionFrom(roots: QqReplyProjection["roots"]): QqReplyProjection {
  return { roots, sources: [] };
}

function rootOf(
  over: Partial<QqReplyProjection["roots"][number]>,
): QqReplyProjection["roots"][number] {
  return {
    fromMessageId: "m1",
    targetMessageId: "t1",
    state: "available",
    depth: 1,
    message: null,
    textPage: null,
    bodyRef: null,
    ...over,
  };
}

function run(input: {
  facts: readonly QqMessageFact[];
  replies?: QqReplyProjection;
  responseMessageIds?: string[];
  detailMediaIds?: ReadonlySet<string>;
  settings?: QqEffectiveMediaPolicy;
  phase?: "decision" | "evaluation" | "generation";
  capabilityEnabled?: boolean;
  now?: string;
}) {
  return selectQqMediaCandidates({
    facts: input.facts,
    replies: input.replies ?? projectionFrom([]),
    focus: focusOf(input.responseMessageIds ?? []),
    settings: input.settings ?? policy(),
    phase: input.phase ?? "decision",
    capabilityEnabled: input.capabilityEnabled ?? true,
    detailMediaIds: input.detailMediaIds ?? new Set(),
    now: input.now ?? NOW,
  });
}

describe("media candidate selection (pure, T10 Step1/2)", () => {
  test("capability_disabled: no candidates, only omission markers, inputs untouched", () => {
    const target = factOf({
      id: "m1",
      parts: [img("img1", "ordinary")],
      occurredAtSeconds: NOW_S - 10,
    });
    const before = JSON.stringify(target);
    const result = run({ facts: [target], responseMessageIds: ["m1"], capabilityEnabled: false });
    expect(result.selected).toEqual([]);
    expect(result.omissions).toEqual([
      { mediaId: "img1", messageId: "m1", reason: "capability_disabled" },
    ]);
    expect(JSON.stringify(target)).toBe(before);
  });

  test("stage_disabled: phase false supplies no candidates, marks stage_disabled", () => {
    const target = factOf({ id: "m1", parts: [img("img1", "ordinary")] });
    const result = run({
      facts: [target],
      responseMessageIds: ["m1"],
      settings: policy({ stages: { decision: false, evaluation: true, generation: true } }),
      phase: "decision",
    });
    expect(result.selected).toEqual([]);
    expect(result.omissions).toEqual([
      { mediaId: "img1", messageId: "m1", reason: "stage_disabled" },
    ]);
  });

  test("strict auto scope: target image plus direct reply root only; depth-8 chain images excluded as not_selected", () => {
    const target = factOf({
      id: "m1",
      parts: [img("imgT", "ordinary")],
      occurredAtSeconds: NOW_S - 30,
    });
    const direct = factOf({
      id: "m2",
      parts: [img("imgD", "ordinary")],
      replyTo: { platformMessageId: "-1" },
      occurredAtSeconds: NOW_S - 20,
    });
    const deep = factOf({
      id: "m8",
      parts: [img("imgDeep", "ordinary")],
      occurredAtSeconds: NOW_S - 10,
    });
    const replies = projectionFrom([
      rootOf({
        fromMessageId: "m2",
        targetMessageId: "m1",
        state: "in_window",
        depth: 1,
        message: factOf({ id: "m1" }),
      }),
      rootOf({
        fromMessageId: "m3",
        targetMessageId: "m2",
        state: "available",
        depth: 2,
        message: { ...deep, parts: [] },
      }),
      rootOf({
        fromMessageId: "m4",
        targetMessageId: "m3",
        state: "available",
        depth: 8,
        message: { ...deep, parts: [] },
      }),
    ]);
    const result = run({ facts: [target, direct, deep], responseMessageIds: ["m2"], replies });
    const selectedIds = result.selected.map((c) => c.mediaId).sort();
    // 自动范围=m2（target）+ 它的直接 root m1；m8 的 imgDeep 是 depth2/8 root，范围外。
    expect(selectedIds).toContain("imgD");
    expect(selectedIds).toContain("imgT");
    expect(selectedIds).not.toContain("imgDeep");
    const deepOmission = result.omissions.find((o) => o.mediaId === "imgDeep");
    expect(deepOmission).toMatchObject({ reason: "not_selected" });
  });

  test("in_window root parts=[] still selects via targetMessageId; depth2 empty-parts root is never guessed", () => {
    const target = factOf({ id: "m2", parts: [], occurredAtSeconds: NOW_S + 5 });
    const windowImg = factOf({ id: "m1", parts: [img("imgWin", "ordinary")] });
    const inWindow = rootOf({
      fromMessageId: "m2",
      targetMessageId: "m1",
      state: "in_window",
      depth: 1,
      message: factOf({ id: "m1", parts: [] }),
    });
    // depth2 root 的 message.parts 恒空；即使宿主同时给了目标事实 m9，也不凭空猜媒体。
    const outside = rootOf({
      fromMessageId: "m3",
      targetMessageId: "-9",
      state: "available",
      depth: 2,
      message: null,
    });
    const result = run({
      facts: [
        windowImg,
        target,
        factOf({ id: "m9", platformMessageId: "-9", parts: [img("imgOut", "ordinary")] }),
      ],
      responseMessageIds: ["m2"],
      replies: projectionFrom([inWindow, outside]),
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ mediaId: "imgWin", category: "ordinary" });
    expect(result.selected[0].messageIds).toEqual(["m1"]);
    const outOmission = result.omissions.find((o) => o.mediaId === "imgOut");
    expect(outOmission).toMatchObject({ reason: "not_selected" });
  });

  test("in_window root target located in supplied facts: image selected and attributed to the window message", () => {
    const target = factOf({ id: "m2", parts: [], occurredAtSeconds: NOW_S + 5 });
    const windowImg = factOf({ id: "m1", parts: [img("imgWin", "ordinary")] });
    const inWindow = rootOf({
      fromMessageId: "m2",
      targetMessageId: "m1",
      state: "in_window",
      depth: 1,
      message: factOf({ id: "m1", parts: [] }),
    });
    const result = run({
      facts: [windowImg, target],
      responseMessageIds: ["m2"],
      replies: projectionFrom([inWindow]),
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({ mediaId: "imgWin", category: "ordinary" });
    expect(result.selected[0].messageIds).toEqual(["m1"]);
    expect(result.selected[0].detail).toBe(false);
  });

  test("unavailable/expired root facts are never selected", () => {
    const revokedRoot = rootOf({
      fromMessageId: "m2",
      targetMessageId: "m1",
      state: "revoked",
      depth: 1,
      message: factOf({ id: "m1", parts: [img("imgR", "ordinary")] }),
    });
    const expiredRoot = rootOf({
      fromMessageId: "m2",
      targetMessageId: "m1",
      state: "expired",
      depth: 1,
      message: factOf({ id: "m1", parts: [img("imgE", "ordinary")] }),
    });
    const target = factOf({ id: "m2", parts: [] });
    const forRevoked = run({
      facts: [target, factOf({ id: "m1", parts: [img("imgR", "ordinary")] })],
      responseMessageIds: ["m2"],
      replies: projectionFrom([revokedRoot]),
    });
    const forExpired = run({
      facts: [target, factOf({ id: "m1", parts: [img("imgE", "ordinary")] })],
      responseMessageIds: ["m2"],
      replies: projectionFrom([expiredRoot]),
    });
    expect(forRevoked.selected).toEqual([]);
    expect(forExpired.selected).toEqual([]);
    const revokedOmission = forRevoked.omissions.find((o) => o.mediaId === "imgR");
    expect(revokedOmission).toMatchObject({ reason: "not_selected" });
  });

  test("completeness unavailable facts and expired sources are never selected", () => {
    const target = factOf({ id: "m1", parts: [] });
    const revoked = factOf({
      id: "m3",
      parts: [img("imgRev", "ordinary")],
      completeness: "unavailable",
    });
    const expiredSrc = factOf({
      id: "m4",
      parts: [img("imgExp", "ordinary")],
      sources: [
        { kind: "qq_message_fact", id: "m4", revision: "1", expiresAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    const valid = factOf({ id: "m5", parts: [img("imgOk", "ordinary")] });
    const result = run({
      facts: [target, revoked, expiredSrc, valid],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...revoked, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m4",
          state: "available",
          depth: 1,
          message: { ...expiredSrc, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m5",
          state: "available",
          depth: 1,
          message: { ...valid, parts: [] },
        }),
      ]),
    });
    expect(result.selected.map((c) => c.mediaId)).toEqual(["imgOk"]);
  });

  test("face parts are not vision candidates", () => {
    const target = factOf({
      id: "m1",
      parts: [{ kind: "face", id: "18", name: null }, img("imgF", "ordinary")],
    });
    const result = run({ facts: [target], responseMessageIds: ["m1"] });
    expect(result.selected.map((c) => c.mediaId)).toEqual(["imgF"]);
  });

  test("shared media dedupe by precise mediaId keeps all qualified original messageIds", () => {
    const target = factOf({ id: "m1", parts: [] });
    const a = factOf({ id: "m3", parts: [img("imgShared", "ordinary")] });
    const b = factOf({ id: "m4", parts: [img("imgShared", "ordinary")] });
    const result = run({
      facts: [target, a, b],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...a, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m4",
          state: "available",
          depth: 1,
          message: { ...b, parts: [] },
        }),
      ]),
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].mediaId).toBe("imgShared");
    expect([...result.selected[0].messageIds].sort()).toEqual(["m3", "m4"]);
  });

  test("category conflict across messages fails closed to unknown, never trusts a single expression downgrade", () => {
    const target = factOf({ id: "m1", parts: [] });
    const a = factOf({ id: "m3", parts: [img("imgC", "expression")] });
    const b = factOf({ id: "m4", parts: [img("imgC", "ordinary")] });
    const result = run({
      facts: [target, a, b],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...a, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m4",
          state: "available",
          depth: 1,
          message: { ...b, parts: [] },
        }),
      ]),
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].category).toBe("unknown");
  });

  test("8 images over max_images 6: priority explicit(range-limited) > focus > direct ordinary/unknown > notdetail expression; leftovers marked not_supplied", () => {
    const target = factOf({
      id: "m1",
      parts: [img("imgFocusOrd", "ordinary")],
      occurredAtSeconds: NOW_S - 40,
    });
    const directOrd = factOf({ id: "m3", parts: [img("imgDirectOrd", "ordinary")] });
    const directExpr = factOf({ id: "m4", parts: [img("imgDirectExpr", "expression")] });
    const directUnknown = factOf({ id: "m5", parts: [img("imgDirectUnk", "unknown")] });
    const focusUnknown = factOf({ id: "m6", parts: [img("imgFocusUnk", "unknown")] });
    // explicit 主控细问关键图只对已在允许范围内的图生效（m7/m8 是本轮目标）。
    const explicitOne = factOf({ id: "m7", parts: [img("imgExplicit", "expression")] });
    const explicitTwo = factOf({ id: "m8", parts: [img("imgExplicit2", "ordinary")] });
    // 伪造 detail id 指向范围外事实：不扩权，仅普通窗口图 not_selected。
    const outOfRange = factOf({ id: "m9", parts: [img("imgForged", "ordinary")] });
    const result = run({
      facts: [
        target,
        directOrd,
        directExpr,
        directUnknown,
        focusUnknown,
        explicitOne,
        explicitTwo,
        outOfRange,
      ],
      responseMessageIds: ["m1", "m6", "m7", "m8"],
      detailMediaIds: new Set(["imgExplicit", "imgExplicit2", "imgForged"]),
      settings: policy({ max_images: 6 }),
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...directOrd, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m4",
          state: "available",
          depth: 1,
          message: { ...directExpr, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m5",
          state: "available",
          depth: 1,
          message: { ...directUnknown, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m9",
          state: "available",
          depth: 2,
          message: { ...outOfRange, parts: [] },
        }),
      ]),
    });
    const chosen = result.selected.map((c) => c.mediaId);
    expect(chosen).toEqual([
      // 同优先级新在前：m8 seq > m7；m6 occurredAt > m1(40s前)；m5 seq > m3。
      "imgExplicit2",
      "imgExplicit",
      "imgFocusUnk",
      "imgFocusOrd",
      "imgDirectUnk",
      "imgDirectOrd",
    ]);
    // 表情未被细问 → 最后优先级，超限即 not_supplied 省略标记。
    const exprOmission = result.omissions.find((o) => o.mediaId === "imgDirectExpr");
    expect(exprOmission).toMatchObject({ reason: "not_supplied" });
    // detail 标记只属于 explicit 主控细问的两张。
    const byId = new Map(result.selected.map((c) => [c.mediaId, c]));
    expect(byId.get("imgExplicit")?.detail).toBe(true);
    expect(byId.get("imgExplicit2")?.detail).toBe(true);
    expect(byId.get("imgFocusOrd")?.detail).toBe(false);
  });

  test("detail marking never expands scope: detailMediaIds outside the allowed range are ignored", () => {
    const target = factOf({ id: "m1", parts: [] });
    const direct = factOf({ id: "m3", parts: [img("imgInRange", "ordinary")] });
    const outside = factOf({ id: "m9", parts: [img("imgOutOfRange", "ordinary")] });
    const result = run({
      facts: [target, direct, outside],
      responseMessageIds: ["m1"],
      detailMediaIds: new Set(["imgOutOfRange"]),
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...direct, parts: [] },
        }),
      ]),
    });
    expect(result.selected.map((c) => c.mediaId)).toEqual(["imgInRange"]);
    expect(result.selected[0].detail).toBe(false);
  });

  test("stable same-second ordering: seq desc then fact.id binary tiebreak within equal priority", () => {
    const target = factOf({ id: "m1", parts: [] });
    const late = factOf({
      id: "mB",
      parts: [img("imgB", "ordinary")],
      seq: 9,
      occurredAtSeconds: NOW_S,
    });
    const early = factOf({
      id: "mA",
      parts: [img("imgA", "ordinary")],
      seq: 9,
      occurredAtSeconds: NOW_S,
    });
    const olderSeq = factOf({
      id: "mC",
      parts: [img("imgC", "ordinary")],
      seq: 3,
      occurredAtSeconds: NOW_S,
    });
    const result = run({
      facts: [target, late, early, olderSeq],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mB",
          state: "available",
          depth: 1,
          message: { ...late, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mA",
          state: "available",
          depth: 1,
          message: { ...early, parts: [] },
        }),
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mC",
          state: "available",
          depth: 1,
          message: { ...olderSeq, parts: [] },
        }),
      ]),
    });
    // 同秒：seq 高优先；同 seq 用 fact.id 二进制序（mA < mB）。
    expect(result.selected.map((c) => c.mediaId)).toEqual(["imgA", "imgB", "imgC"]);
  });

  test("cycle/missing/legacy_unknown roots contribute nothing", () => {
    const target = factOf({ id: "m2", parts: [] });
    const cycles = projectionFrom([
      rootOf({
        fromMessageId: "m2",
        targetMessageId: "m2",
        state: "cycle",
        depth: 1,
        message: factOf({ id: "m2", parts: [img("imgCyc", "ordinary")] }),
      }),
      rootOf({
        fromMessageId: "m2",
        targetMessageId: "-404",
        state: "missing",
        depth: 1,
        message: null,
      }),
      rootOf({
        fromMessageId: "m2",
        targetMessageId: "m1",
        state: "legacy_unknown",
        depth: 1,
        message: factOf({ id: "m1", parts: [img("imgLeg", "ordinary")] }),
      }),
    ]);
    const result = run({
      facts: [target, factOf({ id: "m1", parts: [img("imgLeg", "ordinary")] })],
      responseMessageIds: ["m2"],
      replies: cycles,
    });
    expect(result.selected).toEqual([]);
  });

  test("input facts are never mutated", () => {
    const target = factOf({ id: "m1", parts: [img("img1", "ordinary")] });
    const before = JSON.stringify(target);
    run({ facts: [target], responseMessageIds: ["m1"] });
    expect(JSON.stringify(target)).toBe(before);
  });

  test("non-focus fromMessageId depth1 ROOT_OK root contributes zero scope", () => {
    const target = factOf({ id: "m1", parts: [] });
    const nonFocusReplier = factOf({ id: "mX", parts: [] });
    const replyTarget = factOf({ id: "mY", parts: [img("imgY", "ordinary")] });
    const replies = projectionFrom([
      rootOf({
        fromMessageId: "mX",
        targetMessageId: "mY",
        state: "available",
        depth: 1,
        message: { ...replyTarget, parts: [] },
      }),
    ]);
    const result = run({
      facts: [target, nonFocusReplier, replyTarget],
      responseMessageIds: ["m1"],
      replies,
    });
    expect(result.selected).toEqual([]);
    const omission = result.omissions.find((o) => o.mediaId === "imgY");
    expect(omission).toMatchObject({ reason: "not_selected" });
  });

  test("fabricated ROOT_OK root with message:null grants no scope", () => {
    const target = factOf({ id: "m1", parts: [] });
    const victim = factOf({ id: "mV", parts: [img("imgV", "ordinary")] });
    const result = run({
      facts: [target, victim],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mV",
          state: "available",
          depth: 1,
          message: null,
        }),
      ]),
    });
    expect(result.selected).toEqual([]);
    expect(result.omissions.find((o) => o.mediaId === "imgV")).toMatchObject({
      reason: "not_selected",
    });
  });

  test("ROOT_OK root whose message.id mismatches targetMessageId grants no scope", () => {
    const target = factOf({ id: "m1", parts: [] });
    const victim = factOf({ id: "mV", parts: [img("imgV", "ordinary")] });
    const result = run({
      facts: [target, victim],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mV",
          state: "available",
          depth: 1,
          message: { ...victim, id: "mOther", parts: [] },
        }),
      ]),
    });
    expect(result.selected).toEqual([]);
    expect(result.omissions.find((o) => o.mediaId === "imgV")).toMatchObject({
      reason: "not_selected",
    });
  });

  test("representative choice is permutation-stable for shared media within same tier", () => {
    const target = factOf({ id: "m0", parts: [] });
    const a = factOf({
      id: "mA",
      parts: [img("imgShared", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S - 100,
    });
    const b = factOf({
      id: "mB",
      parts: [img("imgShared", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S,
    });
    const c = factOf({
      id: "mC",
      parts: [img("imgSolo", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S - 50,
    });
    const rootsFor = projectionFrom([
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mA",
        state: "available",
        depth: 1,
        message: { ...a, parts: [] },
      }),
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mB",
        state: "available",
        depth: 1,
        message: { ...b, parts: [] },
      }),
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mC",
        state: "available",
        depth: 1,
        message: { ...c, parts: [] },
      }),
    ]);
    const order1 = run({ facts: [target, a, b, c], responseMessageIds: ["m0"], replies: rootsFor });
    const order2 = run({ facts: [target, b, a, c], responseMessageIds: ["m0"], replies: rootsFor });
    expect(order1.selected.map((s) => s.mediaId)).toEqual(["imgShared", "imgSolo"]);
    expect(order1.selected).toEqual(order2.selected);
    expect(
      [...order1.omissions].sort((x, y) =>
        `${x.mediaId}${x.messageId}`.localeCompare(`${y.mediaId}${y.messageId}`),
      ),
    ).toEqual(
      [...order2.omissions].sort((x, y) =>
        `${x.mediaId}${x.messageId}`.localeCompare(`${y.mediaId}${y.messageId}`),
      ),
    );
  });

  test("budget cut last selected slot is permutation-stable under max_images", () => {
    const target = factOf({ id: "m0", parts: [] });
    const a = factOf({
      id: "mA",
      parts: [img("imgShared", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S - 100,
    });
    const b = factOf({
      id: "mB",
      parts: [img("imgShared", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S,
    });
    const c = factOf({
      id: "mC",
      parts: [img("imgSolo", "ordinary")],
      seq: 5,
      occurredAtSeconds: NOW_S - 50,
    });
    const rootsFor = projectionFrom([
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mA",
        state: "available",
        depth: 1,
        message: { ...a, parts: [] },
      }),
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mB",
        state: "available",
        depth: 1,
        message: { ...b, parts: [] },
      }),
      rootOf({
        fromMessageId: "m0",
        targetMessageId: "mC",
        state: "available",
        depth: 1,
        message: { ...c, parts: [] },
      }),
    ]);
    const args = {
      responseMessageIds: ["m0"],
      replies: rootsFor,
      settings: policy({ max_images: 1 }),
    };
    const cut1 = run({ facts: [target, a, b, c], ...args });
    const cut2 = run({ facts: [target, b, a, c], ...args });
    expect(cut1.selected).toEqual(cut2.selected);
    expect(cut1.selected.map((s) => s.mediaId)).toEqual(["imgShared"]);
  });

  test("budget_limited depth1 root contributes direct scope", () => {
    const target = factOf({ id: "m1", parts: [] });
    const direct = factOf({ id: "m3", parts: [img("imgBL", "ordinary")] });
    const result = run({
      facts: [target, direct],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "m3",
          state: "budget_limited",
          depth: 1,
          message: { ...direct, parts: [] },
        }),
      ]),
    });
    expect(result.selected.map((c) => c.mediaId)).toEqual(["imgBL"]);
  });

  test("in_window targetMessageId absent from facts fails closed, no media guessed", () => {
    const target = factOf({ id: "m2", parts: [] });
    const other = factOf({ id: "m1", parts: [img("imgAny", "ordinary")] });
    const result = run({
      facts: [target, other],
      responseMessageIds: ["m2"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m2",
          targetMessageId: "mNope",
          state: "in_window",
          depth: 1,
          message: factOf({ id: "mNope", parts: [] }),
        }),
      ]),
    });
    expect(result.selected).toEqual([]);
    expect(result.omissions.find((o) => o.mediaId === "imgAny")).toMatchObject({
      reason: "not_selected",
    });
  });

  test("ordinary+unknown and expression+unknown conflicts fail closed to unknown", () => {
    const target = factOf({ id: "m1", parts: [] });
    const run2 = (catA: QqImageCategory, catB: QqImageCategory) => {
      const a = factOf({ id: "m3", parts: [img("imgMix", catA)] });
      const b = factOf({ id: "m4", parts: [img("imgMix", catB)] });
      return run({
        facts: [target, a, b],
        responseMessageIds: ["m1"],
        replies: projectionFrom([
          rootOf({
            fromMessageId: "m1",
            targetMessageId: "m3",
            state: "available",
            depth: 1,
            message: { ...a, parts: [] },
          }),
          rootOf({
            fromMessageId: "m1",
            targetMessageId: "m4",
            state: "available",
            depth: 1,
            message: { ...b, parts: [] },
          }),
        ]),
      });
    };
    expect(run2("ordinary", "unknown").selected[0]?.category).toBe("unknown");
    expect(run2("expression", "unknown").selected[0]?.category).toBe("unknown");
  });

  test("9 distinct images over default max_images 8: exactly 8 selected, 9th marked not_supplied", () => {
    const target = factOf({ id: "m0", parts: [img("img0", "ordinary")] });
    const directs = Array.from({ length: 8 }, (_, i) => {
      const fact = factOf({
        id: `mD${i}`,
        parts: [img(`imgD${i}`, "ordinary")],
        seq: 10 - i,
        occurredAtSeconds: NOW_S,
      });
      return {
        fact,
        root: rootOf({
          fromMessageId: "m0",
          targetMessageId: `mD${i}`,
          state: "available",
          depth: 1,
          message: { ...fact, parts: [] },
        }),
      };
    });
    const result = run({
      facts: [target, ...directs.map((d) => d.fact)],
      responseMessageIds: ["m0"],
      replies: projectionFrom(directs.map((d) => d.root)),
    });
    expect(result.selected).toHaveLength(8);
    expect(new Set(result.selected.map((c) => c.mediaId)).size).toBe(8);
    const supplied = result.selected.map((c) => c.mediaId).sort();
    expect(supplied).toEqual([
      "img0",
      "imgD0",
      "imgD1",
      "imgD2",
      "imgD3",
      "imgD4",
      "imgD5",
      "imgD6",
    ]);
    const omitted = result.omissions.filter((o) => o.reason === "not_supplied");
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toMatchObject({ mediaId: "imgD7", messageId: "mD7" });
  });

  test("focus source fact must exist and be usable: absent/expired/unavailable grant no direct scope", () => {
    const absentRoot = projectionFrom([
      rootOf({
        fromMessageId: "mF",
        targetMessageId: "mY",
        state: "available",
        depth: 1,
        message: factOf({ id: "mY", parts: [] }),
      }),
    ]);
    const victim = factOf({ id: "mY", parts: [img("imgY", "ordinary")] });
    const focusExpired = factOf({
      id: "mF",
      parts: [img("imgFE", "ordinary")],
      sources: [
        { kind: "qq_message_fact", id: "mF", revision: "1", expiresAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    const focusUnavailable = factOf({
      id: "mF",
      parts: [img("imgFU", "ordinary")],
      completeness: "unavailable",
    });
    const resultAbsent = run({
      facts: [victim],
      responseMessageIds: ["mF"],
      replies: absentRoot,
    });
    expect(resultAbsent.selected).toEqual([]);
    expect(resultAbsent.omissions.find((o) => o.mediaId === "imgY")).toMatchObject({
      reason: "not_selected",
    });
    const resultExpired = run({
      facts: [focusExpired, victim],
      responseMessageIds: ["mF"],
      replies: absentRoot,
    });
    expect(resultExpired.selected).toEqual([]);
    const resultUnavailable = run({
      facts: [focusUnavailable, victim],
      responseMessageIds: ["mF"],
      replies: absentRoot,
    });
    expect(resultUnavailable.selected).toEqual([]);
  });

  test("root.message that is unusable (unavailable or expired) grants no scope", () => {
    const target = factOf({ id: "m1", parts: [] });
    const victim = factOf({ id: "mV", parts: [img("imgV", "ordinary")] });
    const resultUnavailable = run({
      facts: [target, victim],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mV",
          state: "available",
          depth: 1,
          message: { ...victim, parts: [], completeness: "unavailable" },
        }),
      ]),
    });
    expect(resultUnavailable.selected).toEqual([]);
    expect(resultUnavailable.omissions.find((o) => o.mediaId === "imgV")).toMatchObject({
      reason: "not_selected",
    });
    const resultExpired = run({
      facts: [target, victim],
      responseMessageIds: ["m1"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "m1",
          targetMessageId: "mV",
          state: "available",
          depth: 1,
          message: {
            ...victim,
            parts: [],
            sources: [
              {
                kind: "qq_message_fact",
                id: "mV",
                revision: "1",
                expiresAt: "2026-10-01T00:00:00.000Z",
              },
            ],
          },
        }),
      ]),
    });
    expect(resultExpired.selected).toEqual([]);
  });

  test("contract-legal NUL in id/mediaId never collides into one forged omission", () => {
    const factP = factOf({
      id: "r",
      parts: [img("p\u0000q", "ordinary")],
    });
    const factQ = factOf({
      id: "q\u0000r",
      parts: [img("p", "ordinary")],
    });
    const result = run({ facts: [factP, factQ] });
    const omissions = result.omissions.filter((o) => o.reason === "not_selected");
    expect(omissions).toHaveLength(2);
    expect(omissions).toEqual([
      { mediaId: "p", messageId: "q\u0000r", reason: "not_selected" },
      { mediaId: "p\u0000q", messageId: "r", reason: "not_selected" },
    ]);
  });

  test("disabled and stage-disabled omissions are deduped and permutation-stable", () => {
    const dup = factOf({
      id: "mD",
      parts: [img("imgDup", "ordinary"), img("imgDup", "ordinary")],
    });
    const z = factOf({ id: "mZ", parts: [img("imgZ", "ordinary")] });
    const order1 = run({
      facts: [dup, z],
      capabilityEnabled: false,
    });
    const order2 = run({
      facts: [z, dup],
      capabilityEnabled: false,
    });
    expect(order1.omissions).toEqual([
      { mediaId: "imgDup", messageId: "mD", reason: "capability_disabled" },
      { mediaId: "imgZ", messageId: "mZ", reason: "capability_disabled" },
    ]);
    expect(order1.omissions).toEqual(order2.omissions);
    const stage1 = run({
      facts: [dup, z],
      settings: policy({ stages: { decision: false, evaluation: true, generation: true } }),
      phase: "decision",
    });
    const stage2 = run({
      facts: [z, dup],
      settings: policy({ stages: { decision: false, evaluation: true, generation: true } }),
      phase: "decision",
    });
    expect(stage1.omissions).toEqual([
      { mediaId: "imgDup", messageId: "mD", reason: "stage_disabled" },
      { mediaId: "imgZ", messageId: "mZ", reason: "stage_disabled" },
    ]);
    expect(stage1.omissions).toEqual(stage2.omissions);
  });

  test("valid focus fact still grants direct scope; full/legacy_partial live root.message stays usable", () => {
    const focus = factOf({ id: "mF", parts: [img("imgFocus", "ordinary")] });
    const direct = factOf({ id: "m3", parts: [img("imgDirect", "ordinary")] });
    const resultFull = run({
      facts: [focus, direct],
      responseMessageIds: ["mF"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "mF",
          targetMessageId: "m3",
          state: "available",
          depth: 1,
          message: { ...direct, parts: [] },
        }),
      ]),
    });
    expect(resultFull.selected.map((c) => c.mediaId)).toEqual(["imgFocus", "imgDirect"]);
    const legacyDirect = factOf({
      id: "m3",
      parts: [img("imgDirect", "ordinary")],
      completeness: "legacy_partial",
    });
    const resultLegacy = run({
      facts: [focus, legacyDirect],
      responseMessageIds: ["mF"],
      replies: projectionFrom([
        rootOf({
          fromMessageId: "mF",
          targetMessageId: "m3",
          state: "budget_limited",
          depth: 1,
          message: { ...legacyDirect, parts: [] },
        }),
      ]),
    });
    expect(resultLegacy.selected.map((c) => c.mediaId)).toEqual(["imgFocus", "imgDirect"]);
  });

  test("unreadable is a valid omission reason (§7.5 unsupported-animation channel, emitted by the service layer)", () => {
    // 选择器本身永不产出 unreadable（它由 prepareNative 的窄捕获追加）；这里只锁两件事：
    // 类型联合接受该值、且既有去重/排序对新值不破坏（reason 不同的元组不互相吞）。
    const omission: QqMediaOmission = {
      mediaId: "imgUnreadable",
      messageId: "m1",
      reason: "unreadable",
    };
    expect(omission.reason).toBe("unreadable");
    const key = JSON.stringify([omission.reason, omission.mediaId, omission.messageId]);
    expect(key).toBe(JSON.stringify(["unreadable", "imgUnreadable", "m1"]));
  });
});
