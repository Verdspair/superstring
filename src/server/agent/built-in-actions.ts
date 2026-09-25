import { z } from "zod";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { Evidence } from "../../shared/contracts/evidence";
import type { ActionDescription } from "./agent-specs";
import type { ActionObservation } from "./context-engine";

export interface ActionContext {
  owner: RunOwner;
  signal: AbortSignal;
}
export interface BuiltInAction {
  description: ActionDescription;
  execute(
    arguments_: Record<string, unknown>,
    context: ActionContext,
  ): Promise<Omit<ActionObservation, "id" | "name">>;
}
export interface EvidenceQueryModule {
  query(
    input: { query: string; limit?: number },
    context: ActionContext,
  ): Promise<readonly Evidence[]>;
}
const QuerySchema = z.strictObject({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});

/** Only read/recomputable actions are installed in this refactor. */
export function createBuiltInActions(modules: {
  memory?: EvidenceQueryModule;
  knowledge?: EvidenceQueryModule;
}): BuiltInAction[] {
  return Object.entries(modules).map(
    ([kind, module]): BuiltInAction => ({
      description: {
        name: `${kind}.query`,
        description: `Read authorized ${kind} evidence`,
        parameters: z.toJSONSchema(QuerySchema),
        capability: `${kind}.read`,
      },
      async execute(arguments_, context) {
        context.signal.throwIfAborted();
        const evidence = await module.query(QuerySchema.parse(arguments_), context);
        context.signal.throwIfAborted();
        return { value: evidence, sources: evidence.flatMap((entry) => entry.sources) };
      },
    }),
  );
}
