import { z } from "zod";

/** A reference is not authority. Hosts resolve access and retention on every read. */
export const SourceRefSchema = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
  revision: z.string(),
  expiresAt: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * 一次来源复验的三态结论：available＝当前可读；expired＝按保留期到期不可读；
 * revoked＝授权撤销/范围移动不可读。各来源 keeper（services/*-sources）与 agent 的
 * 来源复验共用同一份，三值字面量不得各自另拼。
 */
export type SourceAccess = "available" | "expired" | "revoked";

export const EvidenceSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  sources: z.array(SourceRefSchema),
  scope: z.string().optional(),
  score: z.number().optional(),
  preview: z.strictObject({ title: z.string(), summary: z.string() }).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
