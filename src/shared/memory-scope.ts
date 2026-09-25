export type MemoryScopeIdentity =
  | { kind: "web" }
  | { kind: "legacy" }
  | { kind: "qq"; accountId: string; conversationKind: "group" | "private"; peerId: string };

export function memoryScopeIdentity(key: string, agentId: string): MemoryScopeIdentity {
  if (key === agentId) return { kind: "web" };
  try {
    const value: unknown = JSON.parse(key);
    if (
      Array.isArray(value) &&
      value.length === 5 &&
      value[0] === "qq" &&
      value[4] === agentId &&
      typeof value[1] === "string" &&
      /^\d+$/.test(value[1]) &&
      (value[2] === "group" || value[2] === "private") &&
      typeof value[3] === "string" &&
      /^\d+$/.test(value[3])
    ) {
      return { kind: "qq", accountId: value[1], conversationKind: value[2], peerId: value[3] };
    }
  } catch {}
  return { kind: "legacy" };
}
