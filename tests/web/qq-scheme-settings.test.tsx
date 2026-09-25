// QQ 聊天方案页 (§5.2/§11.2, ADR0018 P5f).
//
// The cases follow the page's promises: one shared draft for the whole parameter set, a save that
// carries it under compare-and-swap, `另存为新方案` that leaves the original alone, a delete that
// says how many conversations would be affected, and the two things §11.1 keeps OFF this page —
// model selection and rebinding — asserted by absence.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { SchemeSettings } from "../../src/web/features/qq/SchemeSettings";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-24T00:00:00.000Z";
const COLLECTION = "11111111-1111-4111-8111-111111111111";
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
    // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
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
  },
  context: {
    judgement_message_limit: 20,
    judgement_window_minutes: 60,
    judgement_token_budget: 2000,
    reply_message_limit: 60,
    reply_window_minutes: 360,
    reply_token_budget: 6000,
  },
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
    getQqSchemeUsage: vi.fn().mockResolvedValue({
      scheme_id: scheme().id,
      bindings: 2,
    }),
    listQqStickerCollections: vi.fn().mockResolvedValue([
      {
        id: COLLECTION,
        name: "日常",
        description: null,
        revision: 1,
        asset_count: 1,
      },
    ]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    updateQqScheme: vi
      .fn()
      .mockImplementation(async (_id: string, body: unknown) =>
        scheme({ ...(body as object), revision: 4 }),
      ),
    createQqScheme: vi
      .fn()
      .mockImplementation(async (body: unknown) =>
        scheme({ id: "55555555-5555-4555-8555-555555555555", ...(body as object), revision: 1 }),
      ),
    deleteQqScheme: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as typeof api;
}

async function renderPage(overrides: Partial<typeof api> = {}) {
  const fake = client(overrides);
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
  });
  render(<SchemeSettings />);
  await act(async () => {});
  return { fake };
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("聊天方案页", () => {
  it("读取方案与素材集合，并说明这是 QQ 全局资源", async () => {
    await renderPage();
    expect(screen.getByLabelText("当前方案")).toBeTruthy();
    expect(screen.getByText(/不随当前助手切换/)).toBeTruthy();
    // The six prompts are editable in place and indexed at the top (§11.1/§3.3).
    expect(screen.getByRole("navigation", { name: "提示词索引" })).toBeTruthy();
    expect(screen.getByLabelText("场景与行为")).toBeTruthy();
    expect(screen.getByLabelText("媒体说明任务")).toBeTruthy();
    for (const key of ["scene", "judge", "reply", "review", "sticker", "media"]) {
      expect(document.getElementById(`qq-prompt-${key}`)).toBeTruthy();
    }
  });

  it("改一个参数就列出变更，保存时整组提交并带上已读版本", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("发言冷却（秒）"), { target: { value: "25" } });
    // §11.2's 预览变更: only real differences, in 旧值 → 新值 form.
    const preview = await screen.findByText("将要保存的变更");
    expect(preview).toBeTruthy();
    expect(screen.getByText(/发言冷却（秒）：10 → 25/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        rhythm: expect.objectContaining({ reply_cooldown_seconds: 25 }),
        expected_revision: 3,
      }),
    );
    expect(await screen.findByText("已保存方案")).toBeTruthy();
  });

  it("判断间隔已从页面撤下（间隔与分数复用取消，判断每次真跑）", async () => {
    await renderPage();
    // 2026-09-25 用户决定：这件事不再是一个旋钮，页面也就不该留着它——留着会让人以为它还在生效。
    expect(screen.queryByLabelText("判断间隔（群友消息条数）")).toBeNull();
  });

  it("主动开口门槛是方案里的一个数字，改动走同一份草稿", async () => {
    const { fake } = await renderPage();
    // 0034: the judge answers with a 0–10 interest score, and this is the number it has to reach
    // before she opens her mouth unprompted — the knob the user asked for on 2026-09-25.
    const field = () => screen.getByLabelText("主动开口门槛（0–10 分）") as HTMLInputElement;
    expect(field().value).toBe("6");
    fireEvent.change(field(), { target: { value: "9" } });
    expect(await screen.findByText(/主动开口门槛（0–10 分）：6 → 9/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        rhythm: expect.objectContaining({ initiative_min_score: 9 }),
      }),
    );
  });

  it("媒体与表达里能改「被@媒体读取失败后的等待」，并整组提交", async () => {
    const { fake } = await renderPage();
    // The input shows ITS OWN stored value, not the neighbouring field's: the expression section
    // renders rows from two groups, and a shared value would be invisible to a change-preview
    // assertion (it compares drafts, not inputs).
    expect(
      (screen.getByLabelText("被@媒体读取失败后的等待（分钟）") as HTMLInputElement).value,
    ).toBe("10");
    expect((screen.getByLabelText("每条回复最多几张表情") as HTMLInputElement).value).toBe("1");
    // P5m's window is a scheme parameter (user decision 2026-09-24: editable, 10-minute default),
    // so it travels with the rhythm group the same way the other numeric limits do.
    fireEvent.change(screen.getByLabelText("被@媒体读取失败后的等待（分钟）"), {
      target: { value: "30" },
    });
    expect(await screen.findByText(/被@媒体读取失败后的等待（分钟）：10 → 30/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        rhythm: expect.objectContaining({ media_supplement_window_minutes: 30 }),
      }),
    );
  });

  it("触发开关与提示词都走同一份草稿", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByLabelText("冷场发起", { selector: "input" }));
    fireEvent.change(screen.getByLabelText("判断任务"), { target: { value: "新的判断提示词" } });
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        triggers: expect.objectContaining({ idle_topic: true }),
        prompts: expect.objectContaining({ judge: "新的判断提示词" }),
      }),
    );
  });

  it("授权集合按整集提交", async () => {
    const { fake } = await renderPage();
    fireEvent.click(screen.getByLabelText("日常", { selector: "input" }));
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({ sticker_collections: { collection_ids: [COLLECTION] } }),
    );
  });

  it("另存为新方案会先确认，把草稿存成新方案，不动原来那个", async () => {
    const { fake } = await renderPage();
    fireEvent.change(screen.getByLabelText("发言冷却（秒）"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("另存为新方案"), { target: { value: "安静方案" } });
    fireEvent.click(screen.getByRole("button", { name: "另存" }));
    // 有未保存改动时先问一句（用户 2026-09-25 第 2 项）：另存会把草稿一起存进新方案。
    expect(screen.getByText(/另存会把当前未保存的改动一起存进新方案/)).toBeTruthy();
    expect(fake.createQqScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await act(async () => {});
    expect(fake.createQqScheme).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "安静方案",
        rhythm: expect.objectContaining({ reply_cooldown_seconds: 45 }),
      }),
    );
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
    expect(await screen.findByText("已另存为新方案")).toBeTruthy();
  });

  it("切换方案前确认，取消就留在原方案", async () => {
    const other = scheme({ id: "66666666-6666-4666-8666-666666666666", name: "另一个方案" });
    const { fake } = await renderPage({
      listQqSchemes: vi.fn().mockResolvedValue([scheme(), other]),
    });
    fireEvent.change(screen.getByLabelText("发言冷却（秒）"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("当前方案"), { target: { value: other.id } });
    expect(screen.getByText(/切换会丢掉它们/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {});
    // 还留在原方案，草稿也在。
    expect((screen.getByLabelText("当前方案") as HTMLSelectElement).value).toBe(scheme().id);
    expect((screen.getByLabelText("发言冷却（秒）") as HTMLInputElement).value).toBe("45");
    fireEvent.change(screen.getByLabelText("当前方案"), { target: { value: other.id } });
    fireEvent.click(screen.getByRole("button", { name: "放弃改动并继续" }));
    await act(async () => {});
    expect((screen.getByLabelText("当前方案") as HTMLSelectElement).value).toBe(other.id);
    expect(fake.updateQqScheme).not.toHaveBeenCalled();
  });

  it("数字框不夹紧：越界不写进草稿、报错并挡住保存，改对才放行", async () => {
    const { fake } = await renderPage();
    const field = () => screen.getByLabelText("每小时上限") as HTMLInputElement;
    fireEvent.change(field(), { target: { value: "9999" } });
    // 没有静默改成 500：输入框保留用户打的字；编辑中不打断，失焦才校验。
    expect(field().value).toBe("9999");
    expect(screen.queryByText("需要 1–500 之间的整数")).toBeNull();
    fireEvent.blur(field());
    expect(screen.getByText("需要 1–500 之间的整数")).toBeTruthy();
    expect(screen.queryByText("将要保存的变更")).toBeNull();
    expect((screen.getByRole("button", { name: "保存方案" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/有 1 处输入还需要改对/)).toBeTruthy();
    // 改对之后：报错消失、变更预览出现、保存可用，并且只提交这一个改动。
    fireEvent.change(field(), { target: { value: "300" } });
    await act(async () => {});
    expect(screen.queryByText("需要 1–500 之间的整数")).toBeNull();
    expect(await screen.findByText(/每小时上限：200 → 300/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({ rhythm: expect.objectContaining({ hourly_speech_limit: 300 }) }),
    );
  });

  it("允许时段用时间选择器，按本机时间换算成当天第几分钟", async () => {
    const { fake } = await renderPage();
    const start = () => screen.getByLabelText("允许时段开始") as HTMLInputElement;
    // 未开启时两个时间框是灰的：此刻填了也不会生效，先别让人填。
    expect(start().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("允许时段"));
    await act(async () => {});
    expect(start().disabled).toBe(false);
    fireEvent.change(start(), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("允许时段结束"), { target: { value: "07:00" } });
    await act(async () => {});
    // 存储仍然是"当天第几分钟"（判断端按运行时钟比），页面按本机时间显示与填写。
    const offset = -new Date().getTimezoneOffset();
    const stored = (hours: number, minutes = 0) => (hours * 60 + minutes - offset + 1440) % 1440;
    expect(await screen.findByText(/允许时段开始：/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({
        rhythm: expect.objectContaining({
          active_hours_enabled: true,
          active_hours_start_minutes: stored(22),
          active_hours_end_minutes: stored(7),
        }),
      }),
    );
    // 填回去的值还是本机时间的钟点——回读走的是同一个换算。
    expect(start().value).toBe("22:00");
  });

  it("底部保存条说清状态，改过的字段就地标记，预览可以关掉", async () => {
    await renderPage();
    expect(screen.getByText("当前方案已保存。")).toBeTruthy();
    expect(screen.queryByText("已修改")).toBeNull();
    fireEvent.change(screen.getByLabelText("发言冷却（秒）"), { target: { value: "25" } });
    await act(async () => {});
    expect(screen.getByText("已修改")).toBeTruthy();
    expect(screen.getByText("共 1 项改动尚未保存。")).toBeTruthy();
    // 预览按分区分组：这一项属于「节奏与门槛」。
    expect(screen.getByText("节奏与门槛")).toBeTruthy();
    // 只读的回复任务框做出只读的样子（除了 readOnly，还有一个专门的类）。
    const box = screen.getByLabelText("回复任务") as HTMLTextAreaElement;
    expect(box.className).toContain("readonly-field");
    // 关掉预览之后变更清单不再渲染，保存条仍在。
    fireEvent.click(screen.getByRole("button", { name: "隐藏变更预览" }));
    await act(async () => {});
    expect(screen.queryByText("将要保存的变更")).toBeNull();
    expect(screen.getByText("共 1 项改动尚未保存。")).toBeTruthy();
  });

  it("触发开关写明各自受哪些节奏门槛约束", async () => {
    await renderPage();
    expect(screen.getByText(/不受任何节奏门槛限制/)).toBeTruthy();
    expect(screen.getByText(/还受发言冷却、每小时上限与允许时段约束/)).toBeTruthy();
    expect(screen.getByText(/还受冷场安静、发言冷却、每小时上限与允许时段约束/)).toBeTruthy();
  });

  it("删除要先确认，并说出它被多少个会话使用", async () => {
    const { fake } = await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "删除方案" }));
    expect(screen.getByText(/仍被2个会话使用，请先改绑/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await act(async () => {});
    expect(fake.deleteQqScheme).toHaveBeenCalledWith(scheme().id);
  });

  it("回复任务文案跟着开关走，开关下面那一份只读", async () => {
    const { fake } = await renderPage();
    const box = (await screen.findByLabelText("回复任务")) as HTMLTextAreaElement;
    // 开着＝一次只回一个人（0037：`@` 改由程序按收件人加，模型不再自己写 CQ 码），并且不能改：
    // 这段由开关决定（用户 2026-09-25）。
    expect(box.value).toContain("只写一条消息");
    expect(box.value).toContain("开头由程序 @ 他");
    expect(box.value).not.toContain("[CQ:at,qq=");
    expect(box.readOnly).toBe(true);
    fireEvent.click(screen.getByLabelText("按发言人分开回答"));
    await act(async () => {});
    // 关掉＝程序内置的默认文案，同一条框里换成另一份，仍然只读。
    expect((screen.getByLabelText("回复任务") as HTMLTextAreaElement).value).toContain(
      "按群里的说话方式写一条回复",
    );
    expect((screen.getByLabelText("回复任务") as HTMLTextAreaElement).readOnly).toBe(true);
    // 开关本身进同一份草稿：保存时整组提交。
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    await act(async () => {});
    expect(fake.updateQqScheme).toHaveBeenCalledWith(
      scheme().id,
      expect.objectContaining({ reply: { split_by_speaker: false } }),
    );
  });

  it("不提供模型选择，也不在这页改绑会话", async () => {
    await renderPage();
    // §11.1 keeps model choice in 默认模型 and bindings in 第三方App接入; this page only links.
    expect(screen.queryByLabelText("对话模型")).toBeNull();
    expect(screen.queryByLabelText("记忆读取模型")).toBeNull();
    expect(screen.queryByText(/改绑到/)).toBeNull();
    expect(screen.getByRole("button", { name: "前往默认模型" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "前往知识库配置" })).toBeTruthy();
  });
});
