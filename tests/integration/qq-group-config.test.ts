// 本群 Agent 配置走真实 SQLite 与 HTTP：稀疏差异往返、四个修订的比较交换、绑定镜像同步、
// 素材集合的授权交集、老开关列的迁移搬移，以及管理守卫。

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createApp } from "../../src/server/app";
import { toOrmHandle } from "../../src/server/db/connection";
import {
  insertQqBinding,
  parseQqGroupAgentConfigRow,
  readQqBinding,
  readQqGroupConfigRow,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import {
  readEffectiveQqScheme,
  readQqGroupCapabilityRevision,
  readQqGroupCapabilityRevisions,
} from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeMessageSettings,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { createQqStickerCollection } from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { BUSINESS_MIGRATION_FILES, ensureBusinessSchema } from "../../src/server/db/schema-gate";
import { createAgent } from "../../src/server/services/agent-service";
import {
  createQqBinding,
  type QqBinding,
  updateQqBinding,
} from "../../src/server/services/qq-binding-contract";
import {
  type QqGroupCapability,
  QqGroupCapabilitySchema,
  type QqGroupConfigResponse,
  QqGroupSchemeOverridesSchema,
} from "../../src/shared/contracts/qq-group-config";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

type App = ReturnType<typeof createApp>;

function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const scheme = createQqScheme(business.orm, { name: "群配置方案" });
  return { business, orm: business.orm, db: business.db, app: createApp({ business }), scheme };
}

type TriggerPatch = {
  direct_reply: boolean | null;
  follow_up: boolean | null;
  chiming_in: boolean | null;
  idle_topic: boolean | null;
};

function groupBinding(orm: Orm, schemeId: string, peerId: string, triggers?: TriggerPatch) {
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId,
    agentId: DEFAULT_AGENT_ID,
    schemeId,
    paused: false,
    shareWebMemory: false,
    ...(triggers === undefined ? {} : { triggers }),
  });
  if (created.kind !== "saved") throw new Error("binding seed rejected");
  return insertQqBinding(orm, created.binding);
}

function configRows(orm: Orm, bindingId: string, agentId = DEFAULT_AGENT_ID) {
  return orm
    .select()
    .from(schema.qqGroupAgentConfigs)
    .all()
    .filter((row) => row.bindingId === bindingId && row.agentId === agentId);
}

/** 服务端能力修订读口要的绑定视角（id × agentId × kind），不查库。 */
function bindingRef(bindingId: string, agentId = DEFAULT_AGENT_ID) {
  return { id: bindingId, agentId, kind: "group" as const };
}

function bindingRow(orm: Orm, bindingId: string) {
  return orm
    .select()
    .from(schema.qqBindings)
    .all()
    .find((row) => row.id === bindingId);
}

function authorize(orm: Orm, schemeId: string, collectionIds: string[]) {
  const scheme = readQqScheme(orm, schemeId);
  if (scheme === null) throw new Error("scheme missing");
  return updateQqScheme(orm, schemeId, {
    name: scheme.name,
    stickerCollections: collectionIds,
    expectedRevision: scheme.revision,
  });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value to exist");
  return value;
}

async function currentConfig(app: App, bindingId: string): Promise<QqGroupConfigResponse> {
  const response = await app.request(`/qq/bindings/${bindingId}/config`);
  expect(response.status).toBe(200);
  return (await response.json()) as QqGroupConfigResponse;
}

function putConfig(app: App, bindingId: string, payload: unknown) {
  return app.request(`/qq/bindings/${bindingId}/config`, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

/** 以当前读到的三个修订提交整份配置；CAS 用例直接调 `putConfig` 传坏修订。 */
async function saveConfig(
  app: App,
  orm: Orm,
  bindingId: string,
  overrides: unknown,
  options: { disabled?: string[]; schemeId?: string; schemeChange?: "keep" | "reset" } = {},
) {
  const config = await currentConfig(app, bindingId);
  const schemeId = options.schemeId ?? config.binding.scheme_id;
  const scheme = readQqScheme(orm, schemeId);
  if (scheme === null) throw new Error("scheme missing");
  return putConfig(app, bindingId, {
    agent_id: config.binding.agent_id,
    expected_binding_revision: config.binding.revision,
    expected_scheme_revision: scheme.revision,
    expected_revision: config.revision,
    overrides,
    disabled_capabilities: options.disabled ?? [],
    ...(options.schemeId === undefined ? {} : { scheme_id: options.schemeId }),
    ...(options.schemeChange === undefined ? {} : { scheme_change: options.schemeChange }),
  });
}

async function save(
  app: App,
  orm: Orm,
  bindingId: string,
  overrides: unknown,
  options?: Parameters<typeof saveConfig>[4],
): Promise<QqGroupConfigResponse> {
  const response = await saveConfig(app, orm, bindingId, overrides, options);
  expect(response.status).toBe(200);
  return (await response.json()) as QqGroupConfigResponse;
}

describe("本群 Agent 配置的 HTTP 读写", () => {
  it("稀疏差异整份提交后原样读回，未给字段跟随基础方案", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20001");
    const fresh = await currentConfig(app, binding.id);
    expect(fresh.revision).toBe(0);
    expect(fresh.overrides).toEqual({});
    expect(fresh.disabled_capabilities).toEqual([]);

    const body = await save(app, orm, binding.id, {
      triggers: { direct_reply: true },
      rhythm: { merge_window_seconds: 5 },
    });
    expect(body.revision).toBe(1);
    expect(body.overrides).toEqual({
      triggers: { direct_reply: true },
      rhythm: { merge_window_seconds: 5 },
    });
    expect(body.binding.triggers).toEqual({
      direct_reply: true,
      follow_up: null,
      chiming_in: null,
      idle_topic: null,
    });
    expect(body.effective_scheme.triggers.direct_reply).toBe(true);
    expect(body.effective_scheme.triggers.follow_up).toBe(false);
    expect(body.effective_scheme.rhythm.merge_window_seconds).toBe(5);
    expect(body.effective_scheme.rhythm.reply_cooldown_seconds).toBe(
      schemeRhythm(scheme).reply_cooldown_seconds,
    );
    expect(body.base_scheme.rhythm.merge_window_seconds).toBe(
      schemeRhythm(scheme).merge_window_seconds,
    );

    const stored = configRows(orm, binding.id);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(required(stored[0]).schemeOverrides)).toEqual(body.overrides);
    expect(readQqBinding(orm, binding.id)?.triggers.direct_reply).toBe(true);
    // 读回稳定：同一份状态再读一次，差异与修订都不变。
    const reread = await currentConfig(app, binding.id);
    expect(reread.overrides).toEqual(body.overrides);
    expect(reread.revision).toBe(1);
  });

  it("全是空组的提交归一化成空差异：不产生记录，revision 保持 0", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20002");
    const emptyGroups = {
      triggers: {},
      rhythm: {},
      context: {},
      compression: {},
      output_reserve: {},
      stickers: {},
      prompts: {},
      reply: {},
    };
    const response = await saveConfig(app, orm, binding.id, emptyGroups);
    expect(response.status).toBe(200);
    const body = (await response.json()) as QqGroupConfigResponse;
    expect(body.revision).toBe(0);
    expect(body.overrides).toEqual({});
    expect(configRows(orm, binding.id)).toHaveLength(0);
    // 空差异再存一次同样是 no-op，而不是写出一份以后解析不了的快照。
    const again = await save(app, orm, binding.id, {});
    expect(again.revision).toBe(0);
    expect(configRows(orm, binding.id)).toHaveLength(0);
  });

  it("显式等值覆盖被固定：与基础相同也不跟随基础之后的改动", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20003");
    const baseWindow = schemeRhythm(scheme).merge_window_seconds;
    const saved = await save(app, orm, binding.id, {
      rhythm: { merge_window_seconds: baseWindow },
    });
    expect(saved.overrides.rhythm?.merge_window_seconds).toBe(baseWindow);
    expect(saved.revision).toBe(1);

    const schemeRow = required(readQqScheme(orm, scheme.id));
    updateQqScheme(orm, scheme.id, {
      name: schemeRow.name,
      rhythm: { ...schemeRhythm(schemeRow), merge_window_seconds: baseWindow + 7 },
      expectedRevision: schemeRow.revision,
    });
    const after = await currentConfig(app, binding.id);
    expect(after.base_scheme.rhythm.merge_window_seconds).toBe(baseWindow + 7);
    expect(after.overrides.rhythm?.merge_window_seconds).toBe(baseWindow);
    expect(after.effective_scheme.rhythm.merge_window_seconds).toBe(baseWindow);
    expect(after.revision).toBe(1);
  });

  it("false、0、空素材集合是实打实的覆盖", async () => {
    const { orm, app, scheme } = setup();
    const collection = createQqStickerCollection(orm, { name: "常用" });
    authorize(orm, scheme.id, [collection.id]);
    const binding = groupBinding(orm, scheme.id, "20004");
    const schemeRow = required(readQqScheme(orm, scheme.id));
    updateQqScheme(orm, scheme.id, {
      name: schemeRow.name,
      triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
      expectedRevision: schemeRow.revision,
    });

    const body = await save(app, orm, binding.id, {
      triggers: { direct_reply: false },
      reply: { split_by_speaker: false },
      rhythm: { merge_window_seconds: 0 },
      sticker_collections: { collection_ids: [] },
    });
    expect(body.overrides).toEqual({
      triggers: { direct_reply: false },
      reply: { split_by_speaker: false },
      rhythm: { merge_window_seconds: 0 },
      sticker_collections: { collection_ids: [] },
    });
    expect(body.effective_scheme.triggers.direct_reply).toBe(false);
    expect(body.effective_scheme.reply.split_by_speaker).toBe(false);
    expect(body.effective_scheme.rhythm.merge_window_seconds).toBe(0);
    expect(body.effective_scheme.sticker_collections.collection_ids).toEqual([]);
    // false 进镜像后不是 null：绑定四列照样保留"明确关掉"。
    expect(body.binding.triggers.direct_reply).toBe(false);
  });

  it("未给的 prompt 槽位不落默认值：compress 只在显式写入时出现", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20005");
    const first = await save(app, orm, binding.id, { prompts: { scene: "本群开场白" } });
    expect(first.overrides.prompts).toEqual({ scene: "本群开场白" });
    expect(first.effective_scheme.prompts.compress).toBe(first.base_scheme.prompts.compress);
    const second = await save(app, orm, binding.id, {
      prompts: { scene: "本群开场白", compress: "本群压缩" },
    });
    expect(second.overrides.prompts).toEqual({ scene: "本群开场白", compress: "本群压缩" });
    expect(second.effective_scheme.prompts.compress).toBe("本群压缩");
  });

  it("越界、未知与退役字段在写入口被拒，拒绝不留半份状态", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20006");
    const rejected: unknown[] = [
      { rhythm: { merge_window_seconds: 301 } },
      { rhythm: { judgement_interval_turns: 5 } },
      { context: { reply_message_limit: 60 } },
      { nope: {} },
    ];
    for (const bad of rejected) {
      const response = await saveConfig(app, orm, binding.id, bad);
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("VALIDATION_ERROR");
    }
    expect((await currentConfig(app, binding.id)).revision).toBe(0);
    expect(configRows(orm, binding.id)).toHaveLength(0);
  });

  it("管理守卫：非本机来源 403 且不落缓存，非 JSON 请求体 422", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20007");
    const configPath = `/qq/bindings/${binding.id}/config`;
    for (const request of [
      new Request(`http://rebound.invalid${configPath}`),
      new Request(`http://localhost${configPath}`, {
        headers: { origin: "https://outside.invalid" },
      }),
      new Request(`http://localhost${configPath}`, { headers: { "sec-fetch-site": "cross-site" } }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await errorOf(response)).code).toBe("PERMISSION_MANAGEMENT_FORBIDDEN");
    }
    expect(
      (
        await app.request(`http://localhost${configPath}`, {
          headers: { origin: "http://localhost" },
        })
      ).status,
    ).toBe(200);
    const notJson = await app.request(configPath, {
      method: "PUT",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    expect(notJson.status).toBe(422);
    expect((await errorOf(notJson)).code).toBe("VALIDATION_ERROR");
  });

  it("四个修订的比较交换：绑定、目标方案、配置与当前 Agent 都对不上就拒绝", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20008");
    const config = await currentConfig(app, binding.id);
    const otherScheme = createQqScheme(orm, { name: "另一个方案" });
    const base = {
      agent_id: DEFAULT_AGENT_ID,
      expected_binding_revision: config.binding.revision,
      expected_scheme_revision: scheme.revision,
      expected_revision: 0,
      overrides: { triggers: { direct_reply: true } },
      disabled_capabilities: [],
    };
    const cases: unknown[] = [
      { ...base, expected_binding_revision: config.binding.revision + 1 },
      {
        ...base,
        expected_scheme_revision: otherScheme.revision + 1,
        scheme_id: otherScheme.id,
        scheme_change: "keep",
      },
      { ...base, expected_scheme_revision: otherScheme.revision, scheme_id: otherScheme.id },
      { ...base, agent_id: crypto.randomUUID() },
    ];
    for (const payload of cases) {
      const response = await putConfig(app, binding.id, payload);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("MEMORY_STATE_CONFLICT");
    }
    expect(configRows(orm, binding.id)).toHaveLength(0);
    expect(readQqBinding(orm, binding.id)?.revision).toBe(binding.revision);
    expect(readQqScheme(orm, scheme.id)?.revision).toBe(scheme.revision);
  });

  it("配置修订比较交换：空差异不删记录、revision 单调、旧修订无法 ABA 重赢", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20009");
    const first = await save(app, orm, binding.id, { triggers: { direct_reply: true } });
    expect(first.revision).toBe(1);

    const reset = await save(app, orm, binding.id, {});
    expect(reset.revision).toBe(2);
    expect(reset.overrides).toEqual({});
    expect(reset.binding.triggers).toEqual({
      direct_reply: null,
      follow_up: null,
      chiming_in: null,
      idle_topic: null,
    });
    const rows = configRows(orm, binding.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(required(rows[0]).schemeOverrides)).toEqual({});

    for (const stale of [0, 1]) {
      const response = await putConfig(app, binding.id, {
        agent_id: DEFAULT_AGENT_ID,
        expected_binding_revision: reset.binding.revision,
        expected_scheme_revision: scheme.revision,
        expected_revision: stale,
        overrides: { triggers: { chiming_in: true } },
        disabled_capabilities: [],
      });
      expect(response.status).toBe(409);
    }
    // 同样的空内容再存：内容没变不写库、不涨修订。
    const again = await save(app, orm, binding.id, {});
    expect(again.revision).toBe(2);
    expect(configRows(orm, binding.id)).toHaveLength(1);
    expect(required(configRows(orm, binding.id)[0]).updatedAt).toBe(required(rows[0]).updatedAt);
  });

  it("旧开关入口与记录同步，no-op 保存不动 updated_at", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20010");
    const put = (payload: unknown) =>
      app.request(`/qq/bindings/${binding.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });

    const saved = await put({
      triggers: { direct_reply: true, follow_up: null, chiming_in: null, idle_topic: null },
      expected_revision: binding.revision,
    });
    expect(saved.status).toBe(200);
    let config = await currentConfig(app, binding.id);
    expect(config.overrides).toEqual({ triggers: { direct_reply: true } });
    expect(config.revision).toBe(1);

    const afterRead = required(readQqBinding(orm, binding.id));
    const cleared = await put({
      triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
      expected_revision: afterRead.revision,
    });
    expect(cleared.status).toBe(200);
    config = await currentConfig(app, binding.id);
    expect(config.overrides).toEqual({});
    expect(config.revision).toBe(2);
    expect(configRows(orm, binding.id)).toHaveLength(1);

    const before = required(readQqBinding(orm, binding.id));
    const bindingBefore = required(bindingRow(orm, binding.id));
    const rowBefore = required(configRows(orm, binding.id)[0]);
    const noop = await put({ expected_revision: before.revision });
    expect(noop.status).toBe(200);
    const after = required(readQqBinding(orm, binding.id));
    expect(after.revision).toBe(before.revision);
    expect(required(bindingRow(orm, binding.id)).updatedAt).toBe(bindingBefore.updatedAt);
    expect(required(configRows(orm, binding.id)[0]).updatedAt).toBe(rowBefore.updatedAt);
  });

  it("换 Agent 与回切：新 Agent 无记录＝全部跟随，恢复旧记录不扩大素材授权", async () => {
    const { orm, app, scheme } = setup();
    const collection = createQqStickerCollection(orm, { name: "保留集合" });
    authorize(orm, scheme.id, [collection.id]);
    const binding = groupBinding(orm, scheme.id, "20011");
    const saved = await save(app, orm, binding.id, {
      triggers: { idle_topic: false },
      sticker_collections: { collection_ids: [collection.id] },
    });
    expect(saved.revision).toBe(1);

    // 全局撤掉这个集合的授权：原始选择保留给界面提示，生效值按交集为空。
    authorize(orm, scheme.id, []);
    const revoked = await currentConfig(app, binding.id);
    expect(revoked.overrides.sticker_collections?.collection_ids).toEqual([collection.id]);
    expect(revoked.effective_scheme.sticker_collections.collection_ids).toEqual([]);
    // 选择没变的重存不硬失败：过去撤权留下的旧选择不算这次的新决定。
    const keep = await saveConfig(app, orm, binding.id, revoked.overrides);
    expect(keep.status).toBe(200);

    const agentB = createAgent(
      orm,
      { name: "群配置助手 B", description: "second", model_name: "test-model", is_active: true },
      {
        core_identity: "Synthetic B",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      },
    );
    const put = (payload: unknown) =>
      app.request(`/qq/bindings/${binding.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
    const toB = await put({
      agent_id: agentB.id,
      expected_revision: required(readQqBinding(orm, binding.id)).revision,
    });
    expect(toB.status).toBe(200);
    const configB = await currentConfig(app, binding.id);
    expect(configB.binding.agent_id).toBe(agentB.id);
    expect(configB.revision).toBe(0);
    expect(configB.overrides).toEqual({});
    expect(configB.binding.triggers).toEqual({
      direct_reply: null,
      follow_up: null,
      chiming_in: null,
      idle_topic: null,
    });

    const toA = await put({
      agent_id: DEFAULT_AGENT_ID,
      expected_revision: required(readQqBinding(orm, binding.id)).revision,
    });
    expect(toA.status).toBe(200);
    const configA = await currentConfig(app, binding.id);
    expect(configA.revision).toBe(1);
    expect(configA.overrides).toEqual(revoked.overrides);
    expect(configA.binding.triggers.idle_topic).toBe(false);
    expect(configA.effective_scheme.sticker_collections.collection_ids).toEqual([]);

    // 暂停的群照样能读能配：暂停属于绑定，不改变已保存的差异。
    const paused = await put({
      paused: true,
      expected_revision: required(readQqBinding(orm, binding.id)).revision,
    });
    expect(paused.status).toBe(200);
    const pausedConfig = await currentConfig(app, binding.id);
    expect(pausedConfig.binding.paused).toBe(true);
    expect(pausedConfig.overrides).toEqual(revoked.overrides);
  });

  it("换方案 keep / reset：reset 清掉全部方案差异与本次请求的开关，能力停用保留", async () => {
    const { orm, app, scheme } = setup();
    const other = createQqScheme(orm, { name: "另一个方案" });
    const binding = groupBinding(orm, scheme.id, "20012");
    const saved = await save(
      app,
      orm,
      binding.id,
      { triggers: { direct_reply: true } },
      { disabled: ["memory_read"] },
    );
    expect(saved.revision).toBe(1);
    expect(saved.disabled_capabilities).toEqual(["memory_read"]);

    const kept = await save(app, orm, binding.id, saved.overrides, {
      schemeId: other.id,
      schemeChange: "keep",
      disabled: ["memory_read"],
    });
    expect(kept.binding.scheme_id).toBe(other.id);
    expect(kept.overrides).toEqual({ triggers: { direct_reply: true } });
    expect(kept.disabled_capabilities).toEqual(["memory_read"]);

    const reset = await save(
      app,
      orm,
      binding.id,
      { triggers: { follow_up: true } },
      { schemeId: scheme.id, schemeChange: "reset", disabled: ["memory_read"] },
    );
    expect(reset.binding.scheme_id).toBe(scheme.id);
    expect(reset.overrides).toEqual({});
    expect(reset.binding.triggers).toEqual({
      direct_reply: null,
      follow_up: null,
      chiming_in: null,
      idle_topic: null,
    });
    expect(reset.disabled_capabilities).toEqual(["memory_read"]);
  });

  it("只动自己：基础方案、同账号的另一个群和 Agent 身份都不变", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "20013");
    const other = groupBinding(orm, scheme.id, "20014");
    const otherBefore = required(readQqBinding(orm, other.id));
    const schemeBefore = required(readQqScheme(orm, scheme.id));
    const saved = await save(app, orm, binding.id, { triggers: { direct_reply: true } });
    expect(saved.binding.agent_id).toBe(DEFAULT_AGENT_ID);
    const otherAfter = required(readQqBinding(orm, other.id));
    expect(otherAfter.revision).toBe(otherBefore.revision);
    expect(otherAfter.triggers).toEqual(otherBefore.triggers);
    expect(configRows(orm, other.id)).toHaveLength(0);
    const schemeAfter = required(readQqScheme(orm, scheme.id));
    expect(schemeAfter.revision).toBe(schemeBefore.revision);
    expect(schemeRhythm(schemeAfter)).toEqual(schemeRhythm(schemeBefore));
  });

  it("私聊与不存在的绑定：配置路由是 404", async () => {
    const { orm, app, scheme } = setup();
    const created = createQqBinding({
      id: crypto.randomUUID(),
      accountId: "10001",
      kind: "private",
      peerId: "40001",
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      paused: false,
      shareWebMemory: false,
    });
    if (created.kind !== "saved") throw new Error("binding seed rejected");
    const privateBinding = insertQqBinding(orm, created.binding);
    for (const id of [privateBinding.id, crypto.randomUUID()]) {
      const response = await app.request(`/qq/bindings/${id}/config`);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("MEMORY_NOT_FOUND");
      const put = await putConfig(app, id, {
        agent_id: DEFAULT_AGENT_ID,
        expected_binding_revision: 1,
        expected_scheme_revision: 1,
        expected_revision: 0,
        overrides: {},
        disabled_capabilities: [],
      });
      expect(put.status).toBe(404);
    }
  });
});

describe("0051 迁移：老开关列搬进记录且仍是布尔形态", () => {
  it("非 NULL 的触发列生成记录，全 NULL 与私聊不生成，DDL 约束与 Drizzle 声明一致", () => {
    const db = new Database(":memory:");
    try {
      for (const file of BUSINESS_MIGRATION_FILES.slice(0, 50)) {
        db.exec(
          readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
        );
      }
      db.exec(`
        INSERT INTO qq_schemes (id, name, revision, created_at, updated_at)
          VALUES ('old-scheme', '老方案', 1, 'then', 'then');
        INSERT INTO qq_bindings
          (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
           trigger_direct_reply, trigger_follow_up, trigger_chiming_in, trigger_idle_topic,
           revision, authority_revision, created_at, updated_at)
          VALUES ('grp-1', '10001', 'group', '30001', 'agent-1', 'old-scheme',
            1, 0, NULL, 1, 1, 1, 'then', 'then');
        INSERT INTO qq_bindings
          (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
           trigger_direct_reply, trigger_follow_up, trigger_chiming_in, trigger_idle_topic,
           revision, authority_revision, created_at, updated_at)
          VALUES ('grp-2', '10001', 'group', '30002', 'agent-1', 'old-scheme',
            NULL, NULL, NULL, NULL, 1, 1, 'then', 'then');
        INSERT INTO qq_bindings
          (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
           trigger_direct_reply, trigger_follow_up, trigger_chiming_in, trigger_idle_topic,
           revision, authority_revision, created_at, updated_at)
          VALUES ('priv-1', '10001', 'private', '30003', 'agent-1', 'old-scheme',
            1, NULL, NULL, NULL, 1, 1, 'then', 'then');
        PRAGMA user_version=50;
      `);
      ensureBusinessSchema(db);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 54 });

      const orm = toOrmHandle(db).orm;
      const row = readQqGroupConfigRow(orm, "grp-1", "agent-1");
      expect(row).not.toBeNull();
      const view = parseQqGroupAgentConfigRow(required(row));
      // 老列上的真/假/跟随搬成布尔成员：null 成员在读取时被丢掉，不会变成"固定为 null"。
      expect(view.overrides).toEqual({
        triggers: { direct_reply: true, follow_up: false, idle_topic: true },
      });
      expect(view.disabled_capabilities).toEqual([]);
      // 迁移播种的能力修订是空映射：全部能力＝隐式 0（没有翻转过）。
      expect(required(row).capabilityRevisions).toBe("{}");
      expect(readQqGroupCapabilityRevision(orm, bindingRef("grp-1"), "memory_read")).toBe(0);
      expect(view.capability_revisions.get("memory_read")).toBe(0);
      expect(view.revision).toBe(1);
      expect(
        QqGroupSchemeOverridesSchema.safeParse(JSON.parse(required(row).schemeOverrides)).success,
      ).toBe(true);
      expect(readQqGroupConfigRow(orm, "grp-2", "agent-1")).toBeNull();
      expect(readQqGroupConfigRow(orm, "priv-1", "agent-1")).toBeNull();
      // 老列原样保留。
      expect(
        db
          .query(
            "SELECT trigger_direct_reply AS d, trigger_follow_up AS f, trigger_chiming_in AS c FROM qq_bindings WHERE id = 'grp-1'",
          )
          .get(),
      ).toEqual({ d: 1, f: 0, c: null });

      // DDL 的四个 CHECK 与 Drizzle 声明的四个命名检查一一对应（独立建库上比对）。
      const checkNames = getTableConfig(schema.qqGroupAgentConfigs)
        .checks.map((check) => String(check.name))
        .sort();
      expect(checkNames).toEqual([
        "qq_group_agent_config_capabilities",
        "qq_group_agent_config_capability_revisions",
        "qq_group_agent_config_overrides",
        "qq_group_agent_config_revision",
      ]);
      const ddl = (
        db
          .query(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'qq_group_agent_configs'",
          )
          .get() as { sql: string }
      ).sql;
      expect(ddl.split("CHECK").length - 1).toBe(4);
      expect(ddl).toContain("json_valid(scheme_overrides)");
      expect(ddl).toContain("json_type(scheme_overrides) = 'object'");
      expect(ddl).toContain("json_valid(disabled_capabilities)");
      expect(ddl).toContain("json_type(disabled_capabilities) = 'array'");
      expect(ddl).toContain("json_valid(capability_revisions)");
      expect(ddl).toContain("json_type(capability_revisions) = 'object'");
      expect(ddl).toContain("revision >= 1");
      expect(ddl).toContain("UNIQUE (binding_id, agent_id)");

      // 约束真的在拦：constraint 语义与 Drizzle 的四个名字对应。
      const insertProbe = (id: string, overrides: string, capabilities: string, revision: number) =>
        db
          .query(
            `INSERT INTO qq_group_agent_configs
               (id, binding_id, agent_id, scheme_overrides, disabled_capabilities, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'then', 'then')`,
          )
          .run(id, `probe-${id}`, "probe-agent", overrides, capabilities, revision);
      expect(() => insertProbe("p1", '"scalar"', "[]", 1)).toThrow();
      expect(() => insertProbe("p2", "{}", "{}", 1)).toThrow();
      expect(() => insertProbe("p3", "{}", "[]", 0)).toThrow();
      insertProbe("p4", "{}", "[]", 1);
      expect(() => insertProbe("p4", "{}", "[]", 2)).toThrow();
      // 不带 capability_revisions 的写入走列默认值 '{}'。
      expect(
        (
          db
            .query("SELECT capability_revisions AS r FROM qq_group_agent_configs WHERE id = 'p4'")
            .get() as { r: string }
        ).r,
      ).toBe("{}");
      const insertRevisionsProbe = (id: string, revisions: string) =>
        db
          .query(
            `INSERT INTO qq_group_agent_configs
               (id, binding_id, agent_id, scheme_overrides, disabled_capabilities, capability_revisions, revision, created_at, updated_at)
             VALUES (?, ?, ?, '{}', '[]', ?, 1, 'then', 'then')`,
          )
          .run(id, `probe-${id}`, "probe-agent", revisions);
      expect(() => insertRevisionsProbe("r1", '"scalar"')).toThrow();
      expect(() => insertRevisionsProbe("r2", "[1]")).toThrow();
      insertRevisionsProbe("r3", '{"memory_read": 2}');
    } finally {
      db.close();
    }
  });
});

describe("能力停用的单调修订（证据失效用）", () => {
  const revisionOf = (orm: Orm, bindingId: string) => (capability: QqGroupCapability) =>
    readQqGroupCapabilityRevision(orm, bindingRef(bindingId), capability);

  it("每次停用/恢复都让该能力修订 0→1→2 单调前进，其他能力保持 0，响应体不带修订字段", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21001");
    const rev = revisionOf(orm, binding.id);

    expect(rev("memory_read")).toBe(0); // 没有记录＝全部隐式 0。
    const off = await save(app, orm, binding.id, {}, { disabled: ["memory_read"] });
    expect(off.disabled_capabilities).toEqual(["memory_read"]);
    expect(rev("memory_read")).toBe(1);
    expect(rev("stickers")).toBe(0);

    const on = await save(app, orm, binding.id, {}, { disabled: [] });
    expect(on.disabled_capabilities).toEqual([]);
    expect(rev("memory_read")).toBe(2); // 恢复不回落：关闭期间签发的旧证据不能复活。
    expect(rev("stickers")).toBe(0);

    // 再停用一次继续前进；另一个能力从 0 出发的第一次翻转是 1。
    await save(app, orm, binding.id, {}, { disabled: ["memory_read", "web"] });
    expect(rev("memory_read")).toBe(3);
    expect(rev("web")).toBe(1);
    expect(rev("stickers")).toBe(0);

    // map 读口覆盖全部登记能力，未翻转的＝0。
    const revisions = readQqGroupCapabilityRevisions(orm, bindingRef(binding.id));
    expect(revisions.size).toBe(QqGroupCapabilitySchema.options.length);
    expect(revisions.get("memory_read")).toBe(3);
    expect(revisions.get("stickers")).toBe(0);

    // 公共读写响应不带修订字段：修订是服务端内部状态。
    expect(Object.keys(off)).not.toContain("capability_revisions");
    expect(Object.keys(await currentConfig(app, binding.id))).not.toContain("capability_revisions");
  });

  it("首次普通覆盖落行保全部能力为 0；无关差异、换方案与 reset 都不涨能力修订，no-op 不写库", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21002");
    const rev = revisionOf(orm, binding.id);

    // 第一次普通覆盖（只动触发）创建记录：没有能力被翻过，全部隐式 0，列存 '{}'。
    await save(app, orm, binding.id, { triggers: { direct_reply: true } });
    expect(required(configRows(orm, binding.id)[0]).capabilityRevisions).toBe("{}");
    expect(rev("web")).toBe(0);

    // 停用 web：0 → 1。
    await save(app, orm, binding.id, { triggers: { direct_reply: true } }, { disabled: ["web"] });
    expect(rev("web")).toBe(1);

    // 只改无关的方案差异：能力状态没翻，修订保持 1（无关键位微调不撤销证据）。
    await save(app, orm, binding.id, { triggers: { direct_reply: false } }, { disabled: ["web"] });
    expect(rev("web")).toBe(1);

    // 换基础方案 keep、再 reset：停用集合原样保留处不翻转，修订都不动；reset 清差异但保行保修订。
    const other = createQqScheme(orm, { name: "另一套方案" });
    const keepOverrides = (await currentConfig(app, binding.id)).overrides;
    const kept = await save(app, orm, binding.id, keepOverrides, {
      schemeId: other.id,
      schemeChange: "keep",
      disabled: ["web"],
    });
    expect(kept.binding.scheme_id).toBe(other.id);
    expect(rev("web")).toBe(1);
    const reset = await save(
      app,
      orm,
      binding.id,
      {},
      {
        schemeId: scheme.id,
        schemeChange: "reset",
        disabled: ["web"],
      },
    );
    expect(reset.overrides).toEqual({});
    expect(reset.disabled_capabilities).toEqual(["web"]);
    expect(rev("web")).toBe(1);

    // no-op：内容一致不写库（updated_at 不动）、配置修订不涨，能力修订也不动。
    const rowBefore = required(configRows(orm, binding.id)[0]);
    const revisionBefore = (await currentConfig(app, binding.id)).revision;
    const noop = await saveConfig(app, orm, binding.id, {}, { disabled: ["web"] });
    expect(noop.status).toBe(200);
    expect(required(configRows(orm, binding.id)[0]).updatedAt).toBe(rowBefore.updatedAt);
    expect((await currentConfig(app, binding.id)).revision).toBe(revisionBefore);
    expect(rev("web")).toBe(1);
    expect(rev("memory_read")).toBe(0);
  });

  it("请求体不能自带能力修订：未知字段整体被拒，状态不变", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21003");
    await save(app, orm, binding.id, {}, { disabled: ["web"] });
    const config = await currentConfig(app, binding.id);
    const targetScheme = required(readQqScheme(orm, config.binding.scheme_id));
    const response = await putConfig(app, binding.id, {
      agent_id: config.binding.agent_id,
      expected_binding_revision: config.binding.revision,
      expected_scheme_revision: targetScheme.revision,
      expected_revision: config.revision,
      overrides: {},
      disabled_capabilities: ["web"],
      capability_revisions: { web: 99 },
    });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("VALIDATION_ERROR");
    // 修订由服务端推导，客户端给的 99 不生效。
    expect(readQqGroupCapabilityRevision(orm, bindingRef(binding.id), "web")).toBe(1);
  });
});

// 0052/T12：两组设置进本群稀疏覆盖——嵌套 stages 逐字段跟随、null 原图是真实设置值、
// 保存只动提交的组；配置值改动不推进能力修订（修订只随能力开关翻转前进）。
describe("本群覆盖 0052 的两组设置（T12）", () => {
  it("media_input 的 stages 逐字段覆盖：只关 evaluation 不丢另外两个 true；message_settings 逐字段跟随", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "22001");
    const current = await currentConfig(app, binding.id);
    const response = await putConfig(app, binding.id, {
      agent_id: current.binding.agent_id,
      expected_binding_revision: current.binding.revision,
      expected_scheme_revision: current.base_scheme.revision,
      expected_revision: current.revision,
      overrides: { media_input: { stages: { evaluation: false } } },
      disabled_capabilities: current.disabled_capabilities,
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as QqGroupConfigResponse;
    // 计划 T12 Step7 锚点：evaluation false 落地，decision/generation 保持基础方案的 true。
    expect(saved.effective_scheme.media_input.stages).toEqual({
      decision: true,
      evaluation: false,
      generation: true,
    });
    // 差异里只钉住提交的那个字段，其余字段跟随（浅合并会把整组替换——这是被拒绝的语义）。
    expect(saved.overrides).toEqual({ media_input: { stages: { evaluation: false } } });
    expect(saved.base_scheme.media_input.mode).toBe("native");
    expect(saved.effective_scheme.media_input.mode).toBe("native");

    // message_settings 逐字段：只覆盖 timezone，其余跟随基础方案；media_input 整份提交
    // （已钉住的 stages 一并带上——客户端提交的是完整差异草稿）。
    const second = await save(app, orm, binding.id, {
      message_settings: { timezone: "Asia/Tokyo" },
      media_input: { stages: { evaluation: false }, ordinary_still_max_dimension: 1024 },
    });
    expect(second.overrides).toEqual({
      media_input: { stages: { evaluation: false }, ordinary_still_max_dimension: 1024 },
      message_settings: { timezone: "Asia/Tokyo" },
    });
    expect(second.effective_scheme.message_settings).toEqual({
      ...schemeMessageSettings(scheme),
      timezone: "Asia/Tokyo",
    });
    // null（原图）是可以被显式钉住的真实设置值；保存后读回仍是 null 而不是基础方案值。
    // 整份提交：已钉住的 message_settings 一并带上，不因这次只改 media_input 被清掉。
    expect(second.effective_scheme.media_input.ordinary_still_max_dimension).toBe(1024);
    const backToOriginal = await save(app, orm, binding.id, {
      message_settings: { timezone: "Asia/Tokyo" },
      media_input: { stages: { evaluation: false }, ordinary_still_max_dimension: null },
    });
    expect(backToOriginal.effective_scheme.media_input.ordinary_still_max_dimension).toBeNull();
    expect(backToOriginal.overrides.media_input?.ordinary_still_max_dimension).toBeNull();
    expect(backToOriginal.overrides.message_settings?.timezone).toBe("Asia/Tokyo");

    // 读回稳定：同一份状态再读一次不变。
    const reread = await currentConfig(app, binding.id);
    expect(reread.overrides).toEqual(backToOriginal.overrides);
    expect(reread.effective_scheme.message_settings.timezone).toBe("Asia/Tokyo");
  });

  it("整组提交不丢未提交组的差异：换基础方案 keep/reset 时两组差异随既有语义处理", async () => {
    const { orm, app, scheme } = setup();
    const other = createQqScheme(orm, { name: "另一个方案" });
    const binding = groupBinding(orm, scheme.id, "22002");
    const first = await save(app, orm, binding.id, {
      media_input: { stages: { generation: false } },
      message_settings: { reply_depth: 5 },
    });
    expect(first.overrides).toEqual({
      media_input: { stages: { generation: false } },
      message_settings: { reply_depth: 5 },
    });

    // keep：差异原样保留，生效值按新基础方案合并（其他字段跟随目标方案）。
    const kept = await save(app, orm, binding.id, first.overrides, {
      schemeId: other.id,
      schemeChange: "keep",
    });
    expect(kept.base_scheme.id).toBe(other.id);
    expect(kept.overrides).toEqual(first.overrides);
    expect(kept.effective_scheme.media_input.stages.generation).toBe(false);
    expect(kept.effective_scheme.message_settings.reply_depth).toBe(5);

    // reset：全部跟随新方案（差异清空，能力停用不在本用例范围）。
    const reset = await save(app, orm, binding.id, {}, { schemeChange: "reset" });
    expect(reset.overrides).toEqual({});
    expect(reset.effective_scheme.media_input.stages).toEqual({
      decision: true,
      evaluation: true,
      generation: true,
    });
    expect(reset.effective_scheme.message_settings).toEqual(
      schemeMessageSettings(required(readQqScheme(orm, scheme.id))),
    );
  });

  it("新 group override 写两组设置不推进能力修订；越界/未知字段拒绝且无部分写", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "22003");
    const before = await currentConfig(app, binding.id);

    // 只动配置值（两组覆盖）：能力修订不动（修订只在能力开关翻转时推进）。
    const saved = await save(
      app,
      orm,
      binding.id,
      { media_input: { max_images: 3 } },
      { disabled: ["web"] },
    );
    expect(saved.disabled_capabilities).toEqual(["web"]);
    expect(readQqGroupCapabilityRevision(orm, bindingRef(binding.id), "web")).toBe(1);
    expect(saved.effective_scheme.media_input.max_images).toBe(3);

    // 越界与未知字段在写入口拒绝：无部分写（revision 不动、记录不出现半截组）。
    const rejected: unknown[] = [
      { media_input: { max_images: 0 } },
      { media_input: { stages: { decision: "yes" } } },
      { message_settings: { reply_depth: 9 } },
      { message_settings: { timezone: "Not/AZone" } },
      { media_input: { nope: 1 } },
      { nope: {} },
    ];
    for (const bad of rejected) {
      const response = await saveConfig(app, orm, binding.id, bad);
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("VALIDATION_ERROR");
    }
    const after = await currentConfig(app, binding.id);
    expect(after.overrides).toEqual(saved.overrides);
    expect(after.revision).toBe(saved.revision);
    expect(before.disabled_capabilities).toEqual([]);
  });

  it("换 Agent：新 Agent 无记录＝全部跟随两组；旧 Agent 的两组差异在回切时恢复", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "22004");
    const saved = await save(app, orm, binding.id, {
      media_input: { mode: "description" },
      message_settings: { time_display: "full" },
    });
    expect(saved.revision).toBe(1);

    const agentB = createAgent(
      orm,
      { name: "T12 助手 B", description: "second", model_name: "test-model", is_active: true },
      {
        core_identity: "Synthetic B",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      },
    );
    const put = (payload: unknown) =>
      app.request(`/qq/bindings/${binding.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
    const toB = await put({
      agent_id: agentB.id,
      expected_revision: required(readQqBinding(orm, binding.id)).revision,
    });
    expect(toB.status).toBe(200);
    const configB = await currentConfig(app, binding.id);
    expect(configB.overrides).toEqual({});
    expect(configB.effective_scheme.media_input.mode).toBe("native");
    expect(configB.effective_scheme.message_settings.time_display).toBe("hybrid");

    const toA = await put({
      agent_id: DEFAULT_AGENT_ID,
      expected_revision: required(readQqBinding(orm, binding.id)).revision,
    });
    expect(toA.status).toBe(200);
    const configA = await currentConfig(app, binding.id);
    expect(configA.revision).toBe(1);
    expect(configA.overrides).toEqual(saved.overrides);
    expect(configA.effective_scheme.media_input.mode).toBe("description");
    expect(configA.effective_scheme.message_settings.time_display).toBe("full");
  });

  it("runtime 生效行读出两组合并值：readEffectiveQqScheme 应用本群差异", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "22005");
    await save(app, orm, binding.id, {
      media_input: { stages: { evaluation: false }, max_images: 2 },
      message_settings: { reply_mode: "configured_depth", reply_depth: 6 },
    });
    const effective = readEffectiveQqScheme(orm, required(readQqBinding(orm, binding.id)));
    if (effective === null) throw new Error("effective scheme missing");
    expect(effective.mediaInput).not.toBeNull();
    expect(JSON.parse(String(effective.mediaInput))).toEqual({
      mode: "native",
      stages: { decision: true, evaluation: false, generation: true },
      max_images: 2,
      ordinary_still_max_dimension: null,
      expression_max_dimension: 512,
      expression_frame_count: 3,
      expression_frame_max_dimension: 512,
    });
    expect(JSON.parse(String(effective.messageSettings))).toEqual({
      reply_mode: "configured_depth",
      reply_depth: 6,
      time_display: "hybrid",
      timezone: "Asia/Shanghai",
    });
  });
});

describe("模式互斥：legacy 双 true 绑定的保存边界", () => {
  it("仅改 idle_topic 的无关保存保留 raw 双 true；显式 pair 双 true 写拒绝；非 pair 变更放行", () => {
    const db = new Database(":memory:");
    try {
      for (const file of BUSINESS_MIGRATION_FILES.slice(0, 50)) {
        db.exec(
          readFileSync(path.join(import.meta.dir, "../../migrations/versions", file), "utf8"),
        );
      }
      const SCHEME = "20000000-0000-4000-8000-000000000054";
      const BINDING = "30000000-0000-4000-8000-000000000054";
      const AGENT = "10000000-0000-4000-8000-000000000054";
      db.exec(`
        INSERT INTO qq_schemes (id, name, revision, created_at, updated_at)
          VALUES ('${SCHEME}', '存量方案', 1, 'then', 'then');
        INSERT INTO qq_bindings
          (id, account_id, conversation_kind, peer_id, agent_id, scheme_id,
           trigger_direct_reply, trigger_follow_up, trigger_chiming_in, trigger_idle_topic,
           revision, authority_revision, created_at, updated_at)
          VALUES ('${BINDING}', '10001', 'group', '30001', '${AGENT}', '${SCHEME}',
            1, 1, 1, 0, 1, 1, 'then', 'then');
        PRAGMA user_version=50;
      `);
      ensureBusinessSchema(db);
      const orm = toOrmHandle(db).orm;
      const before = readQqBinding(orm, BINDING);
      expect(before).not.toBeNull();
      const legacy = required(before);
      // raw 双 true 存量。
      expect(legacy.triggers.follow_up).toBe(true);
      expect(legacy.triggers.chiming_in).toBe(true);

      // 真实保存入口 = 合同 updateQqBinding + 仓储 saveQqBinding。
      const save = (current: QqBinding, patch: Record<string, unknown>) => {
        const result = updateQqBinding(current, patch, current.revision);
        if (result.kind !== "saved") throw new Error("unexpected conflict");
        saveQqBinding(orm, { binding: result.binding, expectedRevision: current.revision });
        return required(readQqBinding(orm, BINDING));
      };

      // 存量行上改 idle/direct 必须携带整组 triggers（whole-group travels），而整组里
      // 的 pair 是 raw 双 true → 显式补丁携带双 true 被拒；这类行只能先经 UI 解析 pair
      // 或不带 triggers 补丁做无关保存（pause）。这是父裁定的显式重写即拒的直接推论。
      expect(() => save(legacy, { triggers: { ...legacy.triggers, idle_topic: true } })).toThrow(
        "连续交谈与自主接话互斥",
      );

      // 不带 triggers 补丁的无关保存（paused 翻转）→ 放行，raw 列保持。
      const afterPause = save(legacy, { paused: !legacy.paused });
      expect(afterPause.triggers.follow_up).toBe(true);
      expect(afterPause.triggers.chiming_in).toBe(true);
      expect(afterPause.paused).toBe(!legacy.paused);

      // 先合法退出双 true：显式关闭 chiming_in（开启连续、关闭自主）。
      const afterOff = save(afterPause, {
        triggers: { ...afterPause.triggers, chiming_in: false },
      });
      expect(afterOff.triggers.chiming_in).toBe(false);
      expect(afterOff.triggers.follow_up).toBe(true);

      // 再显式写回双 true（新写引入冲突）→ 拒绝。
      expect(() =>
        save(afterOff, {
          triggers: { ...afterOff.triggers, chiming_in: true },
        }),
      ).toThrow("连续交谈与自主接话互斥");

      // 存量双 true 行上显式重写相同双 true 值：同样是显式 pair 补丁 → 拒绝。
      const afterRewrite = save(afterOff, {
        triggers: { ...afterOff.triggers, chiming_in: true, follow_up: false },
      });
      expect(() =>
        save(
          {
            ...afterRewrite,
            triggers: { ...afterRewrite.triggers, chiming_in: true, follow_up: true },
          },
          {
            triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: false },
          },
        ),
      ).toThrow("连续交谈与自主接话互斥");
    } finally {
      db.close();
    }
  });
});
