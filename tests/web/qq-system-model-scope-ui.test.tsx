// 系统与 QQ 模型作用域 UI：shared/QQ 模型与辅助额度分别保存/放弃、capacity 单读与 late 忽略、
// QQ connection 起载一次与错误单一、invalid-only 可放弃、hidden 不读。全部合成 API，不触网。
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import {
  resetContextAllocationTarget,
  setContextAllocationTarget,
} from "../../src/web/features/context-allocation";
import { selectLocale, translate } from "../../src/web/i18n";
import { QqConnectionTab } from "../../src/web/screens/connections/qq-app-management";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { useSuperstringStore as store } from "../../src/web/store";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const qqSettings = (revision: number): QqSettingsResponse => ({
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision,
});

function createClient(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getQqSettings: vi.fn().mockResolvedValue(qqSettings(3)),
    getQqStatus: vi.fn().mockResolvedValue({ connection: { phase: "ready", reason: null } }),
    listQqConversations: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqSchemes: vi.fn().mockResolvedValue([]),
    getQqOwner: vi
      .fn()
      .mockResolvedValue({ configured: true, account_id: "10001", peer_id: null, revision: 1 }),
    getOrganizationSettings: vi.fn().mockResolvedValue({
      model_name: "org-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 1,
    }),
    getKnowledgeSettings: vi.fn().mockResolvedValue({
      auto_enabled: true,
      model_name: null,
      context_budget: 32000,
      revision: 1,
    }),
    getModelCapacity: vi
      .fn()
      .mockResolvedValue({ model: "vision-model", status: "loaded", context_length: 128000 }),
    saveOrganizationSettings: vi
      .fn()
      .mockImplementation(
        async (body: { expected_revision: number; auxiliary_allocation?: unknown }) => ({
          model_name: "org-default",
          vision_model_name: "vision-model",
          transcription_model_name: null,
          auxiliary_allocation: body.auxiliary_allocation ?? {},
          revision: body.expected_revision + 1,
        }),
      ),
    updateQqSettings: vi
      .fn()
      .mockImplementation(async (body: { expected_revision: number }) =>
        qqSettings(body.expected_revision + 1),
      ),
    ...overrides,
  } as unknown as typeof api;
}

function resetStore(client: ReturnType<typeof createClient>) {
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-connection",
    modelNames: ["org-default", "vision-model"],
    organizationEditor: null,
    knowledgeModelEditor: null,
    qqSettings: null,
    dirty: false,
  });
}

beforeEach(async () => {
  await selectLocale("zh-CN");
  vi.restoreAllMocks();
  resetContextAllocationTarget();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("system and QQ model scope UI", () => {
  it("QQ connection reads settings and status once on entry and the judge group no longer double-reads", async () => {
    const client = createClient();
    resetStore(client);
    render(<QqConnectionTab active={true} />);

    await waitFor(() => expect(store.getState().qqSettings).not.toBeNull());
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});
    // 入口起载：设置与状态各读一次（QqJudgementModel managed 后不再自读）。
    expect(client.getQqSettings).toHaveBeenCalledTimes(1);
    expect(client.getQqStatus).toHaveBeenCalledTimes(1);
    expect(client.getOrganizationSettings).toHaveBeenCalledTimes(1);
    // 页面渲染连接表单与 QQ 模型组。
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
    expect(screen.getByText(translate("qq.models.title"))).toBeTruthy();
    expect(screen.getByText(translate("qq.aux.title"))).toBeTruthy();
    // 两个 QQ 角色：已存 vision 模型作为运行事实显示，容量只按模型读一次。
    expect(await screen.findAllByText(/128000/)).toHaveLength(2);
    expect(client.getModelCapacity).toHaveBeenCalledTimes(1);
    expect(client.getModelCapacity).toHaveBeenCalledWith("vision-model");
  });

  it("retries a failed QQ settings read with exactly one extra request and shows the error once", async () => {
    const getQqSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings down"))
      .mockResolvedValue(qqSettings(3));
    const client = createClient({ getQqSettings });
    resetStore(client);
    // 读取失败横幅在统一壳层的设置分区 wrapper：按真实工作区路由断言错误语义。
    render(<SchemesWorkspace />);

    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((n) => n.textContent?.includes("settings down")),
      ).toBe(true),
    );
    await act(async () => {});
    // 失败读取：入口一次 + 显式重试前共 1 次设置请求，错误只呈现一处。
    expect(getQqSettings).toHaveBeenCalledTimes(1);
    const alerts = screen
      .getAllByRole("alert")
      .filter((n) => n.textContent?.includes("settings down"));
    expect(alerts).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: translate("capabilities.retry") }));
    await waitFor(() => expect(store.getState().qqSettings).not.toBeNull());
    await act(async () => {});
    // 重试后共 2 次，错误消失。
    expect(getQqSettings).toHaveBeenCalledTimes(2);
    expect(
      screen.getAllByRole("alert").filter((n) => n.textContent?.includes("settings down")),
    ).toHaveLength(0);
    expect(screen.getByLabelText(translate("connections.websocketAddress"))).toBeTruthy();
  });

  it("does not start any connection or capacity read while hidden and reads once on activation", async () => {
    const client = createClient();
    resetStore(client);
    const { rerender } = render(<QqConnectionTab active={false} />);
    await act(async () => {});
    expect(client.getQqSettings).not.toHaveBeenCalled();
    expect(client.getQqStatus).not.toHaveBeenCalled();
    expect(client.getOrganizationSettings).not.toHaveBeenCalled();
    expect(client.getModelCapacity).not.toHaveBeenCalled();

    rerender(<QqConnectionTab active={true} />);
    await waitFor(() => expect(store.getState().qqSettings).not.toBeNull());
    await act(async () => {});
    expect(client.getQqSettings).toHaveBeenCalledTimes(1);
    expect(client.getQqStatus).toHaveBeenCalledTimes(1);
    expect(client.getOrganizationSettings).toHaveBeenCalledTimes(1);

    // 回到 hidden：不重新读取，也不追加容量请求。
    rerender(<QqConnectionTab active={false} />);
    await act(async () => {});
    expect(client.getQqSettings).toHaveBeenCalledTimes(1);
    expect(client.getModelCapacity).toHaveBeenCalledTimes(1);
  });

  it("shows the saved vision model capacity once for both QQ roles and ignores a late response after the API client is replaced", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const getModelCapacity = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const client = createClient({ getModelCapacity });
    resetStore(client);
    render(<QqConnectionTab active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});
    expect(getModelCapacity).toHaveBeenCalledTimes(1);

    // 同页替换 API client：旧请求的迟到响应不得写入容量显示，新 client 重新读一次。
    const replacement = createClient({
      getModelCapacity: vi
        .fn()
        .mockResolvedValue({ model: "vision-model", status: "loaded", context_length: 64000 }),
    });
    store.setState({ apiClient: replacement });
    await act(async () => {});
    expect(replacement.getModelCapacity).toHaveBeenCalledTimes(1);
    expect(replacement.getModelCapacity).toHaveBeenCalledWith("vision-model");

    resolveOld({ model: "vision-model", status: "loaded", context_length: 128000 });
    await act(async () => {});
    expect(screen.queryByText(/128000/)).toBeNull();
    // 新 client 的容量在两个角色卡片上各显示一次，且只请求一次。
    expect(await screen.findAllByText(/64000/)).toHaveLength(2);
    expect(replacement.getModelCapacity).toHaveBeenCalledTimes(1);
  });

  it("saves and discards shared default, QQ models and aux roles through independent scopes without cross-draft bleed", async () => {
    const client = createClient();
    resetStore(client);
    render(<QqConnectionTab active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});

    // QQ 模型组：改 vision 模型 → 保存只提交 qq-models 作用域，aux 与 shared 草稿不动。
    fireEvent.change(screen.getByLabelText(translate("models.purpose.vision")), {
      target: { value: "vision-b" },
    });
    expect(store.getState().organizationEditor?.visionModelName).toBe("vision-b");
    const modelGroup = screen
      .getByRole("combobox", { name: translate("models.purpose.vision") })
      .closest("section");
    expect(modelGroup).not.toBeNull();
    const save = within(modelGroup as HTMLElement).getByRole("button", {
      name: translate("library.save"),
    });
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(store.getState().organizationEditor?.source.revision).toBe(2));
    const savedPayload = vi.mocked(client.saveOrganizationSettings).mock.calls[0][0];
    expect(savedPayload).toMatchObject({ vision_model_name: "vision-b" });
    expect(savedPayload).not.toHaveProperty("model_name");
    expect(savedPayload).not.toHaveProperty("auxiliary_allocation");

    // QQ 辅助组：勾选自定义并改输出预留 → 保存只提交 allocation 的两个 QQ 角色。
    fireEvent.click(screen.getByTestId("aux-custom-toggle-qq_sticker_annotate"));
    fireEvent.change(screen.getByTestId("aux-output-reserved-qq_sticker_annotate"), {
      target: { value: "512" },
    });
    const auxSave = screen.getByTestId("aux-save-global-btn");
    await act(async () => {
      fireEvent.click(auxSave);
    });
    await waitFor(() => expect(store.getState().organizationEditor?.source.revision).toBe(3));
    const auxPayload = vi.mocked(client.saveOrganizationSettings).mock.calls[1][0];
    expect(auxPayload).toMatchObject({
      auxiliary_allocation: { qq_sticker_annotate: { output_reserved: 512 } },
    });
    expect(auxPayload).not.toHaveProperty("vision_model_name");
  });

  it("keeps unselected dirty/invalid drafts when saving or discarding the selected scope", async () => {
    const client = createClient();
    resetStore(client);
    render(<QqConnectionTab active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});

    // 知识整理角色（非 QQ 页选中域）勾自定义 + 非法原文：QQ 保存/放弃不受牵动也不清理它。
    act(() =>
      store.setState({
        organizationEditor: {
          ...store.getState().organizationEditor!,
          auxiliaryAllocation: {
            ...store.getState().organizationEditor!.auxiliaryAllocation,
            knowledge_organize: { mode: "auto" },
          },
        },
        allocationInvalidInputs: {
          "global:aux:knowledge_organize_output_reserved": "-5",
        },
      }),
    );
    expect(
      store.getState().allocationInvalidInputs["global:aux:knowledge_organize_output_reserved"],
    ).toBe("-5");

    // QQ 辅助组保存：只提交 QQ 角色，knowledge_organize 草稿与非法 raw 原样保留。
    fireEvent.click(screen.getByTestId("aux-custom-toggle-qq_sticker_annotate"));
    const auxSave = screen.getByTestId("aux-save-global-btn");
    await act(async () => {
      fireEvent.click(auxSave);
    });
    await waitFor(() => expect(store.getState().organizationEditor?.source.revision).toBe(2));
    const auxPayload = vi.mocked(client.saveOrganizationSettings).mock.calls[0][0];
    expect(Object.keys(auxPayload.auxiliary_allocation as object)).toEqual(["qq_sticker_annotate"]);
    expect(
      store.getState().organizationEditor?.auxiliaryAllocation?.knowledge_organize,
    ).toMatchObject({ mode: "auto" });
    expect(
      store.getState().allocationInvalidInputs["global:aux:knowledge_organize_output_reserved"],
    ).toBe("-5");

    // 放弃新修改时恢复最近保存的 QQ 值，不删除已经保存的自定义配置。
    fireEvent.change(screen.getByTestId("aux-mode-select-qq_sticker_annotate"), {
      target: { value: "auto" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("aux-discard-global-btn"));
    });
    expect(
      store.getState().organizationEditor?.auxiliaryAllocation?.qq_sticker_annotate,
    ).toMatchObject({ mode: "fixed" });
    expect(
      store.getState().organizationEditor?.auxiliaryAllocation?.knowledge_organize,
    ).toMatchObject({ mode: "auto" });
    expect(
      store.getState().allocationInvalidInputs["global:aux:knowledge_organize_output_reserved"],
    ).toBe("-5");
  });

  it("enables discard when only invalid raw remains in the selected scope and clears it without touching other roles", async () => {
    const client = createClient();
    resetStore(client);
    render(<QqConnectionTab active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});

    // 草稿不脏，但选中 QQ 角色有非法原文：放弃按钮可用。
    act(() =>
      store.setState({
        allocationInvalidInputs: {
          "global:aux:qq_media_describe_input_limit": "abc",
        },
      }),
    );
    const discardBtn = screen.getByTestId("aux-discard-global-btn") as HTMLButtonElement;
    expect(discardBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(discardBtn);
    });
    // 选中角色的 raw 被清掉。
    expect(
      store.getState().allocationInvalidInputs["global:aux:qq_media_describe_input_limit"],
    ).toBeUndefined();
    expect(discardBtn.disabled).toBe(true);

    // 未选角色的非法 raw 保留：knowledge_organize 的 raw 与该放弃操作无关。
    act(() =>
      store.setState({
        allocationInvalidInputs: {
          "global:aux:knowledge_organize_input_limit": "xyz",
          "global:aux:qq_media_describe_input_limit": "abc",
        },
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("aux-discard-global-btn"));
    });
    expect(
      store.getState().allocationInvalidInputs["global:aux:qq_media_describe_input_limit"],
    ).toBeUndefined();
    expect(
      store.getState().allocationInvalidInputs["global:aux:knowledge_organize_input_limit"],
    ).toBe("xyz");
  });

  it("system aux page renders only knowledge_organize and never requests QQ model capacity", async () => {
    const client = createClient();
    resetStore(client);
    store.setState({ settingsRoute: "models" });
    setContextAllocationTarget({ purpose: "aux" });
    render(<ModelPurposes active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await act(async () => {});

    expect(screen.getByTestId("aux-card-knowledge_organize")).toBeTruthy();
    expect(screen.queryByTestId("aux-card-qq_sticker_annotate")).toBeNull();
    expect(screen.queryByTestId("aux-card-qq_media_describe")).toBeNull();
    // QQ 起载一个都不发生：系统辅助页与 QQ 连接完全隔离。
    expect(client.getQqSettings).not.toHaveBeenCalled();
    expect(client.getQqStatus).not.toHaveBeenCalled();
    // 容量只按 knowledge_organize 的模型读（org-default），不是 vision-model。
    expect(client.getModelCapacity).toHaveBeenCalledTimes(1);
    expect(client.getModelCapacity).toHaveBeenCalledWith("org-default");
  });

  it("cold organization load failure offers retry and the retry succeeds without a duplicate read", async () => {
    const getOrganizationSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("org down"))
      .mockResolvedValue({
        model_name: "org-default",
        vision_model_name: "vision-model",
        transcription_model_name: null,
        auxiliary_allocation: {},
        revision: 1,
      });
    const client = createClient({ getOrganizationSettings });
    resetStore(client);
    render(<QqConnectionTab active={true} />);

    // 冷载失败：页面给重试入口，不伪装成已停用。
    await waitFor(() => expect(store.getState().organizationError).not.toBeNull());
    expect(getOrganizationSettings).toHaveBeenCalledTimes(1);
    const retry = await screen.findByRole("button", { name: translate("models.retryDefaults") });
    await act(async () => {
      fireEvent.click(retry);
    });
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    expect(getOrganizationSettings).toHaveBeenCalledTimes(2);
    expect(store.getState().organizationError).toBeNull();
    // 成功后两组（QQ 模型 + QQ 辅助）都渲染。
    expect(screen.getByText(translate("qq.models.title"))).toBeTruthy();
    expect(screen.getByText(translate("qq.aux.title"))).toBeTruthy();
  });
});
