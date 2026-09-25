export type ModelPurpose =
  | "chat"
  | "retrieval"
  | "compression"
  | "memory_organization"
  | "knowledge_organization"
  | "qq_judgement"
  | "vision"
  | "transcription";
export interface ModelResolution {
  model: string | null;
  source:
    | "agent"
    | "global"
    | "shared_default"
    | "chat"
    | "bound_chat"
    | "gateway"
    | "unloaded"
    | "unconfigured";
}

/** Mirrors runtime-config and knowledge organizer precedence; undefined means not loaded. */
export function resolveModelUse(
  purpose: ModelPurpose,
  configured: string | null,
  chatModel?: string,
  sharedDefault?: string | null,
): ModelResolution {
  const agent = ["chat", "retrieval", "compression", "memory_organization"].includes(purpose);
  if (configured) return { model: configured, source: agent ? "agent" : "global" };
  if (purpose === "vision" || purpose === "transcription" || purpose === "chat")
    return { model: null, source: "unconfigured" };
  if (purpose === "qq_judgement") return { model: null, source: "bound_chat" };
  if (purpose === "memory_organization" || purpose === "knowledge_organization") {
    if (sharedDefault === undefined) return { model: null, source: "unloaded" };
    if (sharedDefault) return { model: sharedDefault, source: "shared_default" };
    if (purpose === "knowledge_organization") return { model: null, source: "gateway" };
  }
  return { model: chatModel || null, source: chatModel ? "chat" : "unconfigured" };
}
