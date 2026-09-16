// Agent routes — 1:1 with `api/agents.py`.
//
// Mounted under `/agents`. Two behaviours that are easy to get wrong:
//   1. `GET /agents/{id}/persona` checks the AGENT exists first, so an unknown
//      agent is 404 AGENT_NOT_FOUND, not 409 PERSONA_NOT_FOUND
//      (agents.py:49-51).
//   2. `POST /agents/batch-delete` is a partial-success endpoint: it never
//      fails the whole request, it reports per-id results. Path order matters —
//      `/batch-delete` must be matched before `/{agent_id}` or a literal
//      "batch-delete" would be parsed as a UUID (and become a 422).

import { Hono } from "hono";
import {
  CreateAgentRequestSchema,
  DeleteAgentsRequestSchema,
  SavePersonaRequestSchema,
  UpdateAgentRequestSchema,
} from "../../shared/contracts";
import { ensureDefaults, type Orm } from "../db/repositories";
import { isAppError } from "../errors";
import {
  createAgent,
  deleteAgent,
  getAgentRowById,
  getPersona,
  listAgents,
  savePersona,
  updateAgent,
} from "../services/agent-service";
import { parseBody, parseUuidParam, readJsonBody } from "./validation";

/** Wire shape of AgentResponse (api/schemas.py AgentResponse). */
export function toAgentResponse(row: {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  additionalInstructions: string;
  modelName: string;
  temperature: number;
  memoryConsolidationModelName: string | null;
  memoryConsolidationPrompt: string;
  memoryConsolidationAdditionalInstructions: string;
  memoryRetrievalModelName: string | null;
  memoryRetrievalPrompt: string;
  contextCompressionModelName: string | null;
  p5Config: string;
  personaIntensity: number;
  isActive: number;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}) {
  let p5: unknown = {};
  try {
    p5 = row.p5Config ? JSON.parse(row.p5Config) : {};
  } catch {
    p5 = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system_prompt: row.systemPrompt,
    additional_instructions: row.additionalInstructions,
    model_name: row.modelName,
    temperature: row.temperature,
    memory_consolidation_model_name: row.memoryConsolidationModelName,
    memory_consolidation_prompt: row.memoryConsolidationPrompt,
    memory_consolidation_additional_instructions: row.memoryConsolidationAdditionalInstructions,
    memory_retrieval_model_name: row.memoryRetrievalModelName,
    memory_retrieval_prompt: row.memoryRetrievalPrompt,
    context_compression_model_name: row.contextCompressionModelName,
    p5_config: p5,
    is_active: row.isActive === 1,
    config_version: row.configVersion,
    persona_intensity: row.personaIntensity,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toPersonaResponse(row: {
  id: string;
  agentId: string;
  coreIdentity: string;
  communicationStyle: string;
  interactionBoundaries: string;
  exampleDialogues: string;
  advancedInstructions: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    agent_id: row.agentId,
    core_identity: row.coreIdentity,
    communication_style: row.communicationStyle,
    interaction_boundaries: row.interactionBoundaries,
    example_dialogues: row.exampleDialogues,
    advanced_instructions: row.advancedInstructions,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function agentRoutes(orm: Orm, defaultModelName: string): Hono {
  const router = new Hono();

  // agents.py:24-27 — list (ensures defaults so a fresh DB always has one).
  // The default agent's model_name comes from the configured LM Studio model
  // (repositories.py:104), NOT from the request.
  router.get("", (c) => {
    ensureDefaults(orm, defaultModelName);
    return c.json(listAgents(orm).map(toAgentResponse));
  });

  // agents.py:30-37 — create (201). `persona` / `persona_intensity` are not
  // part of AgentConfig (extra="forbid"), so they are split out first —
  // mirroring `body.agent_config()` / `body.persona_content()`.
  router.post("", async (c) => {
    const body = parseBody(CreateAgentRequestSchema, await readJsonBody(c.req.raw));
    const { persona, persona_intensity: personaIntensity, ...config } = body;
    const row = createAgent(orm, config as Record<string, unknown>, persona, personaIntensity);
    return c.json(toAgentResponse(row), 201);
  });

  // agents.py:86-117 — partial success, must precede `/{agent_id}`.
  router.post("/batch-delete", async (c) => {
    const body = parseBody(DeleteAgentsRequestSchema, await readJsonBody(c.req.raw));
    const results = body.agent_ids.map((agentId) => {
      try {
        deleteAgent(orm, agentId);
        return { id: agentId, deleted: true, error_code: null, message: "Agent 已删除" };
      } catch (error) {
        if (isAppError(error)) {
          return {
            id: agentId,
            deleted: false,
            error_code: error.code,
            message: error.message,
          };
        }
        throw error;
      }
    });
    const deletedCount = results.filter((r) => r.deleted).length;
    return c.json({
      deleted_count: deletedCount,
      failed_count: results.length - deletedCount,
      results,
    });
  });

  // agents.py:40-43
  router.get("/:agentId", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    return c.json(toAgentResponse(getAgentRowById(orm, agentId)));
  });

  // agents.py:45-51 — agent existence is checked BEFORE the persona lookup.
  router.get("/:agentId/persona", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    getAgentRowById(orm, agentId);
    return c.json(toPersonaResponse(getPersona(orm, agentId)));
  });

  // agents.py:54-68 — in-place overwrite, no version.
  router.put("/:agentId/persona", async (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const body = parseBody(SavePersonaRequestSchema, await readJsonBody(c.req.raw));
    getAgentRowById(orm, agentId);
    const row = savePersona(orm, agentId, body, body.persona_intensity);
    return c.json(toPersonaResponse(row));
  });

  // agents.py:71-77 — PATCH; `expected_version` is required and excluded from
  // the change set.
  router.patch("/:agentId", async (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const body = parseBody(UpdateAgentRequestSchema, await readJsonBody(c.req.raw));
    const { expected_version: expectedVersion, ...changes } = body;
    return c.json(toAgentResponse(updateAgent(orm, agentId, changes, expectedVersion)));
  });

  // agents.py:80-83 — 204, no body.
  router.delete("/:agentId", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    deleteAgent(orm, agentId);
    return c.body(null, 204);
  });

  // agents.py:120-128 — disable via update_agent with the current version.
  router.post("/:agentId/disable", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const agent = getAgentRowById(orm, agentId);
    return c.json(
      toAgentResponse(updateAgent(orm, agentId, { is_active: false }, agent.configVersion)),
    );
  });

  return router;
}
