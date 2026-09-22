import { describe, expect, it } from "bun:test";
import {
  AgentConfigSchema,
  AgentDeleteResultSchema,
  AgentResponseSchema,
  ChatRequestSchema,
  ConsolidateRequestSchema,
  CreateAgentRequestSchema,
  CreateSessionRequestSchema,
  DeleteAgentsRequestSchema,
  EntriesListSchema,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  GovernRequestSchema,
  getErrorHttpStatus,
  IsoTimestampSchema,
  JOB_LEVEL_ERROR_CODES,
  LocalModelCatalogResponseSchema,
  MAX_COMPILED_PERSONA_LENGTH,
  MESSAGE_LEVEL_ERROR_CODES,
  MemoryEntryResponseSchema,
  MemoryJobViewSchema,
  MemorySummarySchema,
  MergeRequestSchema,
  MessageResponseSchema,
  MODEL_LAYER_ERROR_CODES,
  ModelCapacityResponseSchema,
  P5ConfigSchema,
  PersonaContentSchema,
  PolicyUpdateSchema,
  PolicyViewSchema,
  RetrievalPresetSchema,
  RuntimeConfigSchema,
  SavePersonaRequestSchema,
  SessionResponseSchema,
  SessionScopeUpdateSchema,
  SSE_EXCLUSIVE_ERROR_CODES,
  SseDeltaEventSchema,
  SseErrorEventSchema,
  SseEventSchema,
  SseStartEventSchema,
  TurnSchema,
  UpdateAgentRequestSchema,
  UUID_REGEX,
  UuidSchema,
} from "../../src/shared/contracts";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const TS = "2026-01-01T00:00:00.123456Z";

function ok(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean {
  return schema.safeParse(value).success;
}

describe("UUID primitive", () => {
  it("accepts a canonical 36-char UUID (mixed case)", () => {
    expect(ok(UuidSchema, UUID)).toBe(true);
    expect(ok(UuidSchema, "ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
  });

  it("rejects malformed UUIDs", () => {
    expect(ok(UuidSchema, "not-a-uuid")).toBe(false);
    expect(ok(UuidSchema, "123e4567-e89b-12d3-a456")).toBe(false); // too short
    expect(ok(UuidSchema, `${UUID}x`)).toBe(false); // 37 chars
    expect(ok(UuidSchema, "")).toBe(false);
    expect(ok(UuidSchema, 123)).toBe(false);
  });

  it("regex is exported and matches the canonical form", () => {
    expect(UUID_REGEX.test(UUID)).toBe(true);
  });

  // The acceptance surface below is the frozen contract's, whose `UUID` field
  // accepts more spellings than the canonical one. Each case is accepted, so
  // a regex-only check would turn it into a 422 here (#92).
  it("normalises every spelling the contract accepts to lowercase 8-4-4-4-12", () => {
    const upper = UUID.toUpperCase();
    const flat = UUID.replace(/-/g, "").toUpperCase();
    const cases: Array<[string, string]> = [
      [UUID, UUID],
      [upper, UUID],
      [`{${upper}}`, UUID],
      [flat, UUID],
      [`urn:uuid:${upper}`, UUID],
    ];
    for (const [input, expected] of cases) {
      const parsed = UuidSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data : null).toBe(expected);
    }
  });

  it("rejects the spellings the contract rejects", () => {
    // Braces are only valid around the hyphenated body, and the `urn:uuid:`
    // prefix is case-sensitive.
    const flat = UUID.replace(/-/g, "");
    const rejected = [
      `{${flat}}`,
      `urn:uuid:{${UUID}}`,
      `urn:uuid:${flat}`,
      `URN:UUID:${UUID}`,
      `urn:${UUID}`,
      `{${UUID}`,
      `${UUID}}`,
      ` ${UUID}`,
      `${UUID} `,
      `\t${UUID}`,
      "12345678-12345678-12345678-12345678",
      "123456781-234-5678-1234-567812345678",
      `${flat}A`,
      flat.slice(0, 31),
    ];
    for (const input of rejected) {
      expect(ok(UuidSchema, input)).toBe(false);
    }
  });

  it("de-duplicates id arrays by UUID value, not by spelling", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    // Same UUID written three ways must collapse to a single entry, because the
    // source parses each element into uuid.UUID before the de-dup check
    expect(
      ok(ConsolidateRequestSchema, {
        request_key: "k",
        session_id: id,
        turn_ids: [id, id.toUpperCase(), id.replace(/-/g, "")],
      }),
    ).toBe(false);
  });

  it("accepts distinct ids even when they are spelled differently", () => {
    expect(
      ok(ConsolidateRequestSchema, {
        request_key: "k",
        session_id: "123E4567-E89B-12D3-A456-426614174000",
        turn_ids: [UUID.replace(/-/g, ""), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      }),
    ).toBe(true);
  });
});

describe("ISO timestamp primitive", () => {
  it("accepts UTC ISO-8601 with fractional seconds", () => {
    expect(ok(IsoTimestampSchema, TS)).toBe(true);
    expect(ok(IsoTimestampSchema, "2026-12-31T23:59:59.9Z")).toBe(true);
  });

  it("rejects timestamps without fractional seconds / Z", () => {
    expect(ok(IsoTimestampSchema, "2026-01-01T00:00:00Z")).toBe(false);
    expect(ok(IsoTimestampSchema, "2026-01-01T00:00:00.123456")).toBe(false);
    expect(ok(IsoTimestampSchema, "2026-01-01 00:00:00")).toBe(false);
    expect(ok(IsoTimestampSchema, "not-a-date")).toBe(false);
  });
});

describe("strict-object (extra=forbid) behaviour", () => {
  // `ChatRequest` is the one request model WITHOUT
  // an explicit extra-key policy, so the default ignore
  // applies: unknown keys are accepted and dropped, as the contract does
  // interpreter. Modelling it as strict turned a valid request into a 422 (#93).
  it("ChatRequest ignores unknown extra fields and keeps only declared ones", () => {
    const parsed = ChatRequestSchema.safeParse({
      session_id: UUID,
      message: "hi",
      client_request_id: "k",
      surprise: 1,
      extra_thing: { a: 1 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toEqual({
      session_id: UUID,
      message: "hi",
      client_request_id: "k",
    });
  });

  it("still rejects a missing required field or an invalid UUID", () => {
    expect(ok(ChatRequestSchema, { session_id: UUID, message: "hi" })).toBe(false);
    expect(
      ok(ChatRequestSchema, { session_id: "nope", message: "hi", client_request_id: "k" }),
    ).toBe(false);
    expect(
      ok(ChatRequestSchema, { session_id: UUID, message: "   ", client_request_id: "k" }),
    ).toBe(false);
  });

  it("CreateSessionRequest still forbids extras (extra=forbid)", () => {
    expect(ok(CreateSessionRequestSchema, { title: "t", surprise: 1 })).toBe(false);
  });

  it("rejects unknown extra fields on a response schema", () => {
    const bad = {
      id: UUID,
      title: "t",
      agent_id: UUID,
      mode: "chat",
      config_version: 1,
      created_at: TS,
      updated_at: TS,
      hacker: true,
    };
    expect(ok(SessionResponseSchema, bad)).toBe(false);
  });
});

describe("ChatRequest", () => {
  const valid = {
    session_id: UUID,
    message: "hello",
    client_request_id: "req-1",
  };

  it("accepts a valid request", () => {
    expect(ok(ChatRequestSchema, valid)).toBe(true);
  });
  it("rejects missing required field", () => {
    const { message: _drop, ...rest } = valid;
    expect(ok(ChatRequestSchema, rest)).toBe(false);
  });
  it("rejects non-UUID session_id", () => {
    expect(ok(ChatRequestSchema, { ...valid, session_id: "nope" })).toBe(false);
  });
  it("rejects out-of-range message length", () => {
    expect(ok(ChatRequestSchema, { ...valid, message: "" })).toBe(false);
    expect(ok(ChatRequestSchema, { ...valid, message: "x".repeat(8001) })).toBe(false);
  });
  it("rejects out-of-range client_request_id", () => {
    expect(ok(ChatRequestSchema, { ...valid, client_request_id: "x".repeat(65) })).toBe(false);
  });
});

describe("CreateSessionRequest", () => {
  it("applies defaults (title, mode, nullable agent_id/request_id)", () => {
    const r = CreateSessionRequestSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe("新会话");
      expect(r.data.mode).toBe("chat");
      expect(r.data.agent_id).toBeNull();
      expect(r.data.client_request_id).toBeNull();
    }
  });
  it("rejects illegal mode enum", () => {
    expect(ok(CreateSessionRequestSchema, { mode: "workz" })).toBe(false);
  });
});

describe("Agent contracts", () => {
  it("CreateAgentRequest accepts valid + defaults", () => {
    const r = CreateAgentRequestSchema.safeParse({
      name: "A",
      model_name: "m",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.temperature).toBe(0.7);
      expect(r.data.persona_intensity).toBe(60);
      expect(r.data.is_active).toBe(true);
    }
  });

  it("rejects out-of-range temperature", () => {
    expect(
      ok(CreateAgentRequestSchema, {
        name: "A",
        model_name: "m",
        temperature: 2.5,
      }),
    ).toBe(false);
  });

  it("rejects name exceeding 100 chars", () => {
    expect(ok(CreateAgentRequestSchema, { name: "x".repeat(101), model_name: "m" })).toBe(false);
  });

  it("SavePersonaRequest checks the fully compiled persona including headings", () => {
    expect(
      ok(SavePersonaRequestSchema, {
        core_identity: "x".repeat(MAX_COMPILED_PERSONA_LENGTH - 8),
      }),
    ).toBe(true);
    expect(
      ok(SavePersonaRequestSchema, {
        core_identity: "x".repeat(MAX_COMPILED_PERSONA_LENGTH - 7),
      }),
    ).toBe(false);
  });

  it("SavePersonaRequest accepts within budget", () => {
    expect(ok(SavePersonaRequestSchema, { core_identity: "a".repeat(100) })).toBe(true);
  });

  it("PersonaContentSchema counts contract characters, not UTF-16 code units", () => {
    expect(ok(PersonaContentSchema, { core_identity: "😀".repeat(15992) })).toBe(true);
    expect(ok(PersonaContentSchema, { core_identity: "😀".repeat(15993) })).toBe(false);
  });

  it("UpdateAgentRequest requires expected_version", () => {
    expect(ok(UpdateAgentRequestSchema, { name: "A" })).toBe(false);
    expect(ok(UpdateAgentRequestSchema, { name: "A", expected_version: 1 })).toBe(true);
  });

  it("AgentResponse accepts a valid response", () => {
    expect(
      ok(AgentResponseSchema, {
        name: "A",
        description: "",
        system_prompt: "",
        additional_instructions: "",
        model_name: "m",
        temperature: 0.7,
        memory_consolidation_model_name: null,
        memory_consolidation_prompt: "p",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: null,
        memory_retrieval_prompt: "p",
        context_compression_model_name: null,
        p5_config: { retrieval_mode: "standard" },
        is_active: true,
        id: UUID,
        config_version: 1,
        persona_intensity: 60,
        created_at: TS,
        updated_at: TS,
      }),
    ).toBe(true);
  });

  it("AgentConfig rejects illegal temperature type", () => {
    expect(ok(AgentConfigSchema, { name: "A", model_name: "m", temperature: "hot" })).toBe(false);
  });

  it("DeleteAgentsRequest rejects duplicate ids", () => {
    expect(ok(DeleteAgentsRequestSchema, { agent_ids: [UUID, UUID] })).toBe(false);
    expect(ok(DeleteAgentsRequestSchema, { agent_ids: [UUID] })).toBe(true);
    expect(
      ok(DeleteAgentsRequestSchema, {
        agent_ids: [UUID, "222e4567-e89b-12d3-a456-426614174001"],
      }),
    ).toBe(true);
  });

  it("RuntimeConfig accepts valid snapshot with resolved capacities", () => {
    expect(
      ok(RuntimeConfigSchema, {
        agent_id: UUID,
        name: "A",
        system_prompt: "",
        additional_instructions: "",
        model_name: "m",
        temperature: 0.7,
        memory_consolidation_model_name: "m",
        memory_consolidation_prompt: "p",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: "m",
        memory_retrieval_prompt: "p",
        context_compression_model_name: "m",
        p5_config: { retrieval_mode: "standard" },
        resolved_model_capacities: { [UUID]: 8000 },
        mode: "chat",
        config_version: 1,
        persona_intensity: 60,
      }),
    ).toBe(true);
  });

  it("AgentDeleteResult accepts nullable error_code", () => {
    expect(
      ok(AgentDeleteResultSchema, {
        id: UUID,
        deleted: true,
        error_code: null,
        message: "ok",
      }),
    ).toBe(true);
    expect(
      ok(AgentDeleteResultSchema, {
        id: UUID,
        deleted: false,
        error_code: "MESSAGE_NOT_FOUND",
        message: "x",
      }),
    ).toBe(true);
  });
});

describe("P5Config cross-field invariants", () => {
  it("rejects max_entries > candidate_limit in a preset", () => {
    expect(
      ok(RetrievalPresetSchema, {
        candidate_limit: 3,
        max_entries: 5,
        max_tokens: 1024,
        relevance_instruction: "直接相关",
      }),
    ).toBe(false);
  });

  it("accepts max_entries <= candidate_limit", () => {
    expect(
      ok(RetrievalPresetSchema, {
        candidate_limit: 10,
        max_entries: 5,
        max_tokens: 1024,
        relevance_instruction: "直接相关",
      }),
    ).toBe(true);
  });

  it("rejects impossible budget when context_window set", () => {
    // max_output(4096) + context(8000)*0.1 = 4096+800 = 4896 < 8000 -> ok
    expect(
      ok(P5ConfigSchema, {
        context_window: 8000,
        max_output_tokens: 4096,
        safety_margin_ratio: 0.1,
      }),
    ).toBe(true);
    // max_output(7500) + 8000*0.1 = 8300 >= 8000 -> fail
    expect(
      ok(P5ConfigSchema, {
        context_window: 8000,
        max_output_tokens: 7500,
        safety_margin_ratio: 0.1,
      }),
    ).toBe(false);
  });

  it("rejects summary_target > summary_max", () => {
    expect(
      ok(P5ConfigSchema, {
        summary_target_tokens: 5000,
        summary_max_tokens: 4096,
      }),
    ).toBe(false);
    expect(
      ok(P5ConfigSchema, {
        summary_target_tokens: 1024,
        summary_max_tokens: 4096,
      }),
    ).toBe(true);
  });

  it("accepts null context_window (follow model)", () => {
    expect(ok(P5ConfigSchema, { context_window: null })).toBe(true);
  });
});

describe("Memory contracts", () => {
  it("PolicyUpdate accepts valid + defaults", () => {
    const r = PolicyUpdateSchema.safeParse({
      auto_enabled: true,
      expected_version: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.every_turns).toBe(20);
      expect(r.data.target_chars).toBe(1200);
    }
  });

  it("PolicyUpdate rejects out-of-range every_turns", () => {
    expect(
      ok(PolicyUpdateSchema, {
        auto_enabled: true,
        every_turns: 201,
        expected_version: 1,
      }),
    ).toBe(false);
  });

  it("ConsolidateRequest rejects duplicate turn_ids", () => {
    expect(
      ok(ConsolidateRequestSchema, {
        request_key: "k1",
        session_id: UUID,
        turn_ids: [UUID, UUID],
      }),
    ).toBe(false);
    expect(
      ok(ConsolidateRequestSchema, {
        request_key: "k1",
        session_id: UUID,
        turn_ids: [UUID],
      }),
    ).toBe(true);
  });

  it("ConsolidateRequest rejects illegal request_key chars", () => {
    expect(
      ok(ConsolidateRequestSchema, {
        request_key: "bad key!",
        session_id: UUID,
        turn_ids: [UUID],
      }),
    ).toBe(false);
  });

  it("MergeRequest requires >= 2 distinct memory_ids", () => {
    expect(ok(MergeRequestSchema, { request_key: "k", memory_ids: [UUID] })).toBe(false);
    expect(ok(MergeRequestSchema, { request_key: "k", memory_ids: [UUID, UUID] })).toBe(false); // dup
    expect(
      ok(MergeRequestSchema, {
        request_key: "k",
        memory_ids: [UUID, "222e4567-e89b-12d3-a456-426614174001"],
      }),
    ).toBe(true);
  });

  it("GovernRequest requires memory_ids (inherited from MemorySelection)", () => {
    // GovernRequest extends MemorySelection, so the id
    // list is mandatory rather than defaulted.
    expect(ok(GovernRequestSchema, { action: "suppress" })).toBe(false);
    expect(ok(GovernRequestSchema, { memory_ids: [], action: "suppress" })).toBe(false);
  });

  it("GovernRequest purge requires confirm_permanent=true", () => {
    expect(ok(GovernRequestSchema, { memory_ids: [UUID], action: "purge" })).toBe(false);
    expect(
      ok(GovernRequestSchema, {
        memory_ids: [UUID],
        action: "purge",
        confirm_permanent: false,
      }),
    ).toBe(false);
    expect(
      ok(GovernRequestSchema, {
        memory_ids: [UUID],
        action: "purge",
        confirm_permanent: true,
      }),
    ).toBe(true);
  });

  it("GovernRequest enable/suppress need no confirmation", () => {
    expect(ok(GovernRequestSchema, { memory_ids: [UUID], action: "suppress" })).toBe(true);
    expect(ok(GovernRequestSchema, { memory_ids: [UUID], action: "enable" })).toBe(true);
  });

  it("GovernRequest rejects duplicate memory_ids", () => {
    expect(ok(GovernRequestSchema, { memory_ids: [UUID, UUID], action: "suppress" })).toBe(false);
  });

  it("GovernRequest rejects illegal action enum", () => {
    expect(ok(GovernRequestSchema, { memory_ids: [UUID], action: "delete" })).toBe(false);
  });

  it("MemoryEntryResponse accepts detail view", () => {
    expect(
      ok(MemoryEntryResponseSchema, {
        id: UUID,
        name: "n",
        summary: "s",
        tags: ["t"],
        kinds: ["k"],
        body: "b",
        status: "active",
        scope: "reality_user",
        scope_key: UUID,
        created_at: TS,
        config_snapshot: "{}",
      }),
    ).toBe(true);
  });

  it("#83-2 config_snapshot is the parsed object (or null), not a JSON string", () => {
    // The snapshot is persisted as a JSON string
    // string and the route must `JSON.parse` it back. The contract therefore
    // accepts any object or null — never a raw string in the served payload.
    const objectSnapshot = {
      id: UUID,
      name: "n",
      summary: "s",
      tags: [],
      kinds: ["k"],
      body: "b",
      status: "active",
      scope: "reality_user",
      scope_key: UUID,
      created_at: TS,
      config_snapshot: { model_name: "m", temperature: 0.7 },
    };
    expect(ok(MemoryEntryResponseSchema, objectSnapshot)).toBe(true);
    expect(
      ok(MemoryEntryResponseSchema, {
        ...objectSnapshot,
        config_snapshot: null,
      }),
    ).toBe(true);
    // A string-as-object must NOT be the served shape (route must parse it).
    const parsed = MemoryEntryResponseSchema.safeParse(objectSnapshot);
    if (parsed.success) {
      expect(parsed.data.config_snapshot).toEqual({
        model_name: "m",
        temperature: 0.7,
      });
    }
  });

  it("MemoryJobView accepts a merge job with session_id null", () => {
    // 110 enqueues merge jobs without a session, and
    // declares MemoryJob.session_id nullable.
    expect(
      ok(MemoryJobViewSchema, {
        id: UUID,
        kind: "merge",
        session_id: null,
        status: "queued",
        result_id: null,
        error_code: null,
        created_at: TS,
        finished_at: null,
      }),
    ).toBe(true);
  });

  it("MemoryJobView accepts finished_at null", () => {
    expect(
      ok(MemoryJobViewSchema, {
        id: UUID,
        kind: "manual",
        session_id: UUID,
        status: "queued",
        result_id: null,
        error_code: null,
        created_at: TS,
        finished_at: null,
      }),
    ).toBe(true);
    expect(
      ok(MemoryJobViewSchema, {
        id: UUID,
        kind: "manual",
        session_id: UUID,
        status: "succeeded",
        result_id: UUID,
        error_code: null,
        created_at: TS,
        finished_at: TS,
      }),
    ).toBe(true);
  });

  it("MemoryJobView rejects unknown status enum", () => {
    expect(
      ok(MemoryJobViewSchema, {
        id: UUID,
        kind: "manual",
        session_id: UUID,
        status: "cancelled",
        result_id: null,
        error_code: null,
        created_at: TS,
        finished_at: null,
      }),
    ).toBe(false);
  });

  it("PolicyView accepts valid view", () => {
    expect(
      ok(PolicyViewSchema, {
        auto_enabled: true,
        every_turns: 20,
        target_chars: 300,
        version: 1,
      }),
    ).toBe(true);
  });

  it("EntriesList wraps summary items", () => {
    expect(
      ok(EntriesListSchema, {
        total: 1,
        items: [
          {
            id: UUID,
            name: "n",
            summary: "s",
            tags: [],
            kinds: [],
            status: "active",
            created_at: TS,
            scope: "reality_user",
            scope_key: UUID,
          },
        ],
      }),
    ).toBe(true);
  });

  it("MemorySummary rejects unknown status enum", () => {
    expect(
      ok(MemorySummarySchema, {
        id: UUID,
        name: "n",
        summary: "s",
        tags: [],
        kinds: [],
        status: "weird",
        created_at: TS,
        scope: "x",
        scope_key: "y",
      }),
    ).toBe(false);
  });
});

describe("Session scope + message + turn", () => {
  it("SessionScopeUpdate accepts valid scope enum", () => {
    expect(ok(SessionScopeUpdateSchema, { scope: "session_only" })).toBe(true);
    expect(ok(SessionScopeUpdateSchema, { scope: "bogus" })).toBe(false);
  });

  it("MessageResponse accepts nullable error_code/completed_at", () => {
    expect(
      ok(MessageResponseSchema, {
        id: UUID,
        role: "user",
        content: "c",
        status: "completed",
        error_code: null,
        sequence_no: 1,
        turn_id: UUID,
        created_at: TS,
        completed_at: TS,
      }),
    ).toBe(true);
    expect(
      ok(MessageResponseSchema, {
        id: UUID,
        role: "assistant",
        content: "c",
        status: "pending",
        error_code: null,
        sequence_no: 2,
        turn_id: UUID,
        created_at: TS,
        completed_at: null,
      }),
    ).toBe(true);
  });

  it("MessageResponse rejects illegal role", () => {
    expect(
      ok(MessageResponseSchema, {
        id: UUID,
        role: "bot",
        content: "c",
        status: "completed",
        error_code: null,
        sequence_no: 1,
        turn_id: UUID,
        created_at: TS,
        completed_at: TS,
      }),
    ).toBe(false);
  });

  it("Turn accepts nullable lease/token", () => {
    expect(
      ok(TurnSchema, {
        id: UUID,
        generation_status: "active",
        cancel_requested: false,
        lease_expires_at: null,
        generation_token: null,
      }),
    ).toBe(true);
    expect(
      ok(TurnSchema, {
        id: UUID,
        generation_status: "completed",
        cancel_requested: true,
        lease_expires_at: TS,
        generation_token: "a".repeat(36),
      }),
    ).toBe(true);
  });

  it("Turn rejects token of wrong length", () => {
    expect(
      ok(TurnSchema, {
        id: UUID,
        generation_status: "active",
        cancel_requested: false,
        lease_expires_at: null,
        generation_token: "short",
      }),
    ).toBe(false);
  });
});

describe("Model capacity response (#89)", () => {
  it("accepts exactly the three shapes can emit", () => {
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "loaded",
        context_length: 32768,
      }),
    ).toBe(true);
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "unknown",
        context_length: null,
      }),
    ).toBe(true);
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "unavailable",
        context_length: null,
        error_code: "MODEL_NOT_LOADED",
      }),
    ).toBe(true);
  });

  it("rejects combinations the contract can never emit", () => {
    // A success branch must not carry an error code...
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "loaded",
        context_length: 32768,
        error_code: "MODEL_NOT_LOADED",
      }),
    ).toBe(false);
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "unknown",
        context_length: null,
        error_code: "MODEL_NOT_LOADED",
      }),
    ).toBe(false);
    // ..and the failure branch always carries a real code, never null/absent
    // because it is read straight off the raised AppError.
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "unavailable",
        context_length: null,
        error_code: null,
      }),
    ).toBe(false);
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "unavailable",
        context_length: null,
      }),
    ).toBe(false);
    // `loaded` must carry an integer, not null.
    expect(
      ok(ModelCapacityResponseSchema, {
        model: "qwen/qwen3-4b",
        status: "loaded",
        context_length: null,
      }),
    ).toBe(false);
  });
});

describe("Model catalog + error envelope", () => {
  it("LocalModelCatalogResponse requires lm_studio provider", () => {
    expect(
      ok(LocalModelCatalogResponseSchema, {
        provider: "lm_studio",
        status: "available",
        models: [],
        default_model: "m",
      }),
    ).toBe(true);
    expect(
      ok(LocalModelCatalogResponseSchema, {
        provider: "ollama",
        status: "available",
        models: [],
        default_model: "m",
      }),
    ).toBe(false);
  });

  it("ErrorEnvelope accepts request_id optional", () => {
    expect(
      ok(ErrorEnvelopeSchema, {
        error: { code: "SESSION_NOT_FOUND", message: "x" },
      }),
    ).toBe(true);
    expect(
      ok(ErrorEnvelopeSchema, {
        error: { code: "SESSION_NOT_FOUND", message: "x", request_id: "r" },
      }),
    ).toBe(true);
    expect(
      ok(ErrorEnvelopeSchema, {
        error: { code: "UNKNOWN_CODE", message: "x" },
      }),
    ).toBe(false);
  });

  it("ErrorCodeSchema accepts SSE-exclusive + message-level codes", () => {
    expect(ok(ErrorCodeSchema, "MODEL_ERROR")).toBe(true);
    expect(ok(ErrorCodeSchema, "MESSAGE_PERSISTENCE_ERROR")).toBe(true);
    expect(ok(ErrorCodeSchema, "CLIENT_DISCONNECTED")).toBe(true);
    expect(ok(ErrorCodeSchema, "GENERATION_LEASE_EXPIRED")).toBe(true);
  });
});

// Regression guard: the api-contract.md v1 revision listed only 24 codes and
// silently dropped every code raised from db/*
// and
// These tests pin the corrected 66-code taxonomy so the
// defect cannot silently return.
describe("Error code taxonomy (66 codes, api-contract §6.2 v2)", () => {
  it("contains exactly 66 distinct codes", () => {
    expect(ERROR_CODES.length).toBe(66);
    expect(new Set(ERROR_CODES).size).toBe(66);
  });

  it("includes the previously missing context-builder and repository codes", () => {
    const mustHave = [
      "AGENT_NOT_FOUND",
      "AGENT_DISABLED",
      "AGENT_IN_USE",
      "DEFAULT_AGENT_DELETE_FORBIDDEN",
      "CONFIG_VERSION_CONFLICT",
      "PERSONA_NOT_FOUND",
      "INVALID_SESSION_CONFIG",
      "INVALID_TURN_CONFIG",
      "CONTEXT_AUX_BUDGET",
      "CONTEXT_AUX_ERROR",
      "CONTEXT_AUX_TIMEOUT",
      "CONTEXT_BUDGET_EXCEEDED",
      "CONTEXT_CAPACITY_ERROR",
      "CONTEXT_CAPACITY_INSUFFICIENT",
      "CONTEXT_CAPACITY_TIMEOUT",
      "CONTEXT_CAPACITY_UNKNOWN",
      "CONTEXT_CATALOG_LIMIT",
      "CONTEXT_INVALID_RESULT",
      "CONTEXT_INVALID_SELECTION",
      "CONTEXT_MEMORY_BUDGET",
      "CONTEXT_RECALL_BUDGET",
      "CONTEXT_SOURCE_INVALID",
      "CONTEXT_SUMMARY_BUDGET",
      "MEMORY_FORBIDDEN",
      "MEMORY_SOURCE_FORBIDDEN",
      "MEMORY_NOT_FOUND",
      "MEMORY_JOB_NOT_FOUND",
      "MEMORY_REQUEST_CONFLICT",
      "MEMORY_JOB_OWNERSHIP_LOST",
      "MODEL_NOT_LOADED",
      "MODEL_TIMEOUT",
      "MODEL_CAPACITY_AMBIGUOUS",
      "MODEL_CAPACITY_UNAVAILABLE",
      "MODEL_OUTPUT_LIMIT",
      "MODEL_FINISH_UNSUPPORTED",
      "MODEL_STREAM_INTERRUPTED",
    ];
    for (const code of mustHave) {
      expect(ok(ErrorCodeSchema, code)).toBe(true);
    }
  });

  it("documents the HTTP status for every HTTP-layer code", () => {
    const jobOnly = new Set<string>(JOB_LEVEL_ERROR_CODES);
    const statusKeys = Object.keys(ERROR_HTTP_STATUS);
    // 57 HTTP-layer codes = 66 - 1 SSE-only - 2 message-only(new) - 6 job-only
    expect(statusKeys.length).toBe(57);
    for (const key of statusKeys) {
      expect(jobOnly.has(key)).toBe(false);
    }
    // SSE-only and the two message-only extras carry no HTTP status
    expect(getErrorHttpStatus("MESSAGE_PERSISTENCE_ERROR")).toBeUndefined();
    expect(getErrorHttpStatus("CLIENT_DISCONNECTED")).toBeUndefined();
    expect(getErrorHttpStatus("GENERATION_LEASE_EXPIRED")).toBeUndefined();
    // spot-check representative mappings from each source group
    expect(getErrorHttpStatus("SESSION_NOT_FOUND")).toBe(404);
    expect(getErrorHttpStatus("MESSAGE_DELETE_FORBIDDEN")).toBe(400);
    expect(getErrorHttpStatus("VALIDATION_ERROR")).toBe(422);
    expect(getErrorHttpStatus("AGENT_NOT_FOUND")).toBe(404);
    expect(getErrorHttpStatus("MEMORY_FORBIDDEN")).toBe(403);
    expect(getErrorHttpStatus("CONTEXT_AUX_TIMEOUT")).toBe(504);
    expect(getErrorHttpStatus("CONTEXT_CAPACITY_ERROR")).toBe(409);
    expect(getErrorHttpStatus("MODEL_ERROR")).toBe(503);
    expect(getErrorHttpStatus("MODEL_EMPTY_RESPONSE")).toBe(502);
    expect(getErrorHttpStatus("DATABASE_UNAVAILABLE")).toBe(503);
  });

  it("keeps the layer groupings disjoint from each other where documented", () => {
    // Only MESSAGE_PERSISTENCE_ERROR is genuinely SSE-exclusive
    expect([...SSE_EXCLUSIVE_ERROR_CODES]).toEqual(["MESSAGE_PERSISTENCE_ERROR"]);
    // MODEL_ERROR is HTTP-layer 503 that merely travels over SSE
    expect((MODEL_LAYER_ERROR_CODES as readonly string[]).includes("MODEL_ERROR")).toBe(true);
    expect((SSE_EXCLUSIVE_ERROR_CODES as readonly string[]).includes("MODEL_ERROR")).toBe(false);

    expect(MESSAGE_LEVEL_ERROR_CODES.length).toBe(3);

    expect(JOB_LEVEL_ERROR_CODES.length).toBe(6);

    for (const code of [
      ...MESSAGE_LEVEL_ERROR_CODES,
      ...JOB_LEVEL_ERROR_CODES,
      ...MODEL_LAYER_ERROR_CODES,
      ...SSE_EXCLUSIVE_ERROR_CODES,
    ]) {
      expect(ok(ErrorCodeSchema, code)).toBe(true);
    }
  });

  it("rejects codes that do not exist in the contract", () => {
    for (const bogus of ["UNKNOWN_CODE", "MEMORY_ARCHIVED", "MODEL_BUSY", "memory_busy"]) {
      expect(ok(ErrorCodeSchema, bogus)).toBe(false);
    }
  });
});

describe("SSE events discriminated union", () => {
  it("start event validates and is discriminated", () => {
    expect(ok(SseEventSchema, { event: "start", request_id: "r", session_id: UUID })).toBe(true);
  });

  it("delta event validates", () => {
    expect(ok(SseEventSchema, { event: "delta", request_id: "r", text: "hi" })).toBe(true);
  });

  it("done event validates with nullable completed_at", () => {
    expect(
      ok(SseEventSchema, {
        event: "done",
        request_id: "r",
        message_id: UUID,
        created_at: TS,
        completed_at: TS,
      }),
    ).toBe(true);
    expect(
      ok(SseEventSchema, {
        event: "done",
        request_id: "r",
        message_id: UUID,
        created_at: TS,
        completed_at: null,
      }),
    ).toBe(true);
  });

  it("error event validates with any error code", () => {
    expect(
      ok(SseEventSchema, {
        event: "error",
        request_id: "r",
        code: "DATABASE_UNAVAILABLE",
        message: "down",
      }),
    ).toBe(true);
  });

  it("rejects unknown event discriminator", () => {
    expect(ok(SseEventSchema, { event: "ping", request_id: "r" })).toBe(false);
  });

  it("rejects extra field on a strict event variant", () => {
    expect(
      ok(SseStartEventSchema, {
        event: "start",
        request_id: "r",
        session_id: UUID,
        text: "x",
      }),
    ).toBe(false);
  });

  it("rejects missing payload field per variant", () => {
    expect(ok(SseDeltaEventSchema, { event: "delta", request_id: "r" })).toBe(false);
    expect(ok(SseErrorEventSchema, { event: "error", request_id: "r", code: "X" })).toBe(false);
  });

  it("individually-typed variants still parse through the union", () => {
    const start = SseStartEventSchema.parse({
      event: "start",
      request_id: "r",
      session_id: UUID,
    });
    expect(start.event).toBe("start");
  });
});
