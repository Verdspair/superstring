import type { ActionDescription } from "./agent-specs";
import type { BuiltInAction } from "./built-in-actions";

export interface ToolDescriptor extends Omit<ActionDescription, "effect"> {
  readonly effect: "read" | "write";
  readonly sandboxCallable: boolean;
}
export interface ToolCatalog {
  get(name: string): ToolDescriptor | undefined;
  resolve(name: string): BuiltInAction | undefined;
  sandboxable(): readonly ToolDescriptor[];
  advertised(names?: readonly string[]): readonly ActionDescription[];
}
export function describeTool(action: BuiltInAction): ToolDescriptor {
  const effect = action.description.effect ?? "write";
  return Object.freeze({
    ...action.description,
    effect,
    sandboxCallable: effect === "read" && action.sandboxCallable !== false,
  });
}
export function createToolCatalog(actions: readonly BuiltInAction[]): ToolCatalog {
  const byName = new Map<string, { action: BuiltInAction; descriptor: ToolDescriptor }>();
  for (const action of actions) {
    const descriptor = describeTool(action);
    if (byName.has(descriptor.name))
      throw Object.assign(new Error(`TOOL_CATALOG_DUPLICATE: ${descriptor.name}`), {
        code: "TOOL_CATALOG_DUPLICATE",
      });
    byName.set(descriptor.name, { action, descriptor });
  }
  return {
    get: (name) => byName.get(name)?.descriptor,
    resolve: (name) => byName.get(name)?.action,
    sandboxable: () =>
      [...byName.values()]
        .map((entry) => entry.descriptor)
        .filter((descriptor) => descriptor.sandboxCallable),
    advertised: (names = [...byName.keys()]) =>
      names.flatMap((name) => {
        const entry = byName.get(name);
        return entry ? [{ ...entry.action.description }] : [];
      }),
  };
}
export function advertisedActions(catalog: ToolCatalog): readonly ActionDescription[] {
  return catalog.advertised();
}
