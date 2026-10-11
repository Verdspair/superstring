import { z } from "zod";

export const QQ_CONVERSATION_TASK_CLASS = ["mention", "ordinary"] as const;
export const QQ_CONVERSATION_TASK_CAUSE = [
  "direct_reply",
  "follow_up",
  "chiming_in",
  "idle_topic",
] as const;
export const QQ_CONVERSATION_TASK_STATUS = [
  "pending",
  "running",
  "completed",
  "no_output",
  "failed",
  "cancelled",
  "expired",
] as const;

export type QqConversationTaskClass = (typeof QQ_CONVERSATION_TASK_CLASS)[number];
export type QqConversationTaskCause = (typeof QQ_CONVERSATION_TASK_CAUSE)[number];
export type QqConversationTaskStatus = (typeof QQ_CONVERSATION_TASK_STATUS)[number];

export const QQ_CONVERSATION_TASK_LIMIT_DEFAULTS = Object.freeze({
  mentionTaskLimit: 4,
  ordinaryTaskLimit: 1,
  min: 1,
  max: 64,
});

export const QqTaskExecutionSnapshotSchema = z
  .strictObject({
    accountId: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
    bindingId: z.string().trim().min(1),
    bindingEpoch: z.number().int().positive(),
    agentId: z.string().trim().min(1),
    schemeId: z.string().trim().min(1),
    bindingRevision: z.number().int().positive(),
    authorityRevision: z.number().int().positive(),
    schemeRevision: z.number().int().positive(),
    agentConfigVersion: z.number().int().positive(),
    taskClass: z.enum(QQ_CONVERSATION_TASK_CLASS),
    cause: z.enum(QQ_CONVERSATION_TASK_CAUSE),
    sourceFromSeq: z.number().int().nonnegative(),
    sourceThroughSeq: z.number().int().nonnegative(),
    sourceExpiresAt: z.string().datetime().nullable(),
    authorizedTargets: z.array(z.string().trim().min(1)),
    targetParticipants: z.array(
      z.strictObject({
        targetId: z.string().trim().min(1),
        speakerId: z.string().trim().min(1).nullable(),
      }),
    ),
    maxSteps: z.number().int().positive(),
    deliveryTtlSeconds: z.number().int().positive(),
    mentionTaskLimit: z.number().int().positive(),
    ordinaryTaskLimit: z.number().int().positive(),
    taskKey: z.string().trim().min(1),
  })
  .refine(
    (value) => value.sourceFromSeq <= value.sourceThroughSeq,
    "Invalid QQ task snapshot source range",
  );
export type QqTaskExecutionSnapshot = z.infer<typeof QqTaskExecutionSnapshotSchema>;

export const QqConversationTaskLimitsSchema = z.strictObject({
  mentionTaskLimit: z
    .number()
    .int()
    .min(QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.min)
    .max(QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.max),
  ordinaryTaskLimit: z
    .number()
    .int()
    .min(QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.min)
    .max(QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.max),
});
export type QqConversationTaskLimits = z.infer<typeof QqConversationTaskLimitsSchema>;

export const QqConversationTaskClassSchema = z.enum(QQ_CONVERSATION_TASK_CLASS);
export const QqConversationTaskCauseSchema = z.enum(QQ_CONVERSATION_TASK_CAUSE);
export const QqConversationTaskStatusSchema = z.enum(QQ_CONVERSATION_TASK_STATUS);

export const QqConversationTaskSourceRangeSchema = z
  .strictObject({
    conversationId: z.string().trim().min(1),
    bindingEpoch: z.number().int().positive(),
    sourceFromSeq: z.number().int().nonnegative(),
    sourceThroughSeq: z.number().int().nonnegative(),
  })
  .refine((value) => value.sourceFromSeq <= value.sourceThroughSeq, "Invalid QQ task source range");

export function resolveQqConversationTaskLimits(
  value: QqConversationTaskLimits = {
    mentionTaskLimit: QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.mentionTaskLimit,
    ordinaryTaskLimit: QQ_CONVERSATION_TASK_LIMIT_DEFAULTS.ordinaryTaskLimit,
  },
): QqConversationTaskLimits {
  const parsed = QqConversationTaskLimitsSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid QQ conversation task limits");
  return Object.freeze(parsed.data);
}

/**
 * 并行任务上限的生效解析（0059）：绑定成员 null＝跟随方案，非 null＝本会话覆盖。
 * 参数只声明需要的形状（结构化类型），不反向 import `qq.ts`——那边已经引用本模块的
 * 类型化常量，运行时回环会成环。合成值仍过 `resolveQqConversationTaskLimits` 的契约
 * 校验，直接写 SQL 留下的越界行在这里失败，而不是被当成可用上限。
 */
export interface QqTaskLimitsSource {
  mention_task_limit: number;
  ordinary_task_limit: number;
}
export interface QqTaskLimitsOverride {
  mention_task_limit: number | null;
  ordinary_task_limit: number | null;
}

export function resolveQqEffectiveTaskLimits(
  scheme: QqTaskLimitsSource,
  binding: QqTaskLimitsOverride | null,
): QqConversationTaskLimits {
  return resolveQqConversationTaskLimits({
    mentionTaskLimit: binding?.mention_task_limit ?? scheme.mention_task_limit,
    ordinaryTaskLimit: binding?.ordinary_task_limit ?? scheme.ordinary_task_limit,
  });
}

/** 输入防抖的生效解析（0059）：同一 null＝跟随语义。 */
export function qqEffectiveInputAntiSpamEnabled(
  scheme: { enabled: boolean },
  binding: { enabled: boolean | null } | null,
): boolean {
  return binding?.enabled ?? scheme.enabled;
}

const identityKey = (parts: readonly string[]) => `qq-task:${JSON.stringify(parts)}`;

export const qqConversationTaskKey = Object.freeze({
  mention(input: {
    accountId: string;
    conversationId: string;
    bindingEpoch: number;
    platformMessageId: string;
    agentId: string;
  }): string {
    const parsed = z
      .strictObject({
        accountId: z.string().trim().min(1),
        conversationId: z.string().trim().min(1),
        bindingEpoch: z.number().int().positive(),
        platformMessageId: z.string().trim().min(1),
        agentId: z.string().trim().min(1),
      })
      .parse(input);
    return identityKey([
      "mention",
      parsed.accountId,
      parsed.conversationId,
      String(parsed.bindingEpoch),
      parsed.platformMessageId,
      parsed.agentId,
    ]);
  },
  ordinary(input: {
    conversationId: string;
    bindingEpoch: number;
    agentId: string;
    wakeId: string;
  }): string {
    const parsed = z
      .strictObject({
        conversationId: z.string().trim().min(1),
        bindingEpoch: z.number().int().positive(),
        agentId: z.string().trim().min(1),
        wakeId: z.string().trim().min(1),
      })
      .parse(input);
    return identityKey([
      "ordinary",
      parsed.conversationId,
      String(parsed.bindingEpoch),
      parsed.agentId,
      parsed.wakeId,
    ]);
  },
});
