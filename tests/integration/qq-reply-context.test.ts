// T04a 纯算法红绿测：expandQqReplies 仅注入 load/register/fits，不依赖真实仓储/授权。
import { describe, expect, test } from "bun:test";
import { expandQqReplies } from "../../src/server/channels/onebot11/reply-context";
import type { Evidence } from "../../src/shared/contracts/evidence";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessageFocus,
  QqMessageSettings,
} from "../../src/shared/contracts/qq-message";

const NOW = "2026-10-02T00:00:00.000Z";

const scope: QqConversationScope = {
  conversationId: "synthetic-conversation",
  accountId: "90001",
  conversationKind: "group",
  peerId: "30003",
  agentId: "00000000-0000-0000-0000-000000000001",
  bindingId: "synthetic-binding",
  bindingEpoch: 1,
  authorityRevision: 1,
};

const focus: QqMessageFocus = {
  triggerMessageIds: [],
  responseMessageIds: [],
  responseQqs: [],
  assistantQq: "90001",
};

const oneThen: QqMessageSettings = {
  reply_mode: "one_then_on_demand",
  reply_depth: 2,
  time_display: "hybrid",
  timezone: "Asia/Shanghai",
};

const configured: QqMessageSettings = {
  reply_mode: "configured_depth",
  reply_depth: 8,
  time_display: "hybrid",
  timezone: "Asia/Shanghai",
};

function factOf(over: Partial<QqMessageFact> & Pick<QqMessageFact, "id">): QqMessageFact {
  return {
    platformMessageId: null,
    seq: 0,
    occurredAtSeconds: 1790920780,
    speaker: {
      role: "member",
      qq: "10002",
      groupCard: "小周",
      personalNickname: "周同学",
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

function textFact(
  id: string,
  platformMessageId: string,
  text: string,
  over: Partial<QqMessageFact> = {},
): QqMessageFact {
  return factOf({ id, platformMessageId, parts: [{ kind: "text", text }], ...over });
}

interface RunResult {
  roots: ReturnType<typeof expandQqReplies>["roots"];
  sources: ReturnType<typeof expandQqReplies>["sources"];
  registered: Evidence[];
}

function run(input: {
  window: QqMessageFact[];
  settings?: QqMessageSettings;
  remainingTextUnits?: number;
  load: (id: string) => QqMessageFact | null;
  fits?: (value: unknown, sources: readonly unknown[]) => boolean;
}): RunResult {
  const registered: Evidence[] = [];
  const projection = expandQqReplies({
    scope,
    window: input.window,
    focus,
    settings: input.settings ?? oneThen,
    now: NOW,
    remainingTextUnits: input.remainingTextUnits ?? 1000,
    load: input.load,
    register: (evidence) => {
      registered.push(evidence);
      return "registered-test-ref";
    },
    fits: input.fits ?? (() => true),
  });
  return { roots: projection.roots, sources: projection.sources, registered };
}

describe("reply relations (pure traversal)", () => {
  test("window body once with a separately preserved relation", () => {
    const a = textFact("m101", "-101", "今天南京多少度？", { seq: 1 });
    const b = factOf({
      id: "m102",
      platformMessageId: "-102",
      seq: 2,
      speaker: {
        role: "member",
        qq: "10001",
        groupCard: "阿林",
        personalNickname: "周同学",
        legacyDisplayName: null,
        nameState: "known",
      },
      parts: [
        { kind: "mention", qq: "10002" },
        { kind: "text", text: "你不是就在南京吗？" },
      ],
      replyTo: { platformMessageId: "-101" },
    });
    const result = run({ window: [a, b], load: (id) => (id === "-101" ? a : null) });
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m102",
      targetMessageId: "m101",
      state: "in_window",
      depth: 1,
      textPage: null,
      bodyRef: null,
    });
    expect(result.roots[0]?.message?.id).toBe("m101");
    expect(result.registered).toHaveLength(0);
  });

  test("one_then_on_demand stays at depth 1 even when the loaded chain continues", () => {
    const f1 = textFact("f201", "-201", "直接引用原文", { replyTo: { platformMessageId: "-202" } });
    const f2 = textFact("f202", "-202", "不应被读取");
    const b = textFact("m201", "-203", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-201" },
    });
    const loaded: string[] = [];
    const result = run({
      window: [b],
      load: (id) => {
        loaded.push(id);
        return id === "-201" ? f1 : id === "-202" ? f2 : null;
      },
    });
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m201",
      targetMessageId: "f201",
      state: "available",
      depth: 1,
      bodyRef: null,
    });
    expect(result.roots[0]?.textPage).toMatchObject({
      text: "直接引用原文",
      offset: 0,
      total: 6,
      nextOffset: null,
      complete: true,
    });
    expect(loaded).toEqual(["-201"]);
    expect(result.registered).toHaveLength(0);
  });

  test("configured_depth expands all roots breadth-first up to depth 8 and stops", () => {
    const chain: QqMessageFact[] = [];
    for (let i = 1; i <= 9; i += 1) {
      chain.push(
        textFact(`f1${i}`, `-${i}`, `第${i}层正文`, {
          replyTo: { platformMessageId: `-${i + 1}` },
        }),
      );
    }
    const b = textFact("m301", "-0", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-1" } });
    const loaded: string[] = [];
    const result = run({
      window: [b],
      settings: configured,
      load: (id) => {
        loaded.push(id);
        return chain.find((f) => f.platformMessageId === id) ?? null;
      },
    });
    expect(result.roots).toHaveLength(8);
    expect(result.roots.map((root) => root.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.roots.every((root) => root.state === "available")).toBe(true);
    expect(loaded).not.toContain("-9");
  });

  test("path cycle is marked cycle while all relations stay listed", () => {
    const f301 = textFact("f301", "-301", "第一环", { replyTo: { platformMessageId: "-302" } });
    const f302 = textFact("f302", "-302", "第二环", { replyTo: { platformMessageId: "-301" } });
    const b = textFact("m401", "-400", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-301" },
    });
    const result = run({
      window: [b],
      settings: configured,
      load: (id) => (id === "-301" ? f301 : id === "-302" ? f302 : null),
    });
    expect(result.roots).toHaveLength(3);
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "f301",
      state: "available",
      depth: 1,
    });
    expect(result.roots[1]).toMatchObject({
      targetMessageId: "f302",
      state: "available",
      depth: 2,
    });
    expect(result.roots[2]).toMatchObject({
      state: "cycle",
      depth: 3,
      message: null,
      textPage: null,
    });
  });

  test("shared target supplies body once but keeps every relation", () => {
    const shared = textFact("f401", "-401", "共享正文供一次");
    const b1 = textFact("m501", "-501", "第一条", {
      seq: 1,
      replyTo: { platformMessageId: "-401" },
    });
    const b2 = textFact("m502", "-502", "第二条", {
      seq: 2,
      replyTo: { platformMessageId: "-401" },
    });
    const result = run({ window: [b1, b2], load: (id) => (id === "-401" ? shared : null) });
    expect(result.roots).toHaveLength(2);
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "f401",
      state: "available",
      depth: 1,
    });
    expect(result.roots[0]?.textPage).toMatchObject({ text: "共享正文供一次", complete: true });
    expect(result.roots[1]).toMatchObject({
      targetMessageId: "f401",
      state: "available",
      depth: 1,
      textPage: null,
    });
    expect(result.registered).toHaveLength(0);
  });

  test("missing target is reported as missing without guesses", () => {
    const b = textFact("m601", "-601", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-602" },
    });
    const result = run({ window: [b], load: () => null });
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "-602",
      state: "missing",
      message: null,
      textPage: null,
      bodyRef: null,
    });
  });

  test("expired source fact leaks neither text nor identity", () => {
    const expired = textFact("f701", "-702", "过期正文", {
      sources: [
        {
          kind: "qq_message_fact",
          id: "evt-701",
          revision: "1",
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const b = textFact("m701", "-701", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-702" },
    });
    const result = run({ window: [b], load: (id) => (id === "-702" ? expired : null) });
    expect(result.roots[0]).toMatchObject({
      state: "expired",
      message: null,
      textPage: null,
      bodyRef: null,
    });
    expect(result.sources).toHaveLength(0);
  });

  test("expiry comparison uses numeric instants: second-precision same-instant expires", () => {
    const target = textFact("f715", "-715", "同刻正文", {
      sources: [
        {
          kind: "qq_message_fact",
          id: "evt-715",
          revision: "1",
          expiresAt: "2026-10-02T00:00:00Z",
        },
      ],
    });
    const b = textFact("m715", "-714", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-715" },
    });
    const result = run({ window: [b], load: (id) => (id === "-715" ? target : null) });
    expect(result.roots[0]).toMatchObject({
      state: "expired",
      message: null,
      textPage: null,
      bodyRef: null,
    });
  });

  test("revoked completeness is reported without body", () => {
    const revoked = textFact("f801", "-802", "已撤内容", { completeness: "unavailable" });
    const b = textFact("m801", "-801", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-802" },
    });
    const result = run({ window: [b], load: (id) => (id === "-802" ? revoked : null) });
    expect(result.roots[0]).toMatchObject({ state: "revoked", message: null, textPage: null });
  });

  test("window legacy_partial is supplemented from load and never claimed as full window body", () => {
    const windowPartial = factOf({
      id: "w901",
      platformMessageId: "-901",
      seq: 1,
      completeness: "legacy_partial",
      parts: [{ kind: "text", text: "旧片段" }],
    });
    const loadedFull = textFact("f901", "-901", "补足后的完整正文", { seq: 1 });
    const root = textFact("m901", "-902", "窗口触发", {
      seq: 2,
      replyTo: { platformMessageId: "-901" },
    });
    const supplemented = run({
      window: [windowPartial, root],
      load: (id) => (id === "-901" ? loadedFull : null),
    });
    expect(supplemented.roots[0]).toMatchObject({
      targetMessageId: "f901",
      state: "available",
      textPage: { text: "补足后的完整正文", complete: true },
    });
    const withoutLoad = run({ window: [windowPartial, root], load: () => null });
    expect(withoutLoad.roots[0]).toMatchObject({ state: "legacy_unknown", message: null });
  });

  test("expired window fact is not exposed via in_window branch", () => {
    const expiredWindow = textFact("w71", "-71", "窗口过期正文", {
      seq: 1,
      sources: [
        {
          kind: "qq_message_fact",
          id: "evt-71",
          revision: "1",
          expiresAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const b = textFact("m711", "-711", "窗口触发", {
      seq: 2,
      replyTo: { platformMessageId: "-71" },
    });
    const result = run({ window: [expiredWindow, b], load: () => null });
    expect(result.roots[0]).toMatchObject({
      state: "expired",
      message: null,
      textPage: null,
      bodyRef: null,
    });
    expect(result.sources).toHaveLength(0);
  });

  test("forged load answer with a different platform id is treated as missing", () => {
    const forged = textFact("f999", "-999", "伪造正文");
    const b = textFact("m951", "-951", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-952" },
    });
    const result = run({ window: [b], load: () => forged });
    expect(result.roots[0]).toMatchObject({ state: "missing", message: null, textPage: null });
  });
});

describe("budget, unicode paging and refs", () => {
  test("over-budget direct layer gets a unicode prefix page and a registered bodyRef", () => {
    const body = "一二三四五六七八九十甲乙丙丁戊己庚辛"; // 18 码点
    const target = textFact("f11", "-11", body, {
      sources: [{ kind: "qq_message_fact", id: "evt-11", revision: "1" }],
    });
    const b = textFact("m11", "-10", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-11" } });
    const result = run({
      window: [b],
      remainingTextUnits: 5,
      load: (id) => (id === "-11" ? target : null),
    });
    expect(result.roots[0]).toMatchObject({
      state: "budget_limited",
      bodyRef: "registered-test-ref",
    });
    expect(result.roots[0]?.textPage).toMatchObject({
      text: "一二三四五六七八九十甲乙丙丁戊己庚辛".slice(0, 5),
      offset: 0,
      total: 18,
      nextOffset: 5,
      complete: false,
    });
    expect(result.registered).toEqual([
      {
        id: "qq-message:f11",
        text: body,
        sources: [{ kind: "qq_message_fact", id: "evt-11", revision: "1" }],
      },
    ]);
  });

  test("zero remaining budget keeps the relation and registers a restricted read ref", () => {
    const target = textFact("f12", "-12", "没有余量的正文");
    const b = textFact("m12", "-13", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-12" } });
    const result = run({
      window: [b],
      remainingTextUnits: 0,
      load: (id) => (id === "-12" ? target : null),
    });
    expect(result.roots[0]).toMatchObject({
      state: "budget_limited",
      textPage: null,
      bodyRef: "registered-test-ref",
    });
    // M2：关系保留、身份元数据保留，但不从 message.parts 携带全文。
    expect(result.roots[0]?.message?.parts).toEqual([]);
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]).toMatchObject({ id: "qq-message:f12" });
  });

  test("fits=false keeps the relation and registers a restricted read ref", () => {
    const target = textFact("f13", "-13", "再长也装不下");
    const b = textFact("m13", "-14", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-13" } });
    const result = run({
      window: [b],
      remainingTextUnits: 1000,
      load: (id) => (id === "-13" ? target : null),
      fits: () => false,
    });
    expect(result.roots[0]).toMatchObject({
      state: "budget_limited",
      textPage: null,
      bodyRef: "registered-test-ref",
    });
    expect(result.registered).toHaveLength(1);
  });

  test("prefix pages never split surrogate pairs and count code points", () => {
    const target = textFact("f14", "-14", "🐴🐴🐴");
    const b = textFact("m14", "-15", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-14" } });
    const result = run({
      window: [b],
      remainingTextUnits: 2,
      load: (id) => (id === "-14" ? target : null),
    });
    const page = result.roots[0]?.textPage;
    expect(page).toMatchObject({ offset: 0, total: 3, nextOffset: 2, complete: false });
    expect(page?.text).toBe("🐴🐴");
  });

  test("deep layers are cut first and register nothing", () => {
    const f1 = textFact("f15a", "-15", "深度一", { replyTo: { platformMessageId: "-16" } });
    const f2 = textFact("f15b", "-16", "深度二很长很长很长");
    const b = textFact("m15", "-17", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-15" } });
    const result = run({
      window: [b],
      settings: { ...configured, reply_depth: 4 },
      remainingTextUnits: 3,
      load: (id) => (id === "-15" ? f1 : id === "-16" ? f2 : null),
    });
    expect(result.roots[0]).toMatchObject({ targetMessageId: "f15a", state: "available" });
    expect(result.roots[1]).toMatchObject({
      targetMessageId: "f15b",
      state: "budget_limited",
      textPage: null,
      bodyRef: null,
    });
    expect(result.registered).toHaveLength(0);
  });

  test("shallow layers win the budget over deep layers", () => {
    const direct = textFact("f17a", "-17", "直接正文甲", { replyTo: { platformMessageId: "-18" } });
    const deep = textFact("f17b", "-18", "深层正文乙");
    const b = textFact("m17", "-19", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-17" } });
    const result = run({
      window: [b],
      settings: { ...configured, reply_depth: 4 },
      remainingTextUnits: 5,
      load: (id) => (id === "-17" ? direct : id === "-18" ? deep : null),
    });
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "f17a",
      state: "available",
    });
    expect(result.roots[0]?.textPage).toMatchObject({ text: "直接正文甲", complete: true });
    expect(result.roots[1]).toMatchObject({
      targetMessageId: "f17b",
      state: "budget_limited",
      textPage: null,
      bodyRef: null,
    });
    expect(result.registered).toHaveLength(0);
  });

  test("same depth keeps the newer message and cuts the earlier", () => {
    const older = textFact("f18a", "-21", "较早就甲");
    const newer = textFact("f18b", "-22", "较新乙文");
    const bOld = textFact("m18a", "-20", "早触发", {
      seq: 1,
      replyTo: { platformMessageId: "-21" },
    });
    const bNew = textFact("m18b", "-23", "新触发", {
      seq: 2,
      replyTo: { platformMessageId: "-22" },
    });
    const result = run({
      window: [bOld, bNew],
      remainingTextUnits: 4,
      load: (id) => (id === "-21" ? older : id === "-22" ? newer : null),
    });
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m18a",
      targetMessageId: "f18a",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      fromMessageId: "m18b",
      targetMessageId: "f18b",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "较新乙文", complete: true });
  });

  test("stable id breaks seq ties deterministically", () => {
    const fa = textFact("fa1", "-31", "同序甲文");
    const fb = textFact("fb1", "-32", "同序乙文");
    const bFb = textFact("m19a", "-30", "窗口乙", { replyTo: { platformMessageId: "-32" } });
    const bFa = textFact("m19b", "-33", "窗口甲", { replyTo: { platformMessageId: "-31" } });
    const result = run({
      window: [bFb, bFa],
      remainingTextUnits: 4,
      load: (id) => (id === "-31" ? fa : id === "-32" ? fb : null),
    });
    // roots 按窗口顺序（m19a 先）；预算按稳定 ID 决胜：fa1 < fb1 → fa1 保留。
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m19a",
      targetMessageId: "fb1",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      fromMessageId: "m19b",
      targetMessageId: "fa1",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "同序甲文", complete: true });
  });

  test("budget_limited root carries no full text via message; partial page registers ref", () => {
    const target = textFact("f20", "-41", "预算不足的完整正文", {
      speaker: {
        role: "member",
        qq: "10007",
        groupCard: "小七",
        personalNickname: "七仔",
        legacyDisplayName: null,
        nameState: "known",
      },
      sources: [{ kind: "qq_message_fact", id: "evt-20", revision: "1" }],
    });
    const b = textFact("m20", "-40", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-41" } });
    const result = run({
      window: [b],
      remainingTextUnits: 2,
      load: (id) => (id === "-41" ? target : null),
    });
    expect(result.roots[0]).toMatchObject({ state: "budget_limited" });
    expect(result.roots[0]?.message).not.toBeNull();
    expect(result.roots[0]?.message?.parts).toEqual([]);
    // 身份元数据保留（引用区要求），但正文不得从 message.parts 旁路外泄。
    expect(result.roots[0]?.message?.speaker).toMatchObject({ qq: "10007" });
    // 预算 2 → 给出 2 码点 partial page ＋ 恰一次受限读取引用。
    expect(result.roots[0]?.textPage).toMatchObject({ text: "预算", complete: false });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]).toMatchObject({ id: "qq-message:f20" });
  });

  test("zero budget still registers a restricted read ref on the direct layer", () => {
    const target = textFact("f21", "-51", "没有余量的正文", {
      sources: [{ kind: "qq_message_fact", id: "evt-21", revision: "1" }],
    });
    const b = textFact("m21", "-50", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-51" } });
    const result = run({
      window: [b],
      remainingTextUnits: 0,
      load: (id) => (id === "-51" ? target : null),
    });
    expect(result.roots[0]).toMatchObject({
      state: "budget_limited",
      textPage: null,
      bodyRef: "registered-test-ref",
    });
    expect(result.registered).toEqual([
      {
        id: "qq-message:f21",
        text: "没有余量的正文",
        sources: [{ kind: "qq_message_fact", id: "evt-21", revision: "1" }],
      },
    ]);
  });

  test("fits=false direct layer still registers a restricted read ref", () => {
    const target = textFact("f22", "-61", "再长也装不下", {
      sources: [{ kind: "qq_message_fact", id: "evt-22", revision: "1" }],
    });
    const b = textFact("m22", "-60", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-61" } });
    const result = run({
      window: [b],
      remainingTextUnits: 1000,
      load: (id) => (id === "-61" ? target : null),
      fits: () => false,
    });
    expect(result.roots[0]).toMatchObject({
      state: "budget_limited",
      textPage: null,
      bodyRef: "registered-test-ref",
    });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]?.id).toBe("qq-message:f22");
  });

  test("cut deep layer is not registered and shares-target other relations keep no full copy", () => {
    const shared = textFact("f23", "-71", "共享的被裁正文共享的被裁正文", {
      sources: [{ kind: "qq_message_fact", id: "evt-23", revision: "1" }],
    });
    const b1 = textFact("m23a", "-70", "第一条", { seq: 1, replyTo: { platformMessageId: "-71" } });
    const b2 = textFact("m23b", "-72", "第二条", { seq: 2, replyTo: { platformMessageId: "-71" } });
    const result = run({
      window: [b1, b2],
      remainingTextUnits: 0,
      load: (id) => (id === "-71" ? shared : null),
    });
    // 同 target 只登记一次受限读取引用；两个关系都不携带全文。
    expect(result.registered).toHaveLength(1);
    for (const root of result.roots) {
      expect(root.message?.parts ?? []).toEqual([]);
      expect(root.textPage).toBeNull();
    }
  });

  test("shared root body never leaks via message.parts even when target is provided", () => {
    const shared = textFact("f26", "-95", "共享根的完整正文在这里");
    const b1 = textFact("m26a", "-94", "第一条", { seq: 1, replyTo: { platformMessageId: "-95" } });
    const b2 = textFact("m26b", "-96", "第二条", { seq: 2, replyTo: { platformMessageId: "-95" } });
    const result = run({
      window: [b1, b2],
      load: (id) => (id === "-95" ? shared : null),
    });
    // 正文只经第一个关系 root 的 textPage 供一次；两个 root 的 message 都不得携带全文。
    expect(result.roots[0]?.textPage).toMatchObject({
      complete: true,
      text: "共享根的完整正文在这里",
    });
    for (const root of result.roots) {
      expect(root.message?.parts ?? []).toEqual([]);
    }
  });

  test("same-depth ordering compares seq numerically: 9 is older than 10", () => {
    const older = textFact("f27a", "-97", "较早已文");
    const newer = textFact("f27b", "-98", "较新乙文");
    const bOld = textFact("m27a", "-99", "早触发", {
      seq: 9,
      replyTo: { platformMessageId: "-97" },
    });
    const bNew = textFact("m27b", "-100", "新触发", {
      seq: 10,
      replyTo: { platformMessageId: "-98" },
    });
    const result = run({
      window: [bOld, bNew],
      remainingTextUnits: 4,
      load: (id) => (id === "-97" ? older : id === "-98" ? newer : null),
    });
    // 数值序回归护栏：seq 9 早于 10，较新保留。
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m27a",
      targetMessageId: "f27a",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      fromMessageId: "m27b",
      targetMessageId: "f27b",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "较新乙文", complete: true });
  });

  test("seq boundary 1000000 does not flip ordering against 9", () => {
    const older = textFact("f28a", "-101", "较早已文");
    const newer = textFact("f28b", "-102", "较新乙文");
    const bOld = textFact("m28a", "-103", "早触发", {
      seq: 9,
      replyTo: { platformMessageId: "-101" },
    });
    const bNew = textFact("m28b", "-104", "新触发", {
      seq: 1000001,
      replyTo: { platformMessageId: "-102" },
    });
    const result = run({
      window: [bOld, bNew],
      remainingTextUnits: 4,
      load: (id) => (id === "-101" ? older : id === "-102" ? newer : null),
    });
    // 数值序回归护栏：大 seq（含超过 1000000 偏移）不翻转保较新。
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m28a",
      targetMessageId: "f28a",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      fromMessageId: "m28b",
      targetMessageId: "f28b",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "较新乙文", complete: true });
  });

  test("mixed-width seq values order numerically, not lexically (9 vs 999991)", () => {
    const older = textFact("f31a", "-111", "较早已文");
    const newer = textFact("f31b", "-112", "较新乙文");
    const bOld = textFact("m31a", "-113", "早触发", {
      seq: 9,
      replyTo: { platformMessageId: "-111" },
    });
    const bNew = textFact("m31b", "-114", "新触发", {
      seq: 999991,
      replyTo: { platformMessageId: "-112" },
    });
    const result = run({
      window: [bOld, bNew],
      remainingTextUnits: 4,
      load: (id) => (id === "-111" ? older : id === "-112" ? newer : null),
    });
    // 字符串 orderKey 里 1000000-999991="9" 与 1000000-9="999991" 词法比较把较新排到后面；
    // 数值比较必须保较新（999991）。
    expect(result.roots[0]).toMatchObject({
      fromMessageId: "m31a",
      targetMessageId: "f31a",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      fromMessageId: "m31b",
      targetMessageId: "f31b",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "较新乙文", complete: true });
  });

  test("in_window state means window only, sources are still consumed", () => {
    const a = textFact("f24", "-81", "窗口内的正文", {
      seq: 1,
      sources: [{ kind: "qq_message_fact", id: "evt-24", revision: "1" }],
    });
    const b = textFact("m24", "-80", "窗口触发", { seq: 2, replyTo: { platformMessageId: "-81" } });
    const result = run({ window: [a, b], load: () => null });
    expect(result.roots[0]).toMatchObject({ state: "in_window", textPage: null });
    // in_window 同样只给 metadata（parts=[]），以 targetMessageId 指向窗口消息本体。
    expect(result.roots[0]?.message?.parts).toEqual([]);
    expect(result.roots[0]?.targetMessageId).toBe("f24");
    expect(result.sources).toEqual([{ kind: "qq_message_fact", id: "evt-24", revision: "1" }]);
  });

  test("partial page sources are consumed too", () => {
    const target = textFact("f25", "-91", "被截断的正文很长很长", {
      sources: [{ kind: "qq_message_fact", id: "evt-25", revision: "1" }],
    });
    const b = textFact("m25", "-90", "窗口触发", { seq: 1, replyTo: { platformMessageId: "-91" } });
    const result = run({
      window: [b],
      remainingTextUnits: 3,
      load: (id) => (id === "-91" ? target : null),
    });
    expect(result.roots[0]?.textPage).toMatchObject({ complete: false });
    expect(result.sources).toEqual([{ kind: "qq_message_fact", id: "evt-25", revision: "1" }]);
  });

  test("consumed sources are deduplicated keeping the earliest expiry", () => {
    const f1 = textFact("f16a", "-26a", "来源甲", {
      sources: [
        {
          kind: "qq_message_fact",
          id: "evt-16",
          revision: "1",
          expiresAt: "2026-10-03T00:00:00.000Z",
        },
      ],
    });
    const f2 = textFact("f16b", "-26b", "来源乙", {
      sources: [
        {
          kind: "qq_message_fact",
          id: "evt-16",
          revision: "1",
          expiresAt: "2026-10-04T00:00:00.000Z",
        },
      ],
    });
    const b1 = textFact("m16a", "-16a", "第一条", {
      seq: 1,
      replyTo: { platformMessageId: "-26a" },
    });
    const b2 = textFact("m16b", "-16b", "第二条", {
      seq: 2,
      replyTo: { platformMessageId: "-26b" },
    });
    const result = run({
      window: [b1, b2],
      load: (id) => (id === "-26a" ? f1 : id === "-26b" ? f2 : null),
    });
    expect(result.sources).toEqual([
      {
        kind: "qq_message_fact",
        id: "evt-16",
        revision: "1",
        expiresAt: "2026-10-03T00:00:00.000Z",
      },
    ]);
  });

  test("two window messages citing one legacy_partial target get the supplemented body once", () => {
    const windowPartial = factOf({
      id: "w31",
      platformMessageId: "-130",
      seq: 1,
      completeness: "legacy_partial",
      parts: [{ kind: "text", text: "旧片段" }],
    });
    const loadedFull = textFact("f31", "-130", "补足后的共享完整正文", { seq: 1 });
    const b1 = textFact("m31a", "-131", "第一条", {
      seq: 2,
      replyTo: { platformMessageId: "-130" },
    });
    const b2 = textFact("m31b", "-132", "第二条", {
      seq: 3,
      replyTo: { platformMessageId: "-130" },
    });
    const result = run({
      window: [windowPartial, b1, b2],
      settings: configured,
      remainingTextUnits: 1000,
      load: (id) => (id === "-130" ? loadedFull : null),
    });
    // 正文只经一个关系 root 供一次；其余关系只保留 metadata 指向。
    const supplied = result.roots.filter((root) => root.textPage !== null);
    expect(supplied).toHaveLength(1);
    expect(supplied[0]?.textPage).toMatchObject({
      text: "补足后的共享完整正文",
      complete: true,
    });
    const citingRoots = result.roots.filter((root) => root.targetMessageId === "f31");
    expect(citingRoots).toHaveLength(2);
    for (const root of citingRoots) {
      expect(root.state).toBe("available");
      expect(root.message?.parts).toEqual([]);
    }
    expect(result.registered).toHaveLength(0);
  });

  test("tight budget on shared partial target keeps at most one ref and no full-text bypass", () => {
    const windowPartial = factOf({
      id: "w32",
      platformMessageId: "-135",
      seq: 1,
      completeness: "legacy_partial",
    });
    const loadedFull = textFact("f32", "-135", "补足后的共享完整正文", { seq: 1 });
    const b1 = textFact("m32a", "-136", "第一条", {
      seq: 2,
      replyTo: { platformMessageId: "-135" },
    });
    const b2 = textFact("m32b", "-137", "第二条", {
      seq: 3,
      replyTo: { platformMessageId: "-135" },
    });
    const result = run({
      window: [windowPartial, b1, b2],
      settings: configured,
      remainingTextUnits: 3,
      load: (id) => (id === "-135" ? loadedFull : null),
    });
    const supplied = result.roots.filter((root) => root.textPage !== null);
    expect(supplied.length).toBeLessThanOrEqual(1);
    if (supplied[0]?.textPage) expect(supplied[0].textPage.complete).toBe(false);
    expect(result.registered.length).toBeLessThanOrEqual(1);
    for (const root of result.roots) {
      // 全文不旁路：metadata 无正文，page 不得给全篇。
      expect(root.message?.parts ?? []).toEqual([]);
      expect(root.textPage === null || root.textPage.complete === false).toBe(true);
    }
  });

  test("supplemented partial target joins path cycles through the unified path", () => {
    const windowPartial = factOf({
      id: "w33",
      platformMessageId: "-138",
      seq: 1,
      completeness: "legacy_partial",
    });
    const loadedFull = textFact("f33", "-138", "自环补足正文", {
      seq: 1,
      replyTo: { platformMessageId: "-138" },
    });
    const b = textFact("m33", "-139", "窗口触发", {
      seq: 2,
      replyTo: { platformMessageId: "-138" },
    });
    const result = run({
      window: [windowPartial, b],
      settings: configured,
      load: (id) => (id === "-138" ? loadedFull : null),
    });
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "f33",
      state: "available",
    });
    expect(result.roots[0]?.textPage).toMatchObject({ text: "自环补足正文", complete: true });
    expect(result.roots[1]).toMatchObject({ state: "cycle", message: null, textPage: null });
  });

  test("fits receives the real projection candidate without __body or double casts", () => {
    const target = textFact("f29", "-105", "投影口径正文", {
      speaker: {
        role: "member",
        qq: "10009",
        groupCard: "小九",
        personalNickname: "九仔",
        legacyDisplayName: null,
        nameState: "known",
      },
      sources: [{ kind: "qq_message_fact", id: "evt-29", revision: "1" }],
    });
    const b = textFact("m29", "-106", "窗口触发", {
      seq: 1,
      replyTo: { platformMessageId: "-105" },
    });
    const seen: unknown[] = [];
    const result = run({
      window: [b],
      remainingTextUnits: 1000,
      load: (id) => (id === "-105" ? target : null),
      fits: (value) => {
        seen.push(value);
        return true;
      },
    });
    // fits 必须收到带 roots/sources 的完整投影候选值，不带 __body 私有字段。
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) {
      const record = value as Record<string, unknown>;
      expect(record.__body).toBeUndefined();
      expect(Array.isArray(record.roots)).toBe(true);
      expect(Array.isArray(record.sources)).toBe(true);
    }
    const candidate = seen[0] as { roots: Array<Record<string, unknown>>; sources: unknown[] };
    const suppliedRoot = candidate.roots.find((root) => root.textPage !== null);
    expect(suppliedRoot).toBeDefined();
    expect((suppliedRoot?.message as Record<string, unknown> | null)?.parts).toEqual([]);
    expect(candidate.sources).toEqual([{ kind: "qq_message_fact", id: "evt-29", revision: "1" }]);
    expect(result.roots[0]).toMatchObject({ state: "available" });
  });

  test("fits refusal refunds the cost: a later body can still be supplied", () => {
    const first = textFact("f30a", "-107", "第一个被拒的正文用了不少码点");
    const second = textFact("f30b", "-108", "第二个正文可以装下");
    const b1 = textFact("m30a", "-109", "第一条", {
      seq: 1,
      replyTo: { platformMessageId: "-107" },
    });
    const b2 = textFact("m30b", "-110", "第二条", {
      seq: 2,
      replyTo: { platformMessageId: "-108" },
    });
    const rejected = new Set(["f30a"]);
    const result = run({
      window: [b1, b2],
      remainingTextUnits: 1000,
      load: (id) => (id === "-107" ? first : id === "-108" ? second : null),
      fits: (value) => {
        const record = value as Record<string, unknown>;
        // 完整投影候选：f30a 的关系 root 恒存在，拒绝以其拿到任何 textPage 为准。
        if (Array.isArray(record.roots)) {
          const roots = record.roots as Array<{ targetMessageId?: string; textPage?: unknown }>;
          return !roots.some(
            (candidate) => candidate.targetMessageId === "f30a" && candidate.textPage,
          );
        }
        return false;
      },
    });
    // 第一条 fits 拒绝后预算必须全额退款，第二条才拿得到完整正文。
    expect(result.roots[0]).toMatchObject({
      targetMessageId: "f30a",
      state: "budget_limited",
      textPage: null,
    });
    expect(result.roots[1]).toMatchObject({
      targetMessageId: "f30b",
      state: "available",
    });
    expect(result.roots[1]?.textPage).toMatchObject({ text: "第二个正文可以装下", complete: true });
    expect(rejected.size).toBe(1);
  });
});
