import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
// 回归（bounded group-500 recovery）：本群只覆盖半径 B（或 Y）、之后基础方案改小中心 A（或 X），
// 合并值过界——配置页 GET 必须仍可读（原始差异保留、生效值逐字段可读），写边界仍拒绝
// 合并过界并允许合法修复；runtime 全量 schema 的严格关系不被放宽。

import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { insertQqBinding, readQqBinding } from "../../src/server/db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, type Orm } from "../../src/server/db/repositories";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QqSchemeRhythmSchema } from "../../src/shared/contracts/qq";
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
  const scheme = createQqScheme(business.orm, {
    name: "可读冲突方案",
    rhythm: { ...QQ_RHYTHM_DEFAULT },
  });
  return { business, orm: business.orm, app: createApp({ business }), scheme };
}

function groupBinding(orm: Orm, schemeId: string, peerId: string) {
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId,
    agentId: DEFAULT_AGENT_ID,
    schemeId,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding seed rejected");
  return insertQqBinding(orm, created.binding);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value to exist");
  return value;
}

async function currentConfig(app: App, bindingId: string) {
  const response = await app.request(`/qq/bindings/${bindingId}/config`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    base_scheme: { rhythm: Record<string, number | string> };
    effective_scheme: { rhythm: Record<string, number | string> };
    overrides: { rhythm?: Record<string, number> };
    revision: number;
  };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

function putConfig(app: App, bindingId: string, payload: unknown) {
  return app.request(`/qq/bindings/${bindingId}/config`, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

/** 以当前读到的三个修订提交整份配置（与既有 qq-group-config.test.ts 的 saveConfig 同形）。 */
async function saveConfig(
  app: App,
  orm: Orm,
  bindingId: string,
  overrides: unknown,
): Promise<Response> {
  const config = await currentConfig(app, bindingId);
  const binding = required(readQqBinding(orm, bindingId));
  const scheme = required(readQqScheme(orm, binding.schemeId));
  return putConfig(app, bindingId, {
    agent_id: DEFAULT_AGENT_ID,
    expected_binding_revision: binding.revision,
    expected_scheme_revision: scheme.revision,
    expected_revision: config.revision,
    overrides,
    disabled_capabilities: [],
  });
}

/** 把基础方案的节奏改一个字段（整组提交，基础自身必须仍是合法状态）。 */
function changeBaseRhythm(
  orm: Orm,
  schemeId: string,
  patch: { initiative_batch_target_count?: number; initiative_time_target_seconds?: number },
) {
  const row = required(readQqScheme(orm, schemeId));
  updateQqScheme(orm, schemeId, {
    name: row.name,
    rhythm: { ...schemeRhythm(row), ...patch },
    expectedRevision: row.revision,
  });
}

describe("本群配置：基础改动导致合并过界后仍可读", () => {
  it("计数窗口：只覆盖 Y=10，基础 X 15→8 合并过界，GET 可读、过界保存被拒、合法修复成功", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21001");

    // 写入时合法：Y=10 < 基础 X=15。
    const saved = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_batch_jitter_count: 10 },
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).revision).toBe(1);

    // 基础自身合法（5 < 8），但与差异合并后 10 < 8 不成立。
    changeBaseRhythm(orm, scheme.id, { initiative_batch_target_count: 8 });

    // 配置页读不再 500：原始差异保留，生效值逐字段可读。
    const after = await currentConfig(app, binding.id);
    expect(after.overrides.rhythm?.initiative_batch_jitter_count).toBe(10);
    expect(after.base_scheme.rhythm.initiative_batch_target_count).toBe(8);
    expect(after.effective_scheme.rhythm.initiative_batch_target_count).toBe(8);
    expect(after.effective_scheme.rhythm.initiative_batch_jitter_count).toBe(10);
    // runtime 全量 schema 的跨字段关系不被放宽：合并后的生效节奏仍不通过严格校验。
    expect(QqSchemeRhythmSchema.safeParse(after.effective_scheme.rhythm).success).toBe(false);

    // 过界组合的保存被写边界拒绝（合并后校验，错误不留半份状态）。
    const blocked = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_batch_jitter_count: 10, merge_window_seconds: 5 },
    });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).code).toBe("MEMORY_SOURCE_INVALID");

    // 合法修复：把 Y 改回过界内的值，保存成功且 GET 稳定可读。
    const repaired = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_batch_jitter_count: 3 },
    });
    expect(repaired.status).toBe(200);
    const reread = await currentConfig(app, binding.id);
    expect(reread.overrides.rhythm?.initiative_batch_jitter_count).toBe(3);
    expect(reread.effective_scheme.rhythm.initiative_batch_target_count).toBe(8);
    expect(QqSchemeRhythmSchema.safeParse(reread.effective_scheme.rhythm).success).toBe(true);
    // runtime 生效行的合并列同样跟随修复后的差异。
    const row = required(readEffectiveQqScheme(orm, required(readQqBinding(orm, binding.id))));
    expect(row.initiativeBatchJitterCount).toBe(3);
    expect(row.initiativeBatchTargetCount).toBe(8);
  });

  it("时间窗口：只覆盖 B=40，基础 A 60→25 合并过界，GET 可读、重复提交被拒、修复成功", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21002");

    // 写入时合法：B=40 < 基础 A=60。
    const saved = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_time_jitter_seconds: 40 },
    });
    expect(saved.status).toBe(200);

    // 基础自身合法（20 < 25），合并后 40 < 25 不成立。
    changeBaseRhythm(orm, scheme.id, { initiative_time_target_seconds: 25 });

    const after = await currentConfig(app, binding.id);
    expect(after.overrides.rhythm?.initiative_time_jitter_seconds).toBe(40);
    expect(after.base_scheme.rhythm.initiative_time_target_seconds).toBe(25);
    expect(after.effective_scheme.rhythm.initiative_time_target_seconds).toBe(25);
    expect(after.effective_scheme.rhythm.initiative_time_jitter_seconds).toBe(40);
    expect(QqSchemeRhythmSchema.safeParse(after.effective_scheme.rhythm).success).toBe(false);

    // 同一份过界差异重新提交（换方案或重存）也被合并后校验拒绝。
    const blocked = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_time_jitter_seconds: 40 },
    });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).code).toBe("MEMORY_SOURCE_INVALID");

    const repaired = await saveConfig(app, orm, binding.id, {
      rhythm: { initiative_time_jitter_seconds: 5 },
    });
    expect(repaired.status).toBe(200);
    const reread = await currentConfig(app, binding.id);
    expect(reread.overrides.rhythm?.initiative_time_jitter_seconds).toBe(5);
    expect(QqSchemeRhythmSchema.safeParse(reread.effective_scheme.rhythm).success).toBe(true);
  });

  it("严格 schema 的普通边界不放宽：越界覆盖仍被 422 拒绝且不留状态", async () => {
    const { orm, app, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "21003");
    const bad: unknown[] = [
      { rhythm: { merge_window_seconds: 301 } },
      { rhythm: { initiative_time_jitter_seconds: 2000 } },
      { rhythm: { initiative_batch_target_count: 0 } },
    ];
    for (const overrides of bad) {
      const response = await saveConfig(app, orm, binding.id, overrides);
      expect(response.status).toBe(422);
      expect((await errorOf(response)).code).toBe("VALIDATION_ERROR");
    }
    const fresh = await currentConfig(app, binding.id);
    expect(fresh.revision).toBe(0);
    expect(fresh.overrides).toEqual({});
  });
});
