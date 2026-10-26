// External-tool result admission against the context budget: MCP-like and
// skill-like actions enter the runtime through the channel's real action chain
// (OneBotHost externalActions -> ActionExecutor -> observations -> next model
// request). No real MCP server, no network, no real model. The budget owner
// stays untouched: these cases pin the admission contract, they re-implement
// no fitter. Established semantics being reused: subtask fitReadResult
// (agent-runtime); QQ's actionResultFitter wrap for WEB_PERMISSION_RESOURCE
// reads (bot-host, joint per-batch reservation, legal history yield,
// {status:"unavailable", code:"CONTEXT_BUDGET_EXCEEDED"} refusal); unwrapped
// external actions currently reach the next model request as-is.

import { afterEach, describe, expect, it } from "bun:test";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

/** Harness default capacity in byte units (documented on OneBotHarnessOptions.capacity). */
const CAPACITY = 65536;
/** Unique sentinels inside a synthetic oversized payload; absence proves the body is not silently truncated. */
const HEAD = "external-tool-head-marker";
const TAIL = "external-tool-tail-marker";

function oversizedBody(): string {
  return `${HEAD}${"a".repeat(120_000)}${TAIL}`;
}

/** Each individually fits the default window; both together exceed it. */
function halfWindowBody(): string {
  return `${HEAD}${"b".repeat(35_000)}${TAIL}`;
}

function externalAction(input: {
  name: string;
  effect: "read" | "write";
  value: unknown;
  executed: string[];
}): BuiltInAction {
  return {
    description: {
      name: input.name,
      description: "synthetic external tool for result admission coverage",
      parameters: { type: "object", properties: {} },
      capability: "external.test",
      effect: input.effect,
    },
    execute: async () => {
      input.executed.push(input.name);
      return { value: input.value, sources: [] };
    },
  };
}

function invoke(...calls: readonly { name: string }[]): string {
  return JSON.stringify({
    kind: "invoke",
    calls: calls.map((call) => ({ ...call, arguments: {} })),
  });
}

function twoRoundModel(round1: readonly { name: string }[]): {
  seen: ModelRequest[];
  complete: (request: ModelRequest) => Promise<string>;
} {
  const seen: ModelRequest[] = [];
  let round = 0;
  return {
    seen,
    complete: async (request) => {
      seen.push(request);
      round += 1;
      if (round === 1) return invoke(...round1);
      return JSON.stringify({ kind: "none" });
    },
  };
}

function textOf(request: ModelRequest): string {
  return request.messages
    .map((message) =>
      message.content.map((part) => (part.kind === "text" ? part.text : "")).join("\n"),
    )
    .join("\n");
}

function observationsOf(request: ModelRequest): readonly { name: string; value: unknown }[] {
  const found: { name: string; value: unknown }[] = [];
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text) as {
          kind?: string;
          value?: { name?: string; value?: unknown };
        };
        if (data.kind === "action_observation" && typeof data.value?.name === "string")
          found.push({ name: data.value.name, value: data.value.value });
      } catch {}
    }
  }
  return found;
}

function statusOf(value: unknown): string | undefined {
  return (value as { status?: string } | null | undefined)?.status;
}

async function activateSettled(
  h: ReturnType<typeof createOneBotHarness>,
): Promise<{ ok: true; status: string } | { ok: false; error: unknown }> {
  return h.activate("direct_reply").then(
    (value) => ({ ok: true as const, status: (value as { status?: string } | null)?.status ?? "" }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe("external tool results are admitted against the context budget before the next model request", () => {
  it("keeps a normal external read result when it fits", async () => {
    const executed: string[] = [];
    const action = externalAction({
      name: "mcp.notes_read",
      effect: "read",
      value: { note: `${HEAD} small payload ${TAIL}` },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.notes_read" }]);
    const h = createOneBotHarness({ externalActions: () => [action], model });
    h.receive({ id: "81001", text: "hello", addressed: true });
    h.advance(2);
    const settled = await activateSettled(h);

    expect(executed).toEqual(["mcp.notes_read"]);
    expect(settled).toMatchObject({ ok: true, status: "no_output" });
    expect(model.seen).toHaveLength(2);
    const body = textOf(model.seen[1]!);
    expect(body).toContain(HEAD);
    expect(body).toContain(TAIL);
    expect(observationsOf(model.seen[1]!).some((entry) => entry.name === "mcp.notes_read")).toBe(
      true,
    );
  });

  it("admits a single large-but-fitting external read payload in the same window", async () => {
    const executed: string[] = [];
    const action = externalAction({
      name: "mcp.read_single",
      effect: "read",
      value: { report: halfWindowBody() },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.read_single" }]);
    const h = createOneBotHarness({ externalActions: () => [action], model });
    h.receive({ id: "81005", text: "hello", addressed: true });
    h.advance(2);
    const settled = await activateSettled(h);

    // Measured admission, not a capacity estimate: the same window the joint
    // case exceeds really admits this payload whole through the real chain.
    expect(executed).toEqual(["mcp.read_single"]);
    expect(settled).toMatchObject({ ok: true, status: "no_output" });
    expect(model.seen).toHaveLength(2);
    const body = textOf(model.seen[1]!);
    expect(body).toContain(HEAD);
    expect(body).toContain(TAIL);
    expect(inputUnits(model.seen[1]!.messages)).toBeLessThan(CAPACITY);
  });

  it("turns an oversized external read into a bounded refusal before the next model request", async () => {
    const executed: string[] = [];
    const action = externalAction({
      name: "mcp.read_big",
      effect: "read",
      value: { report: oversizedBody() },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.read_big" }]);
    const h = createOneBotHarness({ externalActions: () => [action], model });
    h.receive({ id: "81002", text: "hello", addressed: true });
    h.advance(2);
    const settled = await activateSettled(h);

    // The action really executed exactly once; the run still settles and the
    // next request carries a bounded refusal, never the oversized body.
    expect(executed).toEqual(["mcp.read_big"]);
    expect(settled).toMatchObject({ ok: true, status: "no_output" });
    expect(model.seen).toHaveLength(2);
    const body = textOf(model.seen[1]!);
    expect(body).not.toContain(HEAD);
    expect(body).not.toContain(TAIL);
    const observation = observationsOf(model.seen[1]!).find(
      (entry) => entry.name === "mcp.read_big",
    );
    expect(observation).toBeDefined();
    expect(observation?.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
  });

  it("lets old history yield so a fitting external read result is still returned", async () => {
    const executed: string[] = [];
    const action = externalAction({
      name: "mcp.read_yield",
      effect: "read",
      value: { report: halfWindowBody() },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.read_yield" }]);
    const h = createOneBotHarness({ externalActions: () => [action], model });
    // ~32k units of older history + the result exceed the window: whole-result
    // admission is only possible through legal history yield by the owner.
    for (let index = 0; index < 4; index += 1) {
      h.receive({
        id: String(81020 + index),
        text: `history-yield-marker-${index} ${"c".repeat(8000)}`,
      });
      h.advance(1);
    }
    h.receive({ id: "81024", text: "hello", addressed: true });
    h.advance(2);
    const settled = await activateSettled(h);

    expect(executed).toEqual(["mcp.read_yield"]);
    expect(settled).toMatchObject({ ok: true, status: "no_output" });
    expect(model.seen).toHaveLength(2);
    const body = textOf(model.seen[1]!);
    expect(body).toContain(HEAD);
    expect(body).toContain(TAIL);
    // Measured yield: at least one whole older history message left the window.
    const surviving = [0, 1, 2, 3].filter((index) =>
      body.includes(`history-yield-marker-${index}`),
    );
    expect(surviving.length).toBeLessThan(4);
    expect(inputUnits(model.seen[1]!.messages)).toBeLessThan(CAPACITY);
  });

  it("admits a read batch by joint reservation, not per-result in isolation", async () => {
    const executed: string[] = [];
    const first = externalAction({
      name: "mcp.read_left",
      effect: "read",
      value: { report: halfWindowBody() },
      executed,
    });
    const second = externalAction({
      name: "mcp.read_right",
      effect: "read",
      value: { report: halfWindowBody() },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.read_left" }, { name: "mcp.read_right" }]);
    const h = createOneBotHarness({ externalActions: () => [first, second], model });
    h.receive({ id: "81003", text: "hello", addressed: true });
    h.advance(2);
    const settled = await activateSettled(h);

    expect(executed).toEqual(["mcp.read_left", "mcp.read_right"]);
    expect(settled).toMatchObject({ ok: true, status: "no_output" });
    expect(model.seen).toHaveLength(2);
    // Each result alone fits; jointly they must not: exactly one full payload
    // admitted (either order), the other carries the established refusal.
    const payloadOf = (name: string) =>
      JSON.stringify(observationsOf(model.seen[1]!).find((entry) => entry.name === name)?.value) ??
      "";
    const leftFull = payloadOf("mcp.read_left").includes(HEAD);
    const rightFull = payloadOf("mcp.read_right").includes(HEAD);
    expect(leftFull !== rightFull).toBe(true);
    const statuses = observationsOf(model.seen[1]!)
      .filter((entry) => entry.name === "mcp.read_left" || entry.name === "mcp.read_right")
      .map((entry) => statusOf(entry.value));
    expect(statuses).toContain("unavailable");
    expect(inputUnits(model.seen[1]!.messages)).toBeLessThan(CAPACITY);
  });

  it("executes a generic permission-less external write once and keeps run metadata when the run fails", async () => {
    // Real permitted MCP writes enqueue via AgentTaskService (taskId/status
    // receipt); this no-permission write is an extension-shape candidate, not
    // an MCP production bug. The oversized direct result fails the run today
    // (evidence kept): pinned = one execution, no replay on failure, runtime
    // run metadata queryable. No bounded receipt contract is defined here.
    const executed: string[] = [];
    const action = externalAction({
      name: "mcp.write_once",
      effect: "write",
      value: { receipt: "write-receipt-marker", report: oversizedBody() },
      executed,
    });
    const model = twoRoundModel([{ name: "mcp.write_once" }]);
    const h = createOneBotHarness({ externalActions: () => [action], model });
    h.receive({ id: "81004", text: "hello", addressed: true });
    h.advance(2);
    await activateSettled(h);

    expect(executed).toEqual(["mcp.write_once"]);
    const runs = h.db.query("SELECT status FROM agent_runs").all() as { status: string }[];
    expect(runs.length).toBeGreaterThan(0);
  });
});
