// QQ 事实/引用/时间/媒体上下文整合强测试。
//
// 全部用例走现有 OneBot harness 生产链（createOneBotHarness + scriptedModel），不复制第二条
// 模型链、不造假 service；每次断言都带精确的模型调用 phase 序列与发送条数。
// 判定按规格终态断言。

import { afterEach, expect, it } from "bun:test";
import { saveQqConversationSummary } from "../../src/server/db/qq-summary-repository";
import { DEFAULT_AGENT_ID } from "../../src/server/db/repositories";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { decideGenerate, decideInline, decideInvoke, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

const png = () => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);

/** 某次调用的完整输入文本拼接（模型可见材料的断言面）。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

const phaseList = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/**
 * 从资料信封里解出未转义的「QQ消息事实」渲染文本（msg=/focus= 行在此是原生 JSON，
 * 断言身份/mentions/replyTo/focus 用它，不吃转义干扰）。
 */
const factsSegments = (text: string): string[] => {
  const out: string[] = [];
  const pattern = /\{"facts":("(?:[^"\\]|\\.)*"),"kind":"qq_message_facts"/g;
  for (const match of text.matchAll(pattern)) {
    try {
      out.push(JSON.parse(match[1] ?? '""') as string);
    } catch {
      // 解不开的信封不伪造内容：跳过（外层断言自然会失败并留下现场）。
    }
  }
  return out;
};

const focusLines = (segments: readonly string[]): Record<string, unknown>[] =>
  segments.flatMap((segment) =>
    segment
      .split("\n")
      .filter((line) => line.startsWith("focus="))
      .map((line) => JSON.parse(line.slice("focus=".length)) as Record<string, unknown>),
  );

/** 某次调用输入里的 image part 计数（按 part 对象去重）。 */
const imagePartsOf = (h: OneBotHarness, index: number): number => {
  const seen = new Set<string>();
  for (const message of h.model?.receivedMessages[index]?.messages ?? []) {
    for (const part of message.content) {
      if (part.kind === "image") seen.add(JSON.stringify(part));
    }
  }
  return seen.size;
};

// ---------------------------------------------------------------------------
// S1 群身份双名＋有序 mentions＋focus 分离（规格 §3.1/§4.1/§4.2）
// ---------------------------------------------------------------------------

it("group facts carry both-name identity, ordered real mentions and separated focus", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  // 有序真实 at：先 20003 再 all；正文里的字面 "@20003" 不是平台 at 段。
  h.receive({
    id: "-201",
    speaker: "20002",
    text: "@20003 字面@20003 在吗？",
    addressed: true,
    mentions: ["20003", "all"],
    groupCard: "阿林",
    personalNickname: "林某",
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);

  const decision = callText(h, 0);
  const segments = factsSegments(decision);
  expect(segments.length).toBeGreaterThan(0);
  const facts = segments.join("\n");
  // 双名身份按「群名片优先」呈现（快照与当前映射分开，都是发送时/目录真值）。
  expect(facts).toContain('"displayName":"阿林"');
  expect(facts).toContain('"groupCard":"阿林"');
  expect(facts).toContain('"personalNickname":"林某"');
  // 时间线标签同口径：群名片优先＋真实 QQ 号（不用 Agent UUID）。
  expect(decision).toContain("阿林(20002)");
  // mentions 只来自真实 at 片段且保序：20003 在 all 之前；addressed 的平台 at 本账号
  // 是第三个真实 at；正文里的字面 "@20003" 不产生额外的 20003 mention。
  expect(facts.indexOf('"kind":"mention","qq":"20003"')).toBeGreaterThan(-1);
  expect(facts.indexOf('"kind":"mention","qq":"all"')).toBeGreaterThan(
    facts.indexOf('"kind":"mention","qq":"20003"'),
  );
  expect(facts.split('"kind":"mention"').length - 1).toBe(3);
  expect(facts.split('"kind":"mention","qq":"20003"').length - 1).toBe(1);
  expect(facts).toContain('"kind":"mention","qq":"90001"');
  // focus 与消息严格分开：应答对象 = 20002，助手 = 90001；焦点消息即平台 ID -201。
  const focus = focusLines(segments)[0] ?? {};
  expect(focus.responseQqs).toEqual(["20002"]);
  expect(focus.assistantQq).toBe("90001");
  expect(JSON.stringify(focus)).toContain("-201");
});

// ---------------------------------------------------------------------------
// S2 focus 直接引用原图进自动范围；窗口内无关图不被带看（规格 §7.1/§7.5）
// ---------------------------------------------------------------------------

it("auto image scope covers the direct quote root and excludes an unrelated window image", async () => {
  const image = png();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "root-image": image, "other-image": image },
    model: [decideGenerate("20003", "回答当前消息的图片问题", []), say("合成回复正文")],
  });
  // 根消息：20002 发图。
  h.receive({ id: "-301", speaker: "20002", text: "这是图", image: "root-image" });
  // 无关消息：20004 的另一张图（在窗口里，但不在 focus/direct 范围）。
  h.receive({ id: "-302", speaker: "20004", text: "别看这张", image: "other-image" });
  // 焦点：20003 回复根消息（直接引用）→ 根图进 direct 桶。
  h.receive({
    id: "-303",
    speaker: "20003",
    text: "这张图里有什么？",
    addressed: true,
    replyTo: "-301",
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 决策与生成的原生输入都带且只带根图（1 张；无关图不进）。
  expect(imagePartsOf(h, 0)).toBe(1);
  expect(imagePartsOf(h, 1)).toBe(1);
  // 无关图如实标「未读」，不冒充已理解。
  expect(callText(h, 0)).toContain("另有 1 项媒体未读");
  // 原生 part 只带来源元数据，无 bytes/base64。
  for (const call of h.model?.receivedMessages ?? []) {
    for (const message of call.messages) {
      for (const part of message.content) {
        if (part.kind === "image") {
          expect(Object.keys(part)).not.toContain("bytes");
          expect(Object.keys(part)).not.toContain("base64");
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// S3 configured_depth 不扩大自动图范围（规格 §7.1：引用层数增大不扩自动图像）
// ---------------------------------------------------------------------------

it("configured_depth two layers does not pull the depth-2 image into auto scope", async () => {
  const image = png();
  for (const replyMode of ["one_then_on_demand", "configured_depth"] as const) {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mediaEnabled: true,
      mergeWindowSeconds: 0,
      messageSettings: { reply_mode: replyMode, reply_depth: 2 },
      mediaInput: { mode: "native" },
      imageBytes: { "b-image": image, "a-image": image },
      model: [decideGenerate("20004", "回答", []), say("合成回复正文")],
    });
    // A（20002）发图 → B（20003）带图回复 A → C（20004）回复 B（焦点；depth1 根=B，depth2=A）。
    h.receive({ id: "-401", speaker: "20002", text: "A 图", image: "a-image" });
    h.receive({ id: "-402", speaker: "20003", text: "B 图", image: "b-image", replyTo: "-401" });
    h.receive({
      id: "-403",
      speaker: "20004",
      text: "问 B 的图",
      addressed: true,
      replyTo: "-402",
    });
    await h.activate("direct_reply");
    await h.deliver();
    expect(phaseList(h)).toEqual(["next", "generate"]);
    expect(h.sent).toHaveLength(1);
    // 两种模式一致：自动范围只含 direct（B 图）；depth-2 的 A 图不进、标未读。
    expect(imagePartsOf(h, 0)).toBe(1);
    expect(imagePartsOf(h, 1)).toBe(1);
    expect(callText(h, 0)).toContain("另有 1 项媒体未读");
    h.close();
  }
});

// ---------------------------------------------------------------------------
// S4a one_then_on_demand：窗口外直接引用不自动供正文；同 run 按需读取可见（规格 §4.3/§4.4）
// ---------------------------------------------------------------------------

it("one_then_on_demand does not auto-supply an out-of-window quote body but history.query preview reaches the same run", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [
      decideInvoke("history.query", { query: "续读原文标记XYZ" }),
      decideInline("20002", "基于引用的回答"),
    ],
  });
  // 窗口外根消息：唯一标记正文（私聊只记录 peer 的消息，填充也用 peer 并推进时钟防合并）。
  h.receive({ id: "-501", text: `续读原文标记XYZ${"很长的原始正文。".repeat(40)}` });
  for (let index = 0; index < 12; index++) {
    h.advance(3);
    h.receive({ id: `${-700 - index}`, text: `填充消息${index}` });
  }
  // 焦点：回复根消息（addressed → direct_reply）。
  h.receive({ id: "-502", text: "问一下上面那条", replyTo: "-501", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "next"]);
  expect(h.sent).toHaveLength(1);
  const first = callText(h, 0);
  const second = callText(h, 1);
  // 第一次决策：根正文未自动供入（one_then 只给关系，不给正文）。
  expect(first).not.toContain("续读原文标记XYZ");
  // 同 run 模型按需 history.query：命中项的正文前缀（预览）进入第二次决策输入。
  expect(second).toContain("续读原文标记XYZ");
});

// ---------------------------------------------------------------------------
// S4b configured_depth=2：窗口外直接引用正文应自动供入一层（规格 §4.3）。
// ---------------------------------------------------------------------------

it("configured_depth auto-supplies the direct quote body for an out-of-window root", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideInline("20002", "基于引用的回答")],
  });
  h.receive({ id: "-511", text: `自动展开标记ABC${"被引用的原始正文。".repeat(40)}` });
  for (let index = 0; index < 12; index++) {
    h.advance(3);
    h.receive({ id: `${-800 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-512", text: "问一下上面那条", replyTo: "-511", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next"]);
  expect(h.sent).toHaveLength(1);
  // configured_depth：直接层正文自动供入，不需要模型先调工具。
  expect(callText(h, 0)).toContain("自动展开标记ABC");
});

// ---------------------------------------------------------------------------
// S4b 负对（T11 S4b 修复轮新增）：configured_depth 自动供入路径的边界仍拒绝
// ---------------------------------------------------------------------------

it("configured_depth over-budget quote body is truncated at a unicode prefix with the relation kept", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "基于引用的回答"), say("合成回复正文")],
  });
  // 超预算根正文：头部/尾部各一个唯一标记，预算裁剪后只应出现头部前缀页。
  h.receive({
    id: "-521",
    text: `预算截断头HEAD${"被引用的原始正文。".repeat(20000)}预算截断尾TAIL`,
  });
  for (let index = 0; index < 12; index++) {
    h.advance(3);
    h.receive({ id: `${-900 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-522", text: "问一下上面那条", replyTo: "-521", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const decision = callText(h, 0);
  // 直接层按 Unicode 前缀供入预算内片段：头部标记在场，尾部标记不在场。
  expect(decision).toContain("预算截断头HEAD");
  expect(decision).not.toContain("预算截断尾TAIL");
  // 前缀页如实标 complete=false，不冒充完整原文（规格 §4.4）。
  expect(decision).toContain('"complete":false');
});

it("configured_depth does not auto-supply an expired quote body", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "基于引用的回答"), say("合成回复正文")],
  });
  h.receive({ id: "-531", text: `过期原文CONFIGEXPIRED${"早就该被清理的正文。".repeat(20)}` });
  // 推进 15 天（默认保留 14 天）：正文与事实均过期。
  h.advance(15 * 24 * 60 * 60);
  h.receive({ id: "-532", text: "引用过期消息", replyTo: "-531", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  for (let index = 0; index < (h.model?.calls.length ?? 0); index++) {
    expect(callText(h, index)).not.toContain("过期原文CONFIGEXPIRED");
    expect(callText(h, index)).not.toContain("早就该被清理的正文。");
  }
});

it("configured_depth does not auto-supply a cross-conversation quote body", async () => {
  // 别群：同账号不同群，唯一持有一条带机密正文的消息。
  const other = createOneBotHarness({
    accountId: "90001",
    member: "20002",
    peerId: "30013",
    model: [],
  });
  other.receive({ id: "-541", speaker: "20002", text: "别群机密CONFIGSECRET" });
  other.close();

  const h = createOneBotHarness({
    accountId: "90001",
    member: "20019",
    peerId: "30014",
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20019", "回答"), say("合成回复正文")],
  });
  h.receive({
    id: "-542",
    speaker: "20019",
    text: "configured_depth 引用别群试试",
    addressed: true,
    replyTo: "-541",
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  for (let index = 0; index < (h.model?.calls.length ?? 0); index++) {
    expect(callText(h, index)).not.toContain("别群机密CONFIGSECRET");
  }
});

// ---------------------------------------------------------------------------
// S4b 负对（审阅修复轮新增）：转义正文、深链多根、容量网格单调与窗口保全
// ---------------------------------------------------------------------------

it("escape-heavy quote body is byte-accounted and degrades without killing the run", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    capacity: 40000,
    messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
    model: [decideGenerate("20002", "基于引用的回答"), say("合成回复正文")],
  });
  // 引号/反斜杠/换行/制表在 JSON 序列化时都要转义成多字节——记账必须按渲染后实量。
  h.receive({
    id: "-521",
    text: `转义头HEAD"引号\\反斜杠\n换行\t制表${"被引用的原始正文。".repeat(3000)}转义尾TAIL`,
  });
  for (let index = 0; index < 12; index++) {
    h.advance(3);
    h.receive({ id: `${-900 - index}`, text: `填充消息${index}` });
  }
  h.receive({ id: "-522", text: "问一下上面那条", replyTo: "-521", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const decision = callText(h, 0);
  expect(decision).toContain("转义头HEAD");
  expect(decision).not.toContain("转义尾TAIL");
  expect(decision).toContain('"complete":false');
});

it("deep relation chains degrade metadata rows instead of failing the run", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "20002",
    capacity: 32000,
    messageSettings: { reply_mode: "configured_depth", reply_depth: 8 },
    model: [decideGenerate("20006", "回答", []), say("合成回复正文")],
  });
  // 窗口外根（唯一正文）＋窗口内 5 层链式引用（c1→根、c2→c1…c5→c4）＝6 条关系根。
  h.receive({
    id: "-541",
    speaker: "20001",
    text: `深链根正文CHAINROOT${"很长的原始正文。".repeat(40)}`,
  });
  h.receive({ id: "-542", speaker: "20002", text: "链一", replyTo: "-541" });
  h.receive({ id: "-543", speaker: "20003", text: "链二", replyTo: "-542" });
  h.receive({ id: "-544", speaker: "20004", text: "链三", replyTo: "-543" });
  h.receive({ id: "-545", speaker: "20005", text: "链四", replyTo: "-544" });
  h.receive({ id: "-546", speaker: "20006", text: "链五", replyTo: "-545" });
  h.advance(31);
  // 焦点：链六引用链五（链五等留在窗口内＝in_window；根/链一在窗口外）。
  h.receive({ id: "-547", speaker: "20006", text: "链六问一句", replyTo: "-546", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const decision = callText(h, 0);
  // 窗口文字绝不因引用段被挤掉（规格不变量 3）。
  expect(decision).toContain("链六问一句");
  expect(decision).toContain("链五");
  // 引用段存在且根正文只来自直接层链源（深链根正文，depth 1 的根）。
  expect(decision).toContain("qq_reply_roots");
  expect(decision).toContain("深链根正文CHAINROOT");
});

it("capacity grid stays monotonic: the window survives and quotes degrade gracefully", async () => {
  const body = `网格头HEAD${"被引用的原始正文。".repeat(3000)}网格尾TAIL`;
  let previousSupplied = -1;
  for (const capacity of [24000, 30000, 36000, 48000, 65536]) {
    const h = createOneBotHarness({
      accountId: "90001",
      peerId: "20002",
      kind: "private",
      capacity,
      messageSettings: { reply_mode: "configured_depth", reply_depth: 2 },
      model: [decideGenerate("20002", "基于引用的回答"), say("合成回复正文")],
    });
    h.receive({ id: "-521", text: body });
    for (let index = 0; index < 12; index++) {
      h.advance(3);
      h.receive({ id: `${-900 - index}`, text: `填充消息${index}` });
    }
    h.receive({ id: "-522", text: "问一下上面那条", replyTo: "-521", addressed: true });
    // 容量网格上任何一档都不得整轮失败（引用降级代替 CONTEXT_BUDGET_EXCEEDED）。
    await h.activate("direct_reply");
    await h.deliver();
    expect(phaseList(h)).toEqual(["next", "generate"]);
    expect(h.sent).toHaveLength(1);
    const decision = callText(h, 0);
    // 窗口与焦点文字不丢（不变量 3）。
    expect(decision).toContain("问一下上面那条");
    expect(decision).toContain("填充消息11");
    const supplied = (decision.match(/被引用的原始正文。/g) ?? []).length;
    // 供入量随容量单调不减（同一材料；更多容量不得反而供得更少）。
    expect(supplied).toBeGreaterThanOrEqual(previousSupplied);
    previousSupplied = supplied;
    h.close();
  }
});

// ---------------------------------------------------------------------------
// S5a 跨 scope 引用拒绝：别群平台 ID 不泄正文（规格 §4.3/§12）
// ---------------------------------------------------------------------------

it("a cross-conversation quote target leaks nothing and the run still completes", async () => {
  // 别群：同账号不同群，唯一持有一条带机密正文的消息。
  const other = createOneBotHarness({
    accountId: "90001",
    member: "20002",
    peerId: "30003",
    model: [],
  });
  other.receive({ id: "-601", speaker: "20002", text: "别群机密SECRETTEXT" });
  other.close();

  const h = createOneBotHarness({
    accountId: "90001",
    member: "20009",
    peerId: "30004",
    model: [decideGenerate("20009", "回答", []), say("合成回复正文")],
  });
  // 本群消息引用别群平台 ID：SQL 四元组过滤 → load null → root missing。
  h.receive({
    id: "-602",
    speaker: "20009",
    text: "引用别群试试",
    addressed: true,
    replyTo: "-601",
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 任何一次模型输入都不得出现别群正文。
  for (let index = 0; index < (h.model?.calls.length ?? 0); index++) {
    expect(callText(h, index)).not.toContain("SECRETTEXT");
  }
});

// ---------------------------------------------------------------------------
// S5b 缺失引用事实：关系保留、无伪造正文、整轮完成（规格 §4.3）
// ---------------------------------------------------------------------------

it("a missing quote target keeps the relation line without inventing a body", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-611", text: "引用一条从未存在的消息", replyTo: "-999", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  // 关系明确保留：replyTo 平台 ID 原样出现在事实段；不存在任何伪造正文行。
  const segments = factsSegments(callText(h, 0));
  expect(segments.join("\n")).toContain('"replyTo":{"platformMessageId":"-999"}');
});

// ---------------------------------------------------------------------------
// S5c 过期引用拒绝：正文过期后不泄原文（规格 §4.3/不变量5）
// ---------------------------------------------------------------------------

it("an expired quote target body is not supplied to the model", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-621", text: `过期原文EXPIREDTEXT${"早就该被清理的正文。".repeat(20)}` });
  // 推进 15 天（默认保留 14 天）：正文与事实均过期。
  h.advance(15 * 24 * 60 * 60);
  h.receive({ id: "-622", text: "引用过期消息", replyTo: "-621", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  for (let index = 0; index < (h.model?.calls.length ?? 0); index++) {
    expect(callText(h, index)).not.toContain("EXPIREDTEXT");
  }
});

// ---------------------------------------------------------------------------
// S6 判档不读水位包；回复档才装配（规格不变量4/ADR0019 §8.11）
// ---------------------------------------------------------------------------

const seedSummary = (h: OneBotHarness, marker: string): void => {
  const documentId = h.knowledge("水位包占位", "占位正文");
  const version = (
    h.db
      .query("SELECT content_version AS v FROM knowledge_documents WHERE id=?")
      .get(documentId) as { v: number }
  ).v;
  saveQqConversationSummary(h.orm, {
    conversationId: h.conversationId,
    agentId: DEFAULT_AGENT_ID,
    throughSeq: 0,
    coveredSeq: 0,
    packages: [
      {
        facts: [
          {
            kind: "fact",
            speaker: "20002",
            text: marker,
            source_ids: [JSON.stringify([["knowledge_document", documentId, String(version)]])],
          },
        ],
        fromSeq: 0,
        throughSeq: 0,
        fromSeconds: 0,
        throughSeconds: 0,
        at: h.now(),
      },
    ],
    modelName: "stub",
    configSnapshot: {},
    estimatedTokens: 8,
    at: h.now(),
    expected: null,
    assertCurrent: () => {},
  });
};

it("group judgement phase never sees watermark packages while the private reply phase does", async () => {
  // 群聊：决策档 = judgement → 不装摘要包（生成相是回复档，不在本断言面）。
  const group = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  seedSummary(group, "水位包标记PACKAGETEXT");
  group.receive({
    id: "-701",
    speaker: "20002",
    text: "普通聊天",
    addressed: true,
    groupCard: "阿林",
  });
  await group.activate("direct_reply");
  await group.deliver();
  expect(phaseList(group)).toEqual(["next", "generate"]);
  expect(group.sent).toHaveLength(1);
  const groupDecision = callText(group, 0);
  expect(groupDecision).not.toContain("水位包标记PACKAGETEXT");
  expect(groupDecision).not.toContain("qq_context_packages");
  group.close();

  // 私聊：决策档 = reply → 已存包按装配规则进入输入。
  const priv = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  seedSummary(priv, "水位包标记PACKAGETEXT");
  priv.receive({ id: "-702", text: "普通聊天", addressed: true });
  await priv.activate("direct_reply");
  await priv.deliver();
  expect(callText(priv, 0)).toContain("水位包标记PACKAGETEXT");
});

// ---------------------------------------------------------------------------
// S7 文字不被图挤：图独立于文字预算，窗口文字完整保留（规格不变量3/§11）
// ---------------------------------------------------------------------------

it("a native focus image rides along without crowding out any window text", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    capacity: 40000,
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "focus-image": png() },
    model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
  });
  h.receive({ id: "-801", text: "较早的窗口文字一" });
  h.receive({ id: "-802", text: "较早的窗口文字二" });
  h.receive({
    id: "-803",
    text: "不能挤掉的关键文字KEYTEXT",
    image: "focus-image",
    addressed: true,
  });
  await h.activate("direct_reply");
  await h.deliver();

  expect(phaseList(h)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  const decision = callText(h, 0);
  // 带图焦点消息的文字与更早窗口文字都完整在输入里：图不挤文字、不顶掉窗口。
  expect(decision).toContain("不能挤掉的关键文字KEYTEXT");
  expect(decision).toContain("较早的窗口文字一");
  expect(decision).toContain("较早的窗口文字二");
  // 图 part 同时在场：能力真实生效，而不是靠丢图保文字。
  expect(imagePartsOf(h, 0)).toBe(1);
  expect(imagePartsOf(h, 1)).toBe(1);
});
