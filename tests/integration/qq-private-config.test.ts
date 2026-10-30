import { afterEach, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import {
  insertQqBinding,
  readQqBinding,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { createAgent } from "../../src/server/services/agent-service";
import { createQqBinding, updateQqBinding } from "../../src/server/services/qq-binding-contract";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { cloneBusinessDb } from "../harness/business-db";

const handles: ReturnType<typeof cloneBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function setup() {
  const business = cloneBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const scheme = createQqScheme(business.orm, { name: "shared policy" });
  const result = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "private",
    peerId: "40001",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    triggers: { direct_reply: true, follow_up: null, chiming_in: null, idle_topic: null },
  });
  if (result.kind !== "saved") throw new Error("fixture binding rejected");
  const binding = insertQqBinding(business.orm, result.binding);
  return { business, scheme, binding, app: createApp({ business }) };
}
async function config(h: ReturnType<typeof setup>) {
  const r = await h.app.request(`/qq/bindings/${h.binding.id}/config`);
  expect(r.status).toBe(200);
  return (await r.json()) as QqGroupConfigResponse;
}
function put(
  h: ReturnType<typeof setup>,
  before: QqGroupConfigResponse,
  overrides: unknown,
  extra = {},
) {
  return h.app.request(`/qq/bindings/${h.binding.id}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: before.binding.agent_id,
      expected_binding_revision: before.binding.revision,
      expected_scheme_revision: before.base_scheme.revision,
      expected_revision: before.revision,
      overrides,
      disabled_capabilities: [],
      ...extra,
    }),
  });
}
it("private policy uses the same CAS owner, preserves legacy switches and changes the effective runtime scheme only for its binding", async () => {
  const h = setup();
  const before = await config(h);
  expect(before.overrides.triggers?.direct_reply).toBe(true);
  const overrides = {
    ...before.overrides,
    rhythm: { merge_window_seconds: 7 },
    prompts: { scene: "private-scene" },
    context: { reply_token_budget: 9000 },
  };
  const response = await put(h, before, overrides);
  expect(response.status).toBe(200);
  const saved = (await response.json()) as QqGroupConfigResponse;
  expect(saved.revision).toBe(1);
  expect(saved.binding.triggers.direct_reply).toBe(true);
  const binding = readQqBinding(h.business.orm, h.binding.id);
  if (!binding) throw new Error("binding missing");
  const effective = readEffectiveQqScheme(h.business.orm, binding);
  if (!effective) throw new Error("scheme missing");
  expect(schemeRhythm(effective).merge_window_seconds).toBe(7);
  expect(saved.effective_scheme.prompts.scene).toBe("private-scene");
  expect(saved.base_scheme.prompts.scene).not.toBe("private-scene");
  expect((await put(h, before, overrides)).status).toBe(409);
  const reset = await put(h, saved, {});
  expect(reset.status).toBe(200);
  expect((await config(h)).overrides).toEqual({});
});
it("private policy rejects group-only settings without modifying its record", async () => {
  const h = setup();
  const before = await config(h);
  expect((await put(h, before, {}, { disabled_capabilities: ["web"] })).status).toBe(409);
  expect((await put(h, before, { reply: { split_by_speaker: false } })).status).toBe(409);
  expect(await config(h)).toEqual(before);
});
it("private overrides remain isolated by Agent and survive switching back; scheme changes still require keep or reset", async () => {
  const h = setup();
  const before = await config(h);
  const savedResponse = await put(h, before, {
    ...before.overrides,
    rhythm: { merge_window_seconds: 8 },
  });
  expect(savedResponse.status).toBe(200);
  const other = createAgent(
    h.business.orm,
    { name: "other", model_name: "test-model" },
    {
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
    },
  );
  const original = readQqBinding(h.business.orm, h.binding.id);
  if (!original) throw new Error("missing binding");
  const switched = updateQqBinding(original, { agentId: other.id }, original.revision);
  if (switched.kind !== "saved") throw new Error("switch rejected");
  saveQqBinding(h.business.orm, { binding: switched.binding, expectedRevision: original.revision });
  expect((await config(h)).overrides).toEqual({});
  const current = readQqBinding(h.business.orm, h.binding.id);
  if (!current) throw new Error("missing binding");
  const back = updateQqBinding(current, { agentId: original.agentId }, current.revision);
  if (back.kind !== "saved") throw new Error("switch rejected");
  saveQqBinding(h.business.orm, { binding: back.binding, expectedRevision: current.revision });
  expect((await config(h)).overrides.rhythm?.merge_window_seconds).toBe(8);
  const another = createQqScheme(h.business.orm, { name: "other scheme" });
  const fresh = await config(h);
  expect((await put(h, fresh, fresh.overrides, { scheme_id: another.id })).status).toBe(409);
  const accepted = await put(h, fresh, fresh.overrides, {
    scheme_id: another.id,
    scheme_change: "reset",
  });
  expect(accepted.status).toBe(200);
  expect((await config(h)).overrides).toEqual({});
});

for (const kind of ["group", "private"] as const) {
  for (const decision of ["keep", "reset"] as const) {
    it(`${kind} binding ${decision} rejects a stale config or target scheme preview without partial writes`, async () => {
      const h = setup();
      let binding = h.binding;
      if (kind === "group") {
        const created = createQqBinding({
          id: crypto.randomUUID(),
          accountId: h.binding.accountId,
          kind,
          peerId: "50005",
          agentId: h.binding.agentId,
          schemeId: h.binding.schemeId,
          paused: false,
        });
        if (created.kind !== "saved") throw new Error("group fixture rejected");
        binding = insertQqBinding(h.business.orm, created.binding);
      }
      const app = h.app;
      const read = async () => {
        const response = await app.request(`/qq/bindings/${binding.id}/config`);
        expect(response.status).toBe(200);
        return (await response.json()) as QqGroupConfigResponse;
      };
      const configure = async (before: QqGroupConfigResponse, overrides: unknown) => {
        const response = await app.request(`/qq/bindings/${binding.id}/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_id: before.binding.agent_id,
            expected_binding_revision: before.binding.revision,
            expected_scheme_revision: before.base_scheme.revision,
            expected_revision: before.revision,
            overrides,
            disabled_capabilities: kind === "group" ? ["web"] : [],
          }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as QqGroupConfigResponse;
      };
      const first = await configure(await read(), {
        prompts: { scene: "previewed prompt" },
        stickers: { sticker_min_repeat_minutes: 0 },
        sticker_collections: { collection_ids: [] },
        media_input: { ordinary_still_max_dimension: null },
        rhythm: { initiative_queue_on_busy: false },
      });
      const target = createQqScheme(h.business.orm, { name: "preview target" });
      const input = {
        agent_id: binding.agentId,
        scheme_id: target.id,
        scheme_change: decision,
        expected_revision: first.binding.revision,
        scheme_change_baseline: {
          config_revision: first.revision,
          scheme_revision: target.revision,
        },
        task_limits: { mention_task_limit: 2, ordinary_task_limit: null },
      };
      const submit = (payload = input) =>
        app.request(`/qq/bindings/${binding.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      // Non-trigger edits do not move the binding revision.
      const concurrent = await configure(first, {
        ...first.overrides,
        prompts: { scene: "other editor prompt" },
      });
      expect(concurrent.binding.revision).toBe(first.binding.revision);
      const snapshot = () => ({
        binding: h.business.db.query("SELECT * FROM qq_bindings WHERE id=?").get(binding.id),
        config: h.business.db
          .query("SELECT * FROM qq_group_agent_configs WHERE binding_id=? ORDER BY agent_id")
          .all(binding.id),
        conversations: h.business.db
          .query("SELECT * FROM conversations WHERE source_id=? ORDER BY binding_epoch")
          .all(binding.id),
      });
      const beforeConflict = snapshot();
      expect((await submit()).status).toBe(409);
      expect(snapshot()).toEqual(beforeConflict);
      expect((await read()).overrides.prompts?.scene).toBe("other editor prompt");
      const freshInput = {
        ...input,
        scheme_change_baseline: {
          config_revision: concurrent.revision,
          scheme_revision: target.revision,
        },
      };
      const changedTarget = updateQqScheme(h.business.orm, target.id, {
        name: "new target name",
        expectedRevision: target.revision,
      });
      expect((await submit(freshInput)).status).toBe(409);
      expect(snapshot()).toEqual(beforeConflict);
      const accepted = await submit({
        ...freshInput,
        scheme_change_baseline: {
          config_revision: concurrent.revision,
          scheme_revision: changedTarget.revision,
        },
      });
      expect(accepted.status).toBe(200);
      const saved = await read();
      expect(saved.binding.scheme_id).toBe(target.id);
      expect(saved.binding.task_limits.mention_task_limit).toBe(2);
      expect(saved.disabled_capabilities).toEqual(kind === "group" ? ["web"] : []);
      expect(saved.overrides).toEqual(decision === "keep" ? concurrent.overrides : {});
      expect(saved.effective_scheme.sticker_collections.collection_ids).toEqual([]);
    });
  }
}

it("empty private preview rejects a concurrent config change; legacy switches reset even with no stored config", async () => {
  const h = setup();
  const target = createQqScheme(h.business.orm, { name: "new private base" });
  const preview = await config(h);
  expect(preview.revision).toBe(0);
  const response = await h.app.request(`/qq/bindings/${h.binding.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scheme_id: target.id,
      scheme_change: "reset",
      expected_revision: preview.binding.revision,
      scheme_change_baseline: { config_revision: 0, scheme_revision: target.revision },
    }),
  });
  expect(response.status).toBe(200);
  expect((await config(h)).binding.triggers).toEqual({
    direct_reply: null,
    follow_up: null,
    chiming_in: null,
    idle_topic: null,
  });
  const empty = await config(h);
  const back = {
    scheme_id: h.scheme.id,
    expected_revision: empty.binding.revision,
    scheme_change_baseline: { config_revision: empty.revision, scheme_revision: h.scheme.revision },
  };
  const concurrent = await put(h, empty, { prompts: { scene: "newly created difference" } });
  expect(concurrent.status).toBe(200);
  const before = await config(h);
  const refused = await h.app.request(`/qq/bindings/${h.binding.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(back),
  });
  expect(refused.status).toBe(409);
  expect(await config(h)).toEqual(before);
});

it("binding confirmation without preview revisions is invalid and never clears private differences", async () => {
  const h = setup();
  const first = await config(h);
  expect((await put(h, first, { prompts: { scene: "must survive" } })).status).toBe(200);
  const before = await config(h);
  const target = createQqScheme(h.business.orm, { name: "unconfirmed target" });
  const rejected = await h.app.request(`/qq/bindings/${h.binding.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scheme_id: target.id,
      scheme_change: "reset",
      expected_revision: before.binding.revision,
    }),
  });
  expect(rejected.status).toBe(422);
  expect(await config(h)).toEqual(before);
});

it("virtual config revision zero cannot authorize a scheme move after another editor creates differences", async () => {
  const h = setup();
  const target = createQqScheme(h.business.orm, { name: "empty preview target" });
  const preview = await config(h);
  expect(preview.revision).toBe(0);
  expect(
    (await put(h, preview, { ...preview.overrides, prompts: { scene: "concurrent first record" } }))
      .status,
  ).toBe(200);
  const before = await config(h);
  expect(before.binding.revision).toBe(preview.binding.revision);
  const response = await h.app.request(`/qq/bindings/${h.binding.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scheme_id: target.id,
      expected_revision: before.binding.revision,
      scheme_change_baseline: { config_revision: 0, scheme_revision: target.revision },
    }),
  });
  expect(response.status).toBe(409);
  expect(await config(h)).toEqual(before);
});
