import {
  AGENT_DECISION_JSON_SCHEMA,
  parseAgentDecision,
} from "../../../shared/contracts/agent-output";

function withoutFinalStickerChoice(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  const branches = clone.oneOf;
  if (!Array.isArray(branches)) throw new Error("QQ_DECISION_SCHEMA_SHAPE_INVALID");
  for (const branchValue of branches) {
    const branch = branchValue as Record<string, unknown>;
    const properties = branch.properties as Record<string, unknown> | undefined;
    if ((properties?.kind as Record<string, unknown> | undefined)?.const !== "final") continue;
    const output = properties?.outputs as Record<string, unknown> | undefined;
    const items = output?.items as Record<string, unknown> | undefined;
    const variants = items?.oneOf ?? items?.anyOf;
    if (!Array.isArray(variants)) throw new Error("QQ_FINAL_OUTPUT_SCHEMA_SHAPE_INVALID");
    for (const variantValue of variants) {
      const variant = variantValue as Record<string, unknown>;
      const itemProperties = variant.properties as Record<string, unknown> | undefined;
      if (itemProperties) delete itemProperties.stickerIds;
      if (Array.isArray(variant.required))
        variant.required = variant.required.filter((key) => key !== "stickerIds");
    }
  }
  return clone;
}

export const QQ_DECISION_JSON_SCHEMA = withoutFinalStickerChoice(AGENT_DECISION_JSON_SCHEMA);

export const QQ_DECISION_ENVELOPE_SCHEMA: Record<string, unknown> = {
  ...QQ_DECISION_JSON_SCHEMA,
  oneOf: ((QQ_DECISION_JSON_SCHEMA.oneOf as Record<string, unknown>[]) ?? []).map((branch) => ({
    ...branch,
    properties: {
      ...((branch.properties as Record<string, unknown>) ?? {}),
      media: { type: "array", items: { type: "object" } },
    },
  })),
};

export function parseQqDecision(raw: string) {
  return parseAgentDecision(raw);
}
