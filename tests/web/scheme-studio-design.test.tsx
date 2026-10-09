// 方案工作台的人性化设计用例：
// 整页全宽与页内分组、契约边界来自 schema、无效原文可定位、上下同源保存、
// 顶部导航交给共享守卫、刷新保稿并更新 CAS 基线、删除与用量守卫、
// 命名三选与复制语义、绑定到当前方案的直达链接。
//
// 这些用例只通过界面与 store 观察行为，不替 actions/navigation 断言它们自己的逻辑。

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import {
  QQ_REPLY_DEFAULT_PROMPT,
  QqBindingResponseSchema,
  type QqSchemeResponse,
} from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale, translate } from "../../src/web/i18n";
import { BindingEditor } from "../../src/web/screens/connections/binding-editor";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CREATED = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "默认方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
    merge_window_seconds: 30,
    reply_cooldown_seconds: 10,
    hourly_speech_limit: 200,
    initiative_min_score: 6,
    judgement_interval_turns: 3,
    idle_quiet_minutes: 15,
    active_hours_enabled: false,
    active_hours_start_minutes: 0,
    active_hours_end_minutes: 1439,
    max_recompute_count: 1,
    max_sticker_count: 1,
    media_supplement_window_minutes: 10,
    media_frame_count: 3,
    media_max_dimension: 512,
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
    initiative_time_window_enabled: true,
    initiative_time_target_seconds: 60,
    initiative_time_jitter_seconds: 20,
  },
  context: {
    judgement_message_limit: 20,
    judgement_window_minutes: 60,
    judgement_token_budget: 2000,
    reply_message_limit: 60,
    reply_window_minutes: 360,
    reply_token_budget: 6000,
  },
  compression: { watermark_trigger: 200, package_limit: 8, headroom_ratio: 0.05 },
  output_reserve: { judgement_output_reserved: 512, reply_output_reserved: 2048 },
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5 },
  sticker_collections: { collection_ids: [] },
  prompts: {
    scene: "场景提示词",
    judge: "判断提示词",
    reply: "回复提示词",
    review: "复核提示词",
    sticker: "选图提示词",
    media: "媒体提示词",
    compress: "压缩提示词",
  },
  // 0052：响应契约收紧后两组必填，夹具照完整响应形状造。
  message_settings: {
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  },
  media_input: {
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
    expression_max_dimension: 512,
    expression_frame_count: 3,
    expression_frame_max_dimension: 512,
  },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

function client(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: scheme().id, bindings: 0 }),
    listQqBindings: vi.fn().mockResolvedValue([]),
    listQqStickerCollections: vi
      .fn()
      .mockResolvedValue([
        { id: COLLECTION, name: "日常", description: null, revision: 1, asset_count: 1 },
      ]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (id: string, body: unknown) =>
        scheme({ id, ...(body as object), revision: 4 }),
      ),
    createQqScheme: vi
      .fn()
      .mockImplementation(async (body: unknown) =>
        scheme({ id: CREATED, ...(body as object), revision: 1 }),
      ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
    updateQqBinding: vi.fn().mockResolvedValue(undefined),
    createQqBinding: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof api;
}

async function renderStudio(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeStudio />);
  await act(async () => {});
  return { fake };
}

const tab = (key: string) => userEvent.click(screen.getByRole("tab", { name: translate(key) }));
/** The field id is the one contract-based anchor: `group.name` under `scheme-field-`. */
const byId = (id: string) => document.getElementById(`scheme-field-${id}`) as HTMLInputElement;
/** Radix TabsContent mounts its content a frame after the panel; the locate focus waits one frame too. */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
const orderOf = (fn: unknown) =>
  ((fn as { mock?: { invocationCallOrder?: number[] } }).mock?.invocationCallOrder ??
    []) as number[];

/** A group title lives in a Card; the light title band is what separates page groups. */
function expectGroupWithBand(title: string) {
  const cards = screen
    .getAllByText(title)
    .map((node) => node.closest('[data-slot="card"]'))
    .filter((card): card is HTMLElement => card !== null);
  expect(cards.length).toBeGreaterThan(0);
  const header = cards[0]?.querySelector('[data-slot="card-header"]');
  expect(header?.className).toContain("bg-muted/50");
  expect(header?.className).toContain("border-b");
}

const bindingOf = (schemeId: string) =>
  QqBindingResponseSchema.parse({
    id: BINDING_ID,
    account_id: "10001",
    kind: "group",
    peer_id: "30003",
    agent_id: AGENT_ID,
    scheme_id: schemeId,
    paused: false,
    triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
    share_web_memory: false,
    memory_batch_size: null,
    pending_observations: 0,
    revision: 1,
    authority_revision: 1,
    attention: { mode: "off", members: [] },
  });

const agentOf = (name: string) =>
  AgentResponseSchema.parse({
    id: AGENT_ID,
    name,
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
    p5_config: { recent_turns: 12 },
  });

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Scheme studio layout and grouping", () => {
  it("spreads across the workspace width, wraps the six tabs and bands every in-page group", async () => {
    await renderStudio();
    expect(document.querySelector(".max-w-5xl")).toBeNull();
    expect(screen.getAllByRole("tab").map((node) => node.textContent)).toEqual([
      translate("schemes.sections.participation"),
      translate("schemes.sections.response"),
      translate("schemes.sections.contextReading"),
      translate("schemes.sections.historyCompression"),
      translate("schemes.sections.imageUnderstanding"),
      translate("schemes.sections.stickerSending"),
    ]);
    const tablist = screen.getByRole("tablist");
    expect(tablist.className).toContain("flex-wrap");
    expect(tablist.className).toContain("max-w-full");
    expect(tablist.className).toContain("[&_[role=tab]]:min-h-8");
    expect(tablist.className).toContain("[&_[role=tab]]:whitespace-normal");
    // 页脚在文档流里收尾，不覆盖表单。
    const footer = screen
      .getByRole("button", { name: translate("connections.saveScheme") })
      .closest("footer");
    expect(footer?.className).toContain("shrink-0");
    expect(footer?.className).toContain("border-t");

    for (const [tabKey, titles] of [
      [
        "schemes.sections.participation",
        [
          "connections.speechTriggers",
          "schemes.studio.rhythmTitle",
          "connections.allowedHours",
          "schemes.studio.judgePrompt",
        ],
      ],
      ["schemes.sections.response", ["schemes.studio.replyStructure", "schemes.studio.replyTasks"]],
      [
        "schemes.sections.contextReading",
        [
          "schemes.studio.messageRelations",
          "connections.judgementContext",
          "connections.replyContext",
        ],
      ],
      ["schemes.sections.historyCompression", ["connections.compressionAndAssembly"]],
      [
        "schemes.sections.imageUnderstanding",
        ["schemes.studio.imageInput", "schemes.studio.imageParams", "connections.mediaNoteTask"],
      ],
      [
        "schemes.sections.stickerSending",
        [
          "schemes.studio.stickerParams",
          "connections.authorizedCollections",
          "connections.stickerTask",
        ],
      ],
    ] as [string, string[]][]) {
      await tab(tabKey);
      for (const title of titles) expectGroupWithBand(translate(title));
    }
  });

  it("keeps every parameter visible, with no editor for the retired controls", async () => {
    await renderStudio();
    const ids = new Set<string>();
    for (const tabKey of [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ]) {
      await tab(tabKey);
      for (const input of document.querySelectorAll<HTMLInputElement>('input[type="number"]'))
        ids.add(input.id);
    }
    expect([...ids].sort()).toEqual(
      [
        "scheme-field-compression.headroom_ratio",
        "scheme-field-compression.package_limit",
        "scheme-field-compression.watermark_trigger",
        "scheme-field-context.judgement_message_limit",
        "scheme-field-context.judgement_token_budget",
        "scheme-field-context.judgement_window_minutes",
        "scheme-field-context.reply_token_budget",
        "scheme-field-context.reply_window_minutes",
        // 0052 两组：层数/图数/表情规格与普通静图（其数值输入挂在「限制长边」选择之下）。
        "scheme-field-mediaInput.expression_frame_count",
        "scheme-field-mediaInput.expression_frame_max_dimension",
        "scheme-field-mediaInput.expression_max_dimension",
        "scheme-field-mediaInput.max_images",
        "scheme-field-media_input.ordinary_still_max_dimension",
        "scheme-field-messageSettings.reply_depth",
        "scheme-field-outputReserve.judgement_output_reserved",
        "scheme-field-outputReserve.reply_output_reserved",
        "scheme-field-rhythm.hourly_speech_limit",
        "scheme-field-rhythm.idle_quiet_minutes",
        "scheme-field-rhythm.initiative_batch_jitter_count",
        "scheme-field-rhythm.initiative_batch_target_count",
        "scheme-field-rhythm.initiative_min_score",
        "scheme-field-rhythm.initiative_time_jitter_seconds",
        "scheme-field-rhythm.initiative_time_target_seconds",
        "scheme-field-rhythm.max_recompute_count",
        "scheme-field-rhythm.max_sticker_count",
        "scheme-field-rhythm.media_frame_count",
        "scheme-field-rhythm.media_max_dimension",
        "scheme-field-rhythm.media_supplement_window_minutes",
        "scheme-field-rhythm.merge_window_seconds",
        "scheme-field-rhythm.reply_cooldown_seconds",
        "scheme-field-stickers.sticker_min_repeat_minutes",
        "scheme-field-stickers.sticker_recent_avoid_count",
      ].sort(),
    );
    // 退役控制不可新增编辑入口。
    expect(ids.has("scheme-field-rhythm.judgement_interval_turns")).toBe(false);
    expect(ids.has("scheme-field-context.reply_message_limit")).toBe(false);
    // 回复档条数仍在原位，只是跟随绑定助手（只读展示）。
    await tab("schemes.sections.contextReading");
    expect(
      screen.queryByRole("spinbutton", { name: translate("connections.replyRecentMessages") }),
    ).toBeNull();
  });

  it("renders derived vs custom reply task status badge and bound turns read-only copy", async () => {
    await renderStudio();
    await tab("schemes.sections.response");
    expect(screen.getByText(translate("schemes.studio.replyPromptCustom"))).toBeTruthy();
    const replyInput = screen.getByLabelText(translate("connections.effectiveReplyTask"));
    fireEvent.change(replyInput, { target: { value: QQ_REPLY_DEFAULT_PROMPT } });
    expect(screen.getByText(translate("schemes.studio.replyPromptDerived"))).toBeTruthy();

    await tab("schemes.sections.contextReading");
    expect(screen.getByText(translate("connections.replyRecentMessages"))).toBeTruthy();
    expect(screen.getByText(translate("connections.noConversationUsesThisSchemeYet"))).toBeTruthy();
  });
});

describe("Scheme studio numeric inputs", () => {
  it("takes min/max/step from the contract schema and never writes an empty value as zero", async () => {
    await renderStudio();
    const merge = byId("rhythm.merge_window_seconds");
    expect([merge.min, merge.max, merge.step]).toEqual(["0", "300", "1"]);
    await tab("schemes.sections.contextReading");
    const budget = byId("context.reply_token_budget");
    expect([budget.min, budget.max, budget.step]).toEqual(["256", "16384", "1"]);
    await tab("schemes.sections.historyCompression");
    const headroom = byId("compression.headroom_ratio");
    expect([headroom.min, headroom.max, headroom.step]).toEqual(["0", "50", "1"]);
    await tab("schemes.sections.imageUnderstanding");
    const frames = byId("rhythm.media_frame_count");
    expect([frames.min, frames.max, frames.step]).toEqual(["1", "10", "1"]);
    const dimension = byId("rhythm.media_max_dimension");
    expect([dimension.min, dimension.max, dimension.step]).toEqual(["64", "2048", "1"]);
    await tab("schemes.sections.stickerSending");
    const repeat = byId("stickers.sticker_min_repeat_minutes");
    expect([repeat.min, repeat.max, repeat.step]).toEqual(["0", "1440", "1"]);

    await tab("schemes.sections.participation");
    const mergeAgain = byId("rhythm.merge_window_seconds");
    fireEvent.change(mergeAgain, { target: { value: "" } });
    fireEvent.blur(mergeAgain);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(30);
    expect(mergeAgain.value).toBe("");
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(translate("schemes.studio.integerRange", "0", "300"));
    expect(mergeAgain.getAttribute("aria-describedby") ?? "").toContain(error.id);
    expect(
      (
        screen.getByRole("button", {
          name: translate("connections.saveScheme"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(translate("connections.correctInvalidNumbersFirst"))).toBeTruthy();
  });

  it("keeps raw invalid text, links the error to its input, and locates it on the right tab", async () => {
    await renderStudio();
    await tab("schemes.sections.imageUnderstanding");
    const frames = byId("rhythm.media_frame_count");
    fireEvent.change(frames, { target: { value: "99" } });
    fireEvent.blur(frames);
    expect(frames.value).toBe("99");
    expect(store.getState().qqSchemeEditor?.rhythm.media_frame_count).toBe(3);
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(translate("schemes.studio.integerRange", "1", "10"));
    expect(frames.getAttribute("aria-describedby") ?? "").toContain(error.id);
    expect(frames.getAttribute("aria-invalid")).toBe("true");

    // 切走后错误不在眼前，页脚的「定位无效项」把它带回正确的页签并聚焦。
    await tab("schemes.sections.participation");
    await userEvent.click(
      screen.getByRole("button", { name: translate("schemes.studio.locateInvalid") }),
    );
    await nextFrame();
    expect(
      screen
        .getByRole("tab", { name: translate("schemes.sections.imageUnderstanding") })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(byId("rhythm.media_frame_count"));
  });
});

describe("Scheme studio save paths", () => {
  it("saves the whole scheme from the footer, with only one 保存方案 button and no header save", async () => {
    const { fake } = await renderStudio();
    const footerSave = screen.getByRole("button", { name: translate("connections.saveScheme") });
    expect(
      screen.getAllByRole("button", { name: translate("connections.saveScheme") }),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: translate("workspace.save") })).toBeNull();
    expect((footerSave as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    expect((footerSave as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(footerSave));
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        expected_revision: 3,
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
        context: expect.objectContaining({ reply_token_budget: 6000 }),
        compression: expect.objectContaining({ watermark_trigger: 200 }),
        output_reserve: expect.objectContaining({ reply_output_reserved: 2048 }),
        stickers: expect.objectContaining({ sticker_min_repeat_minutes: 10 }),
        triggers: expect.objectContaining({ direct_reply: true }),
        reply: { split_by_speaker: true },
        sticker_collections: { collection_ids: [] },
        prompts: expect.objectContaining({ scene: "场景提示词" }),
      }),
    );
    // 页脚同源：修改说明后再次保存，验证 CAS 修订号递增为 4。
    fireEvent.change(screen.getByLabelText(translate("connections.description")), {
      target: { value: "更安静" },
    });
    await act(async () => fireEvent.click(footerSave));
    expect(fake.updateQqScheme).toHaveBeenCalledTimes(2);
    expect(fake.updateQqScheme).toHaveBeenLastCalledWith(
      scheme().id,
      expect.objectContaining({ expected_revision: 4, description: "更安静" }),
    );
  });

  it("keeps the draft across a conflict and only adopts the fresh revision on explicit refresh", async () => {
    const fresh = scheme({
      name: "服务端最新",
      revision: 9,
      rhythm: { ...scheme().rhythm, merge_window_seconds: 45 },
    });
    const { fake } = await renderStudio({
      updateQqScheme: vi.fn().mockRejectedValue(new Error("方案已变化，请重新加载后保存")),
      listQqSchemes: vi.fn().mockResolvedValueOnce([scheme()]).mockResolvedValue([fresh]),
    });
    const merge = screen.getByLabelText(translate("connections.mergeWindowSeconds"));
    fireEvent.change(merge, { target: { value: "15" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: translate("connections.saveScheme") })),
    );
    expect(screen.getByRole("alert").textContent).toContain("方案已变化");
    expect((merge as HTMLInputElement).value).toBe("15");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: translate("schemes.studio.refresh") })),
    );
    expect(fake.listQqSchemes).toHaveBeenCalledTimes(2);
    const editor = store.getState().qqSchemeEditor;
    expect(editor?.source.revision).toBe(9);
    expect(editor?.name).toBe("服务端最新");
    expect(editor?.rhythm.merge_window_seconds).toBe(15);
    expect((merge as HTMLInputElement).value).toBe("15");
    expect(
      screen
        .getAllByRole("status")
        .map((node) => node.textContent ?? "")
        .some((text) => text.includes("刷新不提交草稿")),
    ).toBe(true);
  });

  it("hands the top select to the shared navigation guard instead of dropping the draft locally", async () => {
    const other = scheme({ id: OTHER, name: "其他方案" });
    await renderStudio({ listQqSchemes: vi.fn().mockResolvedValue([scheme(), other]) });
    const select = screen.getByLabelText(translate("connections.chooseAChatScheme"));
    // 没有草稿：共享动作直接切换，并落回方案详情路由。
    fireEvent.change(select, { target: { value: other.id } });
    await act(async () => {});
    expect(store.getState().qqSchemeEditor?.source.id).toBe(other.id);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");

    // 有草稿：守卫接管，编辑器与草稿都原地保留。
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    fireEvent.change(select, { target: { value: scheme().id } });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: scheme().id });
    expect(store.getState().qqSchemeEditor?.source.id).toBe(other.id);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
  });
});

describe("Scheme studio new / copy on a dirty draft", () => {
  it("asks save / discard / cancel before a new scheme replaces the draft, and Cancel keeps everything", async () => {
    const { fake } = await renderStudio();
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "我的新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    expect(within(dialog).getByText(translate("schemes.studio.draftGuardMessage"))).toBeTruthy();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.cancel") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
    expect(store.getState().qqInputs.schemeNewName).toBe("我的新方案");
  });

  it("saves first and then creates when the user picks save, and the draft leaves with the switch", async () => {
    const { fake } = await renderStudio();
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "我的新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("workspace.save_and_continue") }),
    );
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledTimes(1);
    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    expect(fake.createQqScheme).toHaveBeenCalledWith({ name: "我的新方案", description: null });
    expect(orderOf(fake.updateQqScheme)[0]).toBeLessThan(orderOf(fake.createQqScheme)[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(CREATED);
    expect(store.getState().qqInputs.schemeNewName).toBe("");
  });

  it("discards by switching to the created scheme when the user picks discard", async () => {
    const { fake } = await renderStudio();
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "我的新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("workspace.discard_and_continue") }),
    );
    await act(async () => {});
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(CREATED);
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(30);
    expect(store.getState().qqInputs.schemeTexts).toEqual({});
  });

  it("keeps the draft and the typed name when creating fails, showing the error in the dialog and the form", async () => {
    const { fake } = await renderStudio({
      createQqScheme: vi.fn().mockRejectedValue(new Error("创建失败：网络")),
    });
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "我的新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("workspace.discard_and_continue") }),
    );
    await act(async () => {});
    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain("创建失败");
    const formAlerts = screen
      .getAllByRole("alert", { hidden: true })
      .filter((node) => node.closest('[role="dialog"]') === null);
    expect(formAlerts).toHaveLength(1);
    expect(formAlerts[0]?.textContent).toContain("创建失败");
    expect(store.getState().qqInputs.schemeNewName).toBe("我的新方案");
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.cancel") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqSchemeEditor?.rhythm.merge_window_seconds).toBe(15);
  });

  it("marks the naming dialog busy while a create is in flight", async () => {
    const pending = Promise.withResolvers<QqSchemeResponse>();
    const { fake } = await renderStudio({ createQqScheme: vi.fn(() => pending.promise) });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    expect(fake.createQqScheme).toHaveBeenCalledTimes(1);
    expect(
      (
        within(dialog).getByRole("button", {
          name: translate("connections.confirm"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: translate("connections.cancel"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => pending.resolve(scheme({ id: CREATED, name: "新方案", revision: 1 })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.getState().qqSchemeEditor?.source.id).toBe(CREATED);
  });

  it("copies the unsaved draft as a new scheme and says so, without touching the source", async () => {
    const { fake } = await renderStudio();
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(screen.getByRole("button", { name: translate("connections.saveAs") }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(translate("schemes.studio.copyHint"))).toBeTruthy();
    expect(within(dialog).getByRole("textbox")).toBeTruthy();
    expect(within(dialog).queryByText(translate("schemes.studio.draftGuardMessage"))).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "副本一" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await act(async () => {});
    expect(fake.createQqScheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "副本一",
        rhythm: expect.objectContaining({ merge_window_seconds: 15 }),
      }),
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(
      store.getState().qqSchemes.find((row) => row.id === scheme().id)?.rhythm.merge_window_seconds,
    ).toBe(30);
    expect(store.getState().qqSchemeEditor?.source.id).toBe(CREATED);
  });
  it("holds save and continue until the invalid numbers are fixed, while discard and continue stays available", async () => {
    await renderStudio();
    const merge = screen.getByLabelText(translate("connections.mergeWindowSeconds"));
    fireEvent.change(merge, { target: { value: "999" } });
    fireEvent.blur(merge);
    await userEvent.click(screen.getByRole("button", { name: translate("connections.create") }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "我的新方案" } });
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    const saveAndContinue = within(dialog).getByRole("button", {
      name: translate("workspace.save_and_continue"),
    }) as HTMLButtonElement;
    const discardAndContinue = within(dialog).getByRole("button", {
      name: translate("workspace.discard_and_continue"),
    }) as HTMLButtonElement;
    expect(saveAndContinue.disabled).toBe(true);
    expect(discardAndContinue.disabled).toBe(false);
  });
});

describe("Scheme studio usage and deletion guards", () => {
  it("deletes an unused scheme after a named confirmation", async () => {
    const { fake } = await renderStudio();
    const remove = screen.getByRole("button", {
      name: translate("connections.deleteScheme"),
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(false);
    await userEvent.click(remove);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      translate("schemes.studio.deleteUnusedConfirm", "默认方案"),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await act(async () => {});
    expect(fake.deleteQqScheme).toHaveBeenCalledWith(scheme().id);
  });

  it("blocks deletion while the scheme is in use and explains how many conversations use it", async () => {
    const { fake } = await renderStudio({
      getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: scheme().id, bindings: 2 }),
    });
    const remove = screen.getByRole("button", {
      name: translate("connections.deleteScheme"),
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(screen.getByText(translate("schemes.studio.inUseCannotDelete", "2"))).toBeTruthy();
    fireEvent.click(remove);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.deleteQqScheme).not.toHaveBeenCalled();
  });

  it("treats an unknown usage count as unknown: explains cannot delete and keeps deletion off", async () => {
    const usage = vi
      .fn()
      .mockRejectedValueOnce(new Error("离线"))
      .mockResolvedValue({ scheme_id: scheme().id, bindings: 0 });
    await renderStudio({ getQqSchemeUsage: usage });
    expect(screen.getByText(translate("schemes.studio.usageUnknownCannotDelete"))).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: translate("connections.deleteScheme"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("用法计数点击把详情切到使用会话视图，不开只读弹窗也不写绑定", async () => {
    const fake = client();
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
    });
    render(<SchemesWorkspace />);
    await act(async () => {});
    const usage = document.querySelector("[data-scheme-usage]") as HTMLElement;
    expect(usage).toBeTruthy();
    await userEvent.click(usage);
    await act(async () => {});
    expect(store.getState().qqSchemeView).toBe("bindings");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });

  it("names the unsaved changes before deleting a dirty draft, and only deletes after confirmation", async () => {
    const { fake } = await renderStudio();
    fireEvent.change(screen.getByLabelText(translate("connections.mergeWindowSeconds")), {
      target: { value: "15" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: translate("connections.deleteScheme") }),
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      translate("schemes.studio.deleteDirtyConfirm", "默认方案"),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: translate("connections.confirm") }),
    );
    await act(async () => {});
    expect(fake.deleteQqScheme).toHaveBeenCalledWith(scheme().id);
  });
});

describe("Scheme studio message input preview (T13 Step4)", () => {
  it("shows a read-only sample on the context tab that follows the draft settings and hides (no forged preview) on an invalid timezone", async () => {
    await renderStudio();
    await tab("schemes.sections.contextReading");
    const previewText = () =>
      document.querySelector("[data-qq-message-preview] pre")?.textContent ?? "";
    // 示例按草稿当前设置渲染（默认 hybrid / Asia/Shanghai），且区域只读。
    expect(previewText()).toContain("now=2026-10-02 00:00:00，timezone=Asia/Shanghai");
    const block = document.querySelector("[data-qq-message-preview]") as HTMLElement;
    expect(block.querySelector("input, textarea, select, button")).toBeNull();

    // 草稿变化实时反映：切到完整相对时间、改时区，示例同 renderer 输出联动。
    const timeSelect = screen.getByLabelText(
      translate("connections.timeDisplayMode"),
    ) as HTMLSelectElement;
    fireEvent.change(timeSelect, { target: { value: "full_relative" } });
    expect(previewText()).toContain("2026-10-01 23:55:00（5分钟前）");
    const timezone = screen.getByLabelText(translate("connections.timezone"));
    fireEvent.change(timezone, { target: { value: "Asia/Tokyo" } });
    expect(previewText()).toContain("timezone=Asia/Tokyo");
    expect(previewText()).toContain("now=2026-10-02 01:00:00");

    // 时区原文非法：不伪造预览（无 pre），显示占位说明；保存仍被拦（既有守卫不变）。
    fireEvent.change(timezone, { target: { value: "Mars/Olympus" } });
    expect(document.querySelector("[data-qq-message-preview] pre")).toBeNull();
    expect(screen.getByText(translate("schemes.studio.messagePreviewUnavailable"))).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: translate("connections.saveScheme"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("Scheme handoff from a conversation binding", () => {
  const conversation = {
    account_id: "10001",
    kind: "group" as const,
    peer_id: "30003",
    messages: 5,
    last_at_seconds: 0,
    binding_id: BINDING_ID,
  };

  async function renderEditor(boundSchemeId: string, overrides: Partial<typeof api> = {}) {
    const fake = client(overrides);
    const binding = bindingOf(boundSchemeId);
    const bound = scheme({ id: boundSchemeId, name: "绑定中的方案" });
    const current = scheme({ id: OTHER, name: "工作台当前方案" });
    const draftTarget = scheme({
      id: "66666666-6666-4666-8666-666666666666",
      name: "草稿想要的目标",
    });
    store.getState().resetForTests(fake);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
      qqSchemes: [bound, current, draftTarget],
      qqSchemeEditor: qqSchemeEditorFrom(current),
      qqBindings: [binding],
      qqBindingsLoaded: true,
      agents: [agentOf("小助手")],
    });
    render(<BindingEditor conversation={conversation} binding={binding} onClose={vi.fn()} />);
    await act(async () => {});
    return { fake, binding, bound, current, draftTarget };
  }

  it("opens the bound scheme in the studio and never saves the binding on the way", async () => {
    const { fake, bound } = await renderEditor("77777777-7777-4777-8777-777777777777");
    const button = screen.getByRole("button", {
      name: translate("schemes.studio.editScheme"),
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // 跳转本身不写绑定，所以不被 busy 锁住；同一行的保存改绑仍然被锁。
    act(() => {
      store.setState({ qqAccessSaving: true });
    });
    expect(button.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: translate("connections.saveBinding"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    act(() => {
      store.setState({ qqAccessSaving: false });
    });
    await userEvent.click(button);
    await act(async () => {});
    expect(store.getState().qqSchemeEditor?.source.id).toBe(bound.id);
    expect(store.getState().settingsRoute).toBe("qq-scheme-config");
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });

  it("routes the draft's scheme through the shared guard and keeps the unsaved binding", async () => {
    const { fake, binding, current, draftTarget } = await renderEditor(
      "77777777-7777-4777-8777-777777777777",
    );
    const select = screen.getByLabelText(translate("connections.schemes")) as HTMLSelectElement;
    await userEvent.selectOptions(select, draftTarget.id);
    await userEvent.click(
      screen.getByRole("button", { name: translate("schemes.studio.editScheme") }),
    );
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().pendingNavigation).toEqual({ kind: "scheme", id: draftTarget.id });
    expect(store.getState().qqSchemeEditor?.source.id).toBe(current.id);
    expect(store.getState().qqInputs.choices[binding.id]?.schemeId).toBe(draftTarget.id);
    expect(fake.updateQqBinding).not.toHaveBeenCalled();
    expect(fake.createQqBinding).not.toHaveBeenCalled();
  });
});

describe("性能阶段补测：窄订阅行为保持（FE-P1, studio）", () => {
  it("与本页无关的 store 更新不重渲染 studio；本页读取字段更新仍正常刷新", async () => {
    await renderStudio();
    const nameInput = screen.getByLabelText("方案名称") as HTMLInputElement;
    // 无关更新：memoryCorrectionSaving 不是本页读取字段 → 窄订阅不得重渲染。
    const htmlBefore = document.body.innerHTML;
    await act(async () => {
      store.setState({ memoryCorrectionSaving: true });
    });
    expect(document.body.innerHTML).toBe(htmlBefore);
    // 本页读取字段更新：qqSchemes 目录变化 → 方案选择器必须反映新方案。
    const extra = scheme({ id: "77777777-7777-4777-8777-777777777777", name: "新到方案" });
    await act(async () => {
      store.setState({ qqSchemes: [scheme(), extra] });
    });
    const combo = screen.getByRole("combobox", { name: "选择聊天方案" }) as HTMLSelectElement;
    expect([...combo.options].some((o) => o.textContent === "新到方案")).toBe(true);
    // 击键仍即时反映：名称输入直接写编辑器。
    fireEvent.change(nameInput, { target: { value: "改名方案" } });
    expect(store.getState().qqSchemeEditor?.name).toBe("改名方案");
  });
});
