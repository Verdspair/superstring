// 本群分配模式（0068）的运行时生效面：差异里保存的 judgement/reply 模式必须与配置页读出的
// 生效方案（`readQqGroupConfig` 的 `effective_scheme.allocation`）一致地出现在 runtime 生效行
// （`readEffectiveQqScheme` → `schemeAllocation`）里。隔离克隆库 + 真实绑定/配置仓储，无网络、
// 无真实模型、无真实 QQ 副作用。
//
// 已知漂移（本文件是它的 RED）：`readEffectiveQqScheme` 取得合并后的 `merged.allocation`，但
// `schemeColumnsFromGroups` 不含 allocation 参数——合并值落不到生效行列上，runtime 的
// `schemeAllocation(effective)` 永远读到基础方案的列值，本群模式覆盖在运行时静默失效。
// 基础方案自身保存的 auto 模式是既有通路，本文件不声称它失效。

import { afterEach, describe, expect, it } from "bun:test";
import { insertQqBinding, readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readEffectiveQqScheme,
  readQqGroupConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeAllocation,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const scheme = createQqScheme(business.orm, {
    name: "分配运行时方案",
    allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } },
  });
  return { orm: business.orm, scheme };
}

function groupBinding(
  orm: ReturnType<typeof cloneBusinessDb>["orm"],
  schemeId: string,
  peerId: string,
) {
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

/** 走真实保存路径提交本群差异：按当前三个修订整份提交，只改传进来的组。 */
function saveOverrides(
  orm: ReturnType<typeof cloneBusinessDb>["orm"],
  bindingId: string,
  overrides: Record<string, unknown>,
) {
  const binding = readQqBinding(orm, bindingId);
  if (!binding) throw new Error("missing binding");
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme) throw new Error("missing scheme");
  return updateQqGroupConfig(orm, {
    bindingId,
    payload: {
      agent_id: binding.agentId,
      expected_binding_revision: binding.revision,
      expected_scheme_revision: scheme.revision,
      expected_revision: 0,
      overrides,
      disabled_capabilities: [],
    },
  });
}

function effectiveRow(orm: ReturnType<typeof cloneBusinessDb>["orm"], bindingId: string) {
  const binding = readQqBinding(orm, bindingId);
  if (!binding) throw new Error("missing binding");
  const effective = readEffectiveQqScheme(orm, binding);
  if (effective === null) throw new Error("effective scheme missing");
  return effective;
}

describe("本群分配模式进入 runtime 生效行（0068 通路完整性）", () => {
  it("差异仅覆盖 judgement=auto：配置页生效方案与 runtime 生效行都变为 auto，reply 仍跟随基础 fixed", () => {
    const { orm, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "24001");

    // 无差异：两处都读基础方案（两档 fixed），稀疏继承的基线状态。
    expect(readQqGroupConfig(orm, binding.id).effective_scheme.allocation).toEqual({
      judgement: { mode: "fixed" },
      reply: { mode: "fixed" },
    });
    const baseRow = effectiveRow(orm, binding.id);
    expect(schemeAllocation(baseRow)).toEqual({
      judgement: { mode: "fixed" },
      reply: { mode: "fixed" },
    });

    saveOverrides(orm, binding.id, { allocation: { judgement: { mode: "auto" } } });

    // 配置页读出的生效方案（既有通路）。
    expect(readQqGroupConfig(orm, binding.id).effective_scheme.allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
    // runtime 生效行：本文件的 RED 断言——修复前 schemeAllocation 仍读基础列，判 fixed。
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
  });

  it("基础方案 auto、本群差异显式回复 fixed：runtime 生效行按本群差异变回 fixed", () => {
    const { orm, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "24002");

    const current = readQqScheme(orm, scheme.id);
    if (!current) throw new Error("scheme missing");
    updateQqScheme(orm, scheme.id, {
      name: current.name,
      allocation: { judgement: { mode: "auto" }, reply: { mode: "auto" } },
      expectedRevision: current.revision,
    });
    // 基础方案自身的 auto 是既有通路（不声明它失效）。
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "auto" },
    });

    saveOverrides(orm, binding.id, { allocation: { reply: { mode: "fixed" } } });
    expect(readQqGroupConfig(orm, binding.id).effective_scheme.allocation).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
    // RED：修复前 runtime 生效行丢掉本群差异，仍判 auto。
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });
  });

  it("稀疏继承稳定：两档全清（差异清空）后 runtime 生效行回到基础方案的值", () => {
    const { orm, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "24003");

    saveOverrides(orm, binding.id, {
      allocation: { judgement: { mode: "auto" }, reply: { mode: "auto" } },
    });
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "auto" },
    });

    // scheme_change=reset 清空方案差异：全部跟随基础方案（能力停用不重置，这里未动）。
    const current = readQqGroupConfig(orm, binding.id);
    updateQqGroupConfig(orm, {
      bindingId: binding.id,
      payload: {
        agent_id: current.binding.agent_id,
        expected_binding_revision: current.binding.revision,
        expected_scheme_revision: current.base_scheme.revision,
        expected_revision: current.revision,
        overrides: {},
        disabled_capabilities: current.disabled_capabilities,
        scheme_change: "reset",
      },
    });
    expect(readQqGroupConfig(orm, binding.id).overrides).toEqual({});
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "fixed" },
      reply: { mode: "fixed" },
    });
  });

  it("基础方案之后改回 fixed：无本群差异的绑定跟随新基础值（时点行为，非陈旧缓存）", () => {
    const { orm, scheme } = setup();
    const binding = groupBinding(orm, scheme.id, "24004");

    const current = readQqScheme(orm, scheme.id);
    if (!current) throw new Error("scheme missing");
    updateQqScheme(orm, scheme.id, {
      name: current.name,
      allocation: { judgement: { mode: "auto" }, reply: { mode: "fixed" } },
      expectedRevision: current.revision,
    });
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "auto" },
      reply: { mode: "fixed" },
    });

    const again = readQqScheme(orm, scheme.id);
    if (!again) throw new Error("scheme missing");
    updateQqScheme(orm, scheme.id, {
      name: again.name,
      allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } },
      expectedRevision: again.revision,
    });
    expect(schemeAllocation(effectiveRow(orm, binding.id))).toEqual({
      judgement: { mode: "fixed" },
      reply: { mode: "fixed" },
    });
  });
});
