// 默认模型页的两处新增（用户 2026-09-25）：
//   1. 「一键覆盖当前助手的模型」——把当前助手的四个**文本用途**一次改成共同默认模型并立即保存；
//      图片理解与语音转写不是助手的字段，所以不在覆盖范围（用户弹窗答复：只覆盖文本用途并直接保存）。
//   2. 「QQ 判断模型」——QQ 全局的一份设置（0038），第三方聊天总开关关着时置灰并给出去处。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import type { SuperstringApi } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { OrganizationModelPage } from "../../src/web/features/knowledge/OrganizationModelPage";
import { QqJudgementModelPage } from "../../src/web/features/qq/QqJudgementModelPage";
import { selectLocale } from "../../src/web/i18n";
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
  render(<OrganizationModelPage />);
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("一键覆盖当前助手的模型", () => {
  it("确认后把四个文本用途一起改成默认模型并立即保存", async () => {
    const fake = renderOrganization(client());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "一键覆盖当前助手的模型" }));
    // 对话框点名两个东西：改哪个助手、改成哪个模型。
    expect(
      screen.getByText(
        /将把「合成助手」的对话、记忆读取、记忆整理与上下文压缩都设为「default-model」/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "覆盖并保存" }));
    await act(async () => {});
    expect(fake.updateAgent).toHaveBeenCalledWith(
      agent().id,
      expect.objectContaining({
        model_name: "default-model",
        memory_retrieval_model_name: "default-model",
        memory_consolidation_model_name: "default-model",
        context_compression_model_name: "default-model",
        expected_version: 7,
      }),
    );
    // 图片理解/语音转写不是助手的字段：payload 里根本不存在它们（组织默认那一页才管这两项）。
    const payload = vi.mocked(fake.updateAgent).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("vision_model_name");
    expect(payload).not.toHaveProperty("transcription_model_name");
    expect(store.getState().pageEditor?.agent.model_name).toBe("default-model");
    expect(store.getState().feedback).toContain("已把这个默认模型覆盖到当前助手的四个文本用途");
  });

  it("四个用途已经就是这个模型时不发请求，只说明无需覆盖", async () => {
    const same = agent({
      model_name: "default-model",
      memory_retrieval_model_name: "default-model",
      memory_consolidation_model_name: "default-model",
      context_compression_model_name: "default-model",
    });
    const fake = client();
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "models",
      agents: [same],
      editorAgentId: same.id,
      pageEditor: newPageEditor(same, persona),
    });
    render(<OrganizationModelPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "一键覆盖当前助手的模型" }));
    fireEvent.click(screen.getByRole("button", { name: "覆盖并保存" }));
    await act(async () => {});
    expect(fake.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().feedback).toContain("无需覆盖");
  });

  it("没有选默认模型、或正在新建助手时按钮不可用", async () => {
    const fake = client();
    store.getState().resetForTests(fake);
    // 未指定共同默认模型：没有可覆盖的东西。
    vi.mocked(fake.getOrganizationSettings).mockResolvedValue(organization(null));
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "models",
      agents: [agent()],
      editorAgentId: agent().id,
      pageEditor: newPageEditor(agent(), persona),
    });
    render(<OrganizationModelPage />);
    await act(async () => {});
    expect(
      (screen.getByRole("button", { name: "一键覆盖当前助手的模型" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();
    // 正在新建的助手：还没有可覆盖的配置。
    vi.mocked(fake.getOrganizationSettings).mockResolvedValue(organization("default-model"));
    store.setState({ editorAgentId: "__new__", pageEditor: newPageEditor(agent(), persona) });
    render(<OrganizationModelPage />);
    await act(async () => {});
    expect(
      (screen.getByRole("button", { name: "一键覆盖当前助手的模型" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/先选中一个已有助手/)).toBeTruthy();
  });
});

describe("QQ 判断模型（0038）", () => {
  it("选中后立即保存，并向界面回读保存值", async () => {
    const fake = client();
    store.getState().resetForTests(fake);
    // 下拉里只有已知模型（与页面上其它模型选择器同一条规则）：夹具把要选的那个放进去。
    store.setState({ modelNames: ["chat-model", "judge-model"] });
    render(<QqJudgementModelPage />);
    await act(async () => {});
    const select = (await screen.findByLabelText("判断开口兴趣打分模型")) as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "judge-model" } });
    await act(async () => {});
    expect(fake.updateQqSettings).toHaveBeenCalledWith({
      judgement_model_name: "judge-model",
      expected_revision: 5,
    });
    expect((screen.getByLabelText("判断开口兴趣打分模型") as HTMLSelectElement).value).toBe(
      "judge-model",
    );
    // 选回「跟随对话模型」＝清空：null 与"不动它"是两件事，这里发的是 null。
    fireEvent.change(screen.getByLabelText("判断开口兴趣打分模型"), { target: { value: "" } });
    await act(async () => {});
    expect(fake.updateQqSettings).toHaveBeenLastCalledWith({
      judgement_model_name: null,
      expected_revision: 6,
    });
  });

  it("第三方聊天总开关关着时置灰，并指出开关在哪", async () => {
    const fake = client({ getQqSettings: vi.fn(async () => settings({ enabled: false })) });
    store.getState().resetForTests(fake);
    // 2026-09-25：开关与 QQ 配置搬到运行模式页（不是一条路由），所以这里钉的是视图跳转。
    const goTo = vi.fn();
    store.setState({ requestPageNavigation: goTo });
    render(<QqJudgementModelPage />);
    await act(async () => {});
    expect((screen.getByLabelText("判断开口兴趣打分模型") as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/第三方聊天总开关关着，判断不会运行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前往运行模式" }));
    expect(goTo).toHaveBeenCalledWith("settings", "operating-mode");
  });

  it("读取失败时给出重试入口，不假装读到了设置", async () => {
    const fake = client({
      getQqSettings: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });
    store.getState().resetForTests(fake);
    render(<QqJudgementModelPage />);
    await act(async () => {});
    expect(screen.queryByLabelText("判断开口兴趣打分模型")).toBeNull();
    expect(screen.getByRole("button", { name: "重试读取 QQ 设置" })).toBeTruthy();
    expect(screen.getByText(/读取 QQ 设置失败/)).toBeTruthy();
  });
});
