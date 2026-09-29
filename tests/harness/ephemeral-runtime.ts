import { type AgentRuntime, createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { TextModelGateway } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { VisionClient } from "../../src/server/llm/vision-client";

/** Explicit isolated test runtime; production assembly always supplies the business repository. */
export function createEphemeralAgentRuntime(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
}): AgentRuntime & { close(): void } {
  const handle = openBusinessDb();
  return Object.assign(
    createAgentRuntime({ ...options, repository: new AgentRunRepository(handle.db) }),
    { close: () => handle.close() },
  );
}
