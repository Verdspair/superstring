// 模型服务页页签刷新回归：providers 首绘只读一次服务商清单并与本地目录合并，
// defaults 头部刷新显式重读组织/知识，不读取 QQ，且刷新只合并不自动保存草稿。
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { knowledgeModelDirty, organizationDirty } from "../../src/web/features/knowledge/types";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { ModelDefaults } from "../../src/web/screens/environment/model-defaults";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";

const provider: ModelProviderResponse = {
  id: PROVIDER_ID,
  name: "DeepSeek",
  base_url: "https://api.deepseek.com/v1",
  has_api_key: true,
  models: [
    { name: "shared-model", context_window: 65536 },
    { name: "remote-chat", context_window: 32768 },
  ],
  revision: 3,
  created_at: "2026-09-25T00:00:00.000000Z",
  updated_at: "2026-09-25T00:00:00.000000Z",
};

const qqSettings = (revision = 5): QqSettingsResponse => ({
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://127.0.0.1:3000/", has_token: true },
  revision,
});

const organization = (modelName: string, revision: number) => ({
  model_name: modelName,
  vision_model_name: null,
  transcription_model_name: null,
  revision,
});

const knowledge = (modelName: string | null, revision: number) => ({
  model_name: modelName,
  revision,
  auto_enabled: true,
  context_budget: 4096,
});

function modelServicesFake(overrides: Partial<typeof api> = {}) {
  const fake = {
    ...api,
    listModelProviders: vi.fn().mockResolvedValue([provider]),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: ["local-chat", "shared-model"],
      default_model: "local-chat",
    }),
    // A permanent pending probe represents a slow remote provider: editing must not wait for it.
    testModelProvider: vi.fn().mockReturnValue(new Promise(() => {})),
    getLocalModelEncodings: vi.fn().mockResolvedValue({ revision: "rev-1", models: [] }),
    getOrganizationSettings: vi.fn().mockResolvedValue(organization("org-baseline", 1)),
    getKnowledgeSettings: vi.fn().mockResolvedValue(knowledge("knowledge-baseline", 1)),
    getQqSettings: vi.fn().mockResolvedValue(qqSettings()),
    saveOrganizationSettings: vi.fn(),
    saveKnowledgeSettings: vi.fn(),
    updateQqSettings: vi.fn(),
  } as unknown as typeof api;
  Object.assign(fake, overrides);
  return fake;
}

async function renderModels(route: "models" | "external-api", overrides: Partial<typeof api> = {}) {
  const fake = modelServicesFake(overrides);
  store.getState().resetForTests(fake);
  store.setState({ settingsRoute: route });
  render(<ModelServices />);
  await act(async () => {});
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("providers tab first paint", () => {
  it("reads providers once, merges local models, and edits while health is pending", async () => {
    const fake = await renderModels("external-api");
    await waitFor(() => expect(store.getState().modelNames).toContain("remote-chat"));

    expect(fake.listModelProviders).toHaveBeenCalledTimes(1);
    expect(fake.listModelProviders).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fake.listModels).toHaveBeenCalledTimes(1);
    // locals first, then external names, deduplicated at the shared model-id boundary.
    expect(store.getState().loadedModelNames).toEqual(["local-chat", "shared-model"]);
    expect(store.getState().externalModelNames).toEqual(["shared-model", "remote-chat"]);
    expect(store.getState().modelNames).toEqual(["local-chat", "shared-model", "remote-chat"]);

    await waitFor(() => expect(fake.testModelProvider).toHaveBeenCalledTimes(1));
    expect(fake.testModelProvider).toHaveBeenCalledWith(PROVIDER_ID, expect.any(AbortSignal));
    // The never-settling probe leaves the row in its explicit checking state.
    expect(screen.getByText(i18n.t("models.checking"))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("models.configure") }));
    const name = screen.getByRole("textbox", { name: i18n.t("models.name") }) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: "草稿服务" } });
    expect(name.value).toBe("草稿服务");
    expect(fake.testModelProvider).toHaveBeenCalledTimes(1);
  });
});

describe("model service responsibilities", () => {
  it("legacy models entry reads resources without fetching unrelated task settings", async () => {
    const fake = await renderModels("models");
    await waitFor(() => expect(fake.listModelProviders).toHaveBeenCalledTimes(1));
    expect(fake.getOrganizationSettings).not.toHaveBeenCalled();
    expect(fake.getKnowledgeSettings).not.toHaveBeenCalled();
    expect(fake.getQqSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("models.refresh") }));
    await waitFor(() => expect(fake.listModelProviders).toHaveBeenCalledTimes(2));
    expect(fake.listModels).toHaveBeenCalledTimes(2);
    expect(fake.getOrganizationSettings).not.toHaveBeenCalled();
    expect(fake.getKnowledgeSettings).not.toHaveBeenCalled();
  });
});
describe("task settings draft merge at their own surfaces", () => {
  it("keeps edited draft fields, adopts the fresh revision, and never auto-saves", async () => {
    const fake = modelServicesFake();
    store.getState().resetForTests(fake);
    store.setState({ contextAllocationTarget: { purpose: "reading", agentId: null } });
    render(
      <>
        <ModelDefaults active scope="organization" />
        <ModelPurposes active embedded />
      </>,
    );
    await waitFor(() => {
      expect(store.getState().organizationEditor).not.toBeNull();
      expect(store.getState().organizationLoading).toBe(false);
      expect(store.getState().knowledgeModelEditor).not.toBeNull();
      expect(store.getState().knowledgeModelLoading).toBe(false);
      expect(store.getState().qqSettings).toBeNull();
    });

    act(() => {
      store.getState().patchOrganization("org-draft");
      store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    });
    expect(organizationDirty(store.getState().organizationEditor)).toBe(true);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "budget")).toBe(true);

    // The explicit refresh reads a newer server baseline.
    vi.mocked(fake.getOrganizationSettings).mockResolvedValue({
      model_name: "org-remote",
      vision_model_name: "vision-remote",
      transcription_model_name: "transcription-remote",
      revision: 8,
    });
    vi.mocked(fake.getKnowledgeSettings).mockResolvedValue({
      model_name: "knowledge-remote",
      revision: 8,
      auto_enabled: false,
      context_budget: 6000,
    });
    vi.mocked(fake.getQqSettings).mockResolvedValue(qqSettings(9));

    await act(async () => {
      await Promise.all([
        store.getState().loadOrganization(true),
        store.getState().loadKnowledgeModel(true),
      ]);
    });
    await waitFor(() => {
      expect(store.getState().organizationEditor?.source.revision).toBe(8);
      expect(store.getState().knowledgeModelEditor?.source.revision).toBe(8);
      expect(store.getState().qqSettings).toBeNull();
    });
    expect(fake.getOrganizationSettings).toHaveBeenCalledTimes(2);
    expect(fake.getKnowledgeSettings).toHaveBeenCalledTimes(2);
    expect(fake.getQqSettings).not.toHaveBeenCalled();

    // The organization purposes merge as one dirty group; the edited row is kept while the
    // source baseline advances. Knowledge model fields merge individually below.
    const orgEditor = store.getState().organizationEditor;
    expect(orgEditor?.modelName).toBe("org-draft");
    expect(organizationDirty(orgEditor)).toBe(true);

    const knowledgeEditor = store.getState().knowledgeModelEditor;
    // The edited field keeps its draft; untouched fields adopt the fresh source and revision.
    expect(knowledgeEditor?.contextBudget).toBe(8192);
    expect(knowledgeEditor?.modelName).toBe("knowledge-remote");
    expect(knowledgeEditor?.autoEnabled).toBe(false);
    expect(knowledgeModelDirty(knowledgeEditor, "model")).toBe(false);
    expect(knowledgeModelDirty(knowledgeEditor, "budget")).toBe(true);

    // A refresh only merges reads; saving stays an explicit action.
    expect(fake.saveOrganizationSettings).not.toHaveBeenCalled();
    expect(fake.saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(fake.updateQqSettings).not.toHaveBeenCalled();
  });
});
