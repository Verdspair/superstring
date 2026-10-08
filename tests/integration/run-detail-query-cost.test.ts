import type { Database, SQLQueryBindings } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";

const RUN_COUNT = 100;
const HISTORY_EVENTS_PER_RUN = 100;
const COMPLETION_EVENTS_PER_RUN = 4;
const EVENTS_PER_RUN = HISTORY_EVENTS_PER_RUN + COMPLETION_EVENTS_PER_RUN;
const OWNER = { kind: "conversation", id: "synthetic-conversation", userId: DEFAULT_USER_ID };
const AT = "2026-10-08T05:00:00.000Z";

type QueryCost = {
  statements: string[];
  eventStatements: number;
  returnedEventRows: number;
  returnedAggregateRows: number;
  returnedPayloadBytes: number;
};
type EventRow = { payload?: string };
type AllRows = { all: (...args: SQLQueryBindings[]) => unknown[] };

let business: ReturnType<typeof openBusinessDb>;
let repository: AgentRunRepository;
let runIds: [string, ...string[]];

beforeAll(() => {
  business = openBusinessDb();
  ensureDefaults(business.orm, "fixture-model");
  repository = new AgentRunRepository(business.db);
  runIds = seedRuns(business.db, repository);
});

afterAll(() => business.close());

function seedRuns(db: Database, runs: AgentRunRepository): [string, ...string[]] {
  const ids: [string, ...string[]] = ["run-detail-000"];
  for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
    const runId = `run-detail-${String(runIndex).padStart(3, "0")}`;
    if (runIndex > 0) ids.push(runId);
    runs.createRun({
      runId,
      specId: "fixture-spec",
      specVersion: "1",
      owner: OWNER,
      at: AT,
    });
    db.query(`UPDATE agent_runs SET status='completed',ended_at=? WHERE run_id=?`).run(AT, runId);
    for (let stepNo = 1; stepNo <= 2; stepNo += 1) {
      db.query(
        `INSERT INTO agent_steps(step_id,run_id,step_no,model,phase,status,started_at,ended_at)
        VALUES(?,?,?,?,?,'completed',?,?)`,
      ).run(`${runId}-step-${stepNo}`, runId, stepNo, "fixture-model", "leaf", AT, AT);
    }
    for (let seq = 1; seq <= HISTORY_EVENTS_PER_RUN; seq += 1) {
      const payload = {
        runId,
        seq,
        at: AT,
        type: "action_result",
        name: "fixture.action",
        observationId: `${runId}-observation-${String(seq).padStart(3, "0")}-${"x".repeat(96)}`,
      };
      db.query("INSERT INTO run_events(run_id,seq,type,at,payload) VALUES(?,?,?,?,?)").run(
        runId,
        seq,
        "action_result",
        AT,
        JSON.stringify(payload),
      );
    }
    for (let completion = 1; completion <= COMPLETION_EVENTS_PER_RUN; completion += 1) {
      const seq = HISTORY_EVENTS_PER_RUN + completion;
      const payload = {
        runId,
        seq,
        at: AT,
        type: "completed",
        outputs: [
          {
            outputId: `${runId}-output-${completion}`,
            targetId: `target-${completion}`,
            status: "prepared",
          },
        ],
      };
      db.query("INSERT INTO run_events(run_id,seq,type,at,payload) VALUES(?,?,?,?,?)").run(
        runId,
        seq,
        "completed",
        AT,
        JSON.stringify(payload),
      );
    }
  }
  return ids;
}

function measureQueries<T>(db: Database, action: (cost: QueryCost) => T): T {
  const cost: QueryCost = {
    statements: [],
    eventStatements: 0,
    returnedEventRows: 0,
    returnedAggregateRows: 0,
    returnedPayloadBytes: 0,
  };
  const original = db.query.bind(db);
  db.query = ((sql: string) => {
    const statement = original(sql);
    const normalized = sql.replace(/\s+/g, " ").trim();
    cost.statements.push(normalized);
    if (/\bFROM run_events\b/i.test(sql)) {
      cost.eventStatements += 1;
      const rowsStatement = statement as unknown as AllRows;
      const all = rowsStatement.all.bind(statement);
      rowsStatement.all = (...bindings) => {
        const rows = all(...bindings) as EventRow[];
        for (const row of rows) {
          if (row.payload === undefined) {
            cost.returnedAggregateRows += 1;
          } else {
            cost.returnedEventRows += 1;
            cost.returnedPayloadBytes += Buffer.byteLength(row.payload);
          }
        }
        return rows;
      };
    }
    return statement;
  }) as typeof db.query;
  try {
    return action(cost);
  } finally {
    db.query = original;
  }
}

function expectFixtureSnapshot(snapshot: RunSnapshot, runId: string) {
  expect(snapshot).toEqual({
    runId,
    specId: "fixture-spec",
    specVersion: "1",
    owner: OWNER,
    status: "completed",
    startedAt: AT,
    endedAt: AT,
    errorCode: null,
    steps: [
      {
        stepId: `${runId}-step-1`,
        runId,
        stepNo: 1,
        model: "fixture-model",
        phase: "leaf",
        status: "completed",
        context: { runId, stepId: `${runId}-step-1` },
        startedAt: AT,
        endedAt: AT,
        errorCode: null,
      },
      {
        stepId: `${runId}-step-2`,
        runId,
        stepNo: 2,
        model: "fixture-model",
        phase: "leaf",
        status: "completed",
        context: { runId, stepId: `${runId}-step-2` },
        startedAt: AT,
        endedAt: AT,
        errorCode: null,
      },
    ],
    lastSeq: EVENTS_PER_RUN,
    outputs: Array.from({ length: COMPLETION_EVENTS_PER_RUN }, (_, index) => ({
      outputId: `${runId}-output-${index + 1}`,
      targetId: `target-${index + 1}`,
      status: "prepared",
    })),
  });
}

describe("run detail query cost", () => {
  it("keeps getRun's typed snapshot while loading only completion payloads", () => {
    const snapshot = measureQueries(business.db, (cost) => {
      const result = repository.getRun(runIds[0]);
      const measured = { ...cost };
      expectFixtureSnapshot(result as RunSnapshot, runIds[0]);
      expect(measured.statements).toHaveLength(4);
      expect(measured.eventStatements).toBe(2);
      expect(measured.returnedEventRows).toBe(COMPLETION_EVENTS_PER_RUN);
      expect(measured.returnedAggregateRows).toBe(1);
      expect(
        measured.statements.some((sql) => /WHERE type='completed' AND run_id IN/i.test(sql)),
      ).toBe(true);
      expect(measured.returnedPayloadBytes).toBeGreaterThan(0);
      return result;
    });
    expect(snapshot).not.toBeNull();
  });

  it("records synthetic listRuns wall-time median without timing assertions", () => {
    repository.listRuns({ ownerKind: OWNER.kind, ownerId: OWNER.id });
    const durations: number[] = [];
    for (let sample = 0; sample < 9; sample += 1) {
      const started = performance.now();
      repository.listRuns({ ownerKind: OWNER.kind, ownerId: OWNER.id });
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    console.log(
      `RUN_DETAIL_BENCHMARK ${JSON.stringify({ fixture: `${RUN_COUNT}x${EVENTS_PER_RUN}`, samples: durations.length, medianMs: durations[4] })}`,
    );
  });

  it("keeps listRuns filtering, order, 100-run limit and snapshots with batched reads", () => {
    const snapshots = measureQueries(business.db, (cost) => {
      const result = repository.listRuns({ ownerKind: OWNER.kind, ownerId: OWNER.id });
      const measured = { ...cost };
      expect(result).toHaveLength(RUN_COUNT);
      const firstRunId = runIds[0];
      const lastRunId = runIds[RUN_COUNT - 1];
      expect(result[0].runId).toBe(lastRunId);
      expect(result.at(-1)?.runId).toBe(firstRunId);
      expectFixtureSnapshot(result[0], lastRunId);
      expectFixtureSnapshot(result.at(-1) as RunSnapshot, firstRunId);
      expect(measured.statements).toHaveLength(4);
      expect(measured.eventStatements).toBe(2);
      expect(measured.returnedEventRows).toBe(RUN_COUNT * COMPLETION_EVENTS_PER_RUN);
      expect(measured.returnedAggregateRows).toBe(RUN_COUNT);
      expect(
        measured.statements.some((sql) => /WHERE type='completed' AND run_id IN/i.test(sql)),
      ).toBe(true);
      expect(measured.returnedPayloadBytes).toBeGreaterThan(0);
      return result;
    });
    expect(snapshots).toHaveLength(RUN_COUNT);
  });
});
