import { z } from "zod";

/** A reference is not authority. Hosts resolve access and retention on every read. */
export const SourceRefSchema = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
  revision: z.string(),
  expiresAt: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const EvidenceSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  sources: z.array(SourceRefSchema),
  scope: z.string().optional(),
  score: z.number().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
