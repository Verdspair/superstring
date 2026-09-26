import { expect, it } from "bun:test";
import { AGENT_DECISION_JSON_SCHEMA, parseAgentDecision } from "../../src/server/agent/agent-specs";

type JsonSchema = {
  type?: string;
  const?: string;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};
it("requests an explicit nullable sticker intent from structured-output providers while accepting legacy omission", () => {
  const schema = AGENT_DECISION_JSON_SCHEMA as JsonSchema;
  const final = schema.oneOf?.find((variant) => variant.properties?.kind?.const === "final");
  const outputs = final?.properties?.outputs?.items?.oneOf ?? [];
  expect(outputs).toHaveLength(2);
  for (const variant of outputs) {
    expect(variant.required).toContain("stickerIds");
    expect(variant.properties?.stickerIds?.anyOf?.some((option) => option.type === "null")).toBe(
      true,
    );
  }
  for (const value of [undefined, null, [], ["disclosed-id"]]) {
    for (const draft of [
      { kind: "inline", text: "answer" },
      { kind: "generate", instructions: "answer" },
    ]) {
      const decision = parseAgentDecision(
        JSON.stringify({
          kind: "final",
          outputs: [
            {
              ...draft,
              targetId: "allowed",
              ...(value === undefined ? {} : { stickerIds: value }),
            },
          ],
        }),
      );
      expect(decision.kind).toBe("final");
    }
  }
});
