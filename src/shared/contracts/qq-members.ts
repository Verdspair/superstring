import { z } from "zod";

export const QqMemberRoleSchema = z.enum(["owner", "admin", "member"]);
export type QqMemberRole = z.infer<typeof QqMemberRoleSchema>;

export const QqMemberSchema = z.strictObject({
  userId: z.string().regex(/^[1-9]\d*$/),
  nickname: z.string().optional(),
  groupCard: z.string().optional(),
  role: QqMemberRoleSchema.optional(),
  title: z.string().optional(),
  joinTimeSeconds: z.number().int().positive().optional(),
  lastSentTimeSeconds: z.number().int().positive().optional(),
  isSelf: z.boolean(),
});
export type QqMember = z.infer<typeof QqMemberSchema>;

export const QqMemberQuerySchema = z.strictObject({
  keyword: z.string().max(128).optional(),
  role: z.enum(["owner", "admin", "member", "unknown"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(128).optional(),
});
export type QqMemberQuery = z.infer<typeof QqMemberQuerySchema>;

export const QqMemberReadSchema = z.strictObject({
  userId: z.string().regex(/^[1-9]\d*$/),
});
export type QqMemberRead = z.infer<typeof QqMemberReadSchema>;

export const QQ_MEMBER_QUERY_PAGE_DEFAULT = 50;
export const QQ_MEMBER_QUERY_PAGE_MAX = 100;
