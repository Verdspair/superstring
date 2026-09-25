import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "../../src/server");
const files = [...new Bun.Glob("**/*.ts").scanSync(root)].map((file) => resolve(root, file));
const transpiler = new Bun.Transpiler({ loader: "ts" });
const moduleName = (file: string) => relative(root, file).split(sep).join("/");
const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
function valueImports(file: string, source: string): string[] {
  // Bun excludes type-only imports and includes re-exports; neither comments nor
  // multiline import formatting can disguise a dependency from this graph.
  return transpiler
    .scanImports(source)
    .flatMap(({ path }) => (path.startsWith(".") ? [resolve(dirname(file), path + ".ts")] : []));
}

describe("Agent inference and leaf dependency boundaries", () => {
  it("keeps inference calls behind Runtime and the protocol adapters", () => {
    const violations: string[] = [];
    for (const [file, source] of sources) {
      const name = moduleName(file);
      if (
        name.startsWith("llm/") ||
        ["agent/agent-runtime.ts", "agent/model-port.ts"].includes(name)
      )
        continue;
      const executable = transpiler.transformSync(source);
      // Gateway/model/vision are the inference seams; domain repositories also have complete().
      if (
        /\b(?:gateway|vision|model)(?:\?\.|\.)\s*(?:complete|streamChat|annotate)\s*(?:\?\.)?\s*\(/.test(
          executable,
        )
      )
        violations.push(name);
    }
    expect(violations).toEqual([]);
  });

  it("keeps leaf consumers from importing conversation assembly through helpers", () => {
    const entries = files.filter((file) => {
      const name = moduleName(file);
      return (
        name.startsWith("modules/") ||
        ["services/memory-service.ts", "services/knowledge-organizer.ts"].includes(name)
      );
    });
    const violations: string[] = [];
    for (const entry of entries) {
      const visited = new Set<string>();
      const pending = [entry];
      while (pending.length) {
        const file = pending.pop();
        if (!file || visited.has(file)) continue;
        visited.add(file);
        const name = moduleName(file);
        // Runtime is the allowed leaf execution boundary; its main loop separately owns context.
        if (name === "agent/agent-runtime.ts") continue;
        if (
          name.startsWith("channels/") ||
          [
            "agent/context-engine.ts",
            "agent/conversation-context.ts",
            "agent/conversation-host.ts",
            "services/context-builder.ts",
          ].includes(name)
        ) {
          violations.push(moduleName(entry) + " -> " + name);
          continue;
        }
        const source = sources.get(file);
        if (source) pending.push(...valueImports(file, source));
      }
    }
    expect(violations).toEqual([]);
  });
});
