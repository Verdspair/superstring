// QQ 存储管理契约（ADR0018 §11.1）：设置读写、只含元数据的条目列表、按类别/选中行的清理。
//
// 与 `contracts/qq.ts` 分开的原因：那里是摘要（用量统计）与旧版五类清理响应，这里是
// 管理面的新形状。两边共享同一份保留边界常量，避免上限漂移。
//
// 契约级安全约束（列表与清理路由、仓储都必须遵守）：
// - 列表永不返回正文、URL、路径、token；到期与保护只由服务端时钟/既有表判定。
// - 清理只处理已到期行；`ids` 为空数组是 422，不是"全部"。

import { z } from "zod";
import { IsoTimestampSchema } from "./common";
import { QQ_RETENTION_MAX_DAYS, QQ_RETENTION_MIN_DAYS } from "./qq";

/** 存储模式固定 manual：到期让内容不可读，物理删除只能由手动清理显式执行。 */
export const QqStorageCleanupModeSchema = z.literal("manual");

export const QqStorageSettingsResponseSchema = z.strictObject({
  /** 与 `qq_settings` 其余字段共用同一修订号：两处编辑不同字段也必须互相察觉。 */
  revision: z.number().int().positive(),
  retention_days: z.number().int().min(QQ_RETENTION_MIN_DAYS).max(QQ_RETENTION_MAX_DAYS),
  cleanup_mode: QqStorageCleanupModeSchema,
});
export type QqStorageSettingsResponse = z.infer<typeof QqStorageSettingsResponseSchema>;

/** 可被管理/清理的存储类别：消息正文、媒体阅读记录、助手发言、发送台账、昵称。 */
export const QqStorageCategorySchema = z.enum([
  "observation_text",
  "media_notes",
  "speech",
  "sends",
  "nicknames",
]);
export type QqStorageCategory = z.infer<typeof QqStorageCategorySchema>;

export const QqStorageStatusFilterSchema = z.enum(["all", "live", "expired"]);
export type QqStorageStatusFilter = z.infer<typeof QqStorageStatusFilterSchema>;

/** 会话维度：与 `peer_id` 一起定位一条记录属于哪间群/私聊。 */
export const QqConversationKindSchema = z.enum(["group", "private"]);
export type QqConversationKind = z.infer<typeof QqConversationKindSchema>;

/**
 * 列表游标：上一页最后一条的 `(clock, id)`。
 *
 * 排序是每类自己的 clock 降序、id 降序；id 是行自身的稳定标识（nicknames 没有单列主键，
 * 用 `account:kind:peer:user` 复合编码并原样回传）。格式不合法的游标是 422，不静默回第一页。
 */
export const QqStorageCursorSchema = z.strictObject({
  clock: z.union([z.number().int(), IsoTimestampSchema]),
  id: z.string().min(1).max(256),
});
export type QqStorageCursor = z.infer<typeof QqStorageCursorSchema>;

export const QqStorageItemsQuerySchema = z.strictObject({
  category: QqStorageCategorySchema.default("observation_text"),
  status: QqStorageStatusFilterSchema.default("all"),
  peer_id: z.string().min(1).max(128).optional(),
  kind: QqConversationKindSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type QqStorageItemsQuery = z.infer<typeof QqStorageItemsQuerySchema>;

export const QqStorageItemSchema = z.strictObject({
  /** 行的稳定标识；nicknames 为 `account:kind:peer:user` 复合编码。 */
  id: z.string().min(1).max(256),
  category: QqStorageCategorySchema,
  account_id: z.string().min(1).max(128),
  kind: QqConversationKindSchema,
  peer_id: z.string().min(1).max(256),
  agent_id: z.string().min(1).max(128).nullable(),
  created_at: IsoTimestampSchema,
  expires_at: IsoTimestampSchema,
  /** 服务端时钟判定：到期即不可读（清理前仍物理留存）。 */
  expired: z.boolean(),
  /** 到期也不得清理的行：例如投递结果未知或仍关联进行中投递的发送记录。 */
  protected: z.boolean(),
});
export type QqStorageItem = z.infer<typeof QqStorageItemSchema>;

export const QqStorageItemsResponseSchema = z.strictObject({
  items: z.array(QqStorageItemSchema),
  next_cursor: z.string().nullable(),
  /** 与筛选条件一致的总条数（分页前）。 */
  total: z.number().int().nonnegative(),
});
export type QqStorageItemsResponse = z.infer<typeof QqStorageItemsResponseSchema>;

/** 清理选择：类别必须显式；`ids` 只在选中一部分行时出现，空数组是 422 而不是"全部"。 */
export const QqStorageCleanupRequestSchema = z.strictObject({
  category: QqStorageCategorySchema,
  ids: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
});
export type QqStorageCleanupRequest = z.infer<typeof QqStorageCleanupRequestSchema>;

export const QqStorageCleanupSelectionResponseSchema = z.strictObject({
  category: QqStorageCategorySchema,
  /** 选择范围内存在的行数（预览与执行同一口径）。 */
  matched: z.number().int().nonnegative(),
  /** 其中已到期的行数。 */
  expired: z.number().int().nonnegative(),
  /** 已到期但按保全规则不可清理的行数。 */
  protected: z.number().int().nonnegative(),
  /** 可清理数 = expired - protected。 */
  removable: z.number().int().nonnegative(),
  /** 实际移除数（预览恒为 0）。 */
  removed: z.number().int().nonnegative(),
});
export type QqStorageCleanupSelectionResponse = z.infer<
  typeof QqStorageCleanupSelectionResponseSchema
>;
