import type { Database } from "bun:sqlite";
import {
  type AgentKnowledgeReadSettings,
  AgentKnowledgeReadSettingsSchema,
  type AgentKnowledgeReadUpdate,
  AgentKnowledgeReadUpdateSchema,
  type FrozenKnowledgeRead,
} from "../../shared/contracts/knowledge";
import { resolveKnowledgeReadBudget } from "../../shared/knowledge-read-config";
import { fail } from "../errors";

type Row = {
  enabled: number;
  context_budget: number | null;
  scope: string;
  document_ids: string;
  revision: number;
};

/** Reading rules never create grants or mutate shared organization settings. */
export class KnowledgeReadRepository {
  constructor(private readonly db: Database) {}

  settings(agentId: string): AgentKnowledgeReadSettings {
    if (!this.db.query("SELECT id FROM agents WHERE id = ?").get(agentId))
      fail("AGENT_NOT_FOUND", "Agent 不存在", 404);
    const row = this.db
      .query<Row, [string]>(
        "SELECT enabled, context_budget, scope, document_ids, revision FROM agent_knowledge_read_settings WHERE agent_id = ?",
      )
      .get(agentId);
    if (!row) fail("INVALID_SESSION_CONFIG", "助手资料读取配置缺失，请检查迁移或恢复备份");
    try {
      return AgentKnowledgeReadSettingsSchema.parse({
        revision: row.revision,
        config: {
          enabled: row.enabled === 1,
          context_budget: row.context_budget,
          scope: row.scope,
          document_ids: JSON.parse(row.document_ids),
        },
      });
    } catch {
      fail("INVALID_SESSION_CONFIG", "助手资料读取配置无效，请检查迁移或恢复备份");
    }
  }

  update(agentId: string, input: AgentKnowledgeReadUpdate): AgentKnowledgeReadSettings {
    const parsed = AgentKnowledgeReadUpdateSchema.parse(input);
    return this.db
      .transaction(() => {
        const old = this.settings(agentId);
        if (old.revision !== parsed.expected_revision)
          fail("KNOWLEDGE_REVISION_CONFLICT", "助手资料读取配置已被修改，请刷新后重试");
        const config = { ...parsed.config, document_ids: [...parsed.config.document_ids].sort() };
        for (const id of config.document_ids) {
          if (
            !this.db
              .query(
                "SELECT 1 FROM knowledge_grants g JOIN knowledge_documents d ON d.id = g.document_id WHERE g.agent_id = ? AND g.document_id = ?",
              )
              .get(agentId, id)
          )
            fail("KNOWLEDGE_NOT_FOUND", "资料不存在或未授权", 404);
        }
        if (
          JSON.stringify({ ...old.config, document_ids: [...old.config.document_ids].sort() }) ===
          JSON.stringify(config)
        )
          return old;
        this.db
          .query(
            "UPDATE agent_knowledge_read_settings SET enabled = ?, context_budget = ?, scope = ?, document_ids = ?, revision = revision + 1 WHERE agent_id = ?",
          )
          .run(
            config.enabled ? 1 : 0,
            config.context_budget,
            config.scope,
            JSON.stringify(config.document_ids),
            agentId,
          );
        return this.settings(agentId);
      })
      .immediate();
  }

  /** Caller owns prepareTurn's immediate transaction; no late settings lookup. */
  freeze(agentId: string): FrozenKnowledgeRead {
    const settings = this.settings(agentId);
    const global = this.db
      .query<{ context_budget: number; auto_enabled: number; revision: number }, []>(
        "SELECT context_budget, auto_enabled, revision FROM knowledge_settings WHERE id = 1",
      )
      .get();
    if (!global) fail("INVALID_SESSION_CONFIG", "全局资料配置缺失");
    const effective = resolveKnowledgeReadBudget(settings.config, global.context_budget);
    return {
      config: settings.config,
      revision: settings.revision,
      budget: effective.budget,
      budget_source: effective.source,
      global_revision: global.revision,
      auto_enabled: global.auto_enabled === 1,
    };
  }
}
