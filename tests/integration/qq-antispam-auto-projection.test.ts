// Verify automatic image supply through the real OneBot host and context projection.
// Synthetic bytes and scripted model calls keep this test independent of external services.

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  batchScore,
  decideGenerate,
  decideInline,
  decideInvoke,
  decideNone,
  say,
} from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(() => {
  closeHarnesses();
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 某次调用输入的 image part（来源元数据，无 bytes/base64——协议红线一并核对）。 */
const imagePartsOf = (h: OneBotHarness, index: number): Array<{ sha256: string }> => {
  const out: Array<{ sha256: string }> = [];
  for (const message of h.model?.receivedMessages[index]?.messages ?? []) {
    for (const part of message.content) {
      if (part.kind === "image") {
        expect(Object.keys(part)).not.toContain("bytes");
        expect(Object.keys(part)).not.toContain("base64");
        expect(Object.keys(part)).not.toContain("url");
        expect(Object.keys(part)).not.toContain("path");
        out.push({ sha256: part.sha256 });
      }
    }
  }
  return out;
};

const phasesOf = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/** 事实原始行的 parts 快照（证明排除只动供给副本、不动任何记录）。 */
const factParts = (h: OneBotHarness): string[] =>
  (
    h.db
      .query("SELECT event_key AS eventKey, parts FROM qq_message_facts ORDER BY event_key")
      .all() as { eventKey: string; parts: string }[]
  ).map((row) => `${row.eventKey}\u0000${row.parts}`);

const statusOf = (result: unknown): string =>
  result !== null && typeof result === "object" && "status" in result
    ? String((result as { status: unknown }).status)
    : "missing";

interface BurstCaseOptions {
  readonly antiSpamEnabled: boolean;
  readonly ids: readonly [string, string, string];
}

/** 共同脚本：同 sender 三条无标记纯图 ≤3 秒；组代表（最后一张载体）即 chime 候选锚。 */
function setupBurst({ antiSpamEnabled, ids }: BurstCaseOptions) {
  const bytesA = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const bytesB = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(120), 8, 8);
  const bytesC = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(200), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "ap-1": bytesA, "ap-2": bytesB, "ap-3": bytesC },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  // 真实开关（DB 列，首条 wire 之前）：宿主 schemeInputAntiSpam 每轮现读，无快照失效。
  h.db
    .query("UPDATE qq_schemes SET input_anti_spam_enabled=? WHERE id=?")
    .run(antiSpamEnabled ? 1 : 0, h.scheme.id);
  // 三条纯图载体：text:null＝真纯图 wire（文字段整个缺席）；无 @、无引用。
  h.receive({ id: ids[0], speaker: "10001", text: null, image: "ap-1" });
  h.advance(1);
  h.receive({ id: ids[1], speaker: "10001", text: null, image: "ap-2" });
  h.advance(1);
  h.receive({ id: ids[2], speaker: "10001", text: null, image: "ap-3" });
  h.model?.push([
    batchScore([
      { targetId: "10001", score: 6, intent: "想回应刚才的图", sourceSeqs: [h.lastEventSeq] },
    ]),
    decideGenerate("10001", "回应刚才的图", []),
    say("主动回复正文"),
  ]);
  h.advance(31);
  return { h, bytesA, bytesB, bytesC };
}

// ---- [AP_1] ON：burst 命中 → 自动输入 0 图；原始行原样 -------------------------------------

it("[AP_1] antispam ON: a same-sender three-carrier burst yields zero automatic image parts while raw fact rows stay intact", async () => {
  const { h, bytesA, bytesB, bytesC } = setupBurst({
    antiSpamEnabled: true,
    ids: ["-9101", "-9102", "-9103"],
  });
  // 激活前快照：3 条载体事件、3 条事实、每条载体事实 parts 各含恰 1 个 image part。
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get()).toEqual({ n: 3 });
  const factsBefore = factParts(h);
  expect(factsBefore).toHaveLength(3);
  const imageBefore = factsBefore.filter((row) => row.includes('"kind":"image"'));
  expect(imageBefore).toHaveLength(3);
  for (const row of imageBefore) {
    const parts = JSON.parse(row.split("\u0000")[1] as string) as Array<{ kind: string }>;
    expect(parts.filter((part) => part.kind === "image")).toHaveLength(1);
  }

  const result = await h.activate("chiming_in");
  await h.deliver();

  // chime 机会真实走完（burst 组代表=最后一张载体仍是合法候选锚，不是机会消失）。
  expect(statusOf(result)).toBe("completed");
  expect(phasesOf(h)).toEqual(["next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 核心断言：三相模型输入 0 个 image part——burst 排除在真实 BotContextSource 供给链生效。
  expect(imagePartsOf(h, 0)).toHaveLength(0);
  expect(imagePartsOf(h, 1)).toHaveLength(0);
  expect(imagePartsOf(h, 2)).toHaveLength(0);
  // 排除发生在准备之前：图片从未被 fetch/登记，资产 0 行；三张受控字节不进任何链路。
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_assets").get()).toEqual({ n: 0 });
  for (const bytes of [bytesA, bytesB, bytesC]) {
    expect(JSON.stringify(h.model?.receivedMessages)).not.toContain(sha(bytes));
  }
  // 原始行原样：激活前后逐字一致（不删、不改、不重写 parts）。
  expect(factParts(h)).toEqual(factsBefore);
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
});

// ---- [AP_2] OFF 对照：同一脚本真实关开关 → 组代表载体图照常自动供入 ------------------------

it("[AP_2] antispam OFF control: the same burst script supplies the anchor carrier image into all phases", async () => {
  const { h, bytesC } = setupBurst({
    antiSpamEnabled: false,
    ids: ["-9201", "-9202", "-9203"],
  });
  const result = await h.activate("chiming_in");
  await h.deliver();

  expect(statusOf(result)).toBe("completed");
  expect(phasesOf(h)).toEqual(["next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 三相各真实携带锚图 1 个 image part（锚=burst 组代表/最后一张载体），sha=受控字节。
  expect(imagePartsOf(h, 0)).toEqual([{ sha256: sha(bytesC) }]);
  expect(imagePartsOf(h, 1)).toEqual([{ sha256: sha(bytesC) }]);
  expect(imagePartsOf(h, 2)).toEqual([{ sha256: sha(bytesC) }]);
  // OFF 侧图片真实被准备：恰 1 行资产、content sha=受控字节。
  const assets = h.db.query("SELECT content_sha256 AS sha FROM qq_media_assets").all() as {
    sha: string;
  }[];
  expect(assets).toEqual([{ sha: sha(bytesC) }]);
  // 原始行数量与 ON 同形：同一脚本产生同样 3 事件/3 事实——开关只影响供给，不删记录。
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 3 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get()).toEqual({ n: 3 });
  expect(factParts(h)).toHaveLength(3);
});

// ---- [AP_3] ON 正例：direct 断组边界后，合格带文图仍真实供入（非全局禁图） ------------------

it("[AP_3] antispam ON: an intervening direct breaker keeps a later eligible captioned image supplied", async () => {
  const captionBytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(88), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "ap-c": captionBytes },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.db.query("UPDATE qq_schemes SET input_anti_spam_enabled=? WHERE id=?").run(1, h.scheme.id);
  // 三张纯图载体 ≤3 秒（burst 命中）。
  h.receive({ id: "-9301", speaker: "10001", text: null, image: "ap-c" });
  h.advance(1);
  h.receive({ id: "-9302", speaker: "10001", text: null, image: "ap-c" });
  h.advance(1);
  h.receive({ id: "-9303", speaker: "10001", text: null, image: "ap-c" });
  h.advance(1);
  // 断组边界：同 sender 显式 @ 的 direct 文本，结算为 no_output（不进普通候选、纯作断组）。
  h.receive({ id: "-9304", speaker: "10001", text: "等一下，先看我这条", addressed: true });
  h.model?.push([decideNone()]);
  await h.activate("direct_reply");
  await h.deliver();
  expect(phasesOf(h)).toEqual(["next"]);
  expect(h.sent).toHaveLength(0);
  h.advance(1);
  // 合格正例：同 sender 带文字说明的图（非纯图载体、自身不成组）成为 chime 锚。
  h.receive({
    id: "-9305",
    speaker: "10001",
    text: "这张图上写的是什么AP3POSITIVE",
    image: "ap-c",
  });
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "想回答图上的问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答图上的问题", []),
    say("主动回复正文"),
  ]);
  h.advance(31);
  const result = await h.activate("chiming_in");
  await h.deliver();

  expect(statusOf(result)).toBe("completed");
  expect(phasesOf(h)).toEqual(["next", "next", "next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 防刷屏不是全局禁图：断组边界后的合格图真实进全部三相输入（sha=受控字节）。
  expect(imagePartsOf(h, 1)).toEqual([{ sha256: sha(captionBytes) }]);
  expect(imagePartsOf(h, 2)).toEqual([{ sha256: sha(captionBytes) }]);
  expect(imagePartsOf(h, 3)).toEqual([{ sha256: sha(captionBytes) }]);
  // 资产恰 1 行（只有合格图被准备）；原始 5 条事件、5 条事实全部原样保留。
  const assets = h.db.query("SELECT content_sha256 AS sha FROM qq_media_assets").all() as {
    sha: string;
  }[];
  expect(assets).toEqual([{ sha: sha(captionBytes) }]);
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_events").get()).toEqual({ n: 5 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get()).toEqual({ n: 5 });
});

it("[AP_4] antispam ON keeps an explicitly addressed pure-image focus readable", async () => {
  const image = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(144), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "ap-direct": image },
    model: [decideGenerate("10001", "回应直接请求", []), say("直接回复")],
  });
  h.db.query("UPDATE qq_schemes SET input_anti_spam_enabled=? WHERE id=?").run(1, h.scheme.id);
  for (const id of ["-9401", "-9402", "-9403"]) {
    h.receive({ id, speaker: "10001", text: null, image: "ap-direct" });
    h.advance(1);
  }
  h.receive({ id: "-9404", speaker: "10001", text: null, image: "ap-direct", addressed: true });
  const factsBefore = factParts(h);
  expect(factsBefore).toHaveLength(4);
  await h.activate("direct_reply");
  await h.deliver();
  expect(phasesOf(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  expect(imagePartsOf(h, 0)).toEqual([{ sha256: sha(image) }]);
  expect(imagePartsOf(h, 1)).toEqual([{ sha256: sha(image) }]);
  expect(factParts(h)).toEqual(factsBefore);
});

it("[AP_5] antispam excludes automatic burst images but leaves real on-demand tools readable", async () => {
  const image = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(96), 8, 8);
  const note = "ANTISPAM_ON_DEMAND_NOTE";
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "ap-tool": image },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    vision: [note],
    model: [],
  });
  h.db.query("UPDATE qq_schemes SET input_anti_spam_enabled=? WHERE id=?").run(1, h.scheme.id);
  let disclosedId: string | undefined;
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const id = observation.value?.items?.[0]?.id;
      if (typeof id !== "string") throw new Error("Missing listed burst image");
      disclosedId = id;
      return [decideInvoke("media.describe", { id })];
    }
    if (observation?.name === "media.describe") {
      expect(observation.value?.status).toBe("described");
      return [decideInvoke("media.note.read", { id: disclosedId })];
    }
    if (observation?.name === "media.note.read") return [decideInline("10001", "按需看图回复", [])];
    return null;
  });
  for (const id of ["-9501", "-9502", "-9503"]) {
    h.receive({ id, speaker: "10001", text: null, image: "ap-tool" });
    h.advance(1);
  }
  const factsBefore = factParts(h);
  h.model?.push([
    batchScore([{ targetId: "10001", score: 6, intent: "按需读取", sourceSeqs: [h.lastEventSeq] }]),
    decideInvoke("media.list", {}),
  ]);
  h.advance(31);
  expect(statusOf(await h.activate("chiming_in"))).toBe("completed");
  await h.deliver();
  expect(imagePartsOf(h, 0)).toHaveLength(0);
  expect(imagePartsOf(h, 1)).toHaveLength(0);
  expect(h.visionCalls).toHaveLength(1);
  expect(disclosedId).toBeDefined();
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.model?.receivedMessages)).toContain(note);
  expect(h.db.query("SELECT status,attempts FROM qq_media_read_tasks").all()).toEqual([
    { status: "succeeded", attempts: 1 },
  ]);
  const sources = h.runs
    .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
    .flatMap((run) => run.steps.flatMap((step) => h.runs.getContext(step.context)?.sources ?? []));
  expect(sources.some((source) => source.kind === "qq_media_read_task")).toBe(true);
  expect(factParts(h)).toEqual(factsBefore);
});

// ---- [AP_6] ON：纯表情载体的明确细问读取成功后，generation 相必须真实供图（explicit 例外） ----

it("[AP_6] antispam ON: a question-anchored media.read of a pure-expression carrier supplies the picture into the generation phase", async () => {
  const bytes = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(52), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "ap-expr": bytes },
    model: [],
  });
  h.db.query("UPDATE qq_schemes SET input_anti_spam_enabled=? WHERE id=?").run(1, h.scheme.id);
  // 载体：平台三键证据（数值 emoji_package_id 形态）纯表情图，text:null＝真纯图 wire，无 @、
  // 无引用——非 direct 纯表情行（antispam 纯表情面排除对象），其 direct 属性不随后续问题改变。
  h.receive({
    id: "-9601",
    speaker: "10001",
    text: null,
    image: "ap-expr",
    imageHint: { emoji_id: "expr", emoji_package_id: 8, summary: "[expression]" },
  });
  // 当前问题：同 sender 文本请求、真实引用载体（reply 平台 ID）并显式 @（direct focus）；
  // questionMessageId="-9602" 是本轮合法 current platform ID，图在直接引用目标上仍可锚。
  h.receive({
    id: "-9602",
    speaker: "10001",
    text: "再看这张图",
    replyTo: "-9601",
    addressed: true,
  });
  const factsBefore = factParts(h);
  let disclosedId: string | undefined;
  let readOk = false;
  driveToolFirst(h, (observation) => {
    if (observation?.name === "media.list") {
      const id = observation.value?.items?.[0]?.id;
      if (typeof id !== "string") throw new Error("Missing listed expression image");
      disclosedId = id;
      return [decideInvoke("media.read", { id, questionMessageId: "-9602" })];
    }
    if (observation?.name === "media.read") {
      // 读取必须真实 ok（prepared 元数据在观察里）；invalid_selection/refuse 不许冒充 RED。
      expect(observation.value?.status).toBe("ok");
      readOk = true;
      return [decideGenerate("10001", "回答表情细节", []), say("合成回复正文")];
    }
    return null;
  });
  h.model?.push([decideInvoke("media.list", {})]);
  await h.activate("direct_reply");
  await h.deliver();

  // 流程真实走完：media.list 披露、media.read ok、回复已发送——不是 selection 失败的空转。
  expect(disclosedId).toBeDefined();
  expect(readOk).toBe(true);
  expect(h.sent).toHaveLength(1);
  const phases = phasesOf(h);
  expect(phases[phases.length - 1]).toBe("generate");
  // 读取前的 decision 相：纯表情自动供给排除真实生效——0 个 image part。
  expect(imagePartsOf(h, 0)).toHaveLength(0);
  // 细问读取成功后 generation 相必须真实携带该图（规格 §7 显式按需读取不受防刷屏限制）。
  expect(imagePartsOf(h, phases.length - 1)).toEqual([{ sha256: sha(bytes) }]);
  // 读取真发生：资产恰 1 行＝受控字节；原始事实行逐字不变（排除只动供给副本）。
  const assets = h.db.query("SELECT content_sha256 AS s FROM qq_media_assets").all() as {
    s: string;
  }[];
  expect(assets).toEqual([{ s: sha(bytes) }]);
  expect(factParts(h)).toEqual(factsBefore);
});
