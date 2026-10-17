import { afterEach, describe, expect, it } from "bun:test";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const now = "2030-01-01T00:00:00.000Z";
function fixture() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  const repo = new AgentRunRepository(h.db);
  const seed = (id: string, userId: string | undefined = DEFAULT_USER_ID) => {
    repo.createRun({
      runId: id,
      specId: "test",
      specVersion: "1",
      owner: {
        kind: "fixture",
        id,
        ...(userId === undefined ? {} : { userId }),
        agentId: DEFAULT_AGENT_ID,
      },
      at: now,
    });
    repo.startStep({
      runId: id,
      stepId: id,
      stepNo: 1,
      model: "synthetic",
      phase: "next",
      at: now,
      messages: [{ role: "user", content: [{ kind: "text", text: "body" }] }],
      sources: [],
    });
  };
  return { h, repo, seed };
}
describe("context storage covering read", () => {
  it("preserves exact counts, principal scope and automatic index maintenance", () => {
    const { h, repo, seed } = fixture();
    seed("live");
    seed("expired");
    seed("revoked");
    seed("foreign", "other-user");
    h.db.query("UPDATE context_snapshots SET expires_at=? WHERE step_id='expired'").run(now);
    repo.redactContext({ runId: "revoked", stepId: "revoked" }, "revoked");
    expect(repo.contextStorageCounts(now)).toEqual({
      live: 1,
      expired: 1,
      revoked: 1,
      withProtectedBody: 2,
      expiredProtectedBodies: 1,
    });
    expect(repo.contextStorageCounts(now, "other-user")).toEqual({
      live: 1,
      expired: 0,
      revoked: 0,
      withProtectedBody: 1,
      expiredProtectedBodies: 0,
    });
    h.db.query("UPDATE context_snapshots SET protected_messages=NULL WHERE step_id='live'").run();
    expect(repo.contextStorageCounts(now).withProtectedBody).toBe(1);
    h.db.query("UPDATE context_snapshots SET protected_output='null' WHERE step_id='live'").run();
    expect(repo.contextStorageCounts(now).withProtectedBody).toBe(2);
    h.db
      .query(
        "UPDATE context_snapshots SET protected_output=NULL,status='expired' WHERE step_id='live'",
      )
      .run();
    expect(repo.contextStorageCounts(now)).toEqual({
      live: 0,
      expired: 1,
      revoked: 1,
      withProtectedBody: 1,
      expiredProtectedBodies: 1,
    });
    h.db.query("DELETE FROM agent_runs WHERE run_id='expired'").run();
    expect(repo.contextStorageCounts(now)).toEqual({
      live: 0,
      expired: 0,
      revoked: 1,
      withProtectedBody: 0,
      expiredProtectedBodies: 0,
    });
    seed("unscoped");
    h.db.query("UPDATE agent_runs SET user_id=NULL WHERE run_id='unscoped'").run();
    expect(repo.contextStorageCounts(now).live).toBe(1);
    expect(repo.contextStorageCounts(now, "other-user").live).toBe(2);
  });
  it("executes its actual aggregate through the covering metadata index without table columns", () => {
    const { h, repo, seed } = fixture();
    seed("plan");
    const query = h.db.query.bind(h.db);
    let executedSql = "";
    let args: unknown[] = [];
    h.db.query = ((sql: string) => {
      const st = query(sql);
      return new Proxy(st, {
        get(t, k) {
          const value = Reflect.get(t, k);
          if (k === "get" && sql.includes("AS withProtectedBody"))
            return (...a: unknown[]) => {
              executedSql = sql;
              args = a;
              return value.apply(t, a);
            };
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    }) as typeof h.db.query;
    repo.contextStorageCounts(now);
    h.db.query = query;
    const plan = query(`EXPLAIN QUERY PLAN ${executedSql}`).all(...(args as string[])) as {
      detail: string;
    }[];
    expect(
      plan.some((p) =>
        p.detail.includes("USING COVERING INDEX ix_context_snapshot_storage_metadata"),
      ),
    ).toBe(true);
    const code = query(`EXPLAIN ${executedSql}`).all(...(args as string[])) as {
      opcode: string;
      p1: number;
      p2: number;
    }[];
    const root = (
      query(
        "SELECT rootpage FROM sqlite_master WHERE type='table' AND name='context_snapshots'",
      ).get() as { rootpage: number }
    ).rootpage;
    const contextCursor = code
      .filter((x) => x.opcode === "OpenRead" && x.p2 === root)
      .map((x) => x.p1);
    expect(code.filter((x) => x.opcode === "Column" && contextCursor.includes(x.p1))).toEqual([]);
  });
});
