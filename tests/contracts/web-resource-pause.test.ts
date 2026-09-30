// 共享 "web" 资源暂停回归：授权面板按 resource 记账（web.search / web.fetch 共用 "web"，
// 见 server/web-access 与 API 资源投影），而两个动作的全名不等于资源名。只按全名匹配会让
// 暂停 "web" 后联网动作照常被提供和领取；这里用真实动作契约钉住修复后的语义：
// 停 "web" 停两个动作；停单个动作只停该动作；MCP/Skill 的逐动作与模块语义不变。

import { describe, expect, it } from "bun:test";
import { createWebActions, WEB_PERMISSION_RESOURCE } from "../../src/server/web-access/actions";
import {
  type ExecutionPolicy,
  ExecutionPolicySchema,
  executionPolicy,
  type PermissionPolicy,
  toolExecutionEnabled,
} from "../../src/shared/contracts/permissions";

/** 走与 runtime.ts 相同的有效配置链：policy.execution → executionPolicy()。 */
function effective(patch: object): ExecutionPolicy {
  const policy: PermissionPolicy = {
    version: 1,
    grants: [],
    execution: ExecutionPolicySchema.parse(patch),
  };
  return executionPolicy(policy);
}
const enabled = (name: string, patch: object) => toolExecutionEnabled(effective(patch), name);

const webActions = createWebActions();

describe("web shared-resource pause", () => {
  it('keeps the shared action contract: both actions use resource "web"', () => {
    expect(WEB_PERMISSION_RESOURCE).toBe("web");
    expect(webActions.map((action) => action.description.name).sort()).toEqual([
      "web.fetch",
      "web.search",
    ]);
    for (const action of webActions) {
      expect(action.description.name.startsWith("web.")).toBe(true);
      expect(action.permission?.resource).toBe(WEB_PERMISSION_RESOURCE);
    }
  });

  it("gates both web actions on the web module alone", () => {
    expect(enabled("web.search", { modules: { web: true } })).toBe(true);
    expect(enabled("web.fetch", { modules: { web: true } })).toBe(true);
    expect(enabled("web.search", { modules: { web: false } })).toBe(false);
    expect(enabled("web.fetch", { modules: { web: false } })).toBe(false);
    // 未配置即默认关闭（不是暂停）；缺省下 mcp/skills 仍可用。
    expect(enabled("web.search", {})).toBe(false);
    expect(enabled("web.fetch", {})).toBe(false);
    expect(enabled("mcp.demo.read", {})).toBe(true);
    expect(enabled("skill.read", {})).toBe(true);
  });

  it("stops both web actions while the shared resource is paused", () => {
    const patch = { modules: { web: true }, pausedTools: ["web"] };
    expect(enabled("web.search", patch)).toBe(false);
    expect(enabled("web.fetch", patch)).toBe(false);
  });

  it("keeps single-action pauses exact, not resource-wide", () => {
    const searchPaused = { modules: { web: true }, pausedTools: ["web.search"] };
    expect(enabled("web.search", searchPaused)).toBe(false);
    expect(enabled("web.fetch", searchPaused)).toBe(true);
    const fetchPaused = { modules: { web: true }, pausedTools: ["web.fetch"] };
    expect(enabled("web.fetch", fetchPaused)).toBe(false);
    expect(enabled("web.search", fetchPaused)).toBe(true);
  });

  it("restores both web actions when the shared pause is cleared", () => {
    const paused = effective({ modules: { web: true }, pausedTools: ["web"] });
    expect(toolExecutionEnabled(paused, "web.search")).toBe(false);
    expect(toolExecutionEnabled(paused, "web.fetch")).toBe(false);
    // 恢复与授权面板一致：从 pausedTools 移除 "web"。
    const resumed = executionPolicy({
      version: 1,
      grants: [],
      execution: { ...paused, pausedTools: [] },
    });
    expect(toolExecutionEnabled(resumed, "web.search")).toBe(true);
    expect(toolExecutionEnabled(resumed, "web.fetch")).toBe(true);
  });

  it("does not change MCP or skill per-action and module behavior", () => {
    // 暂停 "web" 生效的同时不牵连其它模块。
    const webPaused = { modules: { mcp: true, skills: true, web: true }, pausedTools: ["web"] };
    expect(enabled("web.search", webPaused)).toBe(false);
    expect(enabled("mcp.demo.read", webPaused)).toBe(true);
    expect(enabled("skill.read", webPaused)).toBe(true);
    // MCP/Skill 资源名就是动作全名：暂停只影响该动作，裸模块名不是共享资源暂停。
    const mcpPaused = {
      modules: { mcp: true, skills: true },
      pausedTools: ["mcp.demo.read", "mcp", "skill"],
    };
    expect(enabled("mcp.demo.read", mcpPaused)).toBe(false);
    expect(enabled("mcp.demo.write", mcpPaused)).toBe(true);
    expect(enabled("skill.read", mcpPaused)).toBe(true);
    // 模块开关仍是 MCP/Skill 唯一的模块级闸门，与暂停互不替代。
    const modulesOff = { modules: { mcp: false, skills: false, web: false }, pausedTools: [] };
    expect(enabled("mcp.demo.read", modulesOff)).toBe(false);
    expect(enabled("skill.read", modulesOff)).toBe(false);
    expect(enabled("web.search", modulesOff)).toBe(false);
    const modulesOn = { modules: { mcp: true, skills: true, web: true }, pausedTools: [] };
    expect(enabled("mcp.demo.read", modulesOn)).toBe(true);
    expect(enabled("skill.read", modulesOn)).toBe(true);
    expect(enabled("web.search", modulesOn)).toBe(true);
  });
});
