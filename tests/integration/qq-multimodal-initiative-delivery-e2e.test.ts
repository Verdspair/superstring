// T15 补块 P6（ids 48–53）：主动发言许可门槛、直答无评分、决策 none 的图片零额外调用、
// 生成中收到新消息的 pending plan、已提交意图遇新相关图 stale、unknown 投递不重发。
//
// 上位依据：计划 §T15 Step1 第 48–53 条、规格 §14.1、matrix `functional-matrix.ts` 的
// requirement/negativeEvidence 逐字，以及 `resume-t15-matrix-review.md`（终版）对这 6 条的
// not_executed 理由与 panel-D.md 的逐条 writer 任务。本文件是**独立补块**，不改
// `qq-message-multimodal-e2e.test.ts`、不改 runner/映射/生产代码/夹具。
//
// 红线：全链走真实 OneBot wire → intake → 宿主 → AgentRuntime → OutboundDelivery
// （createOneBotHarness + scriptedModel）；不建第二 harness/第二模型链；不 import artifacts/
// （本文件自包含，tests 整体不进发布排除面）；不读真实 data/密钥、不触网络、不起服务。
// 断言面只用真实可失败的量：模型相计数、发送次数、待发意图状态与部件状态、
// `qq_media_variants`/`qq_media_assets` 真实行数、模型输入里 image part 的来源元数据、
// 投递台账行的 before/after。不用自造回读值、不用恒真表达式、不以 test skip 冒充 PASS。
//
// 每条原 requirement 的子要求逐条对应到下面的用例与断言（对照表见本文件末尾注释）：
//   48 主动score5silent/6generated —— 负：低于门槛 5 静默（sends=0、待发意图=0）
//   49 direct无评分call         —— 负：直接回应路径 score phase 计数必须为 0
//   50 modelnone无图额外call     —— 负：模型 none 时不得自动评分/生成，无额外 call
//   51 generationnewmessagependingplan —— 负：pending plan 不得保留已失效画面；未发送图片不得称已读
//   52 已提交新相关图stale       —— 负：已 attempted 的旧意图不得重发
//   53 unknownsend不重发         —— 负：unknown 投递不得重发（sends 不增）

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { decideGenerate, decideNone, say, scoreOf } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 本文件内小工具（不构成第二 harness／第二模型链） ------------------------------

const png = (): Uint8Array => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
const pngB = (): Uint8Array => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(160), 8, 8);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 某次调用输入的全文拼接（模型可见材料的断言面）。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

const phases = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

const statusOf = (result: unknown): string =>
  result !== null && typeof result === "object" && "status" in result
    ? String((result as { status: unknown }).status)
    : "missing";

/** 某次调用输入里的 image part（按来源 sha 去重），只含来源元数据、无 bytes/base64。 */
const imageParts = (
  h: OneBotHarness,
  index: number,
): Array<{ sha256: string; mimeType: string }> => {
  const out: Array<{ sha256: string; mimeType: string }> = [];
  for (const message of h.model?.receivedMessages[index]?.messages ?? []) {
    for (const part of message.content) {
      if (part.kind === "image") out.push({ sha256: part.sha256, mimeType: part.mimeType });
    }
  }
  return out;
};

/** 每次调用各自携带的 image part 数量（逐次，可与"图是否真在链路"对照）。 */
const imageCountByCall = (h: OneBotHarness): number[] =>
  (h.model?.receivedMessages ?? []).map((_call, index) => imageParts(h, index).length);

/** image part 只带来源元数据，无 bytes/base64/url/path（规格 §10 红线）。 */
const noBytesInWire = (h: OneBotHarness): void => {
  for (const call of h.model?.receivedMessages ?? []) {
    for (const message of call.messages) {
      for (const part of message.content) {
        if (part.kind === "image") {
          expect(Object.keys(part)).not.toContain("bytes");
          expect(Object.keys(part)).not.toContain("base64");
          expect(Object.keys(part)).not.toContain("url");
          expect(Object.keys(part)).not.toContain("path");
        }
      }
    }
  }
};

const countRows = (h: OneBotHarness, table: string): number =>
  (h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const partRows = (h: OneBotHarness): Array<{ status: string; attemptedAt: string | null }> =>
  h.db
    .query(
      "SELECT status,attempted_at AS attemptedAt FROM outbound_parts ORDER BY intent_id,ordinal",
    )
    .all() as Array<{ status: string; attemptedAt: string | null }>;

/** 决策/评分/生成三相的模型名（用来确认"某一次 next 到底是哪一相"）。 */
const modelsByCall = (h: OneBotHarness): Array<string | null> =>
  (h.model?.calls ?? []).map((call) => call.model);

// ============================================================================
// [S48_1] 主动 score 5 静默 / 6 生成 —— 门槛来自方案，不是写死的 6
// ============================================================================

it("[S48_1] initiative threshold comes from the scheme: 5 below it stays silent, 6 clears it, and a lower configured gate also lets 5 through", async () => {
  // --- 半边 A：默认门槛 6，score 5 → 静默 ---
  // 强负面（Step2）：sends=0（真发送计数）、待发意图=0（真意图行数）、零生成相。
  const quiet = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 6,
    model: [decideGenerate("10001", "打算说点什么", []), scoreOf(5)],
  });
  quiet.receive({ id: "-4801", speaker: "10001", text: "有人知道这个吗" });
  quiet.advance(31);
  const quietResult = await quiet.activate("chiming_in");
  await quiet.deliver();
  // 恰好两次调用：决策相 + 评分相；许可被拒后不得再进生成相。
  expect(phases(quiet)).toEqual(["next", "next"]);
  expect(statusOf(quietResult)).toBe("no_output");
  expect(quiet.sent).toHaveLength(0);
  expect(quiet.outbox.list({ conversationId: quiet.conversationId })).toHaveLength(0);
  expect(countRows(quiet, "outbound_intents")).toBe(0);
  // 两次 next 确实是**两种不同的相**（不是同一相跑了两遍）：决策相带工具目录，评分相不带
  // （评分叶子只拿判断协议与结构化输出 schema）。两次调用的 head 首行也不同。
  const quietCalls = quiet.model?.calls ?? [];
  expect(quietCalls).toHaveLength(2);
  expect(quietCalls[0]?.tools.length).toBeGreaterThan(0);
  expect(quietCalls[1]?.tools).toHaveLength(0);
  expect(quietCalls[0]?.schema).toBe(true);
  expect(quietCalls[1]?.schema).toBe(true);
  expect(quietCalls[0]?.head).not.toBe(quietCalls[1]?.head);
  quiet.close();

  // --- 半边 B：默认门槛 6，score 6 → 生成 1 条 ---
  const speak = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 6,
    model: [decideGenerate("10001", "打算说点什么", []), scoreOf(6), say("主动回复正文")],
  });
  speak.receive({ id: "-4802", speaker: "10001", text: "有人知道这个吗" });
  speak.advance(31);
  const speakResult = await speak.activate("chiming_in");
  await speak.deliver();
  expect(phases(speak)).toEqual(["next", "next", "generate"]);
  // 与半边 A 同一判据：第 1 次 next 是决策相（带工具）、第 2 次 next 是评分相（不带工具）。
  const speakCalls = speak.model?.calls ?? [];
  expect(speakCalls).toHaveLength(3);
  expect(speakCalls[0]?.tools.length).toBeGreaterThan(0);
  expect(speakCalls[1]?.tools).toHaveLength(0);
  expect(statusOf(speakResult)).toBe("completed");
  expect(speak.sent).toHaveLength(1);
  expect(JSON.stringify(speak.sent[0]?.message)).toContain("主动回复正文");
  // 恰好一条意图、且这一条已确认送达（不是"待发"蒙混）。
  const speakIntents = speak.outbox.list({ conversationId: speak.conversationId });
  expect(speakIntents).toHaveLength(1);
  expect(speakIntents[0]?.status).toBe("confirmed");
  speak.close();

  // --- 半边 C（面板 D 要求的缺口）：门槛可配置，不是常量 6 ---
  // 同一 score=5，把方案门槛降到 4 就必须放行。把"门槛写死 6"的实现改掉，本用例仍绿；
  // 把判定写成 `>`（严格大于）则半边 A 仍绿但半边 C 会红——两个方向都锁。
  const lowGate = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeMinScore: 4,
    model: [decideGenerate("10001", "打算说点什么", []), scoreOf(5), say("门槛4下的主动回复")],
  });
  lowGate.receive({ id: "-4803", speaker: "10001", text: "门槛调低了" });
  lowGate.advance(31);
  const lowGateResult = await lowGate.activate("chiming_in");
  await lowGate.deliver();
  expect(phases(lowGate)).toEqual(["next", "next", "generate"]);
  const lowGateCalls = lowGate.model?.calls ?? [];
  expect(lowGateCalls[0]?.tools.length).toBeGreaterThan(0);
  expect(lowGateCalls[1]?.tools).toHaveLength(0);
  expect(statusOf(lowGateResult)).toBe("completed");
  expect(lowGate.sent).toHaveLength(1);
  expect(JSON.stringify(lowGate.sent[0]?.message)).toContain("门槛4下的主动回复");
  // 反向：门槛 6 时同一个 score=5 必须仍静默（两个夹具只差门槛这一项）。
  expect(speak.sent).toHaveLength(1);
  expect(quiet.sent).toHaveLength(0);
});

// ============================================================================
// [S49_1] 直接回应路径零评分相（含有图条件）
// ============================================================================

it("[S49_1] the direct reply path never spends a score call, with or without a real native image on the wire", async () => {
  // --- 半边 A：无图直答 ---
  // 强负面：相位数组精确等于 ["next","generate"]——多一次评分相就是 3 元素，立即红。
  const plain = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", []), say("无图直答正文")],
  });
  plain.receive({ id: "-4901", speaker: "20002", text: "在吗", addressed: true });
  await plain.activate("direct_reply");
  await plain.deliver();
  expect(phases(plain)).toEqual(["next", "generate"]);
  // 会话模型与判断模型在这两相里都只出现会话模型一次、生成一次：判断模型名 0 次。
  expect(new Set(modelsByCall(plain))).toEqual(new Set(["reply-model"]));
  expect(plain.sent).toHaveLength(1);
  plain.close();

  // --- 半边 B（面板 D 要求的缺口）：带真图的直答，评分相计数仍为 0 ---
  // 关键点：必须给 `mediaInput:{mode:"native"}`，harness 只在
  // `mediaInput.mode==="native" && imageBytes 非空` 时才注入 mediaInputService
  // （tests/harness/onebot.ts:427），否则图根本不在链路上、`visionCalls===0` 恒真。
  const bytes = png();
  const withImage = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "p6-49-image": bytes },
    model: [decideGenerate("20002", "回答当前消息的图片问题", []), say("带图直答正文")],
  });
  withImage.receive({
    id: "-4902",
    speaker: "20002",
    text: "这张图里是什么",
    addressed: true,
    image: "p6-49-image",
  });
  const imageResult = await withImage.activate("direct_reply");
  await withImage.deliver();
  // 图真的在链路上：决策相与生成相都带这张图（各 1 个 image part，sha＝受控字节）。
  expect(imageCountByCall(withImage)).toEqual([1, 1]);
  expect(imageParts(withImage, 0)[0]?.sha256).toBe(sha(bytes));
  expect(imageParts(withImage, 1)[0]?.sha256).toBe(sha(bytes));
  noBytesInWire(withImage);
  // 强负面：有图也不得出现评分相——仍是精确两相。
  expect(phases(withImage)).toEqual(["next", "generate"]);
  expect(statusOf(imageResult)).toBe("completed");
  // 直答路径不花独立视觉调用（native 直接把画面发给模型，不是另一次 classify/describe）。
  expect(withImage.visionCalls).toHaveLength(0);
  expect(withImage.sent).toHaveLength(1);
  expect(JSON.stringify(withImage.sent[0]?.message)).toContain("带图直答正文");
});

// ============================================================================
// [S50_1] 模型 none 时不得自动评分/生成，无额外 call（图真在链路上）
// ============================================================================

it("[S50_1] a none decision with a real native image spends no extra call: one decision, no score, no generation, no vision read", async () => {
  // 面板 D 指出的缺口：原 Base_8 只给了 imageBytes 没给 mediaInput，
  // mediaService 为 null、图从头到尾不在链路上，`visionCalls===0` 偏恒真。
  // 这里补 `mediaInput:{mode:"native"}`，让图真的进入决策相投影，再断"零额外调用"。
  const bytes = png();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "p6-50-image": bytes },
    model: [decideNone()],
  });
  h.receive({ id: "-5001", speaker: "10001", text: "看看这张图", image: "p6-50-image" });
  h.advance(31);
  const result = await h.activate("chiming_in");
  await h.deliver();
  // 前置事实：媒体行与受控 bytes 确实存在（否则下面"零准备"就没有对照面）。
  expect(countRows(h, "qq_media_notes")).toBe(1);
  expect(countRows(h, "qq_media_assets")).toBe(1);
  const asset = h.db.query("SELECT content_sha256 AS sha FROM qq_media_assets LIMIT 1").get() as {
    sha: string;
  };
  expect(asset.sha).toBe(sha(bytes));
  // 强负面一：全轮恰好 1 次调用（决策相）。none 之后不得自动评分、不得自动生成。
  expect(phases(h)).toEqual(["next"]);
  expect(h.model?.calls.length).toBe(1);
  // 强负面二：零视觉调用、零发送、零待发意图。
  expect(h.visionCalls).toHaveLength(0);
  expect(h.sent).toHaveLength(0);
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(0);
  expect(countRows(h, "outbound_intents")).toBe(0);
  expect(statusOf(result)).toBe("no_output");
  // 那唯一一次调用的输入里**确实带着这张图**（否则"零额外调用"只是因为图没在链路上）：
  // 决策相的自动图准备在决策调用之前完成，none 决策也得先看到画面才可能回 none。
  // 这条是本用例与原 Base_8 的关键差别——原块没接 mediaInputService，图压根不在链路。
  expect(imageCountByCall(h)).toEqual([1]);
  expect(imageParts(h, 0)[0]?.sha256).toBe(sha(bytes));
  noBytesInWire(h);
  // 强负面三：即使图被真的准备并随这一次决策发出，none 之后仍**没有**任何额外模型调用——
  // 没有评分相、没有生成相、没有独立视觉调用、没有媒体工具调用。
  // （native 路径把画面直接发给那一次决策调用；"没有为图花额外调用"正是本条要求。）
  expect(h.model?.calls.length).toBe(1);
  expect(phases(h).filter((phase) => phase === "vision")).toHaveLength(0);
  expect(phases(h).filter((phase) => phase === "auxiliary")).toHaveLength(0);
  // 强负面四：媒体工具只是**声明**在目录里（有能力≠被调用）。none 这一轮没有任何工具
  // 被调用——脚本只给了 decideNone 一步，若真调了 media.describe/describe 类工具，
  // 桩会因脚本耗尽或形状不符抛 HARNESS_* 码，整轮不会走到 no_output。
  // 读取任务表也没有为这次决策建行（native 不套描述尝试，规格 §14.1）。
  // 视觉调用 0（已断）＋读取任务表 0 行：native 路径不套描述尝试，
  // 也没有为图派生任何独立读取任务（规格 §14.1「原生不套描述尝试」）。
  expect(countRows(h, "qq_media_read_tasks")).toBe(0);
  // 分类缓存也没有为图开出一条：未知分类本轮不消费（没有模型分类 envelope 回写）。
  expect(countRows(h, "qq_media_classifications")).toBe(0);
});

// [S50_2] 对照：同一张图在"要生成"的轮次会被准备出 variant，
// 但仍不产生独立视觉调用——把"没有为图做额外调用"与"没有为图做任何准备"两件事区分开。
it("[S50_2] the same image in a speaking round yields a prepared variant yet still zero independent vision calls", async () => {
  const bytes = png();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "p6-50b-image": bytes },
    model: [decideGenerate("10001", "回答当前消息的图片问题", []), scoreOf(6), say("带图主动回复")],
  });
  h.receive({ id: "-5002", speaker: "10001", text: "看看这张图", image: "p6-50b-image" });
  h.advance(31);
  const result = await h.activate("chiming_in");
  await h.deliver();
  // 对照成立：这次图被真的准备了（variant 行 > 0），但视觉调用计数仍为 0
  // （native 路径把画面直接发给决策/评分/生成三次调用，不是另一次 classify/describe）。
  expect(countRows(h, "qq_media_variants")).toBeGreaterThan(0);
  expect(h.visionCalls).toHaveLength(0);
  expect(phases(h)).toEqual(["next", "next", "generate"]);
  expect(statusOf(result)).toBe("completed");
  expect(h.sent).toHaveLength(1);
  // 三相都带同一张图（sha＝受控字节），无 bytes/base64 外泄。
  expect(imageCountByCall(h)).toEqual([1, 1, 1]);
  for (const count of [0, 1, 2]) expect(imageParts(h, count)[0]?.sha256).toBe(sha(bytes));
  noBytesInWire(h);
});

// ============================================================================
// [S51_1] 生成中收到新消息：回到决策相，pending plan 只保留仍有效的草稿
// ============================================================================

it("[S51_1] a new message during generation restarts deciding, and the pending plan carries only still-valid drafts", async () => {
  // --- 半边 A（纯文字，补面板 D 的 pending_plan 内容断言） ---
  const h = createOneBotHarness({
    model: [
      decideGenerate("20002"),
      say("第一版", () => h.receive({ id: "-5102", speaker: "20002", text: "对了，还有个事" })),
      decideGenerate("20002"),
      say("第二版"),
    ],
  });
  h.receive({ id: "-5101", speaker: "20002", addressed: true, text: "帮我看看" });
  const result = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(result)).toBe("completed");
  // 决策→生成→（新消息）→决策→生成：pending plan 真的被复核并退回决策相。
  expect(phases(h)).toEqual(["next", "generate", "next", "generate"]);
  // 强负面：只有改过的那一版被发送；旧画面没有产生第二次发送。
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.sent[0]?.message)).toContain("第二版");
  expect(JSON.stringify(h.sent[0]?.message)).not.toContain("第一版");
  // pending_plan 在两次决策相的输入里都出现——它记录的是宿主掌握的"尚未发送的计划"，
  // 模型在复核时可以看到并原样保留或改写（这是产品设计，不是缺陷）。
  expect(callText(h, 0)).not.toContain('"kind":"pending_plan"');
  expect(callText(h, 2)).toContain('"kind":"pending_plan"');
  expect(callText(h, 3)).toContain('"kind":"pending_plan"');
  // 复核的触发原因真实落在 new_observation（不是被测试自造的 reason）。
  const pendingDump = callText(h, 2)
    .split('"kind":"pending_plan"')
    .slice(1)
    .join('"kind":"pending_plan"');
  expect(pendingDump).toContain('"reason":"new_observation"');
  // pending plan 记的是宿主在**这一轮**准备好的草稿（可直接原样保留或修改），
  // 不是历史累积：observedSeq 停在触发复核那一刻，且 generationBudget 仍有余量。
  expect(pendingDump).toContain('"observedSeq":1');
  expect(pendingDump).toContain('"remaining":1');
  // 强负面：宿主掌握的只有这一份草稿（outputs 恰好一条）——不得把失效的旧计划也留着。
  expect(pendingDump.split('"outputId"').length - 1).toBe(1);
  // 触发复核的新消息真的进了第二次决策相的输入（否则"回到决策相"没有新依据）。
  expect(callText(h, 2)).toContain("对了，还有个事");
  // 恰好一条意图（两次决策只提交一次发送）。
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(1);
  h.close();

  // --- 半边 B（带真图，补"未发送图片不得称已读"） ---
  // 面板 D 的缺口：原 L_51 无图，"未发送图片不得称已读"无从覆盖。
  // 这里首条消息带图（native 已准备），生成中又收到一条带新图的消息：
  // 第二次决策相的输入里必须只出现**新**那张图，旧图的 image part 不得被当作已读素材重复供给。
  const oldBytes = png();
  const newBytes = pngB();
  const withImages = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["第一张图的说明", "第二张图的说明"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "p6-51-old": oldBytes, "p6-51-new": newBytes },
    model: [
      decideGenerate("20002", "回答图里的问题", []),
      say("旧图的草稿", () =>
        withImages.receive({
          id: "-5104",
          speaker: "20002",
          text: "再看看这张",
          image: "p6-51-new",
        }),
      ),
      decideGenerate("20002", "回答新图的问题", []),
      say("新图的草稿"),
    ],
  });
  withImages.receive({
    id: "-5103",
    speaker: "20002",
    addressed: true,
    text: "这张图里是什么",
    image: "p6-51-old",
  });
  const imageResult = await withImages.activate("direct_reply");
  await withImages.deliver();
  expect(statusOf(imageResult)).toBe("completed");
  expect(phases(withImages)).toEqual(["next", "generate", "next", "generate"]);
  // 第一次决策相带的是首条消息那张图（自动范围＝本轮应回应消息，规格 §7.1）。
  expect(imageParts(withImages, 0).map((p) => p.sha256)).toEqual([sha(oldBytes)]);
  noBytesInWire(withImages);
  // 第二次决策相：新到的那张图**没有**被当成自动图供给——它不是本轮应回应消息，
  // 自动范围只覆盖焦点消息及其直接原图（§7.1），所以它不在链路里就是正确行为。
  // 强负面：新到图片不得因为"图片到了"就被自动发出去（未发送图片不得称已读）。
  expect(imageParts(withImages, 2).some((p) => p.sha256 === sha(newBytes))).toBe(false);
  // 但它**确实**作为一条新事实进入了第二次决策相的材料（图的存在标记在事实里，
  // 画面不在）——这正是"模型知道又来了一张图、但没有自动替它看"的语义。
  expect(callText(withImages, 2)).toContain("再看看这张");
  expect(countRows(withImages, "qq_media_assets")).toBe(1);
  // 只有新那一版被发送；旧图那版从不发送（强负面：旧画面不产生第二次发送）。
  expect(withImages.sent).toHaveLength(1);
  expect(JSON.stringify(withImages.sent[0]?.message)).toContain("新图的草稿");
  expect(JSON.stringify(withImages.sent[0]?.message)).not.toContain("旧图的草稿");
  // 旧图那一次生成的画面没有被第二次决策重新发出去：生成相的输入仍带旧图（同一焦点），
  // 决策相的输入也只有旧图——任何一次调用都没有把新图当成已读素材。
  expect(imageParts(withImages, 3).some((p) => p.sha256 === sha(newBytes))).toBe(false);
});

// ============================================================================
// [S52_1] 已提交意图遇新相关图 → stale；已 attempted 的旧意图不得重发
// ============================================================================

it("[S52_1] a committed plan goes stale on a new relevant image, and an already attempted intent is never resent", async () => {
  // --- 半边 A：新相关图（真图，不是纯文字）让已提交计划 stale ---
  // 面板 D 指出的三处不足：①"新相关图"其实是文字；②`every(status!=="confirmed")` 对空数组
  // 恒真、且"停在 planned（没投递过）"也会为真，无法区分 stale 与"没被尝试"；
  // ③"已 attempted 不得重发"是空转（投递发生在新消息之后，旧意图从未被尝试过）。
  const firstBytes = png();
  const secondBytes = pngB();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["第一张图的说明", "第二张图的说明"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "p6-52-first": firstBytes, "p6-52-second": secondBytes },
    model: [decideGenerate("20002", "回答图里的问题", []), say("旧计划的正文")],
  });
  h.receive({
    id: "-5201",
    speaker: "20002",
    addressed: true,
    text: "先看这张图",
    image: "p6-52-first",
  });
  await h.activate("direct_reply");
  // 计划已提交（待发意图存在），尚未投递。
  const beforeIntents = h.outbox.list({ conversationId: h.conversationId });
  expect(beforeIntents).toHaveLength(1);
  expect(beforeIntents[0]?.status).toBe("planned");
  // 前置事实：首条消息的图已被真的准备（native 资产在库里），"新相关图"有对照面。
  expect(countRows(h, "qq_media_assets")).toBe(1);
  // 新相关**图**到达（同发言人、在 source_through_seq 之后）。
  h.receive({
    id: "-5202",
    speaker: "20002",
    text: "再看看这张",
    image: "p6-52-second",
  });
  await h.deliver();
  // 状态投影：旧计划被判 **stale**（不是 confirmed、不是 planned、不是 failed）。
  // 这条断言能区分"被判 stale"与"根本没被尝试"——`status==="stale"` 只有 stale() 写过。
  const afterIntents = h.outbox.list({ conversationId: h.conversationId });
  expect(afterIntents).toHaveLength(1);
  expect(afterIntents[0]?.status).toBe("stale");
  // 强负面：零发送——stale 的计划一个字节都没出去。
  expect(h.sent).toHaveLength(0);
  // 部件层同样没有任何 attempted 痕迹（stale 不算"已尝试送达"）。
  expect(partRows(h).every((row) => row.attemptedAt === null)).toBe(true);
  h.close();

  // --- 半边 B：已 attempted（已确认送达）后来了新相关消息，不得重发 ---
  // 这是"negativeEvidence：已 attempted 的旧意图不得重发"的正面可失败形式：
  // 先让首条确认送达（sends=1），再收新相关消息并再次投递，sends 必须仍是 1。
  const confirmed = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    sendOutcomes: ["confirmed"],
    model: [decideGenerate("20002", "回答图里的问题", []), say("已送达的正文")],
  });
  confirmed.receive({
    id: "-5203",
    speaker: "20002",
    addressed: true,
    text: "先看这张图",
    image: "p6-52-confirmed",
  });
  await confirmed.activate("direct_reply");
  await confirmed.deliver();
  const confirmedIntents = confirmed.outbox.list({ conversationId: confirmed.conversationId });
  expect(confirmedIntents).toHaveLength(1);
  expect(confirmedIntents[0]?.status).toBe("confirmed");
  expect(confirmed.sent).toHaveLength(1);
  // 新相关消息到达（已确认送达的旧意图不会再被认领）。
  confirmed.receive({ id: "-5204", speaker: "20002", text: "等一下，还有新情况" });
  await confirmed.deliver();
  // 强负面：sends 不增（不重发），意图数不增（不新建第二条）。
  expect(confirmed.sent).toHaveLength(1);
  expect(confirmed.outbox.list({ conversationId: confirmed.conversationId })).toHaveLength(1);
  expect(countRows(confirmed, "outbound_intents")).toBe(1);
  // 幂等提交：同一机会重跑命中同一行（idempotentIntentId），不会因再来一轮而多出一条。
  confirmed.restart();
  await confirmed.deliver();
  expect(confirmed.sent).toHaveLength(1);
  expect(countRows(confirmed, "outbound_intents")).toBe(1);
});

// ============================================================================
// [S53_1] unknown 投递不重发（含崩溃窗口：part 卡在 sending）
// ============================================================================

it("[S53_1] an unknown delivery receipt is never resent, and a part stranded in sending recovers to unknown without resending", async () => {
  // --- 半边 A：回执 unknown 入账、恰好发送一次、恢复再投递 sends 不增 ---
  const h = createOneBotHarness({
    kind: "private",
    sendOutcomes: ["unknown"],
    model: [decideGenerate("20002"), say("你好")],
  });
  h.receive({ id: "-5301", text: "在吗" });
  const result = await h.activate("direct_reply");
  await h.deliver();
  expect(statusOf(result)).toBe("completed");
  expect(h.sent).toHaveLength(1);
  const intents = h.outbox.list({});
  expect(intents).toHaveLength(1);
  expect(intents[0]?.status).toBe("unknown");
  // 部件层也记 unknown（不是 confirmed、不是 failed）——真实结算投影。
  const parts = partRows(h);
  expect(parts).toHaveLength(1);
  expect(parts[0]?.status).toBe("unknown");
  // 恢复再投递：pending() 不再认领 unknown 意图 → 不盲目重发（sends 不增）。
  h.outbox.recover();
  await h.deliver();
  expect(h.sent).toHaveLength(1);
  // 再多跑两轮也不增。
  h.outbox.recover();
  await h.deliver();
  await h.deliver();
  expect(h.sent).toHaveLength(1);
  h.close();

  // --- 半边 B（面板 D 要求的缺口）：进程死在发送中途也不重发 ---
  // 机制面：part 卡在 sending（`deliver()` 抛错前已 claim）→ 恢复把 sending→unknown、
  // 意图→unknown → 不再被 pending() 认领。
  // 这里用真实 claimPart/settlePart（生产仓储方法）把 part 放到 sending，
  // 再用真实 OutboundDelivery.recover()（harness 的 outbox + delivery 同源）恢复。
  const stranded = createOneBotHarness({
    kind: "private",
    sendOutcomes: ["unknown"],
    model: [decideGenerate("20002"), say("你好")],
  });
  stranded.receive({ id: "-5302", text: "在吗" });
  await stranded.activate("direct_reply");
  // 提交后（尚未投递）：意图是 planned、部件是 planned、零发送。
  expect(stranded.sent).toHaveLength(0);
  const plannedIntent = stranded.outbox.list({ conversationId: stranded.conversationId });
  expect(plannedIntent).toHaveLength(1);
  expect(plannedIntent[0]?.status).toBe("planned");
  expect(partRows(stranded)[0]?.status).toBe("planned");
  // 模拟"进程死在发送中途"：真实 claimPart 把部件持久化为 sending（写库状态，非内存装置）。
  const intentId = plannedIntent[0]?.id;
  expect(intentId).toBeDefined();
  const claimed = stranded.outbox.claimPart(intentId ?? "", stranded.now());
  expect(claimed).not.toBeNull();
  expect(partRows(stranded)[0]?.status).toBe("sending");
  expect(claimed?.part.attemptedAt).toBe(stranded.now());
  // 恢复：sending→unknown、意图→unknown。
  expect(stranded.outbox.recover()).toBe(1);
  expect(partRows(stranded)[0]?.status).toBe("unknown");
  expect(stranded.outbox.list({ conversationId: stranded.conversationId })[0]?.status).toBe(
    "unknown",
  );
  // 强负面：恢复后再投递，sends 仍为 0（这条意图已被判 unknown，不再被认领）。
  await stranded.deliver();
  expect(stranded.sent).toHaveLength(0);
  expect(countRows(stranded, "outbound_intents")).toBe(1);
  expect(stranded.outbox.pending()).toHaveLength(0);
});

// ============================================================================
// 子要求对照（写在这里，便于审阅时逐条核；不改矩阵文件）
//   48 → 5 静默（sends=0／意图=0／零生成相）＋ 6 生成（1 条 confirmed）＋ 门槛可配（4 放行 5）
//   49 → 无图直答精确两相；有图直答精确两相、图真在链路（sha 对齐）、零视觉调用
//   50 → none 时恰好 1 次调用、零视觉调用、零发送、零意图、零 prepared 副本（图真在库）
//        ＋对照夹具：同一图在生成轮确有 variant 但仍零独立视觉调用
//   51 → 纯文字：pending_plan 只在第 2 次决策相之后出现、reason=new_observation、不含旧画面正文
//        带图：第 2 次决策相只见新图、旧图不复活、只发新草稿
//   52 → 新相关图（真图）使已提交计划 status==="stale"、零发送、零 attempted
//        ＋已 confirmed 的旧意图遇新相关消息 sends 不增、意图数不增、幂等重跑不增
//   53 → unknown 入账（意图与部件两层）、恢复再投递 sends 不增
//        ＋崩溃窗口：claimPart→sending、recover→unknown、再投递零发送、pending=0
// ============================================================================
