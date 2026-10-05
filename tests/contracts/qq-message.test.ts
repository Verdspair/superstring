// QQ 消息事实与消息设置契约（T01）：默认值锁定、严格字段、真实 IANA 时区验证。
// §2.3 的类型逐字沿用，由编译期钉子（Equal/Expect）钉住 schema 推导与声明类型的一致性。

import { expect, test } from "bun:test";
import type * as z from "zod";
import {
  QQ_MEDIA_INPUT_DEFAULT,
  QqMediaInputSettingsSchema,
} from "../../src/shared/contracts/qq-media-input";
import {
  QQ_MESSAGE_SETTINGS_DEFAULT,
  type QqConversationScope,
  QqConversationScopeSchema,
  type QqIdentity,
  QqIdentitySchema,
  type QqMessageFact,
  QqMessageFactSchema,
  type QqMessageFocus,
  QqMessageFocusSchema,
  type QqMessagePart,
  QqMessagePartSchema,
  type QqMessageSettings,
  QqMessageSettingsSchema,
  type QqReplyMode,
  type QqTimeDisplay,
} from "../../src/shared/contracts/qq-message";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

test("approved defaults and boundaries", () => {
  // 计划 T01 Step1 锚点测试（逐字）：默认值 toEqual、reply_depth=9 拒、伪时区拒、stages 额外键拒。
  expect(QQ_MESSAGE_SETTINGS_DEFAULT).toEqual({
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  });
  expect(QQ_MEDIA_INPUT_DEFAULT).toEqual({
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
    expression_max_dimension: 512,
    expression_frame_count: 3,
    expression_frame_max_dimension: 512,
  });
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, reply_depth: 9 }).success,
  ).toBe(false);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, timezone: "Not/AZone" })
      .success,
  ).toBe(false);
  expect(
    QqMediaInputSettingsSchema.safeParse({
      ...QQ_MEDIA_INPUT_DEFAULT,
      stages: { decision: true, evaluation: true, generation: true, extra: true },
    }).success,
  ).toBe(false);
});

test("message settings 严格拒绝额外字段，边界 1–8，真实时区通过", () => {
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, extra: 1 }).success,
  ).toBe(false);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, reply_depth: 0 }).success,
  ).toBe(false);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, reply_depth: 1 }).success,
  ).toBe(true);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, reply_depth: 8 }).success,
  ).toBe(true);
  expect(
    QqMessageSettingsSchema.safeParse({
      reply_mode: "configured_depth",
      reply_depth: 2,
      time_display: "full_relative",
      timezone: "Asia/Shanghai",
    }).success,
  ).toBe(true);
  expect(
    QqMessageSettingsSchema.safeParse({
      ...QQ_MESSAGE_SETTINGS_DEFAULT,
      reply_mode: "instant",
    }).success,
  ).toBe(false);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, timezone: "" }).success,
  ).toBe(false);
  expect(
    QqMessageSettingsSchema.safeParse({ ...QQ_MESSAGE_SETTINGS_DEFAULT, timezone: "UTC" }).success,
  ).toBe(true);
});

test("QqIdentitySchema：身份来源非 empty，双昵称与 currentName 可选", () => {
  const identity: QqIdentity = {
    role: "member",
    qq: "10001",
    groupCard: "阿林",
    personalNickname: "林某",
    legacyDisplayName: null,
    nameState: "known",
  };
  expect(QqIdentitySchema.parse(identity)).toEqual(identity);
  expect(
    QqIdentitySchema.parse({
      ...identity,
      currentName: { groupCard: null, personalNickname: "林某" },
    }).currentName,
  ).toEqual({ groupCard: null, personalNickname: "林某" });
  // 空字符串不是身份：qq、双昵称非空才收。
  expect(QqIdentitySchema.safeParse({ ...identity, qq: "" }).success).toBe(false);
  expect(QqIdentitySchema.safeParse({ ...identity, personalNickname: "" }).success).toBe(false);
  expect(QqIdentitySchema.safeParse({ ...identity, extra: 1 }).success).toBe(false);
  expect(QqIdentitySchema.safeParse({ ...identity, role: "moderator" }).success).toBe(false);
});

test("QqIdentitySchema：来源字段不进共享契约，extra 严格拒绝", () => {
  const identity: QqIdentity = {
    role: "member",
    qq: "10001",
    groupCard: "阿林",
    personalNickname: "林某",
    legacyDisplayName: null,
    nameState: "known",
  };
  expect(QqIdentitySchema.safeParse({ ...identity, groupCardSource: "wire" }).success).toBe(false);
  expect(QqIdentitySchema.safeParse({ ...identity, personalNicknameSource: "local" }).success).toBe(
    false,
  );
});

test("QqMessagePartSchema：五种部件，图片分类只能取三类", () => {
  const parts: QqMessagePart[] = [
    { kind: "text", text: "你不是就在南京吗？" },
    { kind: "mention", qq: "10002" },
    { kind: "mention", qq: "all" },
    { kind: "face", id: "74", name: "可爱" },
    { kind: "face", id: "74", name: null },
    { kind: "image", mediaId: "image1", category: "expression" },
    { kind: "unavailable", type: "forward" },
  ];
  for (const part of parts) {
    expect(QqMessagePartSchema.parse(part)).toEqual(part);
  }
  expect(
    QqMessagePartSchema.safeParse({ kind: "image", mediaId: "i", category: "sticker" }).success,
  ).toBe(false);
  expect(QqMessagePartSchema.safeParse({ kind: "text", text: "x", url: "https://x" }).success).toBe(
    false,
  );
  expect(QqMessagePartSchema.safeParse({ kind: "voice" }).success).toBe(false);
});

test("QqMessageFactSchema：关系事实完整形状，严格拒绝额外字段", () => {
  const fact: QqMessageFact = {
    id: "m102",
    platformMessageId: "-102",
    seq: 2,
    occurredAtSeconds: 1790920785,
    speaker: {
      role: "member",
      qq: "10001",
      groupCard: "阿林",
      personalNickname: "林某",
      legacyDisplayName: null,
      nameState: "known",
    },
    parts: [{ kind: "text", text: "你不是就在南京吗？" }],
    mentions: [
      { qq: "10002", identity: null },
      {
        qq: "10002",
        identity: {
          role: "member",
          qq: "10002",
          groupCard: "小周",
          personalNickname: "周同学",
          legacyDisplayName: null,
          nameState: "known",
        },
      },
    ],
    replyTo: { platformMessageId: "-101" },
    sources: [{ kind: "qq_message_fact", id: "m102", revision: "1" }],
    completeness: "full",
  };
  expect(QqMessageFactSchema.parse(fact)).toEqual(fact);
  expect(QqMessageFactSchema.safeParse({ ...fact, extra: true }).success).toBe(false);
  expect(QqMessageFactSchema.safeParse({ ...fact, platformMessageId: "" }).success).toBe(false);
  expect(QqMessageFactSchema.safeParse({ ...fact, seq: 1.5 }).success).toBe(false);
  // replyTo 为 null 与平台 ID 为 null 都是合法状态；缺字段不行。
  expect(
    QqMessageFactSchema.safeParse({
      ...fact,
      platformMessageId: null,
      replyTo: null,
      sources: [],
    }).success,
  ).toBe(true);
});

test("QqConversationScopeSchema 与 QqMessageFocusSchema：作用域七元组与焦点", () => {
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
  expect(QqConversationScopeSchema.parse(scope)).toEqual(scope);
  expect(QqConversationScopeSchema.safeParse({ ...scope, bindingEpoch: 0 }).success).toBe(false);
  expect(QqConversationScopeSchema.safeParse({ ...scope, authorityRevision: 0 }).success).toBe(
    false,
  );
  expect(QqConversationScopeSchema.safeParse({ ...scope, extra: 1 }).success).toBe(false);
  const focus: QqMessageFocus = {
    triggerMessageIds: ["m102"],
    responseMessageIds: ["m102"],
    responseQqs: ["10001"],
    assistantQq: "90001",
  };
  expect(QqMessageFocusSchema.parse(focus)).toEqual(focus);
  expect(QqMessageFocusSchema.safeParse({ ...focus, extra: 1 }).success).toBe(false);
});

test("§2.3 类型与 schema 推导逐字一致（编译期钉子）", () => {
  const pins = {
    timeDisplay: true as Expect<Equal<QqTimeDisplay, "full" | "full_relative" | "hybrid">>,
    replyMode: true as Expect<Equal<QqReplyMode, "one_then_on_demand" | "configured_depth">>,
    settings: true as Expect<Equal<QqMessageSettings, z.infer<typeof QqMessageSettingsSchema>>>,
    identity: true as Expect<Equal<QqIdentity, z.infer<typeof QqIdentitySchema>>>,
    part: true as Expect<Equal<QqMessagePart, z.infer<typeof QqMessagePartSchema>>>,
    fact: true as Expect<Equal<QqMessageFact, z.infer<typeof QqMessageFactSchema>>>,
    scope: true as Expect<Equal<QqConversationScope, z.infer<typeof QqConversationScopeSchema>>>,
    focus: true as Expect<Equal<QqMessageFocus, z.infer<typeof QqMessageFocusSchema>>>,
  };
  expect(Object.values(pins).every((pin) => pin === true)).toBe(true);
});
