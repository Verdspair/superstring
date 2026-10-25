// 增量贡献指导：本文件只依赖既有导出（buildQqPrompt / qqPromptMessages /
// qqReplaceOutputRule / 判断读取），按行为不变量断言程序拥有的自主路径指导，
// 不钉整句文案。
// 绿色不代表真实模型在语义上不再重复——语义判断仍归模型，本契约只保证指导真实进入
// 判断与回复两档的自主路径，且不改既有评分、输出替换与用户可编辑提示词契约。

import { describe, expect, it } from "bun:test";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
  QQ_JUDGEMENT_SCORE_RULE,
  QQ_PROMPT_DEFAULTS,
  QQ_REPLY_ENVELOPE_OUTPUT_RULE,
  type QqPromptPath,
  type QqPromptStage,
  qqJudgeAllowsSpeech,
  qqJudgeOutcome,
  qqPromptMessages,
  qqReplaceOutputRule,
  TIER_OUTPUT_RULES,
} from "../../src/server/services/qq-prompt-contract";

const message = {
  occurredAtSeconds: 90,
  speaker: "member" as const,
  speakerId: "20002",
  text: "今天南京多少度？",
  mediaNotes: [],
  mediaUnread: 0,
};

function build(tier: QqPromptStage, path: QqPromptPath, prompts: unknown = QQ_PROMPT_DEFAULTS) {
  return buildQqPrompt({
    tier,
    path,
    persona: "已编译人设",
    prompts,
    timeline: [message],
    nowSeconds: 100,
  });
}

const pathBody = (tier: QqPromptStage, path: QqPromptPath, prompts?: unknown) =>
  build(tier, path, prompts).find((s) => s.origin === "path")?.body ?? "";

/**
 * 增量贡献指导必须讲清的行为概念（语义关键词级断言，同源措辞允许微调）：
 *  - 比较在飞与已送达的工作，而不是只看新消息本身；
 *  - 新 seq／新说话人／接续不自动构成新贡献；
 *  - 同一个问题已有任务在答，不再补一条空话；
 *  - 独立的新问题与纠正照常保留；
 *  - 公开意图是意图不是送达；unknown 不等于已回答，也不能当安全重放的理由。
 */
const CONTRIBUTION_CONCEPTS: readonly (readonly [string, RegExp])[] = [
  ["比较在飞中的工作", /在飞|尚未送达|还没送达|未(送达|发出)/],
  ["比较已送达的工作", /已送达|已确认|已经?(送达|发出)/],
  ["接续不自动等于新贡献", /不自动等于|不(必然|一定|自动)?(构成|算|是)新/],
  ["新话头或新增价值措辞", /新话头|新增(价值|贡献|信息)/],
  ["同一问题已在回答不再补空话", /已经在?回答|正在回答|同一?(个|样的?)问题/],
  ["独立问题与纠正照常保留", /独立|照常|仍然(可以|允许|保留)|不(受|受不)影响/],
  ["纠正仍然合法", /纠正|更正/],
  ["公开意图不等于送达", /公开意图|declaredIntents/],
  ["unknown 不等于已回答", /unknown|未知/],
  ["不因未确认而重放", /不(要|会|能)?(因为|因).{0,8}(重发|重放|再来)|不重发|不重放/],
];

const AUTONOMY_PATHS = ["chiming_in", "idle_topic"] as const;
const DIRECT_PATHS = ["direct_reply", "follow_up"] as const;

describe("incremental contribution guidance (autonomy paths, program-owned)", () => {
  it("reaches judgement and reply of both autonomy paths while keeping the existing scene line", () => {
    for (const path of AUTONOMY_PATHS) {
      for (const tier of ["judgement", "reply"] as const) {
        const body = pathBody(tier, path);
        // 既有「本次场景」行逐字保留：指导是**追加**，不替换场景说明。
        expect(body).toContain("本次场景");
        for (const [concept, pattern] of CONTRIBUTION_CONCEPTS) {
          const matched = pattern.test(body);
          expect(matched, `${path}/${tier} 缺少概念「${concept}」`).toBe(true);
        }
        // 固定字面量：同一输入两次装配逐字一致（供应商 prompt 前缀稳定性）。
        expect(pathBody(tier, path)).toBe(body);
      }
    }
  });

  it("stays out of direct_reply and follow_up and leaves constraints and score rubric byte-unchanged", () => {
    for (const path of DIRECT_PATHS) {
      for (const tier of ["judgement", "reply"] as const) {
        const body = pathBody(tier, path);
        for (const [, pattern] of CONTRIBUTION_CONCEPTS) expect(body).not.toMatch(pattern);
        // 直接路径场景行不得被顺带改写。
        expect(body).toContain("本次场景");
      }
    }
    // 输出要求与打分口径是共享契约：指导不进入这两段，也不改它们的字面。
    for (const tier of ["judgement", "reply", "review", "sticker", "media"] as const) {
      const sections = build(tier, "chiming_in");
      expect(sections.find((s) => s.origin === "constraints")?.body).toBe(TIER_OUTPUT_RULES[tier]);
      const scoring = sections.find((s) => s.origin === "scoring");
      if (tier === "judgement") expect(scoring?.body).toBe(QQ_JUDGEMENT_SCORE_RULE);
      else expect(scoring).toBeUndefined();
    }
  });

  it("renders custom saved prompts verbatim with the guidance alongside as program-owned text", () => {
    const prompts = {
      ...QQ_PROMPT_DEFAULTS,
      judge: "自定义判断任务：只看这一句。",
      reply: "自定义回复任务：只看这一句。",
    };
    for (const [tier, slot] of [
      ["judgement", "judge"],
      ["reply", "reply"],
    ] as const) {
      const sections = build(tier, "chiming_in", prompts);
      // 用户可编辑槽位原样进 task 段，不拼接、不改写。
      expect(sections.find((s) => s.origin === "task")?.body).toBe(prompts[slot]);
      // 指导是程序拥有的，进 path 段而不是用户槽位；自定义方案仍然拿到它。
      const body = sections.find((s) => s.origin === "path")?.body ?? "";
      for (const [, pattern] of CONTRIBUTION_CONCEPTS) expect(body).toMatch(pattern);
      expect(body).not.toContain("自定义");
    }
  });

  it("keeps native envelope output-rule replacement exact with the guidance preserved", () => {
    for (const [tier, rule] of [
      ["judgement", QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE],
      ["reply", QQ_REPLY_ENVELOPE_OUTPUT_RULE],
    ] as const) {
      const sections = build(tier, "chiming_in");
      const messages = qqPromptMessages(sections).map((m) => ({
        role: m.role,
        content: [{ kind: "text" as const, text: m.content }],
      }));
      const replaced = qqReplaceOutputRule(messages, tier, rule);
      const systemText =
        replaced.find((m) => m.role === "system")?.content[0]?.kind === "text"
          ? (
              replaced.find((m) => m.role === "system")!.content[0] as {
                kind: "text";
                text: string;
              }
            ).text
          : "";
      const userText =
        replaced.find((m) => m.role === "user")?.content[0]?.kind === "text"
          ? (replaced.find((m) => m.role === "user")!.content[0] as { kind: "text"; text: string })
              .text
          : "";
      // plain 要求恰好被整段替换一次；程序指导原样保留在 system 面。
      expect(systemText).toContain(rule);
      expect(systemText).not.toContain(TIER_OUTPUT_RULES[tier]);
      for (const [, pattern] of CONTRIBUTION_CONCEPTS) expect(systemText).toMatch(pattern);
      // 用户数据（时间线）从不因输出替换改动，也从不进入 system 面。
      expect(userText).toContain("今天南京多少度？");
      expect(systemText).not.toContain("今天南京多少度？");
    }
  });

  it("keeps the recipient target line on autonomy paths when replying to named or anonymous speakers", () => {
    // 回归：指导只能**追加**在原有场景行之后，绝不能提前 return 掉「这一轮你要回的是…」。
    const named = buildQqPrompt({
      tier: "reply",
      path: "chiming_in",
      persona: "已编译人设",
      prompts: QQ_PROMPT_DEFAULTS,
      timeline: [message],
      nowSeconds: 100,
      replyingTo: { speakerId: "20002", label: "群友 小明(20002)" },
    });
    const namedScene = named.find((s) => s.origin === "path")?.body ?? "";
    expect(namedScene).toContain("这一轮你要回的是 群友 小明(20002)");
    expect(namedScene).toContain("开头会由程序 @ 他");
    for (const [, pattern] of CONTRIBUTION_CONCEPTS) expect(namedScene).toMatch(pattern);

    const anonymous = buildQqPrompt({
      tier: "reply",
      path: "chiming_in",
      persona: "已编译人设",
      prompts: QQ_PROMPT_DEFAULTS,
      timeline: [message],
      nowSeconds: 100,
      replyingTo: { speakerId: null, label: "匿名群友" },
    });
    const anonScene = anonymous.find((s) => s.origin === "path")?.body ?? "";
    expect(anonScene).toContain("这一轮你要回的是 匿名群友");
    expect(anonScene).not.toContain("开头会由程序 @ 他");
    for (const [, pattern] of CONTRIBUTION_CONCEPTS) expect(anonScene).toMatch(pattern);
  });

  it("does not clamp the score: a continuation still clears the scheme threshold like any verdict", () => {
    // 语义去重不归程序：score 6 / frozen minScore 2 仍由既有阈值契约决定；
    // 指导只能影响模型，不能在程序侧放行或拦截。
    const outcome = qqJudgeOutcome(JSON.stringify({ score: 6, reason: "接续补充" }));
    expect(qqJudgeAllowsSpeech(outcome, 2)).toBe(true);
    expect(qqJudgeAllowsSpeech(qqJudgeOutcome(JSON.stringify({ score: 1 })), 2)).toBe(false);
    expect(qqJudgeAllowsSpeech({ kind: "unreadable" }, 0)).toBe(false);
  });
});
