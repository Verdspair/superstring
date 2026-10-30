// Agent routes
// Mounted under `/agents`. Two behaviours that are easy to get wrong:
// 1. `GET /agents/{id}/persona` checks the AGENT exists first, so an unknown
// agent is 404 AGENT_NOT_FOUND, not 409 PERSONA_NOT_FOUND
// 2. `POST /agents/batch-delete` is a partial-success endpoint: it never
// fails the whole request, it reports per-id results. Path order matters
// `/batch-delete` must be matched before `/{agent_id}` or a literal
// "batch-delete" would be parsed as a UUID (and become a 422).

import { Hono } from "hono";
import {
  CreateAgentRequestSchema,
  DeleteAgentsRequestSchema,
  SavePersonaRequestSchema,
  UpdateAgentRequestSchema,
} from "../../shared/contracts";
import type { PermissionRequirement } from "../../shared/contracts/permissions";
import type { ToolDefinition } from "../../shared/contracts/tool-directory";
import { ensureDefaults, type Orm } from "../db/repositories";
import { isAppError } from "../errors";
import type { McpManagement } from "../mcp/management";
import { PermissionError, type PermissionService } from "../permissions/service";
import { agentConfigFields } from "../services/agent-config-fields";
import type { AgentRow } from "../services/agent-service";
import {
  AGENT_CREATION_PERMISSION_ERRORS,
  createAgent,
  deleteAgent,
  getAgentRowById,
  getPersona,
  listAgents,
  savePersona,
  updateAgent,
} from "../services/agent-service";
import { managementErrors } from "./management";
import { parseBody, parseUuidParam, readJsonBody } from "./validation";

/** Wire shape of AgentResponse (AgentResponse). */
export function toAgentResponse(row: AgentRow) {
  return {
    id: row.id,
    ...agentConfigFields(row),
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

export interface AgentRoutesOptions {
  permissions?: PermissionService;
  externalActions?: () => readonly ToolDefinition[];
  mcpManagement?: McpManagement;
}

export function snapshotAgentCreationRequirements(
  actions: () => readonly ToolDefinition[],
  management?: McpManagement,
): PermissionRequirement[] {
  const before = management?.status();
  if (before?.code) throw new PermissionError(before.code);
  if (before?.servers.some((server) => server.config.enabled && server.state === "error")) {
    throw new PermissionError("MCP_CONNECT_FAILED");
  }
  if (before?.servers.some((server) => server.config.enabled && server.state !== "connected")) {
    throw new PermissionError("MCP_CATALOG_PENDING");
  }
  const requirements = actions().flatMap((action) => {
    const requirement = action.permission;
    return requirement
      ? [
          {
            ...requirement,
            ...(requirement.directories ? { directories: [...requirement.directories] } : {}),
          },
        ]
      : [];
  });
  const after = management?.status();
  if (after?.code) throw new PermissionError(after.code);
  if (before?.revision !== after?.revision) throw new PermissionError("MCP_CONFIG_CONFLICT");
  if (after?.servers.some((server) => server.config.enabled && server.state === "error")) {
    throw new PermissionError("MCP_CONNECT_FAILED");
  }
  if (after?.servers.some((server) => server.config.enabled && server.state !== "connected")) {
    throw new PermissionError("MCP_CATALOG_PENDING");
  }
  return requirements;
}

export function agentRoutes(
  orm: Orm,
  defaultModelName: string,
  options?: AgentRoutesOptions,
): Hono {
  const router = new Hono();
  router.onError(
    managementErrors({
      ...AGENT_CREATION_PERMISSION_ERRORS,
      MCP_CATALOG_PENDING: [409, "MCP 工具目录尚未就绪，请检查连接后重试"],
      MCP_CONFIG_CONFLICT: [409, "MCP 配置已变化，请重新读取后创建"],
      MCP_CONFIG_INVALID: [503, "MCP 配置格式无效"],
      MCP_CONFIG_UNAVAILABLE: [503, "MCP 配置不可读"],
      MCP_CONNECT_FAILED: [503, "MCP 工具发现失败，请检查连接后创建"],
    }),
  );

  // list (ensures defaults so a fresh DB always has one).
  // The default agent's model_name comes from the configured LM Studio model
  // NOT from the request.
  router.get("", (c) => {
    ensureDefaults(orm, defaultModelName);
    return c.json(listAgents(orm).map(toAgentResponse));
  });

  // create (201). `persona` / `persona_intensity` are not
  // part of AgentConfig (extra="forbid"), so they are split out first
  // mirroring `body.agent_config()` / `body.persona_content()`.
  router.post("", async (c) => {
    const body = parseBody(CreateAgentRequestSchema, await readJsonBody(c.req.raw));
    const { persona, persona_intensity: personaIntensity, ...config } = body;
    if (options?.mcpManagement) {
      const before = options.mcpManagement.status();
      const after = await options.mcpManagement.reload();
      if (before.revision !== after.revision) throw new PermissionError("MCP_CONFIG_CONFLICT");
    }
    const requirements = snapshotAgentCreationRequirements(
      options?.externalActions ?? (() => []),
      options?.mcpManagement,
    );
    const row = createAgent(orm, config as Record<string, unknown>, persona, personaIntensity, {
      permissions: options?.permissions,
      requirements,
    });
    return c.json(toAgentResponse(row), 201);
  });

  // partial success, must precede `/{agent_id}`.
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

  // 43
  router.get("/:agentId", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    return c.json(toAgentResponse(getAgentRowById(orm, agentId)));
  });

  // agent existence is checked BEFORE the persona lookup.
  router.get("/:agentId/persona", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    getAgentRowById(orm, agentId);
    return c.json(toPersonaResponse(getPersona(orm, agentId)));
  });

  // in-place overwrite, no version.
  router.put("/:agentId/persona", async (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const body = parseBody(SavePersonaRequestSchema, await readJsonBody(c.req.raw));
    getAgentRowById(orm, agentId);
    const row = savePersona(orm, agentId, body, body.persona_intensity);
    return c.json(toPersonaResponse(row));
  });

  // PATCH; `expected_version` is required and excluded from
  // the change set.
  router.patch("/:agentId", async (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const body = parseBody(UpdateAgentRequestSchema, await readJsonBody(c.req.raw));
    const { expected_version: expectedVersion, ...changes } = body;
    return c.json(toAgentResponse(updateAgent(orm, agentId, changes, expectedVersion)));
  });

  // Deletes the agent; responds 204 with no body.
  router.delete("/:agentId", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    deleteAgent(orm, agentId);
    return c.body(null, 204);
  });

  // disable via update_agent with the current version.
  router.post("/:agentId/disable", (c) => {
    const agentId = parseUuidParam(c.req.param("agentId"));
    const agent = getAgentRowById(orm, agentId);
    return c.json(
      toAgentResponse(updateAgent(orm, agentId, { is_active: false }, agent.configVersion)),
    );
  });

  return router;
}
