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

describe("single memory settings page actions", () => {
  it("legacy fieldless draft refresh keeps only edited enabled and adopts a smaller remote allowance", async () => {
    const { persisted, client } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...persisted.p5_config,
        memory_read: {
          enabled: false,
          max_bytes: persisted.p5_config.retrieval_presets.standard.max_tokens,
        },
      },
    });
    const remote = {
      ...persisted,
      config_version: 9,
      p5_config: { ...persisted.p5_config, memory_read: { enabled: true, max_bytes: 256 } },
    };
    vi.mocked(client.getAgent).mockResolvedValueOnce(remote);
    expect(await store.getState().refreshSettingsAgent()).toBe(true);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual({
      enabled: false,
      max_bytes: 256,
    });
    expect(store.getState().pageEditor?.agent.p5_config.retrieval_presets).toEqual(
      persisted.p5_config.retrieval_presets,
    );
  });
  it("patch/dirty/save owns active bytes but leaves every raw preset intact", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...persisted.p5_config, memory_read: { enabled: true, max_bytes: 9999 } },
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(updateAgent.mock.calls[0][1].p5_config).toMatchObject({
      memory_read: { enabled: true, max_bytes: 9999 },
      retrieval_presets: persisted.p5_config.retrieval_presets,
    });
  });
  it("discard restores only owned fields and invalid strings, preserving context and other Agents", async () => {
    const { persisted } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...persisted.p5_config, memory_read: { enabled: false, max_bytes: 222 } },
    });
    store
      .getState()
      .patchPageAgent("context", { p5_config: { ...persisted.p5_config, recent_turns: 12 } });
    store.setState({
      allocationInvalidInputs: {
        "agent:A:reading:memory:bytes": "",
        "agent:B:aux:memory_consolidate": "abc",
      },
    });
    store.getState().discardSettingsPages("memory-tools");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual(
      persisted.p5_config.memory_read,
    );
    expect(store.getState().pageEditor?.draft.p5_config.recent_turns).toBe(12);
    expect(store.getState().allocationInvalidInputs).toEqual({
      "agent:B:aux:memory_consolidate": "abc",
    });
  });
  it("refresh keeps local memory bytes while adopting a foreign enabled value and new CAS version", async () => {
    const { persisted, client, updateAgent } = setup({
      p5_config: { ...agentFixture().p5_config, memory_read: { enabled: true, max_bytes: 4096 } },
    });
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...persisted.p5_config, memory_read: { enabled: true, max_bytes: 1234 } },
    });
    vi.mocked(client.getAgent).mockResolvedValueOnce({
      ...persisted,
      config_version: 5,
      p5_config: { ...persisted.p5_config, memory_read: { enabled: false, max_bytes: 4096 } },
    });
    expect(await store.getState().refreshSettingsAgent()).toBe(true);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual({
      enabled: false,
      max_bytes: 1234,
    });
    expect(store.getState().pageEditor?.agent.config_version).toBe(5);
    expect(updateAgent).not.toHaveBeenCalled();
  });
  it("invalid memory raw refuses writing and a later API response cannot replace the next editor", async () => {
    const { persisted, updateAgent } = setup();
    await openEditor();
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...persisted.p5_config, memory_read: { enabled: false, max_bytes: 222 } },
    });
    store.setState({ allocationInvalidInputs: { "agent:A:reading:memory:bytes": "0" } });
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(store.getState().error).toContain(INVALID_NOTICE);
  });
});
