// Defensive-read-work contract: same-synchronous-pass duplicate proofs.
// D1/D4 count calls in-process (counting guard / counting prepare). D2 scan counting is a
// separate native probe so this suite never mocks node:fs or pollutes the module registry.

import { afterEach, describe, expect, it } from "bun:test";
import * as realFs from "node:fs";
import path from "node:path";
import { ActionExecutor, type ActionGuard } from "../../src/server/agent/action-executor";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import {
  insertQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { PermissionService } from "../../src/server/permissions/service";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { createSkillActions } from "../../src/server/skills/actions";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";
import type { QqGroupCapability } from "../../src/shared/contracts/qq-group-config";

type BusinessHandle = ReturnType<typeof openBusinessDb>;

const handles: BusinessHandle[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const directory of directories.splice(0))
    realFs.rmSync(directory, { recursive: true, force: true });
});

function groupSetup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const scheme = createQqScheme(h.orm, { name: "defensive-read-work" });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, created.binding);
  const owner: RunOwner = { kind: "qq_binding", id: binding.id, agentId: DEFAULT_AGENT_ID };
  const guard = new QqGroupCapabilityGuard(h.orm);
  return { h, binding, owner, guard };
}

function writeCaps(
  h: BusinessHandle,
  bindingId: string,
  disabled: readonly QqGroupCapability[],
  expectedRevision: number,
) {
  writeQqGroupAgentConfigRow(h.orm, {
    bindingId,
    agentId: DEFAULT_AGENT_ID,
    overrides: {},
    disabledCapabilities: disabled,
    expectedRevision,
  });
}

/** Shadow the connection's prepare() so per-statement counts are visible to the test only. */
function countingDb(h: BusinessHandle) {
  const counts = new Map<string, number>();
  const original = h.db.prepare.bind(h.db);
  (h.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return original(sql);
  };
  return {
    reset: () => counts.clear(),
    tableReads: (table: string) => {
      let total = 0;
      for (const [sql, count] of counts) if (sql.includes(`"${table}"`)) total += count;
      return total;
    },
    restore: () => {
      delete (h.db as unknown as { prepare?: unknown }).prepare;
    },
  };
}

function countingGuard(real: QqGroupCapabilityGuard) {
  const counts = { assertAction: 0, actionSources: 0, assertSources: 0 };
  const guard: ActionGuard = {
    assert: (owner, capability) => real.assert(owner, capability),
    allowed: (owner, capability) => real.allowed(owner, capability),
    sources: (owner, capability) => real.sources(owner, capability),
    actionAllowed: (action, owner) => real.actionAllowed(action, owner),
    assertAction: (action, owner, options) => {
      counts.assertAction += 1;
      real.assertAction(action, owner, options);
    },
    actionSources: (action, owner) => {
      counts.actionSources += 1;
      return real.actionSources(action, owner);
    },
    assertSources: (owner, sources) => {
      counts.assertSources += 1;
      real.assertSources(owner, sources);
    },
  };
  return { guard, counts };
}

function webAction(overrides: Partial<BuiltInAction> = {}): BuiltInAction {
  return {
    permission: { resource: "web.search", revision: "v1", approvalRequired: false },
    description: {
      name: "web.search",
      capability: "web",
      description: "search",
      parameters: {},
      effect: "read",
    },
    async execute() {
      return { value: { status: "ok" }, sources: [] };
    },
    ...overrides,
  };
}

function permissionsFor(actions: readonly BuiltInAction[]): PermissionService {
  let policy: PermissionPolicy = {
    version: 1,
    grants: actions.map((action) => ({
      resource: action.description.name,
      revision: "v1",
      approved: false,
      directories: [],
    })),
  };
  return new PermissionService({
    read: () => ({ revision: "test", policy }),
    replace: (_expected, next) => {
      policy = next;
      return { revision: "test", policy };
    },
  });
}

const context = (owner: RunOwner): ActionContext => ({
  owner,
  signal: new AbortController().signal,
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe("D1 action executor: one group check per assert boundary", () => {
  it("runs the group check once per synchronous assert, not on both sides", async () => {
    const { owner, guard: realGuard } = groupSetup();
    const { guard, counts } = countingGuard(realGuard);
    const action = webAction();
    const executor = new ActionExecutor(permissionsFor([action]), () => 3, guard);
    await executor.execute(action, {}, context(owner));
    // One assert before the action and one after it; each must check the group exactly once.
    expect(counts.assertAction).toBe(2);
    expect(counts.actionSources).toBe(1);
    expect(counts.assertSources).toBe(1);
  });

  it("keeps group-first failure and permission-denied codes", async () => {
    const { h, binding, owner, guard: realGuard } = groupSetup();
    writeCaps(h, binding.id, ["web"], 0);
    const denied = webAction({
      permission: { resource: "web.search", revision: "v1", approvalRequired: false },
    });
    const closed = new PermissionService({
      read: () => ({ revision: "x", policy: { version: 1, grants: [] } }),
      replace() {
        throw new Error("unavailable");
      },
    });
    const groupFirst = new ActionExecutor(closed, () => 3, realGuard);
    expect(await asyncCodeOf(() => groupFirst.execute(denied, {}, context(owner)))).toBe(
      "QQ_GROUP_CAPABILITY_DISABLED",
    );

    writeCaps(h, binding.id, [], 1);
    const permissionFirst = new ActionExecutor(closed, () => 3, realGuard);
    expect(await asyncCodeOf(() => permissionFirst.execute(denied, {}, context(owner)))).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("keeps off->on during flight from reviving the result", async () => {
    const { h, binding, owner, guard: realGuard } = groupSetup();
    const gate = deferred();
    const action = webAction({
      async execute() {
        await gate.gate;
        return { value: { status: "ok" }, sources: [] };
      },
    });
    const executor = new ActionExecutor(permissionsFor([action]), () => 3, realGuard);
    const pending = executor.execute(action, {}, context(owner));
    writeCaps(h, binding.id, ["web"], 0);
    writeCaps(h, binding.id, [], 1);
    gate.release();
    expect(await asyncCodeOf(() => pending)).toBe("QQ_GROUP_CAPABILITY_DISABLED");
  });

  it("keeps the post-fitResult recheck live", async () => {
    const { h, binding, owner, guard: realGuard } = groupSetup();
    const action = webAction({
      async fitResult(value) {
        writeCaps(h, binding.id, ["web"], 0);
        writeCaps(h, binding.id, [], 1);
        return value;
      },
    });
    const executor = new ActionExecutor(permissionsFor([action]), () => 3, realGuard);
    expect(await asyncCodeOf(() => executor.execute(action, {}, context(owner)))).toBe(
      "QQ_GROUP_CAPABILITY_DISABLED",
    );
  });
});

describe("D4 capability guard: one config read per synchronous call", () => {
  it("reads the group config once in sources() and once in assertLeaf()", () => {
    const { h, binding, owner, guard } = groupSetup();
    writeCaps(h, binding.id, ["web"], 0);
    const counter = countingDb(h);
    try {
      counter.reset();
      const refs = guard.sources(owner, "media");
      expect(counter.tableReads("qq_group_agent_configs")).toBe(1);
      expect(refs).toHaveLength(1);
      expect(refs[0]?.revision).toBe("0");

      counter.reset();
      const freeze = guard.assertLeaf(owner, "memory.consolidate");
      expect(counter.tableReads("qq_group_agent_configs")).toBe(1);
      expect(counter.tableReads("qq_bindings")).toBe(1);
      expect(typeof freeze).toBe("function");
    } finally {
      counter.restore();
    }
  });

  it("keeps the frozen epoch closure and its fresh per-call verdicts", () => {
    const { h, binding, owner, guard } = groupSetup();
    writeCaps(h, binding.id, ["web"], 0);
    const freeze = guard.assertLeaf(owner, "memory.consolidate");
    if (typeof freeze !== "function") throw new Error("expected a freeze closure");
    writeCaps(h, binding.id, ["web", "memory_organize"], 1);
    expect(codeOf(freeze)).toBe("QQ_GROUP_CAPABILITY_DISABLED");
    // A fresh assertLeaf reads the current record again: re-enabling is a new epoch, not a revive.
    writeCaps(h, binding.id, ["web"], 2);
    const again = guard.assertLeaf(owner, "memory.consolidate");
    if (typeof again !== "function") throw new Error("expected a freeze closure");
    expect(codeOf(again)).toBeUndefined();
    expect(codeOf(freeze)).toBe("QQ_GROUP_CAPABILITY_DISABLED");
  });

  it("keeps the defaults for a group without a config record", () => {
    const { owner, guard } = groupSetup();
    const refs = guard.sources(owner, "web");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.revision).toBe("0");
    expect(guard.sources({ kind: "conversation", id: "missing" }, "web")).toEqual([]);
  });
});

function baseDirectory(): string {
  const fixtureRoot = path.resolve(
    import.meta.dir,
    "../../artifacts/validation/defensive-read-work",
  );
  realFs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = realFs.mkdtempSync(path.join(fixtureRoot, "case-"));
  directories.push(directory);
  return directory;
}

function install(root: string, folder: string, body = "body"): string {
  const directory = path.join(root, folder);
  realFs.mkdirSync(directory, { recursive: true });
  realFs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${JSON.stringify(folder)}\ndescription: ${JSON.stringify("synthetic")}\n---\n${body}`,
  );
  return directory;
}

describe("D2 skill catalog: parity only (scan counting is a native probe)", () => {
  it("keeps the catalog output identical across repeated executes", async () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    install(root, "alpha");
    install(root, "beta");
    const actions = createSkillActions(root);
    const catalogAction = actions.find((action) => action.description.name === "skill.catalog");
    if (!catalogAction) throw new Error("missing skill.catalog");
    const ctx = context({ kind: "conversation", id: crypto.randomUUID() } as RunOwner);
    const first = await catalogAction.execute({}, ctx);
    const second = await catalogAction.execute({}, ctx);
    expect(second.value).toEqual(first.value);
    expect(second.sources).toEqual(first.sources);
  });

  it("keeps standalone assertAvailable and revision detection", async () => {
    const base = baseDirectory();
    const root = path.join(base, "skills");
    const demo = install(root, "demo");
    const actions = createSkillActions(root);
    const byName = new Map(actions.map((action) => [action.description.name, action]));
    const catalogAction = byName.get("skill.catalog");
    const readAction = byName.get("skill.read");
    if (!catalogAction || !readAction) throw new Error("missing skill actions");
    const ctx = context({ kind: "conversation", id: crypto.randomUUID() } as RunOwner);
    await catalogAction.execute({}, ctx);
    await readAction.execute({ name: "demo" }, ctx);
    const document = realFs.readFileSync(path.join(demo, "SKILL.md"), "utf8");
    realFs.writeFileSync(path.join(demo, "SKILL.md"), `${document}edited`);
    expect(codeOf(() => catalogAction.assertAvailable?.())).toBe("PERMISSION_REVISION_CHANGED");
    expect(await asyncCodeOf(() => readAction.execute({ name: "demo" }, ctx))).toBe(
      "PERMISSION_REVISION_CHANGED",
    );
  });
});
