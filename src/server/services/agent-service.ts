// Agent configuration + in-place Persona persistence.
// Three behaviours that must not drift:
// 1. Persona saving is an IN-PLACE OVERWRITE — no version row, no history
// (ADR 0008). Persona and `persona_intensity` are written together.
// 2. An agent update compares the *parsed* config before deciding whether to
// bump `config_version`. A PATCH whose values are unchanged must NOT bump
// the version, otherwise every client's cached `expected_version` breaks.
// 3. Agent deletion refuses the built-in default agent and any agent bound to
// a session — historical conversations must never lose their Agent.
// Known faithful quirk (do NOT "fix" silently): `UpdateAgentRequest` accepts
// `persona_intensity`, but `AgentConfig` has `extra="forbid"` and does not
// declare it. So a PATCH that explicitly carries `persona_intensity` fails
// validation and becomes VALIDATION_ERROR 422. Recorded in
// docs/INVALID_CONFIG_PATHS.md.

import { eq } from "drizzle-orm";
import { AgentConfigSchema, type PersonaContent } from "../../shared/contracts";
import {
  asDatabaseError,
  DEFAULT_AGENT_ID,
  isIntegrityError,
  newId,
  nowIso,
  type Orm,
} from "../db/repositories";
import * as schema from "../db/schema";
import { AppError, ValidationError } from "../errors";
import { agentConfigFields } from "./agent-config-fields";

export type AgentRow = typeof schema.agents.$inferSelect;
export type PersonaRow = typeof schema.agentPersonas.$inferSelect;

/** Stable key order so two parsed configs compare structurally. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return item;
  });
}

/** 404 when missing. */
export function getAgentRowById(orm: Orm, agentId: string): AgentRow {
  const row = orm.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!row) throw new AppError("AGENT_NOT_FOUND", "Agent 不存在", 404);
  return row;
}

/** ordered by created_at then id. */
export function listAgents(orm: Orm): AgentRow[] {
  return orm.select().from(schema.agents).orderBy(schema.agents.createdAt, schema.agents.id).all();
}

export function createAgent(
  orm: Orm,
  config: Record<string, unknown>,
  persona: PersonaContent,
  personaIntensity: number | null = null,
): AgentRow {
  const parsed = AgentConfigSchema.safeParse(config);
  if (!parsed.success) throw new ValidationError("Agent 配置不合法");
  const values = parsed.data;

  const now = nowIso();
  const agentId = newId();
  const intensity =
    personaIntensity === null || personaIntensity === undefined
      ? undefined
      : Math.max(0, Math.min(100, Math.trunc(personaIntensity)));

  // `Agent(**values)` + an explicit `persona_intensity` override.
  orm
    .insert(schema.agents)
    .values({
      id: agentId,
      name: values.name,
      description: values.description,
      systemPrompt: values.system_prompt,
      additionalInstructions: values.additional_instructions,
      p5Config: JSON.stringify(values.p5_config),
      modelName: values.model_name,
      temperature: values.temperature,
      memoryConsolidationModelName: values.memory_consolidation_model_name,
      memoryConsolidationPrompt: values.memory_consolidation_prompt,
      memoryConsolidationAdditionalInstructions:
        values.memory_consolidation_additional_instructions,
      memoryRetrievalModelName: values.memory_retrieval_model_name,
      memoryRetrievalPrompt: values.memory_retrieval_prompt,
      contextCompressionModelName: values.context_compression_model_name,
      personaIntensity: intensity ?? 60,
      isActive: values.is_active ? 1 : 0,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  orm.insert(schema.agentKnowledgeReadSettings).values({ agentId }).run();
  orm
    .insert(schema.agentPersonas)
    .values({
      id: newId(),
      agentId,
      coreIdentity: persona.core_identity,
      communicationStyle: persona.communication_style,
      interactionBoundaries: persona.interaction_boundaries,
      exampleDialogues: persona.example_dialogues,
      advancedInstructions: persona.advanced_instructions,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getAgentRowById(orm, agentId);
}

/** missing persona is a config fault (409), not 404. */
export function getPersona(orm: Orm, agentId: string): PersonaRow {
  const row = orm
    .select()
    .from(schema.agentPersonas)
    .where(eq(schema.agentPersonas.agentId, agentId))
    .get();
  if (!row) {
    throw new AppError("PERSONA_NOT_FOUND", "Agent 尚未建立人设与性格，请检查迁移或恢复备份", 409);
  }
  return row;
}

/** overwrite in place; never creates a version. */
export function savePersona(
  orm: Orm,
  agentId: string,
  content: PersonaContent,
  personaIntensity: number | null = null,
): PersonaRow {
  const agent = getAgentRowById(orm, agentId);
  const persona = getPersona(orm, agentId);
  const now = nowIso();

  orm
    .update(schema.agentPersonas)
    .set({
      coreIdentity: content.core_identity,
      communicationStyle: content.communication_style,
      interactionBoundaries: content.interaction_boundaries,
      exampleDialogues: content.example_dialogues,
      advancedInstructions: content.advanced_instructions,
      updatedAt: now,
    })
    .where(eq(schema.agentPersonas.id, persona.id))
    .run();

  if (personaIntensity !== null && personaIntensity !== undefined) {
    const clamped = Math.max(0, Math.min(100, Math.trunc(personaIntensity)));
    orm
      .update(schema.agents)
      .set({ personaIntensity: clamped, updatedAt: now })
      .where(eq(schema.agents.id, agent.id))
      .run();
  } else {
    orm.update(schema.agents).set({ updatedAt: now }).where(eq(schema.agents.id, agent.id)).run();
  }

  return getPersona(orm, agentId);
}

export function updateAgent(
  orm: Orm,
  agentId: string,
  changes: Record<string, unknown>,
  expectedVersion: number,
): AgentRow {
  const agent = getAgentRowById(orm, agentId);
  if (expectedVersion !== agent.configVersion) {
    throw new AppError("CONFIG_VERSION_CONFLICT", "配置已被修改，请重新加载后保存", 409);
  }

  const current = agentConfigFields(agent);
  // `extra="forbid"` means an unknown key (notably `persona_intensity`) is a
  // 422, exactly like the contract.
  const parsed = AgentConfigSchema.safeParse({ ...current, ...changes });
  if (!parsed.success) throw new ValidationError("Agent 配置不合法");
  const next = parsed.data;

  const currentParsed = AgentConfigSchema.safeParse(current);
  const unchanged = currentParsed.success && canonical(currentParsed.data) === canonical(next);

  if (!unchanged) {
    const now = nowIso();
    orm
      .update(schema.agents)
      .set({
        name: next.name,
        description: next.description,
        systemPrompt: next.system_prompt,
        additionalInstructions: next.additional_instructions,
        modelName: next.model_name,
        temperature: next.temperature,
        memoryConsolidationModelName: next.memory_consolidation_model_name,
        memoryConsolidationPrompt: next.memory_consolidation_prompt,
        memoryConsolidationAdditionalInstructions:
          next.memory_consolidation_additional_instructions,
        memoryRetrievalModelName: next.memory_retrieval_model_name,
        memoryRetrievalPrompt: next.memory_retrieval_prompt,
        contextCompressionModelName: next.context_compression_model_name,
        p5Config: JSON.stringify(next.p5_config),
        isActive: next.is_active ? 1 : 0,
        configVersion: agent.configVersion + 1,
        updatedAt: now,
      })
      .where(eq(schema.agents.id, agentId))
      .run();
  }

  return getAgentRowById(orm, agentId);
}

/**
 * 126. The default Agent is undeletable and an Agent
 * referenced by any session is refused, so history keeps a resolvable agent_id.
 */
export function deleteAgent(orm: Orm, agentId: string): AgentRow {
  const agent = getAgentRowById(orm, agentId);
  if (agent.id === DEFAULT_AGENT_ID) {
    throw new AppError(
      "DEFAULT_AGENT_DELETE_FORBIDDEN",
      "内置默认 Agent 不能删除；可以停用或修改配置",
      409,
    );
  }
  const used = orm
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(eq(schema.sessions.agentId, agentId))
    .limit(1)
    .get();
  if (used) {
    throw new AppError(
      "AGENT_IN_USE",
      "Agent 已被历史会话使用，不能删除；如不再用于新会话，请改为停用",
      409,
    );
  }

  try {
    orm.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
  } catch (error) {
    if (!isIntegrityError(error)) throw asDatabaseError(error);
    throw new AppError(
      "AGENT_IN_USE",
      "Agent 正在被会话使用，删除未执行；请刷新后重试或改为停用",
      409,
    );
  }
  return agent;
}
