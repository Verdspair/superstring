import type { EntriesList, PersonaResponse } from "../../shared/contracts";
import type { SuperstringApi } from "../api";

/**
 * 助手首屏预热：纯人设读取 + 选中记忆前 100 条摘要预览。
 * 单槽只读缓存，槽位与在途任务都以 {api, agentId} 为唯一 owner；
 * 换客户端同 ID 不消费旧数据，迟到旧请求不覆盖新槽位，失败不缓存。
 */
export interface WarmAgentResult {
  persona: PersonaResponse | null;
  memoryEntries: EntriesList | null;
}

export interface AgentPreloadStoreState {
  selectedNewSessionAgentId?: string | null;
  editorAgentId?: string | null;
  agents?: readonly { id: string }[];
  dirty?: boolean;
}

/** 预热目标的单槽只读权威 ID：新会话选中 > 真实编辑目标 > 助手列表首位。 */
export function getPreloadTargetAgentId(storeState: AgentPreloadStoreState): string | null {
  if (storeState.selectedNewSessionAgentId) return storeState.selectedNewSessionAgentId;
  if (storeState.editorAgentId && storeState.editorAgentId !== "__new__")
    return storeState.editorAgentId;
  return storeState.agents?.[0]?.id ?? null;
}

/** 在途草稿（dirty）期间排除预热；其余情况只要求存在合法目标助手。 */
export function isAgentPreloadEligible(storeState: AgentPreloadStoreState): boolean {
  if (storeState.dirty) return false;
  return getPreloadTargetAgentId(storeState) !== null;
}

interface AgentPreloadOwner {
  api: SuperstringApi;
  agentId: string;
}

const sameOwner = (owner: AgentPreloadOwner, api: SuperstringApi, agentId: string): boolean =>
  owner.api === api && owner.agentId === agentId;

let slot:
  | (AgentPreloadOwner & {
      persona: PersonaResponse | null;
      memoryEntries: EntriesList | null;
    })
  | null = null;
let inFlight: { owner: AgentPreloadOwner; promise: Promise<WarmAgentResult> } | null = null;

/**
 * 统一执行助手人设与选中记忆首屏预读（仅 GET，不写任何状态）。
 * - 人设与记忆列表互相独立：单项失败只落空该项，双项都失败才算失败且不缓存；
 * - 同 {api, agentId} 重复调用直接命中已有结果，不重复发包。
 */
export function warmAgentResources(api: SuperstringApi, agentId: string): Promise<WarmAgentResult> {
  if (slot && sameOwner(slot, api, agentId) && (slot.persona || slot.memoryEntries)) {
    return Promise.resolve({ persona: slot.persona, memoryEntries: slot.memoryEntries });
  }
  if (inFlight && sameOwner(inFlight.owner, api, agentId)) return inFlight.promise;
  const owner: AgentPreloadOwner = { api, agentId };
  const run = async (): Promise<WarmAgentResult> => {
    const [persona, memoryEntries] = await Promise.allSettled([
      api.getPersona(agentId),
      api.listMemoryEntries(agentId, 0, 100),
    ]);
    if (persona.status === "rejected" && memoryEntries.status === "rejected") throw persona.reason;
    const result: WarmAgentResult = {
      persona: persona.status === "fulfilled" ? persona.value : null,
      memoryEntries: memoryEntries.status === "fulfilled" ? memoryEntries.value : null,
    };
    // 只有仍是当前 owner 的任务落值：迟到旧请求不覆盖新槽位。
    if (inFlight?.owner === owner)
      slot = { api, agentId, persona: result.persona, memoryEntries: result.memoryEntries };
    return result;
  };
  const promise = run().finally(() => {
    if (inFlight?.owner === owner) inFlight = null;
  });
  inFlight = { owner, promise };
  return promise;
}

/**
 * 前台人设消费：预热在途时共享同一 Promise（不重复发包），
 * 落定后消费已就绪人设；未命中或预热失败返回 null，由前台正常重读。
 */
export async function resolvePreloadedPersona(
  api: SuperstringApi,
  agentId: string,
): Promise<PersonaResponse | null> {
  if (inFlight && sameOwner(inFlight.owner, api, agentId)) {
    try {
      const result = await inFlight.promise;
      if (!result.persona) return null;
      consumePreloadedPersona(api, agentId);
      return result.persona;
    } catch {
      return null;
    }
  }
  return consumePreloadedPersona(api, agentId);
}

export function peekPreloadedPersona(api: SuperstringApi, agentId: string): PersonaResponse | null {
  return slot && sameOwner(slot, api, agentId) ? slot.persona : null;
}

export function consumePreloadedPersona(
  api: SuperstringApi,
  agentId: string,
): PersonaResponse | null {
  if (!slot || !sameOwner(slot, api, agentId) || !slot.persona) return null;
  const persona = slot.persona;
  slot = slot.memoryEntries ? { ...slot, persona: null } : null;
  return persona;
}

export function peekPreloadedMemory(api: SuperstringApi, agentId: string): EntriesList | null {
  return slot && sameOwner(slot, api, agentId) ? slot.memoryEntries : null;
}

export function consumePreloadedMemory(api: SuperstringApi, agentId: string): EntriesList | null {
  if (!slot || !sameOwner(slot, api, agentId) || !slot.memoryEntries) return null;
  const memoryEntries = slot.memoryEntries;
  slot = slot.persona ? { ...slot, memoryEntries: null } : null;
  return memoryEntries;
}

/** 清除预热缓存（重置或切换助手时调用；不带参数清整个单槽与在途 owner，迟到请求不再落值）。 */
export function clearAgentPreloadCache(agentId?: string): void {
  if (!agentId || slot?.agentId === agentId) slot = null;
  if (!agentId || inFlight?.owner.agentId === agentId) inFlight = null;
}
