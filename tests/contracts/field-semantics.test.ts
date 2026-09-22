// Field-level string semantics — replayed against a frozen golden file.
// Why a golden and not hand-written assertions: the schema checks the length
// bounds against the RAW input and only then runs the field's own
// post-validator, and every field picks a different one. The rules are easy to
// get subtly wrong in the other direction (we already shipped a "trim then
// bound" helper that accepted a rejected message). The golden was captured once
// and is trusted as-is; it is never regenerated in CI, so it cannot drift with
// our own assumptions.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { z } from "zod";
import { MemoryDraftSchema } from "../../src/server/services/memory-contract";
import {
  AgentConfigSchema,
  ChatRequestSchema,
  CreateAgentRequestSchema,
  CreateSessionRequestSchema,
  PersonaContentSchema,
  RetrievalPresetSchema,
  UpdateAgentRequestSchema,
  UpdateSessionRequestSchema,
} from "../../src/shared/contracts";
import {
  codePointLength,
  isBlank,
  unicodeStrip,
} from "../../src/shared/contracts/code-point-string";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

type GoldenCase = {
  id: string;
  schema: string;
  watched: string;
  accepted: boolean;
  value: unknown;
  error: string | null;
};

const golden = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../fixtures/field-semantics.golden.json"), "utf8"),
) as { cases: GoldenCase[] };

/** Our schema for each model named in the golden. */
const SCHEMA_BY_SOURCE: Record<string, z.ZodType> = {
  ChatRequest: ChatRequestSchema,
  CreateSessionRequest: CreateSessionRequestSchema,
  UpdateSessionRequest: UpdateSessionRequestSchema,
  AgentConfig: AgentConfigSchema,
  CreateAgentRequest: CreateAgentRequestSchema,
  UpdateAgentRequest: UpdateAgentRequestSchema,
  PersonaContent: PersonaContentSchema,
  MemoryDraft: MemoryDraftSchema,
  RetrievalPreset: RetrievalPresetSchema,
};

/** Payloads are shared verbatim: the golden stores the input it validated. */
function payloadFor(id: string): Record<string, unknown> {
  const raw = PAYLOADS[id];
  if (raw === undefined) throw new Error(`no payload registered for golden case ${id}`);
  return raw;
}

/** Trailing whitespace: the length must be measured on the RAW value. */
const PAD = "  ";
const pad = (value: string) => `${value}${PAD}`;

const PAYLOADS: Record<string, Record<string, unknown>> = {
  "chat.message.raw_over_limit_after_trim": {
    session_id: UUID,
    message: pad("a".repeat(7999)),
    client_request_id: "k",
  },
  "chat.message.at_limit": { session_id: UUID, message: "a".repeat(8000), client_request_id: "k" },
  "chat.message.blank_spaces": { session_id: UUID, message: "  ", client_request_id: "k" },
  "chat.message.blank_nel": { session_id: UUID, message: "\u0085", client_request_id: "k" },
  "chat.message.bom_is_not_blank": {
    session_id: UUID,
    message: "\ufeff",
    client_request_id: "k",
  },
  "chat.message.padded_is_stripped": {
    session_id: UUID,
    message: "  hi  ",
    client_request_id: "k",
  },
  "session.title.raw_over_limit_after_trim": { title: pad("a".repeat(199)) },
  "session.title.blank": { title: " " },
  "session.update.title.raw_over_limit_after_trim": { title: pad("a".repeat(199)) },
  "agentconfig.name.nel_is_blank": { name: "\u0085", model_name: "m" },
  "agentconfig.name.bom_is_not_blank": { name: "\ufeff", model_name: "m" },
  "agentconfig.description.not_stripped": { name: "n", model_name: "m", description: "  留白  " },
  "agentconfig.description.raw_over_limit_after_trim": {
    name: "n",
    model_name: "m",
    description: pad("a".repeat(1999)),
  },
  "agentconfig.system_prompt.not_stripped": {
    name: "n",
    model_name: "m",
    system_prompt: "  keep me  ",
  },
  "agentconfig.additional_instructions.is_stripped": {
    name: "n",
    model_name: "m",
    additional_instructions: "  drop me  ",
  },
  "agentconfig.additional_instructions.blank_allowed": {
    name: "n",
    model_name: "m",
    additional_instructions: "   ",
  },
  "agentconfig.memory_consolidation_prompt.blank_rejected": {
    name: "n",
    model_name: "m",
    memory_consolidation_prompt: "  ",
  },
  "agentconfig.model_name.null_allowed": {
    name: "n",
    model_name: "m",
    memory_consolidation_model_name: null,
  },
  "agentconfig.model_name.blank_rejected": {
    name: "n",
    model_name: "m",
    memory_retrieval_model_name: "  ",
  },
  "createagent.description.not_stripped": {
    name: "n",
    model_name: "m",
    description: "  留白  ",
  },
  "createagent.additional_instructions.not_stripped_at_request_layer": {
    name: "n",
    model_name: "m",
    additional_instructions: "  drop me  ",
  },
  "createagent.memory_consolidation_prompt.not_stripped_at_request_layer": {
    name: "n",
    model_name: "m",
    memory_consolidation_prompt: "  keep me  ",
  },
  "createagent.name.nel_is_blank": { name: "\u0085", model_name: "m" },
  "updateagent.description.empty_allowed": { expected_version: 1, description: "" },
  "updateagent.description.blank_rejected": { expected_version: 1, description: " " },
  "updateagent.description.nel_rejected": { expected_version: 1, description: "\u0085" },
  "updateagent.description.not_stripped": { expected_version: 1, description: "  留白  " },
  "updateagent.description.raw_over_limit_after_trim": {
    expected_version: 1,
    description: pad("a".repeat(1999)),
  },
  "updateagent.additional_instructions.empty_allowed": {
    expected_version: 1,
    additional_instructions: "",
  },
  "updateagent.additional_instructions.not_stripped": {
    expected_version: 1,
    additional_instructions: "  keep me  ",
  },
  "updateagent.p5_config.explicit_null_rejected": { expected_version: 1, p5_config: null },
  "updateagent.is_active.explicit_null_rejected": { expected_version: 1, is_active: null },
  "updateagent.persona_intensity.explicit_null_rejected": {
    expected_version: 1,
    persona_intensity: null,
  },
  "updateagent.temperature.explicit_null_rejected": { expected_version: 1, temperature: null },
  "updateagent.memory_consolidation_model_name.null_allowed": {
    expected_version: 1,
    memory_consolidation_model_name: null,
  },
  "updateagent.memory_consolidation_model_name.blank_rejected": {
    expected_version: 1,
    memory_retrieval_model_name: "  ",
  },
  "persona.core_identity.blank_allowed_and_stripped": { core_identity: "   " },
  "draft.name.raw_over_limit_after_trim": {
    name: pad("a".repeat(99)),
    summary: "s",
    kinds: ["working"],
    body: "b",
  },
  "draft.name.nel_is_blank": { name: "\u0085", summary: "s", kinds: ["working"], body: "b" },
  "draft.name.bom_is_not_blank": { name: "\ufeff", summary: "s", kinds: ["working"], body: "b" },
  "draft.tags.astral_counts_as_one": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
    tags: ["\u{1f600}".repeat(31)],
  },
  "draft.tags.astral_over_60": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
    tags: ["\u{1f600}".repeat(61)],
  },
  "draft.tags.nel_is_blank": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
    tags: ["\u0085"],
  },
  "draft.tags.bom_is_not_blank": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
    tags: ["\ufeff"],
  },
  "draft.tags.dedup_after_strip_preserving_order": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
    tags: [" a ", "b", "a"],
  },
  "draft.tags.omitted_defaults_to_empty": {
    name: "n",
    summary: "s",
    kinds: ["working"],
    body: "b",
  },
  "preset.relevance_instruction.blank_rejected": {
    candidate_limit: 10,
    max_entries: 5,
    max_tokens: 100,
    relevance_instruction: " ",
  },
};

describe("field semantics golden", () => {
  it("covers every case the generator emitted", () => {
    // A golden case added without a payload here would silently
    // stop being verified — fail loudly instead.
    const missing = golden.cases.map((c) => c.id).filter((id) => PAYLOADS[id] === undefined);
    expect(missing).toEqual([]);
    expect(golden.cases.length).toBeGreaterThan(40);
  });

  for (const testCase of golden.cases) {
    it(`${testCase.id} → ${testCase.accepted ? "accept" : "reject"}`, () => {
      const schema = SCHEMA_BY_SOURCE[testCase.schema];
      if (!schema) throw new Error(`no schema for ${testCase.schema}`);

      const parsed = schema.safeParse(payloadFor(testCase.id));
      expect(parsed.success).toBe(testCase.accepted);
      if (!testCase.accepted) return;

      // Accepting is not enough: the stored value must match too, otherwise a
      // strip that should not happen (or a missing one) would go unnoticed.
      const data = parsed.data as Record<string, unknown>;
      expect(data[testCase.watched]).toEqual(testCase.value);
    });
  }
});

describe("code-point string primitives", () => {
  it("unicodeStrip uses the contract's whitespace set, not JS trim()", () => {
    // The contract strips these; String.prototype.trim() does not.
    for (const ch of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085"]) {
      expect(unicodeStrip(`${ch}ab${ch}`)).toBe("ab");
      expect(`${ch}ab${ch}`.trim()).not.toBe("ab");
    }
    // ..and the reverse: U+FEFF is whitespace to JS but not to the contract.
    expect("\ufeffab\ufeff".trim()).toBe("ab");
    expect(unicodeStrip("\ufeffab\ufeff")).toBe("\ufeffab\ufeff");
  });

  it("isBlank follows the contract, so U+0085 is blank and U+FEFF is not", () => {
    expect(isBlank("\u0085")).toBe(true);
    expect(isBlank("\ufeff")).toBe(false);
    expect(isBlank("   ")).toBe(true);
  });

  it("codePointLength counts code points, not UTF-16 code units", () => {
    expect("😀".length).toBe(2);
    expect(codePointLength("😀")).toBe(1);
    expect(codePointLength("a😀b")).toBe(3);
  });
});
