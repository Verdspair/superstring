// 绑定目录读取与写入的竞态：旧读取不得覆盖刚保存的结果，保存开始即作废在途读取，
// 写入成功后方案使用量先未知再真实重读，连接草稿在刷新合并后可重试 409（store 级断言）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  QqBindingResponse,
  QqConversationListItem,
  QqSchemeResponse,
  QqSettingsResponse,
} from "../../src/shared/contracts/qq";
import { QqBindingResponseSchema } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale } from "../../src/web/i18n";
import { type SuperstringState, useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const FIRST = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING_ONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_TWO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scheme = (overrides: Partial<QqSchemeResponse> = {}): QqSchemeResponse => ({
  id: FIRST,
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
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const settings: QqSettingsResponse = {
  enabled: false,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: true },
  revision: 3,
};

const bindingOf = (peer: string, id: string, schemeId = FIRST): QqBindingResponse =>
  QqBindingResponseSchema.parse({
    id,
    account_id: "10001",
    kind: "group",
    peer_id: peer,
    agent_id: AGENT,
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

const chat = (peer: string): QqConversationListItem => ({
  account_id: "10001",
  kind: "group",
  peer_id: peer,
  messages: 5,
  last_at_seconds: 100,
  binding_id: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function reset(overrides: Partial<typeof api> = {}, state: Partial<SuperstringState> = {}) {
  const fake = {
    ...api,
    getQqSettings: async () => settings,
    getQqStatus: async () => ({ connection: null }),
    listQqConversations: async () => [],
    listQqBindings: async () => [],
    listQqSchemes: async () => [scheme()],
    getQqSchemeUsage: async (id: string) => ({ scheme_id: id, bindings: 0 }),
    ...overrides,
  } as unknown as typeof api;
  store.getState().resetForTests(fake);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-scheme-config",
    qqSettings: settings,
    qqSchemes: [scheme()],
    qqSchemeEditor: qqSchemeEditorFrom(scheme()),
    ...state,
  });
  return fake;
}

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("在途目录读取晚到：不得覆盖刚保存的方案行与编辑器基线", async () => {
  const schemes = deferred<QqSchemeResponse[]>();
  reset({
    listQqSchemes: vi.fn(() => schemes.promise),
    updateQqScheme: vi.fn(async (_id, body) => scheme({ ...(body as object), revision: 4 })),
  });
  const reading = store.getState().loadQqBindingDirectory();
  store.getState().patchQqScheme({ name: "本地改名" });
  expect(await store.getState().saveQqScheme()).toBe(true);
  expect(store.getState().qqSchemes[0]?.name).toBe("本地改名");
  // 旧目录响应带着保存前的行晚到。
  schemes.resolve([scheme({ name: "默认方案", revision: 3 })]);
  await reading;
  await tick();
  expect(store.getState().qqSchemes[0]?.name).toBe("本地改名");
  expect(store.getState().qqSchemes[0]?.revision).toBe(4);
  expect(store.getState().qqSchemeEditor?.source.revision).toBe(4);
});

it("绑定写入开始时在途读取失效：旧绑定列表不得回滚新写入", async () => {
  const stale = deferred<QqBindingResponse[]>();
  const list = vi
    .fn()
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValue([bindingOf("30003", BINDING_ONE), bindingOf("40004", BINDING_TWO)]);
  reset({
    listQqBindings: list,
    createQqBinding: vi.fn().mockResolvedValue(bindingOf("40004", BINDING_TWO)),
  });
  const reading = store.getState().loadQqBindingDirectory();
  const ok = await store
    .getState()
    .bindQqConversation({ conversation: chat("40004"), agentId: AGENT, schemeId: FIRST });
  expect(ok).toBe(true);
  expect(store.getState().qqBindings.map((row) => row.peer_id)).toEqual(["30003", "40004"]);
  stale.resolve([bindingOf("30003", BINDING_ONE)]);
  await reading;
  await tick();
  expect(store.getState().qqBindings.map((row) => row.peer_id)).toEqual(["30003", "40004"]);
  expect(store.getState().qqBindingsLoaded).toBe(true);
  expect(store.getState().qqBindingsLoading).toBe(false);
});

it("保存进行中不开始读取目录", async () => {
  const listBindings = vi.fn();
  const getSettings = vi.fn();
  const listSchemes = vi.fn();
  reset({ listQqBindings: listBindings, getQqSettings: getSettings, listQqSchemes: listSchemes });
  store.setState({ qqSchemeSaving: true });
  await store.getState().loadQqBindingDirectory();
  expect(listBindings).not.toHaveBeenCalled();
  expect(getSettings).not.toHaveBeenCalled();
  store.setState({ qqSchemeSaving: false, qqAccessSaving: true });
  await store.getState().loadQqBindingDirectory();
  expect(listBindings).not.toHaveBeenCalled();
  expect(listSchemes).not.toHaveBeenCalled();
});

it("目录读取失败：按未知呈现且不落地半份结果", async () => {
  const listBindings = vi.fn().mockRejectedValue(new Error("目录离线"));
  reset(
    {
      listQqSchemes: vi.fn().mockResolvedValue([scheme({ id: OTHER, name: "别的方案" })]),
      listQqBindings: listBindings,
    },
    { qqSchemeUsage: { schemeId: FIRST, bindings: 0 } },
  );
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqSchemeUsage).toBeNull();
  expect(store.getState().qqBindingsLoaded).toBe(false);
  expect(store.getState().qqBindingsError).toContain("目录离线");
  expect(store.getState().qqBindingsLoading).toBe(false);
  // 失败不落地方案目录：仍是原缓存，不拿半份新目录继续。
  expect(store.getState().qqSchemes.map((row) => row.id)).toEqual([FIRST]);
  // 重试成功后恢复。
  listBindings.mockResolvedValue([bindingOf("30003", BINDING_ONE)]);
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqBindingsLoaded).toBe(true);
  expect(store.getState().qqBindings.map((row) => row.peer_id)).toEqual(["30003"]);
});

it("写入成功后方案使用量先清为未知再真实重读，旧计数不得放行删除", async () => {
  const usage = deferred<{ scheme_id: string; bindings: number }>();
  reset(
    {
      listQqBindings: vi.fn().mockResolvedValue([bindingOf("30003", BINDING_ONE)]),
      updateQqBinding: vi.fn().mockResolvedValue(bindingOf("30003", BINDING_ONE)),
      getQqSchemeUsage: vi.fn(() => usage.promise),
    },
    { qqSchemeUsage: { schemeId: FIRST, bindings: 0 } },
  );
  expect(
    await store.getState().updateQqBindingRow(bindingOf("30003", BINDING_ONE), { paused: true }),
  ).toBe(true);
  await tick();
  // 读取还没回来：按未知处理，不得沿用旧 0。
  expect(store.getState().qqSchemeUsage).toBeNull();
  usage.resolve({ scheme_id: FIRST, bindings: 1 });
  await tick();
  expect(store.getState().qqSchemeUsage).toEqual({ schemeId: FIRST, bindings: 1 });
});

it("resetForTests 后晚到的读取不落地（重置令牌）", async () => {
  const stale = deferred<QqBindingResponse[]>();
  reset({
    listQqBindings: vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue([bindingOf("30003", BINDING_ONE)]),
  });
  const reading = store.getState().loadQqBindingDirectory();
  store.getState().resetForTests(store.getState().apiClient);
  const again = store.getState().loadQqBindingDirectory();
  await again;
  expect(store.getState().qqBindings.map((row) => row.peer_id)).toEqual(["30003"]);
  stale.resolve([bindingOf("99999", BINDING_TWO)]);
  await reading;
  await tick();
  expect(store.getState().qqBindings.map((row) => row.peer_id)).toEqual(["30003"]);
  expect(store.getState().qqBindingsLoaded).toBe(true);
});

it("目录读取不丢连接草稿的已改字段，也不改写它的原基线", async () => {
  reset({
    getQqSettings: vi.fn().mockResolvedValue({
      ...settings,
      revision: 8,
      transport: { endpoint: "ws://elsewhere", has_token: true },
    }),
  });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      connection: {
        source: settings,
        endpoint: "ws://localhost:4000",
        accountId: "10001",
        token: "secret",
      },
    },
  }));
  await store.getState().loadQqBindingDirectory();
  const draft = store.getState().qqInputs.connection;
  expect(draft?.endpoint).toBe("ws://localhost:4000");
  expect(draft?.token).toBe("secret");
  expect(draft?.source.revision).toBe(3);
  expect(store.getState().qqSettings?.revision).toBe(8);
});

it("保存开始后晚到的旧设置响应不得回滚刚保存的结果", async () => {
  const old = deferred<QqSettingsResponse>();
  reset({
    getQqSettings: vi.fn().mockImplementationOnce(() => old.promise),
    updateQqSettings: vi.fn(async () => ({ ...settings, enabled: true, revision: 4 })),
  });
  const reading = store.getState().loadQqBindingDirectory();
  expect(await store.getState().saveQqSurface({ enabled: true })).toBe(true);
  expect(store.getState().qqSettings?.revision).toBe(4);
  old.resolve({ ...settings, enabled: false, revision: 3 });
  await reading;
  await tick();
  expect(store.getState().qqSettings?.revision).toBe(4);
  expect(store.getState().qqSettings?.enabled).toBe(true);
});

it("连接页刷新合并草稿并推进 revision：冲突后可直接重试", async () => {
  const fake = reset({
    getQqSettings: vi.fn().mockResolvedValue({
      ...settings,
      revision: 8,
      account_id: "101",
      transport: { endpoint: "ws://elsewhere", has_token: true },
    }),
    updateQqSettings: vi.fn(async () => ({ ...settings, revision: 8, account_id: "101" })),
    updateQqTransport: vi.fn(async () => ({
      ...settings,
      account_id: "101",
      revision: 8,
      transport: { endpoint: "ws://localhost:4000", has_token: true },
    })),
  });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      connection: {
        source: settings,
        endpoint: "ws://localhost:4000",
        accountId: "10001",
        token: "secret",
      },
    },
  }));
  await store.getState().refreshQqConnection();
  const draft = store.getState().qqInputs.connection;
  expect(draft?.source.revision).toBe(8);
  expect(draft?.endpoint).toBe("ws://localhost:4000");
  // 未改字段跟随新基线。
  expect(draft?.accountId).toBe("101");
  expect(draft?.token).toBe("secret");
  expect(await store.getState().saveQqDrafts()).toBe(true);
  expect(fake.updateQqTransport).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: "ws://localhost:4000", expected_revision: 8 }),
  );
});

it("方案不在目录时保留脏草稿供另存，不自动切换", async () => {
  reset({ listQqSchemes: vi.fn().mockResolvedValue([scheme({ id: OTHER, name: "别的方案" })]) });
  store.getState().patchQqScheme({ name: "本地改名" });
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqSchemes.map((row) => row.id)).toEqual([OTHER]);
  expect(store.getState().qqSchemeEditor?.source.id).toBe(FIRST);
  expect(store.getState().qqSchemeEditor?.name).toBe("本地改名");
  expect(store.getState().qqSchemeUsage).toBeNull();
});

it("隐式绑定读取不打开方案编辑器或推进未确认的保存基线", async () => {
  reset({ listQqSchemes: vi.fn().mockResolvedValue([scheme({ name: "远端改名", revision: 8 })]) });
  store.getState().patchQqScheme({ name: "本地改名" });
  const editor = store.getState().qqSchemeEditor;
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqSchemes[0]?.revision).toBe(8);
  expect(store.getState().qqSchemeEditor).toBe(editor);
  expect(store.getState().qqSchemeEditor?.source.revision).toBe(3);
  expect(store.getState().qqSchemeEditor?.name).toBe("本地改名");

  reset({}, { qqSchemeEditor: null });
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqSchemeEditor).toBeNull();
});

// ---- 显式「刷新保存基线」（loadQqBindingDirectory(bindingId)）---------------------------------

it("显式刷新只合并点名绑定的草稿：已改字段保留、未改字段与 revision 跟随新基线", async () => {
  const base = QqBindingResponseSchema.parse({
    ...bindingOf("30003", BINDING_ONE),
    attention: { mode: "soft", members: ["111"] },
  });
  const fresh = QqBindingResponseSchema.parse({
    ...bindingOf("30003", BINDING_ONE),
    revision: 9,
    scheme_id: OTHER,
    attention: { mode: "hard", members: ["222"] },
  });
  const otherBase = bindingOf("40004", BINDING_TWO);
  reset({ listQqBindings: vi.fn().mockResolvedValue([fresh, otherBase]) });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      choices: {
        [BINDING_ONE]: { agentId: AGENT_TWO, schemeId: FIRST, source: base },
        [BINDING_TWO]: { agentId: AGENT_TWO, schemeId: FIRST, source: otherBase },
      },
      attention: { [BINDING_ONE]: { mode: "hard", members: "111", source: base } },
    },
    qqMemoryBatchDrafts: { [BINDING_ONE]: { value: "15", revision: 1 } },
  }));
  await store.getState().loadQqBindingDirectory(BINDING_ONE);
  const choice = store.getState().qqInputs.choices[BINDING_ONE];
  expect(choice?.agentId).toBe(AGENT_TWO); // 已改：保留用户输入
  expect(choice?.schemeId).toBe(OTHER); // 未改：跟随新基线
  expect(choice?.source?.revision).toBe(9);
  const attention = store.getState().qqInputs.attention[BINDING_ONE];
  expect(attention?.mode).toBe("hard"); // 已改：保留
  expect(attention?.members).toBe("222"); // 与基线同集合：跟随新基线
  expect(attention?.source?.revision).toBe(9);
  expect(store.getState().qqMemoryBatchDrafts[BINDING_ONE]).toEqual({ value: "15", revision: 9 });
  // 点名的是 BINDING_ONE，别的绑定草稿一动不动。
  expect(store.getState().qqInputs.choices[BINDING_TWO]?.agentId).toBe(AGENT_TWO);
  expect(store.getState().qqInputs.choices[BINDING_TWO]?.source?.revision).toBe(1);
});

it("显式刷新保留非法/空的名单原文，不拿新基线覆盖", async () => {
  const base = QqBindingResponseSchema.parse({
    ...bindingOf("30003", BINDING_ONE),
    attention: { mode: "soft", members: ["111"] },
  });
  const fresh = QqBindingResponseSchema.parse({
    ...bindingOf("30003", BINDING_ONE),
    revision: 9,
    attention: { mode: "hard", members: ["222"] },
  });
  reset({ listQqBindings: vi.fn().mockResolvedValue([fresh]) });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      // 只有分隔符的名单解析为空：naive 实现会把它当成「没改」而覆盖成新基线。
      attention: { [BINDING_ONE]: { mode: "hard", members: "，、；", source: base } },
    },
  }));
  await store.getState().loadQqBindingDirectory(BINDING_ONE);
  const attention = store.getState().qqInputs.attention[BINDING_ONE];
  expect(attention?.members).toBe("，、；");
  expect(attention?.mode).toBe("hard");
  expect(attention?.source.revision).toBe(9);
});

it("真实 409 后显式刷新：同一改绑草稿以新 revision 重试成功（严格 API 参数）", async () => {
  const update = vi
    .fn()
    .mockRejectedValueOnce(new Error("REVISION_CONFLICT"))
    .mockResolvedValue(
      QqBindingResponseSchema.parse({ ...bindingOf("30003", BINDING_ONE), revision: 9 }),
    );
  reset({
    listQqBindings: vi.fn().mockResolvedValue([
      QqBindingResponseSchema.parse({
        ...bindingOf("30003", BINDING_ONE),
        revision: 9,
        scheme_id: OTHER,
      }),
    ]),
    updateQqBinding: update,
  });
  const base = bindingOf("30003", BINDING_ONE);
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      choices: { [BINDING_ONE]: { agentId: AGENT_TWO, schemeId: FIRST, source: base } },
    },
  }));
  // 抽屉保存撞上 409：草稿保留旧基线。
  expect(
    await store.getState().updateQqBindingRow(base, { agent_id: AGENT_TWO, scheme_id: FIRST }),
  ).toBe(false);
  expect(update).toHaveBeenNthCalledWith(1, BINDING_ONE, {
    agent_id: AGENT_TWO,
    scheme_id: FIRST,
    expected_revision: 1,
  });
  await store.getState().loadQqBindingDirectory(BINDING_ONE);
  const merged = store.getState().qqInputs.choices[BINDING_ONE];
  expect(merged?.agentId).toBe(AGENT_TWO);
  expect(merged?.schemeId).toBe(OTHER);
  expect(merged?.source?.revision).toBe(9);
  expect(store.getState().error).toBeNull();
  const baseline = merged?.source;
  if (!baseline) throw new Error("刷新后应留下可保存的基线");
  // 同一改绑再次保存：以刷新后的 baseline 通过 CAS。
  expect(
    await store.getState().updateQqBindingRow(baseline, { agent_id: AGENT_TWO, scheme_id: OTHER }),
  ).toBe(true);
  expect(update).toHaveBeenNthCalledWith(2, BINDING_ONE, {
    agent_id: AGENT_TWO,
    scheme_id: OTHER,
    expected_revision: 9,
  });
});

it("隐式目录读取绝不刷新绑定草稿基线", async () => {
  const base = bindingOf("30003", BINDING_ONE);
  const fresh = QqBindingResponseSchema.parse({ ...base, revision: 9, scheme_id: OTHER });
  reset({ listQqBindings: vi.fn().mockResolvedValue([fresh]) });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      choices: { [BINDING_ONE]: { agentId: AGENT_TWO, schemeId: FIRST, source: base } },
    },
    qqMemoryBatchDrafts: { [BINDING_ONE]: { value: "15", revision: 1 } },
  }));
  await store.getState().loadQqBindingDirectory();
  expect(store.getState().qqInputs.choices[BINDING_ONE]?.source?.revision).toBe(1);
  expect(store.getState().qqInputs.choices[BINDING_ONE]?.agentId).toBe(AGENT_TWO);
  expect(store.getState().qqInputs.choices[BINDING_ONE]?.schemeId).toBe(FIRST);
  expect(store.getState().qqMemoryBatchDrafts[BINDING_ONE]).toEqual({ value: "15", revision: 1 });
  expect(store.getState().feedback).toBe("");
});

it("显式刷新失败：草稿与旧基线原样保留，目录按未知呈现", async () => {
  const base = QqBindingResponseSchema.parse({
    ...bindingOf("30003", BINDING_ONE),
    attention: { mode: "soft", members: ["111"] },
  });
  reset({ listQqBindings: vi.fn().mockRejectedValue(new Error("目录离线")) });
  store.setState((state) => ({
    qqInputs: {
      ...state.qqInputs,
      choices: { [BINDING_ONE]: { agentId: AGENT_TWO, schemeId: FIRST, source: base } },
      attention: { [BINDING_ONE]: { mode: "hard", members: "111 222", source: base } },
    },
    qqMemoryBatchDrafts: { [BINDING_ONE]: { value: "15", revision: 1 } },
  }));
  await store.getState().loadQqBindingDirectory(BINDING_ONE);
  expect(store.getState().qqInputs.choices[BINDING_ONE]).toEqual({
    agentId: AGENT_TWO,
    schemeId: FIRST,
    source: base,
  });
  expect(store.getState().qqInputs.attention[BINDING_ONE]?.members).toBe("111 222");
  expect(store.getState().qqInputs.attention[BINDING_ONE]?.source.revision).toBe(1);
  expect(store.getState().qqMemoryBatchDrafts[BINDING_ONE]).toEqual({ value: "15", revision: 1 });
  expect(store.getState().qqBindingsLoaded).toBe(false);
  expect(store.getState().qqBindingsError).toContain("目录离线");
  // 失败不假装刷新成功。
  expect(store.getState().feedback).toBe("");
});
