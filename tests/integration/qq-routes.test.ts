// P5a: the QQ scheme routes (ADR0018).
//
// These tests go through the real HTTP surface (createApp + app.request) rather than calling
// the repository, because the thing being pinned is the wire shape: switches as booleans,
// revisions on every write, and the two refusals a settings surface has to explain — a
// duplicate name and a scheme that is still in use.
//
// The default matters as much as the fields: a brand-new scheme has every switch off, so
// binding one cannot make an assistant start talking on its own. That default is asserted
// rather than assumed, because it is the difference between "the assistant is quiet until I
// ask" and "the assistant spoke in my group before I configured anything".

import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

type App = ReturnType<typeof createApp>;

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm, app: createApp({ business }) };
}

function json(app: App, method: string, path: string, payload: unknown) {
  return app.request(path, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createScheme(app: App, payload: unknown): Promise<QqSchemeResponse> {
  const response = await json(app, "POST", "/qq/schemes", payload);
  expect(response.status).toBe(201);
  return body<QqSchemeResponse>(response);
}

async function listSchemes(app: App): Promise<QqSchemeResponse[]> {
  return body<QqSchemeResponse[]>(await app.request("/qq/schemes"));
}

async function updateScheme(app: App, id: string, payload: unknown): Promise<QqSchemeResponse> {
  return body<QqSchemeResponse>(await json(app, "PUT", `/qq/schemes/${id}`, payload));
}

function insertBinding(orm: Orm, schemeId: string) {
  orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: AGENT_ID,
      schemeId,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
}

describe("QQ scheme routes", () => {
  it("starts empty", async () => {
    const h = setup();
    try {
      expect(await listSchemes(h.app)).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("creates a quiet scheme: every switch off until the user turns one on", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "默认方案" });
      expect(created.triggers).toEqual({
        direct_reply: false,
        follow_up: false,
        chiming_in: false,
        idle_topic: false,
      });
      // The rhythm group is on the wire now that its values are decided (P3b-1), and a new
      // scheme gets the defaults rather than a zeroed group: a cooldown of 0 or an hourly cap
      // of 0 would mean "speak as fast as you like" and "never speak", neither of which is a
      // default anyone chose.
      expect(created.rhythm).toEqual({
        merge_window_seconds: 30,
        reply_cooldown_seconds: 10,
        hourly_speech_limit: 200,
        // 0034: the unprompted-speech threshold travels with the rhythm group.
        initiative_min_score: 6,
        // 0036: 每 X 条群友消息才真跑一次判断（间隔内复用上次读数）。
        judgement_interval_turns: 3,
        idle_quiet_minutes: 15,
        active_hours_enabled: false,
        active_hours_start_minutes: 0,
        active_hours_end_minutes: 1439,
        max_recompute_count: 1,
        max_sticker_count: 1,
        media_supplement_window_minutes: 10,
        media_frame_count: 3,
        media_max_dimension: 512,
        initiative_batch_target_count: 15,
        initiative_batch_jitter_count: 5,
        initiative_queue_on_busy: true,
        // 0055: the time window rides with the count window, and a new scheme opens it at
        // the user-fixed 60±20 (an existing scheme stays off through the 0055 DDL default).
        initiative_time_window_enabled: true,
        initiative_time_target_seconds: 60,
        initiative_time_jitter_seconds: 20,
      });
      // The second decided group: what the judgement and the reply each get to see.
      expect(created.context).toEqual({
        judgement_message_limit: 20,
        judgement_window_minutes: 60,
        judgement_token_budget: 2000,
        reply_message_limit: 60,
        reply_window_minutes: 360,
        reply_token_budget: 6000,
      });
      expect(created.output_reserve).toEqual({
        judgement_output_reserved: 512,
        reply_output_reserved: 2048,
      });
      // §9.3's repetition rules are on the wire too, now that their values are decided (P4d).
      expect(created.stickers).toEqual({
        sticker_min_repeat_minutes: 10,
        sticker_recent_avoid_count: 5,
      });
      expect(created.description).toBeNull();
      expect(created.revision).toBe(1);
      // Wire shape: identity, switches, every decided parameter group, and revision — and
      // nothing from a §5.2 group whose values are still pending. A new scheme authorizes no
      // collections: the set is empty until the user says which ones it may draw from (P4g).
      expect(created.sticker_collections).toEqual({ collection_ids: [] });
      // 0035: the reply shape rides with the prompts it selects between; a new scheme splits by
      // speaker, because that is the behaviour the user asked for.
      expect(created.reply).toEqual({ split_by_speaker: true });
      // 0052：两组新设置必须以完整组上线。响应契约收紧后是必填——迁移间隙的 optional 形状
      // 不再合法，NULL 行由仓储按已批准默认组兜底后输出。
      expect(created.message_settings).toEqual({
        reply_mode: "one_then_on_demand",
        reply_depth: 2,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      });
      expect(created.media_input).toEqual({
        mode: "native",
        stages: { decision: true, evaluation: true, generation: true },
        max_images: 8,
        ordinary_still_max_dimension: null,
        expression_max_dimension: 512,
        expression_frame_count: 3,
        expression_frame_max_dimension: 512,
      });
      expect(Object.keys(created).sort()).toEqual([
        "compression",
        "context",
        "created_at",
        "description",
        "id",
        "media_input",
        "message_settings",
        "name",
        "output_reserve",
        "prompts",
        "reply",
        "revision",
        "rhythm",
        "sticker_collections",
        "stickers",
        "triggers",
        "updated_at",
      ]);
    } finally {
      h.business.close();
    }
  });

  it("edits two output reserves through the scheme API and rejects invalid values", async () => {
    const h = setup();
    try {
      const first = await createScheme(h.app, { name: "A" });
      const second = await createScheme(h.app, { name: "B" });
      const changed = { judgement_output_reserved: 1024, reply_output_reserved: 4096 };
      const updated = await updateScheme(h.app, first.id, {
        name: first.name,
        output_reserve: changed,
        expected_revision: first.revision,
      });
      expect(updated.output_reserve).toEqual(changed);
      expect(updated.revision).toBe(2);
      const stale = await h.app.request(`/qq/schemes/${first.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: first.name, output_reserve: changed, expected_revision: 1 }),
      });
      expect(stale.status).toBe(409);
      expect(
        (await listSchemes(h.app)).find((row) => row.id === second.id)?.output_reserve,
      ).toEqual({ judgement_output_reserved: 512, reply_output_reserved: 2048 });
      expect(
        (await updateScheme(h.app, first.id, { name: first.name, expected_revision: 2 })).revision,
      ).toBe(2);
      const createdCustom = await createScheme(h.app, {
        name: "C",
        output_reserve: { judgement_output_reserved: 256, reply_output_reserved: 16384 },
      });
      expect(createdCustom.output_reserve).toEqual({
        judgement_output_reserved: 256,
        reply_output_reserved: 16384,
      });
      for (const output_reserve of [
        { judgement_output_reserved: 255, reply_output_reserved: 2048 },
        { judgement_output_reserved: 512, reply_output_reserved: 32769 },
        { judgement_output_reserved: 512 },
      ]) {
        const response = await h.app.request(`/qq/schemes/${first.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: first.name, output_reserve, expected_revision: 2 }),
        });
        expect(response.status).toBe(422);
      }
    } finally {
      h.business.close();
    }
  });

  it("keeps the switches it was given", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, {
        name: "会回话的方案",
        description: "只回应，不主动",
        triggers: { direct_reply: true, follow_up: true, chiming_in: false, idle_topic: false },
      });
      expect(created.triggers).toEqual({
        direct_reply: true,
        follow_up: true,
        chiming_in: false,
        idle_topic: false,
      });
      expect(created.description).toBe("只回应，不主动");
      const listed = await listSchemes(h.app);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.triggers.chiming_in).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("rejects a blank name, a partial switch set and an unknown field", async () => {
    const h = setup();
    try {
      expect((await json(h.app, "POST", "/qq/schemes", { name: "   " })).status).toBe(422);
      expect(
        (await json(h.app, "POST", "/qq/schemes", { name: "x", triggers: { direct_reply: true } }))
          .status,
      ).toBe(422);
      expect(
        (
          await json(h.app, "POST", "/qq/schemes", {
            name: "x",
            triggers: {
              direct_reply: true,
              follow_up: false,
              chiming_in: false,
              idle_topic: false,
              extra: 1,
            },
          })
        ).status,
      ).toBe(422);
      // Nothing was written by any of the rejected requests.
      expect(await listSchemes(h.app)).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a duplicate name, because the name is how a human identifies the scheme", async () => {
    const h = setup();
    try {
      await createScheme(h.app, { name: "同名" });
      expect((await json(h.app, "POST", "/qq/schemes", { name: " 同名 " })).status).toBe(409);
    } finally {
      h.business.close();
    }
  });

  it("reads one scheme, and separates a missing one from a malformed id", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "方案" });
      const found = await h.app.request(`/qq/schemes/${created.id}`);
      expect(found.status).toBe(200);
      expect((await body<QqSchemeResponse>(found)).id).toBe(created.id);
      expect((await h.app.request(`/qq/schemes/${MISSING_ID}`)).status).toBe(404);
      // A non-UUID path segment is a validation failure, not a 404: it never reaches the lookup.
      expect((await h.app.request("/qq/schemes/not-a-uuid")).status).toBe(422);
    } finally {
      h.business.close();
    }
  });

  it("updates name, description and switches under compare-and-swap", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "旧名" });
      const updated = await updateScheme(h.app, created.id, {
        name: "新名",
        description: "说明",
        triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
        expected_revision: created.revision,
      });
      expect(updated.name).toBe("新名");
      expect(updated.triggers.chiming_in).toBe(true);
      expect(updated.revision).toBe(created.revision + 1);
      // Omitting the switches leaves them alone.
      const renamed = await updateScheme(h.app, created.id, {
        name: "再改名",
        expected_revision: updated.revision,
      });
      expect(renamed.triggers.chiming_in).toBe(true);
      expect(renamed.description).toBe("说明");
    } finally {
      h.business.close();
    }
  });

  it("does not pretend a no-op save was a change", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "方案", description: "说明" });
      const again = await updateScheme(h.app, created.id, {
        name: "方案",
        description: "说明",
        triggers: { direct_reply: false, follow_up: false, chiming_in: false, idle_topic: false },
        expected_revision: created.revision,
      });
      expect(again.revision).toBe(created.revision);
    } finally {
      h.business.close();
    }
  });

  it("refuses a stale revision and an unknown scheme", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "方案" });
      expect(
        (
          await json(h.app, "PUT", `/qq/schemes/${created.id}`, {
            name: "改",
            expected_revision: created.revision + 5,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await json(h.app, "PUT", `/qq/schemes/${MISSING_ID}`, {
            name: "改",
            expected_revision: 1,
          })
        ).status,
      ).toBe(404);
    } finally {
      h.business.close();
    }
  });

  it("reports how many bindings use a scheme, so a refusal can be explained first", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "在用方案" });
      expect(
        await body<{ scheme_id: string; bindings: number }>(
          await h.app.request(`/qq/schemes/${created.id}/usage`),
        ),
      ).toEqual({
        scheme_id: created.id,
        bindings: 0,
      });
      insertBinding(h.orm, created.id);
      expect(
        await body<{ scheme_id: string; bindings: number }>(
          await h.app.request(`/qq/schemes/${created.id}/usage`),
        ),
      ).toEqual({
        scheme_id: created.id,
        bindings: 1,
      });
      expect((await h.app.request(`/qq/schemes/${MISSING_ID}/usage`)).status).toBe(404);
    } finally {
      h.business.close();
    }
  });

  it("deletes an unused scheme and refuses one that is still bound", async () => {
    const h = setup();
    try {
      const used = await createScheme(h.app, { name: "在用" });
      insertBinding(h.orm, used.id);
      expect((await h.app.request(`/qq/schemes/${used.id}`, { method: "DELETE" })).status).toBe(
        409,
      );

      const free = await createScheme(h.app, { name: "未用" });
      expect((await h.app.request(`/qq/schemes/${free.id}`, { method: "DELETE" })).status).toBe(
        204,
      );
      expect(await listSchemes(h.app)).toHaveLength(1);
      expect((await h.app.request(`/qq/schemes/${free.id}`)).status).toBe(404);
    } finally {
      h.business.close();
    }
  });

  // 0052/T12：两组设置的 HTTP roundtrip。请求体未知字段被严格拒绝（shape 严格），
  // create 未提供 → 响应带完整默认组；update 未提供 → 保持现值；引用/时间字段真实保存回读。
  it("round-trips the message settings and media input groups over HTTP and refuses unknown fields", async () => {
    const h = setup();
    try {
      const created = await createScheme(h.app, { name: "往返方案" });
      expect(created.message_settings).toEqual({
        reply_mode: "one_then_on_demand",
        reply_depth: 2,
        time_display: "hybrid",
        timezone: "Asia/Shanghai",
      });
      expect(created.media_input.mode).toBe("native");
      expect(created.media_input.stages).toEqual({
        decision: true,
        evaluation: true,
        generation: true,
      });

      // 引用（层数 + configured_depth）与时间（完整时间 + 真实时区）真实保存回读。
      const updated = await updateScheme(h.app, created.id, {
        name: "往返方案",
        message_settings: {
          reply_mode: "configured_depth",
          reply_depth: 4,
          time_display: "full",
          timezone: "Asia/Tokyo",
        },
        media_input: {
          mode: "description",
          stages: { decision: true, evaluation: false, generation: true },
          max_images: 4,
          ordinary_still_max_dimension: 1024,
          expression_max_dimension: 256,
          expression_frame_count: 5,
          expression_frame_max_dimension: 2048,
        },
        expected_revision: created.revision,
      });
      expect(updated.message_settings).toEqual({
        reply_mode: "configured_depth",
        reply_depth: 4,
        time_display: "full",
        timezone: "Asia/Tokyo",
      });
      expect(updated.media_input).toEqual({
        mode: "description",
        stages: { decision: true, evaluation: false, generation: true },
        max_images: 4,
        ordinary_still_max_dimension: 1024,
        expression_max_dimension: 256,
        expression_frame_count: 5,
        expression_frame_max_dimension: 2048,
      });
      expect(updated.revision).toBe(2);

      // update 未提供 → 保持现值；读回一致。
      const renamed = await updateScheme(h.app, created.id, {
        name: "往返方案二",
        expected_revision: updated.revision,
      });
      expect(renamed.message_settings).toEqual(updated.message_settings);
      expect(renamed.media_input).toEqual(updated.media_input);

      // shape 严格：未知字段（含运行时才有的普通动图派生值与请求侧的垃圾键）整体拒绝，422。
      const badRequests: unknown[] = [
        {
          name: "往返方案二",
          message_settings: { ...updated.message_settings, extra: true },
          expected_revision: renamed.revision,
        },
        {
          name: "往返方案二",
          media_input: { ...updated.media_input, ordinary_frame_count: 3 },
          expected_revision: renamed.revision,
        },
        {
          name: "往返方案二",
          message_settings: { ...updated.message_settings, timezone: "Mars/Olympus" },
          expected_revision: renamed.revision,
        },
        {
          name: "往返方案二",
          // stages 必须整组：缺 evaluation 的半截组不是「那一阶段不动」。
          media_input: {
            ...updated.media_input,
            stages: { decision: false, generation: false },
          },
          expected_revision: renamed.revision,
        },
      ];
      for (const payload of badRequests) {
        const response = await json(h.app, "PUT", `/qq/schemes/${created.id}`, payload);
        expect(response.status).toBe(422);
      }
      const after = await h.app.request(`/qq/schemes/${created.id}`);
      expect(await body<QqSchemeResponse>(after)).toEqual(renamed);
    } finally {
      h.business.close();
    }
  });
});
