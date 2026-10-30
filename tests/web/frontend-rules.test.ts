import { describe, expect, it } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import { toDraft } from "../../src/web/features/agents/draft";
import {
  acceptPageAgent,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import { createOptimisticMessages } from "../../src/web/features/chat/message-rules";

const NOW = "2026-09-17T12:00:00.000Z";
const agent = () =>
  AgentResponseSchema.parse({
    id: "agent",
    name: "saved",
    model_name: "model",
    config_version: 4,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
  });
function fixtures() {
  const saved = agent();
  const draft = structuredClone(toDraft(saved));
  draft.name = "draft";
  draft.memory_retrieval_prompt = "draft retrieval";
  draft.p5_config.memory_read = { enabled: false, max_bytes: 2048 };
  draft.p5_config.context_window = 8192;
  return { saved, draft };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

describe("当前页面纯规则", () => {
  const persona = () =>
    PersonaResponseSchema.parse({
      id: "p",
      agent_id: "agent",
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: NOW,
      updated_at: NOW,
    });
  it("basic only submits its fields and version, not models/context/persona", () => {
    const { saved, draft } = fixtures();
    const editor = newPageEditor(saved, persona());
    editor.draft = draft;
    expect(Object.keys(pageAgentPayload(editor, "basic")).sort()).toEqual(
      ["name", "description", "is_active", "expected_version"].sort(),
    );
    expect(pageAgentPayload(editor, "basic")).toMatchObject({ name: "draft", expected_version: 4 });
  });
  it("memory submits its active settings with saved context/raw values and never mutates inputs", () => {
    const { saved, draft } = fixtures();
    const before = structuredClone({ saved, draft });
    const editor = newPageEditor(saved, persona());
    editor.draft = freeze(draft);
    expect(pageAgentPayload(editor, "memory-tools").p5_config).toMatchObject({
      memory_read: { enabled: false, max_bytes: 2048 },
      context_window: saved.p5_config.context_window,
      retrieval_presets: saved.p5_config.retrieval_presets,
    });
    expect({ saved, draft }).toEqual(before);
  });
  it("context submits only context and saved historical retrieval fields", () => {
    const { saved, draft } = fixtures();
    const editor = newPageEditor(saved, persona());
    editor.draft = freeze(draft);
    const payload = pageAgentPayload(editor, "context");
    expect(payload.p5_config?.context_window).toBe(8192);
    expect(payload.p5_config?.retrieval_mode).toBe(saved.p5_config.retrieval_mode);
    expect(payload.p5_config?.retrieval_presets).toEqual(saved.p5_config.retrieval_presets);
    expect(payload.p5_config?.memory_read).toEqual(saved.p5_config.memory_read);
  });
  it.each(["basic", "memory-tools", "context"] as const)(
    "%s acceptance updates only its fields and version",
    (page) => {
      const { saved, draft } = fixtures();
      const editor = newPageEditor(saved, persona());
      editor.draft = freeze(draft);
      const before = structuredClone(draft);
      const accepted = acceptPageAgent(editor, page, { ...saved, config_version: 5 });
      expect(accepted.agent.config_version).toBe(5);
      expect(accepted.draft.config_version).toBe(5);
      expect(accepted.draft.name).toBe(page === "basic" ? saved.name : "draft");
      // Retired raw prompt is not owned by active reading settings.
      expect(accepted.draft.memory_retrieval_prompt).toBe("draft retrieval");
      expect(accepted.draft.p5_config.context_window).toBe(
        page === "context" ? saved.p5_config.context_window : 8192,
      );
      expect(accepted.draft.p5_config.memory_read).toEqual(
        page === "memory-tools" ? saved.p5_config.memory_read : { enabled: false, max_bytes: 2048 },
      );
      expect(accepted.draft.p5_config.retrieval_mode).toBe(saved.p5_config.retrieval_mode);
      expect(draft).toEqual(before);
    },
  );
});

describe("消息纯规则", () => {
  it("乐观消息只依赖显式的文本、ID和时间", () => {
    expect(createOptimisticMessages("你好", "request", NOW)).toEqual(
      createOptimisticMessages("你好", "request", NOW),
    );
    const rows = createOptimisticMessages("你好", "request", NOW);
    expect(rows.map((row) => [row.id, row.role, row.status])).toEqual([
      ["optimistic-user-request", "user", "completed"],
      ["optimistic-assistant-request", "assistant", "pending"],
    ]);
  });
});
