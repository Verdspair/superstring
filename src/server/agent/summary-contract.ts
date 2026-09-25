import { z } from "zod";

const SummaryFactSchema = z.strictObject({
  kind: z.enum(["fact", "decision", "todo", "uncertainty"]),
  speaker: z.enum(["user", "assistant", "both"]),
  text: z.string().min(1),
  source_ids: z.array(z.string()).min(1),
});
export const SummaryResultSchema = z.strictObject({
  facts: z.array(SummaryFactSchema),
});

/** Frozen response shapes before per-call enum/maxItems restrictions are added. */
export const SUMMARY_RESULT_JSON_SCHEMA = {
  $defs: {
    SummaryFact: {
      additionalProperties: false,
      properties: {
        kind: {
          pattern: "^(fact|decision|todo|uncertainty)$",
          title: "Kind",
          type: "string",
        },
        speaker: {
          pattern: "^(user|assistant|both)$",
          title: "Speaker",
          type: "string",
        },
        text: { minLength: 1, title: "Text", type: "string" },
        source_ids: {
          items: { type: "string" },
          minItems: 1,
          title: "Source Ids",
          type: "array",
        },
      },
      required: ["kind", "speaker", "text", "source_ids"],
      title: "SummaryFact",
      type: "object",
    },
  },
  additionalProperties: false,
  properties: {
    facts: {
      items: { $ref: "#/$defs/SummaryFact" },
      title: "Facts",
      type: "array",
    },
  },
  required: ["facts"],
  title: "SummaryResult",
  type: "object",
} as const;
