// 原生工具调用的服务档位：带原生工具调用训练的服务会在决策 JSON 之后追加一段调用标记，
// 整段不再可解析（AGENT_DECISION_INVALID）。修法是让模型用原生 `tool_calls` 表达 invoke
// （`src/server/llm/model-gateway.ts` 把它映射回现有 invoke 决策，严格解析与动作边界都不放松）。
// 不接受 tools 的服务会用 4xx 拒绝整单请求，因此按「服务 + 模型」记住是否带 tools：
// 记忆只决定“要不要带 tools”；读不出的解析规则（fail closed、不猜内容）与授权边界都不受它影响。

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
