import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { dirtyPages } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const INVALID_NOTICE = "请先修正方案中的无效数字，再保存。";

function agentFixture(id = "A", overrides: Partial<AgentResponse> = {}): AgentResponse {
  return AgentResponseSchema.parse({
    id,
    name: `Agent ${id}`,
    description: "",
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides,
  });
}

function personaFixture(id = "A"): PersonaResponse {
  return PersonaResponseSchema.parse({
    id: `persona-${id}`,
    agent_id: id,
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  });
}

interface Harness {
  persisted: AgentResponse;
  updateAgent: ReturnType<typeof vi.fn>;
  client: SuperstringApi;
}

function setup(fresh?: Partial<AgentResponse>): Harness {
  let persisted = agentFixture("A", fresh);
  const updateAgent = vi.fn(async (_id: string, body: Record<string, unknown>) => {
    const { expected_version, ...patch } = body;
    expect(expected_version).toBe(persisted.config_version);
    persisted = {
      ...persisted,
      ...patch,
      config_version: persisted.config_version + 1,
    } as AgentResponse;
    return persisted;
  });
  const client = {
    getAgent: vi.fn(async (id: string) => (id === "A" ? persisted : agentFixture(id))),
    getPersona: vi.fn(async (id: string) => personaFixture(id)),
    getPolicy: vi.fn(async () => ({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 300,
      version: 1,
    })),
    updatePolicy: vi.fn(),
    getModelCapacity: vi.fn(async () => ({ context_length: 32768 })),
    listMemorySessions: vi.fn(async () => []),
    listMemoryJobs: vi.fn(async () => []),
    updateAgent,
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    agents: [persisted],
    allocationInvalidInputs: {},
  });
  return { persisted, updateAgent, client };
}

/** 打开编辑会话并断言在编辑器上（editAgent 是设置页打开助手的正规入口）。 */
async function openEditor(): Promise<void> {
  expect(await store.getState().editAgent("A")).toBe(true);
}

beforeEach(() => {
  selectLocale("zh-CN");
});

describe("page-actions nested preset ownership (patch → dirty → save)", () => {
  it("memory-tools patch of retrieval_presets changes draft max_tokens, marks dirty, and the save API payload keeps foreign non-budget fields with a bumped version", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: { ...persisted.p5_config.retrieval_presets.broad, max_tokens: 9999 },
        },
      },
    });
    // Bug root: the patch previously hit no explicit context branch and was a silent NOOP.
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(
      9999,
    );
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    const [calledId, body] = updateAgent.mock.calls[0] as [string, Record<string, unknown>];
    expect(calledId).toBe("A");
    const p5 = body.p5_config as Record<string, unknown>;
    // memory-tools page owns max_tokens: new value lands
    expect((p5.retrieval_presets as Record<string, unknown>).broad).toMatchObject({
      max_tokens: 9999,
    });
    // foreign non-budget fields are preserved from the saved baseline
    expect((p5.retrieval_presets as Record<string, unknown>).broad).toMatchObject({
      candidate_limit: persisted.p5_config.retrieval_presets.broad.candidate_limit,
      max_entries: persisted.p5_config.retrieval_presets.broad.max_entries,
      relevance_instruction: persisted.p5_config.retrieval_presets.broad.relevance_instruction,
    });
    expect(body.expected_version).toBe(1);
    // other preset modes remain untouched
    expect((p5.retrieval_presets as Record<string, unknown>).conservative).toMatchObject(
      persisted.p5_config.retrieval_presets.conservative,
    );
  });

  it("memory-tools patch preserves unchanged max_tokens while updating other preset fields", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: { ...persisted.p5_config.retrieval_presets.broad, candidate_limit: 88 },
        },
      },
    });
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad.candidate_limit,
    ).toBe(88);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(updateAgent).toHaveBeenCalledTimes(1);
    const p5 = (updateAgent.mock.calls[0][1] as Record<string, unknown>).p5_config as Record<
      string,
      unknown
    >;
    expect((p5.retrieval_presets as Record<string, unknown>).broad).toMatchObject({
      candidate_limit: 88,
    });
    // Unchanged max_tokens remains the saved value.
    expect((p5.retrieval_presets as Record<string, unknown>).broad).toMatchObject({
      max_tokens: persisted.p5_config.retrieval_presets.broad.max_tokens,
    });
  });
});

describe("discardSettingsPages restores only page-owned nested keys", () => {
  it("context discard retains memory preset draft; memory discard restores it without touching context", async () => {
    const { persisted } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: {
            ...persisted.p5_config.retrieval_presets.broad,
            candidate_limit: 123,
            max_tokens: 7777,
          },
        },
      },
    });
    store
      .getState()
      .patchPageAgent("context", { p5_config: { ...persisted.p5_config, recent_turns: 12 } });
    store.getState().discardSettingsPages("context");
    let editor = store.getState().pageEditor;
    expect(editor?.draft.p5_config.recent_turns).toBe(persisted.p5_config.recent_turns);
    expect(editor?.draft.p5_config.retrieval_presets.broad).toMatchObject({
      candidate_limit: 123,
      max_tokens: 7777,
    });
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);
    store
      .getState()
      .patchPageAgent("context", { p5_config: { ...persisted.p5_config, recent_turns: 12 } });
    store.getState().discardSettingsPages("memory-tools");
    editor = store.getState().pageEditor;
    expect(editor?.draft.p5_config.retrieval_presets.broad).toEqual(
      persisted.p5_config.retrieval_presets.broad,
    );
    expect(editor?.draft.p5_config.recent_turns).toBe(12);
    expect(dirtyPages(editor)).toEqual(["context"]);
  });

  it("memory-tools discard clears its invalid raw inputs while keeping other agents' entries", async () => {
    const { persisted } = setup();
    await openEditor();
    store.setState({
      allocationInvalidInputs: {
        "agent:A:reading:memory:broad": "-5",
        "agent:B:aux:memory_consolidate": "abc",
      },
    });
    store.getState().discardSettingsPages("memory-tools");
    expect(store.getState().allocationInvalidInputs).toEqual({
      "agent:B:aux:memory_consolidate": "abc",
    });
    // Full discard clears everything and resets the whole draft to saved.
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: { ...persisted.p5_config.retrieval_presets.broad, max_tokens: 1234 },
        },
      },
    });
    store.getState().discardSettingsPages();
    expect(store.getState().allocationInvalidInputs).toEqual({
      "agent:B:aux:memory_consolidate": "abc",
    });
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(
      persisted.p5_config.retrieval_presets.broad.max_tokens,
    );
  });
});

describe("refreshSettingsAgent merges presets per nested ownership", () => {
  it("keeps local budget draft while adopting a foreign non-budget change; the memory page adopts foreign budget while keeping its local non-budget draft", async () => {
    const first = setup();
    const { persisted, client } = first;
    await openEditor();
    // Local memory draft: user changed max_tokens only.
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: { ...persisted.p5_config.retrieval_presets.broad, max_tokens: 7777 },
        },
      },
    });
    // A foreign writer changes candidate_limit (memory-owned) and summary_max_tokens.
    const fresh = agentFixture("A", {
      config_version: 5,
      p5_config: {
        ...persisted.p5_config,
        summary_max_tokens: 8192,
        retrieval_presets: {
          ...persisted.p5_config.retrieval_presets,
          broad: { ...persisted.p5_config.retrieval_presets.broad, candidate_limit: 200 },
        },
      },
    });
    (client.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fresh);
    expect(await store.getState().refreshSettingsAgent()).toBe(true);
    let editor = store.getState().pageEditor;
    // Foreign non-budget change adopted (previously the whole object was overwritten by the stale draft).
    expect(editor?.draft.p5_config.retrieval_presets.broad.candidate_limit).toBe(200);
    expect(editor?.draft.p5_config.summary_max_tokens).toBe(8192);
    // Local budget draft retained and still dirty for the memory-tools page.
    expect(editor?.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(7777);
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);

    // Reverse direction: foreign budget change is adopted, local memory non-budget draft retained.
    const second = setup();
    const { persisted: persisted2, client: client2 } = second;
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted2.p5_config,
        retrieval_presets: {
          ...persisted2.p5_config.retrieval_presets,
          broad: { ...persisted2.p5_config.retrieval_presets.broad, candidate_limit: 321 },
        },
      },
    });
    const fresh2 = agentFixture("A", {
      config_version: 7,
      p5_config: {
        ...persisted2.p5_config,
        retrieval_presets: {
          ...persisted2.p5_config.retrieval_presets,
          broad: { ...persisted2.p5_config.retrieval_presets.broad, max_tokens: 4242 },
        },
      },
    });
    (client2.getAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fresh2);
    expect(await store.getState().refreshSettingsAgent()).toBe(true);
    editor = store.getState().pageEditor;
    // Foreign budget adopted into the draft baseline; local non-budget draft retained and dirty.
    expect(editor?.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(4242);
    expect(editor?.draft.p5_config.retrieval_presets.broad.candidate_limit).toBe(321);
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);
  });
});

describe("context save is blocked by leftover allocation invalid inputs", () => {
  it("an agent-prefixed invalid entry fails the context save before the API and keeps the draft", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("context", {
      p5_config: {
        ...persisted.p5_config,
        recent_turns: 12,
      },
    });
    store.setState({ allocationInvalidInputs: { "agent:A:aux:memory_consolidate": "-1" } });
    expect(await store.getState().saveSettingsPage("context")).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(store.getState().error).toBe(INVALID_NOTICE);
    // Draft retained: user can fix the raw input and retry.
    expect(store.getState().pageEditor?.draft.p5_config.recent_turns).toBe(12);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["context"]);
    // Not this agent's prefix: save goes through.
    store.setState({ allocationInvalidInputs: { "agent:B:aux:memory_consolidate": "-1" } });
    expect(await store.getState().saveSettingsPage("context")).toBe(true);
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it("the same gate applies to the bulk path saveAllSettingsPages", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...persisted.p5_config, retrieval_mode: "broad" },
    });
    store.setState({ allocationInvalidInputs: { "agent:A:reading:memory:standard": "x" } });
    expect(await store.getState().saveAllSettingsPages()).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(store.getState().error).toBe(INVALID_NOTICE);
  });
});

it("context discard leaves knowledge raw and memory-tools discard leaves context raw", () => {
  const retained = { "agent:A:reading:knowledgeAgent": "-9", "global:knowledge": "bad" };
  store.setState({
    allocationInvalidInputs: { ...retained, "agent:A:aux:research_input_limit": "-3" },
  });
  store.getState().discardSettingsPages("context");
  expect(store.getState().allocationInvalidInputs).toEqual(retained);
  store.setState({ allocationInvalidInputs: { "agent:A:context:recent_turns": "" } });
  store.getState().discardSettingsPages("memory-tools");
  expect(store.getState().allocationInvalidInputs).toEqual({ "agent:A:context:recent_turns": "" });
});
