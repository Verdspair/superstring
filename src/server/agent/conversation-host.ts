import { startAgentTrace, traceErrorCode, withinAgentTrace } from "../observability/agent-tracing";
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
    const scope = startAgentTrace(this.options.runtime.telemetry, "conversation.activate", () => ({
      channel:
        conversation.channel === "web"
          ? "web"
          : conversation.channel === "onebot11"
            ? "onebot11"
            : "system",
      stage: "run",
      conversationId: conversation.id,
      agentId: conversation.agentId,
      userId: activation.owner.userId,
      details: { topology: conversation.topology, outputMode: activation.outputMode },
    }));
    return withinAgentTrace(scope, async () => {
      try {
        const result = await this.options.runtime.run(spec, {
          ...activation,
          conversationId: conversation.id,
          owner: { ...activation.owner, agentId: conversation.agentId },
        });
        scope?.update({ runId: result.runId, status: result.status });
        return result;
      } catch (error) {
        if (activation.signal?.aborted)
          scope?.end("cancelled", traceErrorCode(activation.signal.reason));
        throw error;
      }
    });
  }
}
