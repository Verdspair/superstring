// 本文件只测 QQ 群能力 guard 的「同步读取工作量」：一个 assertSources 调用内的多条
// qq_group_capability 引用应共用一次群归属与一次群配置读取；不跨调用/await 保留快照，
// 下一次调用仍读当前记录。SQL 次数用 Drizzle logger 计，判定等价性以现有 sourceAccess 为基线，
// 不写毫秒阈值（Root 原生测量性能）。

import { afterEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  insertQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { createAgent } from "../../src/server/services/agent-service";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqGroupCapability } from "../../src/shared/contracts/qq-group-config";

type BusinessHandle = ReturnType<typeof openBusinessDb>;

const handles: BusinessHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function makeGroupBinding(h: BusinessHandle, name: string, peerId: string) {
  const scheme = createQqScheme(h.orm, { name });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId,
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  return insertQqBinding(h.orm, created.binding);
}

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const binding = makeGroupBinding(h, "capability-read-work", "30003");
  const owner: RunOwner = { kind: "qq_binding", id: binding.id, agentId: DEFAULT_AGENT_ID };
  return { h, binding, owner };
}

function writeCaps(
  h: BusinessHandle,
  bindingId: string,
  disabled: readonly QqGroupCapability[],
  expectedRevision: number,
) {
  writeQqGroupAgentConfigRow(h.orm, {
    bindingId,
    agentId: DEFAULT_AGENT_ID,
    overrides: {},
    disabledCapabilities: disabled,
    expectedRevision,
  });
}

function refFor(
  bindingId: string,
  capability: string,
  revision = "0",
  agentId = DEFAULT_AGENT_ID,
): SourceRef {
  return {
    kind: "qq_group_capability",
    id: JSON.stringify([bindingId, agentId, capability]),
    revision,
  };
}

/** Drizzle logger over the same synthetic connection: one entry per executed statement. */
function countingGuard(h: BusinessHandle) {
  const sql: string[] = [];
  const orm = drizzle(h.db, {
    schema,
    logger: {
      logQuery(query: string) {
        sql.push(query);
      },
    },
  });
  return { sql, guard: new QqGroupCapabilityGuard(orm) };
}

function countSql(sql: readonly string[], table: string): number {
  return sql.filter((query) => query.toLowerCase().includes(table)).length;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("QQ group capability source read work", () => {
  it("keeps calls with no capability refs at zero SQL", () => {
    const { h, owner } = setup();
    const { sql, guard } = countingGuard(h);
    guard.assertSources(owner, []);
    guard.assertSources(owner, [
      { kind: "external_document", id: "doc-1", revision: "1" },
      { kind: "conversation_message", id: "message-1", revision: "1" },
    ]);
    expect(sql).toEqual([]);
  });

  it("shares one scope read and one config read across refs in one call", () => {
    const { h, binding, owner } = setup();
    const { sql, guard } = countingGuard(h);
    const refs = [
      refFor(binding.id, "memory_read"),
      refFor(binding.id, "knowledge_read"),
      refFor(binding.id, "web"),
    ];
    // 现有逐条判定是等价基线；合并读取不得改变任一条的结论。
    expect(refs.map((ref) => guard.sourceAccess(ref, owner))).toEqual([
      "available",
      "available",
      "available",
    ]);

    sql.length = 0;
    guard.assertSources(owner, refs);
    expect(countSql(sql, "qq_bindings")).toBe(1);
    expect(countSql(sql, "qq_group_agent_configs")).toBe(1);
    expect(sql).toHaveLength(2);

    // 1000 次调用仍各读一次：快照不得跨调用复用。
    sql.length = 0;
    for (let index = 0; index < 1000; index++) guard.assertSources(owner, refs);
    expect(countSql(sql, "qq_bindings")).toBe(1000);
    expect(countSql(sql, "qq_group_agent_configs")).toBe(1000);
    expect(sql).toHaveLength(2000);
  });

  it("keeps the same verdicts as per-ref sourceAccess for stale, disabled, cross-group and malformed refs", () => {
    const { h, binding, owner } = setup();
    const { guard } = countingGuard(h);
    const other = makeGroupBinding(h, "capability-read-work-other", "30004");
    writeCaps(h, binding.id, ["media"], 0);

    const cases: SourceRef[][] = [
      [refFor(binding.id, "memory_read")],
      [refFor(binding.id, "media", "1")],
      [refFor(binding.id, "web", "1")],
      [refFor(other.id, "web")],
      [{ kind: "qq_group_capability", id: "not-json", revision: "0" }],
      [
        {
          kind: "qq_group_capability",
          id: JSON.stringify([binding.id, DEFAULT_AGENT_ID, "nope"]),
          revision: "0",
        },
      ],
      [refFor(binding.id, "memory_read"), refFor(binding.id, "media", "1")],
    ];
    for (const refs of cases) {
      const available = refs.every((ref) => guard.sourceAccess(ref, owner) === "available");
      expect(codeOf(() => guard.assertSources(owner, refs))).toBe(
        available ? undefined : "QQ_GROUP_CAPABILITY_DISABLED",
      );
    }
  });

  it("keeps source order for malformed refs instead of pre-parsing everything", () => {
    const { h, binding, owner } = setup();
    const { sql, guard } = countingGuard(h);

    // 坏引用在最前：legacy 在读 scope/config 之前就失败。
    expect(
      codeOf(() =>
        guard.assertSources(owner, [
          { kind: "qq_group_capability", id: "not-json", revision: "0" },
          refFor(binding.id, "web"),
        ]),
      ),
    ).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(sql).toEqual([]);

    // 有效引用在前：仍先完成本调用的 scope/config 读取，再由后面的坏引用失败（legacy 顺序）。
    expect(
      codeOf(() =>
        guard.assertSources(owner, [
          refFor(binding.id, "web"),
          { kind: "qq_group_capability", id: "not-json", revision: "0" },
        ]),
      ),
    ).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(sql).toHaveLength(2);
  });

  it("keeps invalid stored config fail-closed instead of revoking or passing", () => {
    const { h, binding, owner } = setup();
    const { guard } = countingGuard(h);
    writeCaps(h, binding.id, ["media"], 0);
    const ref = refFor(binding.id, "web");

    h.db
      .query(
        "UPDATE qq_group_agent_configs SET capability_revisions = ? WHERE binding_id = ? AND agent_id = ?",
      )
      .run('{"web":-1}', binding.id, DEFAULT_AGENT_ID);
    expect(codeOf(() => guard.assertSources(owner, [ref]))).toBe("MEMORY_SOURCE_INVALID");
    expect(codeOf(() => guard.sourceAccess(ref, owner))).toBe("MEMORY_SOURCE_INVALID");

    h.db
      .query(
        "UPDATE qq_group_agent_configs SET capability_revisions = '{}', disabled_capabilities = ? WHERE binding_id = ? AND agent_id = ?",
      )
      .run('["nope"]', binding.id, DEFAULT_AGENT_ID);
    expect(codeOf(() => guard.assertSources(owner, [ref]))).toBe("MEMORY_SOURCE_INVALID");
    expect(codeOf(() => guard.sourceAccess(ref, owner))).toBe("MEMORY_SOURCE_INVALID");

    // 存储校验先于后面的坏引用：逐条 lazy 解析保持 legacy 的错误优先级。
    expect(
      codeOf(() =>
        guard.assertSources(owner, [
          ref,
          { kind: "qq_group_capability", id: "not-json", revision: "0" },
        ]),
      ),
    ).toBe("MEMORY_SOURCE_INVALID");
    expect(
      codeOf(() =>
        guard.assertSources(owner, [
          { kind: "qq_group_capability", id: "not-json", revision: "0" },
          ref,
        ]),
      ),
    ).toBe("QQ_GROUP_CAPABILITY_DISABLED");
  });

  it("re-reads scope and config on every call: disable, off-on and rebind are visible", () => {
    const { h, binding, owner } = setup();
    const { sql, guard } = countingGuard(h);
    const ref = refFor(binding.id, "web");
    guard.assertSources(owner, [ref]);
    expect(sql).toHaveLength(2);

    writeCaps(h, binding.id, ["web"], 0);
    sql.length = 0;
    expect(codeOf(() => guard.assertSources(owner, [ref]))).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(sql).toHaveLength(2);
    expect(guard.sourceAccess(ref, owner)).toBe("revoked");

    writeCaps(h, binding.id, [], 1);
    expect(codeOf(() => guard.assertSources(owner, [ref]))).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    expect(guard.assertSources(owner, [refFor(binding.id, "web", "2")])).toBeUndefined();

    const agentB = createAgent(
      h.orm,
      {
        name: "capability read work B",
        description: "second",
        model_name: "test-model",
        is_active: true,
      },
      {
        core_identity: "Synthetic B",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      },
    );
    h.db.query("UPDATE qq_bindings SET agent_id = ? WHERE id = ?").run(agentB.id, binding.id);
    sql.length = 0;
    expect(codeOf(() => guard.assertSources(owner, [refFor(binding.id, "web", "2")]))).toBe(
      "QQ_GROUP_CAPABILITY_DISABLED",
    );
    // 归属不明的 owner 只需一次绑定读取；配置尚未读取。
    expect(sql).toHaveLength(1);
    const ownerB: RunOwner = { kind: "qq_binding", id: binding.id, agentId: agentB.id };
    expect(
      guard.assertSources(ownerB, [refFor(binding.id, "web", "0", agentB.id)]),
    ).toBeUndefined();
  });
});
