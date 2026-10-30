import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { PermissionService } from "../../src/server/permissions/service";
import {
  createWebActions,
  WEB_PERMISSION_RESOURCE,
  WEB_PERMISSION_REVISION,
} from "../../src/server/web-access/actions";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

afterEach(closeHarnesses);

/**
 * Retained original failure evidence and context budget calibration:
 * - Evidence raw: MIXED-SCALAR-FIRST-30308.raw.bin (PID 30308, exit 1)
 * - Estimated limit L = 60313 (context-engine UTF-8 units)
 * - Baseline with media.list = 58476
 * - Minimum second web denial + sibling reads (790) + envelope floor (181) + allowance (512) = 60501
 * - Exceeds limit by 188 units at pre-write; full page alone (71388) far exceeds L.
 * - 14k verified positive: first 55370, last 58138, settles normally.
 * - 15k estimated budget refusal: first 57370, honest CONTEXT_BUDGET_EXCEEDED fatal before media WRITE.
 *   (Note: based on current estimated budget calculation under UTF-8 unit boundary, not physical provider proof.)
 */
interface NearCapacityScenario {
  readonly label: string;
  readonly questionChars: number;
  readonly expectation: "settle_success" | "estimated_budget_refusal";
}

const NEAR_CAPACITY_SCENARIOS: readonly NearCapacityScenario[] = [
  {
    label:
      "14k verified positive: exact 4 actions fit within budget (55370 -> 58138 units) and settle normally",
    questionChars: 14_000,
    expectation: "settle_success",
  },
  {
    label:
      "15k estimated budget refusal: current estimated budget cannot fit limit 60313, honest CONTEXT_BUDGET_EXCEEDED fatal before media write",
    questionChars: 15_000,
    expectation: "estimated_budget_refusal",
  },
];

function createWebPermissions(): PermissionService {
  return new PermissionService({
    read: () => ({
      revision: "web-grant-test",
      policy: {
        version: 1,
        grants: [
          {
            resource: WEB_PERMISSION_RESOURCE,
            approved: true,
            revision: WEB_PERMISSION_REVISION,
            directories: [],
          },
        ],
      },
    }),
    replace: () => {
      throw new Error("PERMISSION_POLICY_CONFLICT");
    },
  });
}

function createWebFixture(options: { readonly pageContent?: (url: string) => string } = {}) {
  const networkCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    networkCalls.push(url);
    const content = options.pageContent
      ? options.pageContent(url)
      : `<html><head><title>Page</title></head><body><article>Content for ${url}</article></body></html>`;
    return new Response(content, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;

  const permissions = createWebPermissions();
  const actions = createWebActions({
    fetchImpl,
    resolve: async () => ["93.184.216.34"],
  });

  return {
    networkCalls,
    permissions,
    externalActions: () => actions,
    actionExecutor: (_orm: unknown, guard: QqGroupCapabilityGuard) =>
      new ActionExecutor(permissions, undefined, guard),
    resolveSource: (
      source: Parameters<PermissionService["sourceAccess"]>[0],
      owner: Parameters<PermissionService["sourceAccess"]>[1],
    ) => permissions.sourceAccess(source, owner),
  };
}

function decisionFor(request: ModelRequest, decision: Record<string, unknown>): string {
  const schema = request.responseSchema;
  const properties = schema?.properties;
  const branches = (schema?.oneOf ?? []) as Record<string, unknown>[];
  const hasMedia =
    (properties !== null && typeof properties === "object" && "media" in properties) ||
    branches.some((branch) => {
      const fields = branch.properties;
      return fields !== null && typeof fields === "object" && "media" in fields;
    });
  return JSON.stringify(hasMedia ? { decision, media: [] } : decision);
}

function extractDisclosedMediaId(request: ModelRequest): string {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text) as {
          readonly kind?: string;
          readonly value?: {
            readonly name?: string;
            readonly value?: { readonly items?: ReadonlyArray<{ readonly id: string }> };
          };
        };
        if (data.kind === "action_observation" && data.value?.name === "media.list") {
          const id = data.value.value?.items?.[0]?.id;
          if (id) return id;
        }
      } catch {}
    }
  }
  throw new Error("No media id disclosed by media.list in model request messages");
}

function extractActionObservations(request: ModelRequest): Array<{
  readonly id: string;
  readonly name: string;
  readonly value: unknown;
  readonly sources: readonly {
    readonly kind: string;
    readonly id: string;
    readonly revision: string;
  }[];
}> {
  const observations: Array<{
    readonly id: string;
    readonly name: string;
    readonly value: unknown;
    readonly sources: readonly {
      readonly kind: string;
      readonly id: string;
      readonly revision: string;
    }[];
  }> = [];
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text) as {
          readonly kind?: string;
          readonly value?: {
            readonly id?: string;
            readonly name?: string;
            readonly value?: unknown;
            readonly sources?: readonly {
              readonly kind: string;
              readonly id: string;
              readonly revision: string;
            }[];
          };
        };
        if (
          data.kind === "action_observation" &&
          typeof data.value?.name === "string" &&
          typeof data.value.id === "string"
        ) {
          observations.push({
            id: data.value.id,
            name: data.value.name,
            value: data.value.value,
            sources: data.value.sources ?? [],
          });
        }
      } catch {}
    }
  }
  return observations;
}

function assertPositiveObservations(
  h: ReturnType<typeof createOneBotHarness>,
  web: ReturnType<typeof createWebFixture>,
  request: ModelRequest,
): void {
  if (!request.runId || !request.owner) throw new Error("Missing actual mixed-action run identity");
  const run = h.runs.getRun(request.runId);
  if (!run) throw new Error("Missing mixed-action run snapshot");
  expect(run.owner).toEqual(request.owner);
  expect(run.owner.kind).toBe("conversation");
  expect(run.owner.id).toBe(h.conversationId);
  const decisions = run.steps.filter((step) => step.phase === "next");
  expect(decisions).toHaveLength(3);
  const snapshot = h.runs.getContext(decisions[2]!.context);
  if (!snapshot) throw new Error("Missing final mixed-action decision context");
  expect(snapshot.status).toBe("exact");
  expect(snapshot.messages).toEqual([...request.messages]);

  const round2Obs = extractActionObservations(request).filter((o) => o.name !== "media.list");
  const names = round2Obs.map((o) => o.name).sort();
  expect(names).toEqual(["media.describe", "sticker.search", "web.fetch", "web.fetch"]);

  // media.describe observation guard
  const mediaObs = round2Obs.find((o) => o.name === "media.describe");
  expect(mediaObs).toBeDefined();

  // Tie the disclosed batch to this run's real action-result identities, not another run's refs.
  const observationIds = new Set(round2Obs.map((observation) => observation.id));
  const results = h.runs
    .listEvents(run.runId)
    .filter((event) => event.type === "action_result" && observationIds.has(event.observationId));
  expect(results.map((event) => (event.type === "action_result" ? event.name : "")).sort()).toEqual(
    names,
  );
  expect(results).toHaveLength(4);

  const webAction = web.externalActions().find((action) => action.description.name === "web.fetch");
  if (!webAction?.permission) throw new Error("Missing actual web.fetch permission requirement");
  const permission = web.permissions.source(webAction.permission, run.owner);
  expect(permission.id).toBe(WEB_PERMISSION_RESOURCE);
  expect(permission.revision).toMatch(/^[0-9a-f]{64}$/);
  const guard = new QqGroupCapabilityGuard(h.orm);
  const capabilities = guard.sources(run.owner, "web");
  expect(capabilities).toHaveLength(1);
  expect(JSON.parse(capabilities[0]!.id)).toEqual([h.bindingId, run.owner.agentId, "web"]);
  expect(capabilities[0]!.revision).toMatch(/^\d+$/);
  const retainedWebAuthority = snapshot.sources.filter(
    (source) =>
      (source.kind === "tool_permission" && source.id === permission.id) ||
      (source.kind === "qq_group_capability" && source.id === capabilities[0]!.id),
  );
  expect(retainedWebAuthority).toHaveLength(2);
  expect(retainedWebAuthority).toContainEqual(permission);
  expect(retainedWebAuthority).toContainEqual(capabilities[0]);
  expect(web.permissions.sourceAccess(permission, run.owner)).toBe("available");
  expect(guard.sourceAccess(capabilities[0]!, run.owner)).toBe("available");

  const webObsList = round2Obs.filter((o) => o.name === "web.fetch");
  expect(webObsList).toHaveLength(2);
  for (const webObs of webObsList) {
    expect(webObs.value).toBeDefined();
    expect(webObs.sources.some((source) => source.kind === "tool_permission")).toBe(false);
    expect(webObs.sources.some((source) => source.kind === "qq_group_capability")).toBe(false);
  }

  // sticker.search fixture guard: fixture returns status "disabled" with 0 refs (no approved collection).
  // Explicit contract: marked as disabled fixture, NOT claimed as true functional available positive.
  const stickerObs = round2Obs.find((o) => o.name === "sticker.search");
  expect(stickerObs).toBeDefined();
  const stickerVal = stickerObs?.value as
    | {
        readonly status?: string;
        readonly refs?: readonly unknown[];
      }
    | undefined;
  expect(stickerVal?.status).toBe("disabled");
  expect(stickerVal?.refs ?? []).toHaveLength(0);
}

describe("OneBot mixed four-action budget regression and low-load control", () => {
  it("low-load positive control: exact 4 actions (web.fetch x 2, media.describe write, sticker.search read) settle normally with 1 vision call and 1 task attempt", async () => {
    const web = createWebFixture();
    const seen: ModelRequest[] = [];
    let round = 0;

    const h = createOneBotHarness({
      kind: "group",
      vision: ["synthetic cat description"],
      stickersAvailable: true,
      externalActions: web.externalActions,
      actionExecutor: web.actionExecutor,
      resolveSource: web.resolveSource,
      model: {
        complete: async (request) => {
          seen.push(request);
          round += 1;
          if (round === 1) {
            return decisionFor(request, {
              kind: "invoke",
              calls: [{ name: "media.list", arguments: {} }],
            });
          }
          if (round === 2) {
            const genuineMediaId = extractDisclosedMediaId(request);
            return decisionFor(request, {
              kind: "invoke",
              calls: [
                {
                  name: "web.fetch",
                  arguments: { url: "https://public.example/page-a", limit: 4096 },
                },
                {
                  name: "web.fetch",
                  arguments: { url: "https://public.example/page-b", limit: 4096 },
                },
                {
                  name: "media.describe",
                  arguments: { id: genuineMediaId },
                },
                {
                  name: "sticker.search",
                  arguments: { query: "greeting" },
                },
              ],
            });
          }
          return decisionFor(request, { kind: "none" });
        },
      },
    });

    h.receive({
      id: "99001",
      image: "upstream-file-low-load",
      text: "Fetch two pages, describe the image, and search a sticker.",
      addressed: true,
    });

    h.advance(2);
    const activateResult = (await h.activate("direct_reply")) as { status: string };
    expect(activateResult.status).toBe("no_output");
    expect(web.networkCalls).toEqual([
      "https://public.example/page-a",
      "https://public.example/page-b",
    ]);
    expect(h.visionCalls).toHaveLength(1);

    const tasks = h.db.query("SELECT attempts, status FROM qq_media_read_tasks").all() as Array<{
      attempts: number;
      status: string;
    }>;
    expect(tasks).toEqual([{ attempts: 1, status: "succeeded" }]);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.list({})).toHaveLength(0);

    // Guard model business observations and this decision snapshot's full authority.
    expect(seen).toHaveLength(3);
    assertPositiveObservations(h, web, seen[2]);
  });

  for (const scenario of NEAR_CAPACITY_SCENARIOS) {
    it(`near-capacity ${scenario.label}`, async () => {
      const web = createWebFixture({
        pageContent: (url) =>
          `<html><head><title>Padded ${url}</title></head><body><article>${"文".repeat(4096)}</article></body></html>`,
      });
      const seen: ModelRequest[] = [];
      let round = 0;

      const h = createOneBotHarness({
        kind: "group",
        vision: [`synthetic cat description ${scenario.questionChars}`],
        stickersAvailable: true,
        externalActions: web.externalActions,
        actionExecutor: web.actionExecutor,
        resolveSource: web.resolveSource,
        model: {
          complete: async (request) => {
            seen.push(request);
            round += 1;
            if (round === 1) {
              return decisionFor(request, {
                kind: "invoke",
                calls: [{ name: "media.list", arguments: {} }],
              });
            }
            if (round === 2) {
              const genuineMediaId = extractDisclosedMediaId(request);
              return decisionFor(request, {
                kind: "invoke",
                calls: [
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/page-a", limit: 4096 },
                  },
                  {
                    name: "web.fetch",
                    arguments: { url: "https://public.example/page-b", limit: 4096 },
                  },
                  {
                    name: "media.describe",
                    arguments: { id: genuineMediaId },
                  },
                  {
                    name: "sticker.search",
                    arguments: { query: "greeting" },
                  },
                ],
              });
            }
            return decisionFor(request, { kind: "none" });
          },
        },
      });

      h.receive({
        id: String(99002 + scenario.questionChars),
        image: `upstream-file-near-capacity-${scenario.questionChars}`,
        text: "b".repeat(scenario.questionChars),
        addressed: true,
      });

      h.advance(2);
      const settled = await h.activate("direct_reply").then(
        (value) => ({ ok: true as const, value: value as { status: string } }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const firstUnits = seen[0] ? inputUnits(seen[0].messages) : 0;

      if (scenario.expectation === "settle_success") {
        // 14k verified positive: must NOT fail, settles normally within budget
        if (!settled.ok) {
          throw settled.error;
        }
        expect(firstUnits).toBeGreaterThan(50000);
        expect(firstUnits).toBeLessThan(60313);
        const lastUnits = seen[2] ? inputUnits(seen[2].messages) : 0;
        expect(lastUnits).toBeGreaterThan(firstUnits);
        expect(lastUnits).toBeLessThan(60313);

        expect(settled.value.status).toBe("no_output");
        expect(seen).toHaveLength(3);
        expect(web.networkCalls).toHaveLength(2);
        expect(h.visionCalls).toHaveLength(1);
        expect(h.db.query("SELECT attempts, status FROM qq_media_read_tasks").all()).toEqual([
          { attempts: 1, status: "succeeded" },
        ]);
        expect(h.sent).toHaveLength(0);
        expect(h.outbox.list({})).toHaveLength(0);

        // Guard model business observations and this decision snapshot's full authority.
        assertPositiveObservations(h, web, seen[2]);
      } else {
        // 15k estimated budget refusal: current estimated budget cannot fit limit 60313
        // Honest fatal error BEFORE media WRITE: CONTEXT_BUDGET_EXCEEDED
        // Do NOT call fatal no_output success or erase original failed raw history
        expect(settled.ok).toBe(false);
        if (settled.ok) throw new Error("expected settle failure");
        const error = settled.error as { readonly code?: string; readonly message?: string };
        const errorCode = error.code ?? error.message ?? "";
        expect(errorCode).toMatch(/CONTEXT_BUDGET_EXCEEDED/);

        expect(firstUnits).toBeGreaterThan(56000);
        expect(seen).toHaveLength(2);
        expect(web.networkCalls).toHaveLength(2);
        expect(h.visionCalls).toHaveLength(0);
        expect(h.db.query("SELECT attempts, status FROM qq_media_read_tasks").all()).toEqual([]);
        expect(h.sent).toHaveLength(0);
        expect(h.outbox.list({})).toHaveLength(0);
      }
    });
  }
});
