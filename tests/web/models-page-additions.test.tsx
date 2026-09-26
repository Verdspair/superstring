// 默认模型页的两处新增：
//   1. 「一键覆盖当前助手的模型」——把当前助手的四个**文本用途**一次改成共同默认模型并立即保存；
//      图片理解与语音转写不是助手的字段，所以不在覆盖范围（用户弹窗答复：只覆盖文本用途并直接保存）。
//   2. 「QQ 判断模型」——QQ 全局的一份设置（0038），第三方聊天总开关关着时置灰并给出去处。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import type { SuperstringApi } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { ModelDefaults } from "../../src/web/screens/environment/model-defaults";
import { useSuperstringStore as store } from "../../src/web/store";

const agent = (overrides: Partial<AgentResponse> = {}) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    name: "合成助手",
    description: "",
    additional_instructions: "",
    model_name: "chat-model",
    temperature: 0.7,
    memory_consolidation_model_name: null,
    memory_consolidation_prompt: "整理",
    memory_consolidation_additional_instructions: "",
    memory_retrieval_model_name: null,
    memory_retrieval_prompt: "读取",
    context_compression_model_name: null,
    p5_config: {},
    is_active: true,
    config_version: 7,
    persona_intensity: 50,
    updated_at: "2026-09-25T00:00:00.000Z",
    created_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  }) as AgentResponse;
const persona = { agent_id: "00000000-0000-4000-8000-000000000001" } as PersonaResponse;
const organization = (model: string | null) => ({
  model_name: model,
  vision_model_name: null,
  transcription_model_name: null,
  revision: 3,
});

const settings = (overrides: Partial<QqSettingsResponse> = {}): QqSettingsResponse => ({
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://127.0.0.1:3000/", has_token: true },
  revision: 5,
  ...overrides,
});

function client(overrides: Partial<SuperstringApi> = {}) {
  return {
    getOrganizationSettings: vi.fn(async () => organization("default-model")),
    saveOrganizationSettings: vi.fn(async (body: object) => ({ ...body, revision: 4 })),
    getKnowledgeSettings: vi.fn(async () => ({
      model_name: null,
      revision: 1,
      auto_enabled: true,
      context_budget: 4096,
    })),
    updateAgent: vi.fn(async (_id: string, body: object) => agent({ ...(body as object) })),
    getQqSettings: vi.fn(async () => settings()),
    updateQqSettings: vi.fn(async (body: { judgement_model_name?: string | null }) =>
      settings({ judgement_model_name: body.judgement_model_name ?? null, revision: 6 }),
    ),
    ...overrides,
  } as unknown as SuperstringApi;
}

function renderOrganization(fake: SuperstringApi) {
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "models",
    agents: [agent()],
    editorAgentId: agent().id,
    pageEditor: newPageEditor(agent(), persona),
  });
  render(<ModelDefaults />);
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("Model purpose boundaries", () => {
  it("applies the shared model to four text purposes with the current Agent version", async () => {
    const fake = renderOrganization(client());
    await act(async () => {});
    await act(async () => {
      expect(await store.getState().applyDefaultModelToAgent("default-model")).toBe(true);
    });
    expect(fake.updateAgent).toHaveBeenCalledWith(
      agent().id,
      expect.objectContaining({
        expected_version: 7,
        model_name: "default-model",
        memory_retrieval_model_name: "default-model",
        memory_consolidation_model_name: "default-model",
        context_compression_model_name: "default-model",
      }),
    );
  });
  it("does not write when all four purposes already match", async () => {
    const fake = client();
    store.getState().resetForTests(fake);
    const current = agent({
      model_name: "same",
      memory_retrieval_model_name: "same",
      memory_consolidation_model_name: "same",
      context_compression_model_name: "same",
    });
    store.setState({ editorAgentId: current.id, pageEditor: newPageEditor(current, persona) });
    expect(await store.getState().applyDefaultModelToAgent("same")).toBe(true);
    expect(fake.updateAgent).not.toHaveBeenCalled();
  });
  it("saves QQ judgement selection independently and clears it with null", async () => {
    const fake = renderOrganization(client());
    store.setState({ modelNames: ["judge-model"] });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("判断模型"), { target: { value: "judge-model" } });
    await act(async () => {});
    expect(fake.updateQqSettings).toHaveBeenCalledWith({
      judgement_model_name: "judge-model",
      expected_revision: 5,
    });
    fireEvent.change(screen.getByLabelText("判断模型"), { target: { value: "" } });
    await act(async () => {});
    expect(fake.updateQqSettings).toHaveBeenLastCalledWith({
      judgement_model_name: null,
      expected_revision: 6,
    });
  });
  it("explains that a configured QQ model does not run while the connection is disabled", async () => {
    renderOrganization(client({ getQqSettings: vi.fn(async () => settings({ enabled: false })) }));
    await act(async () => {});
    expect(screen.getByText(/第三方聊天总开关已关闭/)).toBeTruthy();
  });
  it("provides a retry when QQ settings fail to load", async () => {
    const fake = renderOrganization(
      client({
        getQqSettings: vi
          .fn()
          .mockRejectedValueOnce(new Error("unavailable"))
          .mockResolvedValue(settings()),
      }),
    );
    await act(async () => {});
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "重试读取 QQ 设置" })),
    );
    expect(fake.getQqSettings).toHaveBeenCalledTimes(2);
  });
});
