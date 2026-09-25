import type { AgentRuntime, ConversationInput, ConversationRunResult } from "./agent-runtime";
import type { AgentSpec } from "./agent-specs";

export interface HostedConversation {
  id: string;
  channel: string;
  topology: "direct" | "shared";
  agentId: string;
}
export interface ConversationActivation extends Omit<ConversationInput, "conversationId"> {
  conversation: HostedConversation;
  spec: AgentSpec;
}

/**
 * Shared activation boundary. Channels own leases, input projection and durable commits;
 * the AgentRuntime owns every decide/invoke/observe/generate iteration.
 */
export class ConversationHost {
  constructor(private readonly options: { runtime: AgentRuntime }) {}

  activate(input: ConversationActivation): Promise<ConversationRunResult> {
    const { conversation, spec, ...activation } = input;
    return this.options.runtime.run(spec, {
      ...activation,
      conversationId: conversation.id,
      owner: { ...activation.owner, agentId: conversation.agentId },
    });
  }
}
