// 原生工具调用的服务档位（issue #10，2026-09-26）。
//
// 背景：决策协议原本只有"正文必须是一个完整 JSON 对象"这一条路。带原生工具调用训练的服务/模型会在
// 正确的决策 JSON 之后追加一段调用标记（已观测到 DeepSeek 系的 `<｜DSML｜｜invoke …>`），整段不再可
// 解析 → `AGENT_DECISION_INVALID`，主动发言路径上表现为静默失败。
//
// 修法是让模型用原生 `tool_calls` 表达 invoke（`src/server/llm/model-gateway.ts` 把它映射回现有
// invoke 决策，严格解析与动作边界都不放松）。但支持程度因服务而异：不接受 tools 的服务会用 4xx 拒
// 绝整单请求。这里沿用结构化输出那套思路——按「服务 + 模型」记住一次，撞过就不再白撞。
//
// 记忆只决定"要不要带 tools"；读不出的解析规则（fail closed、不猜内容）与授权边界都不受它影响。

/** key = 服务地址 + 模型：同一台服务换模型可能支持程度不同，所以两者都算进身份。 */
const unavailable = new Set<string>();

/** 这个服务+模型已经明确拒绝过 tools（本进程内）。 */
export function toolsUnavailable(key: string): boolean {
  return unavailable.has(key);
}

export function rememberToolsUnavailable(key: string): void {
  unavailable.add(key);
}

const announced = new Set<string>();

/** 每个服务+模型只提示一次：这条请求被拒是因为它带了 tools，本进程起不再带。 */
export function announceToolsFallback(
  key: string,
  model: string,
  status: number | undefined,
  reason: string,
): void {
  if (announced.has(key)) return;
  announced.add(key);
  console.warn(
    `[model-tools] ${model} 拒绝 tools（HTTP ${status ?? "?"}），本进程起改用 JSON 决策协议：${reason}`,
  );
}
