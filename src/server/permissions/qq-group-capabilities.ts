// 本群系统能力停用的统一判定面：模型可见工具目录、执行、子任务/后台与结果提交边界都从这里过一遍。
// 判定只做「停用收缩」：不属于 QQ 群（Web、私聊）一律放行，不借本群配置扩大既有授权。
//
// 所有者 → 绑定：`qq_binding` 以 id 直接指向绑定；`conversation` 经会话行；`memory_job` 经
// `config_snapshot.scope_key`。属于 QQ 群但绑定缺失或助手不匹配的按停用处理（fail closed）。
//
// 来源引用（`qq_group_capability`）的 revision 是**该能力停用纪元**的十进制串：跟随↔停用每次
// 翻转 +1，旧纪元引用永久失效（关闭再恢复不复活），改无关字段不失效。引用固定绑定 × 助手。

import { eq } from "drizzle-orm";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  type QqGroupCapability,
  QqGroupCapabilitySchema,
} from "../../shared/contracts/qq-group-config";
import type { BuiltInAction } from "../agent/built-in-actions";
import { readBindingByConversation, readQqBinding } from "../db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  readQqGroupCapabilityRevision,
} from "../db/qq-group-config-repository";
import type { Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { fail } from "../errors";

/** 来源引用的 kind：群能力证据。 */
export const QQ_GROUP_CAPABILITY_SOURCE_KIND = "qq_group_capability";

/**
 * 动作名 → 能力。按真实注册名匹配（含研究/代码扩展与 MCP/Skill/Task 前缀）；
 * `history.*` 原样保留——history_summary 只控制 summary 工具与压缩，不禁原始历史。
 */
const ACTION_CAPABILITIES: ReadonlyArray<
  | { name: string; capability: QqGroupCapability }
  | { prefix: string; capability: QqGroupCapability }
> = [
  { name: "sticker.search", capability: "stickers" },
  { name: "research.run", capability: "research" },
  { name: "code.run", capability: "code" },
  { prefix: "memory.", capability: "memory_read" },
  { prefix: "qq.members.", capability: "members_read" },
  { prefix: "knowledge.", capability: "knowledge_read" },
  { prefix: "summary.", capability: "history_summary" },
  { prefix: "media.", capability: "media" },
  { prefix: "web.", capability: "web" },
  { prefix: "mcp.", capability: "mcp" },
  { prefix: "skill.", capability: "skills" },
  { prefix: "task.", capability: "tasks" },
];

/** 叶子运行的 spec id → 能力（真实 id）。未登记的一律不属停用面（如 QQ 主决策与评分）。 */
const LEAF_CAPABILITIES = {
  "media.describe": "media",
  "context.compress.events": "history_summary",
  "context.compress": "history_summary",
  "onebot.sticker.select": "stickers",
  "memory.consolidate": "memory_organize",
  "memory.suppression": "memory_organize",
  "memory.select": "memory_read",
} as const satisfies Record<string, QqGroupCapability>;

type GroupScope =
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "group"; bindingId: string; agentId: string };

function actionCapability(name: string): QqGroupCapability | undefined {
  for (const entry of ACTION_CAPABILITIES) {
    if ("name" in entry ? entry.name === name : name.startsWith(entry.prefix))
      return entry.capability;
  }
  return undefined;
}

function capabilityRefId(bindingId: string, agentId: string, capability: QqGroupCapability) {
  return JSON.stringify([bindingId, agentId, capability]);
}

function parseCapabilityRefId(
  id: string,
): { bindingId: string; agentId: string; capability: QqGroupCapability } | null {
  let value: unknown;
  try {
    value = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [bindingId, agentId, capability] = value;
  if (
    typeof bindingId !== "string" ||
    typeof agentId !== "string" ||
    typeof capability !== "string"
  )
    return null;
  const parsed = QqGroupCapabilitySchema.safeParse(capability);
  return parsed.success ? { bindingId, agentId, capability: parsed.data } : null;
}

/**
 * `scope_key` 的归属：Web 记忆是裸 Agent id（不是 QQ 键）＝无群约束；私聊＝无群约束；
 * 自称 QQ 群但缺账号/群号的键＝无法确认绑定，按停用处理。
 */
function parseQqScopeKey(
  scopeKey: string,
):
  | { kind: "none" }
  | { kind: "unresolved" }
  | { kind: "group"; accountId: string; peerId: string; agentId?: string } {
  let value: unknown;
  try {
    value = JSON.parse(scopeKey);
  } catch {
    return { kind: "none" };
  }
  if (!Array.isArray(value) || value[0] !== "qq") return { kind: "none" };
  if (value[2] === "private") return { kind: "none" };
  if (value[2] !== "group" || typeof value[1] !== "string" || typeof value[3] !== "string")
    return { kind: "unresolved" };
  return {
    kind: "group",
    accountId: value[1],
    peerId: value[3],
    ...(typeof value[4] === "string" ? { agentId: value[4] } : {}),
  };
}

export class QqGroupCapabilityGuard {
  constructor(private readonly orm: Orm) {}

  /** owner 是否属于某个有效 QQ 群；Web/私聊＝无约束。 */
  private scope(owner: RunOwner): GroupScope {
    switch (owner.kind) {
      case "qq_binding":
        return this.bindingScope(owner);
      case "conversation":
        return this.conversationScope(owner);
      case "memory_job":
        return this.memoryJobScope(owner);
      default:
        return { kind: "none" };
    }
  }

  private bindingScope(owner: RunOwner): GroupScope {
    const binding = readQqBinding(this.orm, owner.id);
    if (!binding || (owner.agentId !== undefined && owner.agentId !== binding.agentId))
      return { kind: "unresolved" };
    return binding.kind === "group"
      ? { kind: "group", bindingId: binding.id, agentId: binding.agentId }
      : { kind: "none" };
  }

  private conversationScope(owner: RunOwner): GroupScope {
    const row = this.orm
      .select({
        channel: schema.conversations.channel,
        sourceId: schema.conversations.sourceId,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, owner.id))
      .get();
    if (!row || row.channel !== "onebot11") return { kind: "none" };
    const binding = readQqBinding(this.orm, row.sourceId);
    if (!binding || (owner.agentId !== undefined && owner.agentId !== binding.agentId))
      return { kind: "unresolved" };
    return binding.kind === "group"
      ? { kind: "group", bindingId: binding.id, agentId: binding.agentId }
      : { kind: "none" };
  }

  private memoryJobScope(owner: RunOwner): GroupScope {
    const row = this.orm
      .select({
        agentId: schema.memoryJobs.agentId,
        configSnapshot: schema.memoryJobs.configSnapshot,
      })
      .from(schema.memoryJobs)
      .where(eq(schema.memoryJobs.id, owner.id))
      .get();
    // 行缺失无法判断这套整理的归属，不能默默当 Web 放行。
    if (!row) return { kind: "unresolved" };
    let snapshot: { scope_key?: unknown };
    try {
      snapshot = JSON.parse(row.configSnapshot) as { scope_key?: unknown };
    } catch {
      return { kind: "unresolved" };
    }
    if (typeof snapshot.scope_key !== "string") return { kind: "unresolved" };
    const identity = parseQqScopeKey(snapshot.scope_key);
    if (identity.kind === "none") return { kind: "none" };
    if (identity.kind === "unresolved") return { kind: "unresolved" };
    const binding = readBindingByConversation(this.orm, {
      accountId: identity.accountId,
      kind: "group",
      peerId: identity.peerId,
    });
    // 当前绑定的助手必须与整理的助手一致；换绑后不得拿旧助手的能力状态放行。
    if (
      !binding ||
      binding.kind !== "group" ||
      binding.agentId !== row.agentId ||
      (identity.agentId !== undefined && identity.agentId !== row.agentId)
    )
      return { kind: "unresolved" };
    if (owner.agentId !== undefined && owner.agentId !== binding.agentId)
      return { kind: "unresolved" };
    return { kind: "group", bindingId: binding.id, agentId: binding.agentId };
  }

  private disabled(scope: { bindingId: string; agentId: string }): ReadonlySet<string> {
    const config = readQqGroupAgentConfig(this.orm, {
      id: scope.bindingId,
      agentId: scope.agentId,
      kind: "group",
    });
    return new Set(config.disabled_capabilities);
  }

  /** 来源引用的 revision：能力当前纪元（跟随↔停用每次翻转 +1）的十进制串，绑定签发时刻。 */
  private capabilityRevision(
    scope: { bindingId: string; agentId: string },
    capability: QqGroupCapability,
  ): string {
    return String(
      readQqGroupCapabilityRevision(
        this.orm,
        { id: scope.bindingId, agentId: scope.agentId, kind: "group" },
        capability,
      ),
    );
  }

  /** 能力是否放行。无群约束＝true；QQ 群但绑定不可确认＝false。 */
  allowed(owner: RunOwner, capability: QqGroupCapability): boolean {
    const scope = this.scope(owner);
    if (scope.kind === "none") return true;
    if (scope.kind === "unresolved") return false;
    return !this.disabled(scope).has(capability);
  }

  assert(owner: RunOwner, capability: QqGroupCapability): void {
    const scope = this.scope(owner);
    if (scope.kind === "none") return;
    if (scope.kind === "unresolved")
      fail("QQ_GROUP_CAPABILITY_DISABLED", "无法确认这条 QQ 绑定，按停用处理");
    if (this.disabled(scope).has(capability))
      fail("QQ_GROUP_CAPABILITY_DISABLED", "本群已停用该能力");
  }

  /** 动作是否放行：未映射的能力面不受本群停用约束。 */
  actionAllowed(action: BuiltInAction, owner: RunOwner): boolean {
    const capability = actionCapability(action.description.name);
    return capability === undefined ? true : this.allowed(owner, capability);
  }

  assertAction(action: BuiltInAction, owner: RunOwner): void {
    const capability = actionCapability(action.description.name);
    if (capability !== undefined) this.assert(owner, capability);
  }

  /** 能力当前启用的来源引用：非群、停用或归属不明时为 []。自动装配（非工具）同样靠它把产出绑定到当前纪元。 */
  sources(owner: RunOwner, capability: QqGroupCapability): SourceRef[] {
    const scope = this.scope(owner);
    if (scope.kind !== "group" || this.disabled(scope).has(capability)) return [];
    return [
      {
        kind: QQ_GROUP_CAPABILITY_SOURCE_KIND,
        id: capabilityRefId(scope.bindingId, scope.agentId, capability),
        revision: this.capabilityRevision(scope, capability),
      },
    ];
  }

  /** 动作结果的来源引用：只对已映射能力、属有效 QQ 群且当前启用的所有者发出。 */
  actionSources(action: BuiltInAction, owner: RunOwner): SourceRef[] {
    const capability = actionCapability(action.description.name);
    return capability === undefined ? [] : this.sources(owner, capability);
  }

  /**
   * 复验一条来源引用。非群能力引用返回 undefined（交给别的解析器）；群能力引用只认
   * (绑定, 助手, 能力) 与当前所有者一致、当前启用且 revision === 当前纪元串的引用，其余
   * （跨群/跨助手复用、旧纪元、未知状态串与停用状态）一律 revoked。
   */
  sourceAccess(source: SourceRef, owner: RunOwner): "available" | "revoked" | undefined {
    if (source.kind !== QQ_GROUP_CAPABILITY_SOURCE_KIND) return undefined;
    const ref = parseCapabilityRefId(source.id);
    if (!ref) return "revoked";
    const scope = this.scope(owner);
    if (
      scope.kind !== "group" ||
      scope.bindingId !== ref.bindingId ||
      scope.agentId !== ref.agentId ||
      this.disabled(scope).has(ref.capability)
    )
      return "revoked";
    return source.revision === this.capabilityRevision(scope, ref.capability)
      ? "available"
      : "revoked";
  }

  /** 结果提交边界：只检查群能力引用，其余来源交给原有解析器。 */
  assertSources(owner: RunOwner, sources: readonly SourceRef[]): void {
    for (const source of sources) {
      if (
        source.kind === QQ_GROUP_CAPABILITY_SOURCE_KIND &&
        this.sourceAccess(source, owner) !== "available"
      )
        fail("QQ_GROUP_CAPABILITY_DISABLED", "本群来源已失效，结果不得继续使用");
    }
  }

  /** 叶子运行边界：初次断言并冻结当前纪元，返回供 Runtime 在步落盘前复验的闭包（off 后再 on 也不放行）。 */
  assertLeaf(owner: RunOwner, specId: string): void | (() => void) {
    const capability = (LEAF_CAPABILITIES as Record<string, QqGroupCapability | undefined>)[specId];
    if (capability === undefined) return;
    this.assert(owner, capability);
    const scope = this.scope(owner);
    // Web/私聊不属停用面，没有纪元可冻结；归属无法确认的已在上面按停用失败。
    if (scope.kind !== "group") return;
    const source: SourceRef = {
      kind: QQ_GROUP_CAPABILITY_SOURCE_KIND,
      id: capabilityRefId(scope.bindingId, scope.agentId, capability),
      revision: this.capabilityRevision(scope, capability),
    };
    return () => this.assertSources(owner, [source]);
  }
}
