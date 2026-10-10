// 绑定写入与目录读取的生命周期：PUT 确认即已提交——保存行立即落地、导航不得被在途读取卡住、
// 动作如实结算；已提交后的读取失败不得把写入翻成失败；重置后旧写入的 ack 不得串入新状态。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  QqBindingResponse,
  QqSchemeResponse,
  QqSettingsResponse,
} from "../../src/shared/contracts/qq";
import { QqBindingResponseSchema } from "../../src/shared/contracts/qq";
import { api } from "../../src/web/api";
import { qqSchemeEditorFrom } from "../../src/web/features/qq/types";
import { selectLocale } from "../../src/web/i18n";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { type SuperstringState, useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const FIRST = "22222222-2222-4222-8222-222222222222";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
  // 响应契约收紧后两组必填，夹具照完整响应形状造。
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

const deferred = <T,>() => {
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

it("PUT 确认后保存行立即落地：目录行已是新值、导航不锁、动作已结算（在途读取不算写）", async () => {
  const schemes = deferred<QqSchemeResponse[]>();
  const base = bindingOf("30003", BINDING_ONE);
  const ack: QqBindingResponse = { ...base, paused: true, revision: 2 };
  reset(
    {
      updateQqBinding: vi.fn().mockResolvedValue(ack),
      listQqBindings: vi.fn().mockResolvedValue([ack]),
      listQqSchemes: vi.fn(() => schemes.promise),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  let settled = false;
  const action = store
    .getState()
    .updateQqBindingRow(base, { paused: true })
    .then((ok) => {
      settled = true;
      return ok;
    });
  try {
    await tick();
    await tick();
    // PUT 已确认：保存行立即是新值，不等目录读取回来才落。
    expect(store.getState().qqBindings[0]).toMatchObject({
      id: BINDING_ONE,
      paused: true,
      revision: 2,
    });
    // 目录读取还在途：写已提交，导航不得被读取卡住。
    expect(navigationBusy(store.getState())).toBe(false);
    expect(settled).toBe(true);
  } finally {
    // 清理必须解除挂起的目录读取，避免悬空的 open handle。
    schemes.resolve([scheme()]);
    await action;
    await tick();
  }
});

it("PUT pending 期间开始的读取晚到：旧列表快照不得覆盖已确认的保存行", async () => {
  const put = deferred<QqBindingResponse>();
  const oldList = deferred<QqBindingResponse[]>();
  const base = bindingOf("30003", BINDING_ONE);
  const ack: QqBindingResponse = { ...base, paused: true, revision: 2 };
  reset(
    {
      updateQqBinding: vi.fn(() => put.promise),
      listQqBindings: vi.fn(() => oldList.promise),
      listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  const action = store.getState().updateQqBindingRow(base, { paused: true });
  await tick();
  // PUT 在途期间页面触发的真实刷新读取：抓到旧列表快照。
  const reading = store.getState().loadQqBindings({ refresh: true, background: true });
  await tick();
  // ack 先到：保存行已确认落地。
  put.resolve(ack);
  expect(await action).toBe(true);
  await tick();
  expect(store.getState().qqBindings[0]).toMatchObject({
    id: BINDING_ONE,
    paused: true,
    revision: 2,
  });
  // 旧列表快照晚到：不得覆盖 ack 已确认的行（ack 应作废在途读取的 owner）。
  oldList.resolve([base]);
  await reading;
  await tick();
  expect(store.getState().qqBindings[0]).toMatchObject({
    id: BINDING_ONE,
    paused: true,
    revision: 2,
  });
});

it("PUT 在途期间全局导航保持写保护，ack 到达并落地后解除", async () => {
  const put = deferred<QqBindingResponse>();
  const base = bindingOf("30003", BINDING_ONE);
  const ack: QqBindingResponse = { ...base, paused: true, revision: 2 };
  reset(
    {
      updateQqBinding: vi.fn(() => put.promise),
      listQqBindings: vi.fn().mockResolvedValue([ack]),
      listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  const action = store.getState().updateQqBindingRow(base, { paused: true });
  await tick();
  // 写在途：全局导航守卫必须拦住（既有守卫保留）。
  expect(navigationBusy(store.getState())).toBe(true);
  put.resolve(ack);
  expect(await action).toBe(true);
  await tick();
  expect(navigationBusy(store.getState())).toBe(false);
});

it("PUT 已提交后目录读取失败：动作不得翻成 false，已保存的行保留", async () => {
  const base = bindingOf("30003", BINDING_ONE);
  const ack: QqBindingResponse = { ...base, paused: true, revision: 2 };
  reset(
    {
      updateQqBinding: vi.fn().mockResolvedValue(ack),
      listQqBindings: vi.fn().mockResolvedValue([ack]),
      listQqSchemes: vi.fn().mockRejectedValue(new Error("目录离线")),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  const result = await store.getState().updateQqBindingRow(base, { paused: true });
  // 写已提交：读取失败不得把动作报成失败。
  expect(result).toBe(true);
  expect(store.getState().qqBindings[0]).toMatchObject({
    id: BINDING_ONE,
    paused: true,
    revision: 2,
  });
  await tick();
  expect(navigationBusy(store.getState())).toBe(false);
});

it("重置后旧写入的 ack 不串入新状态：目录行仍由新 api 决定", async () => {
  const put = deferred<QqBindingResponse>();
  const base = bindingOf("30003", BINDING_ONE);
  const ack: QqBindingResponse = { ...base, paused: true, revision: 2 };
  reset(
    {
      updateQqBinding: vi.fn(() => put.promise),
      listQqBindings: vi.fn().mockResolvedValue([base]),
      listQqSchemes: vi.fn().mockResolvedValue([scheme()]),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  const staleAction = store.getState().updateQqBindingRow(base, { paused: true });
  const freshRow: QqBindingResponse = { ...base, revision: 9 };
  const freshSchemes = deferred<QqSchemeResponse[]>();
  store.getState().resetForTests({
    ...api,
    listQqBindings: vi.fn().mockResolvedValue([freshRow]),
    listQqSchemes: vi.fn(() => freshSchemes.promise),
  } as unknown as typeof api);
  store.setState({ qqBindings: [freshRow], qqBindingsLoaded: true });
  try {
    put.resolve(ack);
    await tick();
    await tick();
    // 旧写入的 ack（paused true / revision 2）不得落进重置后的目录。
    expect(store.getState().qqBindings[0]).toMatchObject({
      id: BINDING_ONE,
      paused: false,
      revision: 9,
    });
  } finally {
    freshSchemes.resolve([scheme()]);
    await staleAction;
    await tick();
  }
});

it("POST ack 目录未 loaded 且读取在途：动作立即为 true、导航不锁、保存行落地且不捏全目录 ready", async () => {
  const created = bindingOf("40004", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  const schemes = deferred<QqSchemeResponse[]>();
  reset(
    {
      createQqBinding: vi.fn().mockResolvedValue(created),
      listQqBindings: vi.fn().mockResolvedValue([created]),
      listQqSchemes: vi.fn(() => schemes.promise),
    },
    { qqBindings: [], qqBindingsLoaded: false },
  );
  let settled = false;
  const action = store
    .getState()
    .bindQqPeerNumber({ kind: "group", peerId: "40004", agentId: AGENT, schemeId: FIRST })
    .then((ok) => {
      settled = true;
      return ok;
    });
  try {
    await tick();
    await tick();
    // POST ack 确认后动作立即结算、导航不锁
    expect(settled).toBe(true);
    expect(navigationBusy(store.getState())).toBe(false);
    // 保存行立即落地
    expect(store.getState().qqBindings).toHaveLength(1);
    expect(store.getState().qqBindings[0]).toMatchObject({ id: created.id, peer_id: "40004" });
    // 未全量读取前，不捏造全目录 ready
    expect(store.getState().qqBindingsLoaded).toBe(false);
  } finally {
    schemes.resolve([scheme()]);
    await action;
    await tick();
    // reload settled 后最终断言：目录行仍为 POST 回读的 created 行，不被旧目录覆盖。
    await tick();
    expect(store.getState().qqBindings).toHaveLength(1);
    expect(store.getState().qqBindings[0]).toMatchObject({ id: created.id, peer_id: "40004" });
  }
});

it("memoryqueued 独立读取失败不影响 verdict 且旧 API 失败不反写新错误", async () => {
  const base = bindingOf("30003", BINDING_ONE);
  const getSchemes = deferred<QqSchemeResponse[]>();
  reset(
    {
      organiseQqMemory: vi.fn().mockResolvedValue({ status: "queued", pending: 5 }),
      listQqSchemes: vi.fn(() => getSchemes.promise),
    },
    { qqBindings: [base], qqBindingsLoaded: true },
  );
  const action = store.getState().organiseQqMemoryRow(base);
  await tick();
  // 写阶段立即结束，verdict 返回
  const verdict = await action;
  expect(verdict).toEqual({ status: "queued", pending: 5 });
  expect(navigationBusy(store.getState())).toBe(false);
  // 重置为新 API
  store.getState().resetForTests({ ...api });
  store.setState({ qqBindingsError: null });
  // 旧 API 的挂起读取失败
  getSchemes.reject(new Error("旧 API 离线"));
  await tick();
  await tick();
  // 旧 API 失败不得反写新状态
  expect(store.getState().qqBindingsError).toBeNull();
});

it("旧 API 写入的 finally 不清除新 API 上新发起的写锁", async () => {
  const stalePut = deferred<QqBindingResponse>();
  const freshPut = deferred<QqBindingResponse>();
  const base = bindingOf("30003", BINDING_ONE);
  reset({
    updateQqBinding: vi.fn(() => stalePut.promise),
  });
  const staleAction = store.getState().updateQqBindingRow(base, { paused: true });
  await tick();
  expect(navigationBusy(store.getState())).toBe(true);
  // 切换到新 API：新写入由真实动作持有写锁。
  const freshBase = bindingOf("40004", BINDING_TWO);
  const freshAck: QqBindingResponse = { ...freshBase, paused: true, revision: 2 };
  store.getState().resetForTests({
    ...api,
    updateQqBinding: vi.fn(() => freshPut.promise),
  } as unknown as typeof api);
  const freshAction = store
    .getState()
    .updateQqBindingRow(freshBase, { paused: true })
    .then((ok) => (ok ? "ok" : "fail"));
  await tick();
  // 新写操作在途：锁由新 API 的真实动作持有。
  expect(store.getState().qqAccessSaving).toBe(true);
  // 旧写入完成并进入 finally：不得清新 API 的锁。
  stalePut.resolve(base);
  await staleAction;
  await tick();
  expect(store.getState().qqAccessSaving).toBe(true);
  // 新 ack 到达：锁由新 API 自己的 finally 正确解除并落地 source。
  freshPut.resolve(freshAck);
  expect(await freshAction).toBe("ok");
  await tick();
  expect(store.getState().qqAccessSaving).toBe(false);
  expect(store.getState().qqBindings[0]).toMatchObject({
    id: BINDING_TWO,
    paused: true,
    revision: 2,
  });
});
