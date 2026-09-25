// P5b: the QQ settings, conversation and binding routes (ADR0018).
//
// Two things here are worth more than the happy paths:
//   * the transport token. The response must never carry it, an omitted token must mean
//     "leave it alone" while `null` means "clear it", and both are asserted against the raw
//     response text rather than against a parsed field — a leaked credential would be a leak
//     even if the shape looked right.
//   * the conversation list. It comes from what the intake actually saw, so a binding cannot
//     be created for a conversation that never spoke.
//
// The key file is injected: the real one resolves inside the app's own state directory, and a
// test has no business writing there.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app";
import { createSession, ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  QqBindingResponse,
  QqConversationListItem,
  QqOwnerResponse,
  QqSchemeResponse,
  QqSettingsResponse,
} from "../../src/shared/contracts/qq";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const TOKEN = "local-napcat-token-9c1f";

type App = ReturnType<typeof createApp>;

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-qq-routes-"));
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  createSession(business.orm, "会话", { modelName: MODEL });
  const app = createApp({
    business,
    qqTransportKeyPath: path.join(dir, "qq-transport.key"),
  });
  return { business, orm: business.orm, app, dir };
}

function cleanup(h: ReturnType<typeof setup>) {
  h.business.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function json(app: App, method: string, route: string, payload: unknown) {
  return app.request(route, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function settings(app: App): Promise<QqSettingsResponse> {
  return body<QqSettingsResponse>(await app.request("/qq/settings"));
}

async function createScheme(app: App, name: string): Promise<QqSchemeResponse> {
  const response = await json(app, "POST", "/qq/schemes", { name });
  expect(response.status).toBe(201);
  return body<QqSchemeResponse>(response);
}

async function createBinding(app: App, schemeId: string, overrides: Record<string, unknown> = {}) {
  return json(app, "POST", "/qq/bindings", {
    account_id: "10001",
    kind: "group",
    peer_id: "20001",
    agent_id: AGENT_ID,
    scheme_id: schemeId,
    ...overrides,
  });
}

function insertEvent(orm: Orm, eventKey: string, peerId: string, occurredAtSeconds: number) {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId: AGENT_ID,
      messageId: eventKey,
      occurredAtSeconds,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: nowIso(),
    })
    .run();
}

describe("QQ settings routes", () => {
  it("reports the surface state without ever carrying the token", async () => {
    const h = setup();
    try {
      const initial = await settings(h.app);
      expect(initial).toEqual({
        enabled: false,
        account_id: null,
        judgement_model_name: null,
        transport: { endpoint: null, has_token: false },
        revision: 1,
      });

      const saved = await json(h.app, "PUT", "/qq/transport", {
        endpoint: "ws://127.0.0.1:3000/",
        token: TOKEN,
        expected_revision: initial.revision,
      });
      expect(saved.status).toBe(200);
      const text = await saved.text();
      // Asserted against the raw text: a leaked credential is a leak however neat the shape.
      expect(text).not.toContain(TOKEN);
      const view = JSON.parse(text) as QqSettingsResponse;
      expect(view.transport).toEqual({ endpoint: "ws://127.0.0.1:3000/", has_token: true });
      expect(await (await h.app.request("/qq/settings")).text()).not.toContain(TOKEN);
    } finally {
      cleanup(h);
    }
  });

  it("separates 'leave the token alone' from 'clear the token'", async () => {
    const h = setup();
    try {
      const first = await settings(h.app);
      await json(h.app, "PUT", "/qq/transport", {
        endpoint: "ws://127.0.0.1:3000/",
        token: TOKEN,
        expected_revision: first.revision,
      });
      const withToken = await settings(h.app);
      // Omitting the token keeps it, even while the endpoint changes.
      await json(h.app, "PUT", "/qq/transport", {
        endpoint: "ws://127.0.0.1:3001/",
        expected_revision: withToken.revision,
      });
      expect((await settings(h.app)).transport.has_token).toBe(true);
      // `null` clears it.
      const before = await settings(h.app);
      await json(h.app, "PUT", "/qq/transport", {
        token: null,
        expected_revision: before.revision,
      });
      const cleared = await settings(h.app);
      expect(cleared.transport.has_token).toBe(false);
      expect(cleared.transport.endpoint).toBe("ws://127.0.0.1:3001/");
    } finally {
      cleanup(h);
    }
  });

  it("refuses an endpoint the transport would not dial, and an impossible account", async () => {
    const h = setup();
    try {
      const before = await settings(h.app);
      expect(
        (
          await json(h.app, "PUT", "/qq/transport", {
            endpoint: "http://example.com/",
            expected_revision: before.revision,
          })
        ).status,
      ).toBe(409);
      expect((await settings(h.app)).transport.endpoint).toBeNull();
      // An account id the OneBot layer would reject never reaches storage.
      expect(
        (
          await json(h.app, "PUT", "/qq/settings", {
            account_id: "not-a-number",
            expected_revision: before.revision,
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await json(h.app, "PUT", "/qq/settings", {
            account_id: "10001",
            expected_revision: before.revision,
          })
        ).status,
      ).toBe(200);
      expect((await settings(h.app)).account_id).toBe("10001");
    } finally {
      cleanup(h);
    }
  });

  it("does not pretend a no-op save was a change, and refuses a stale revision", async () => {
    const h = setup();
    try {
      const initial = await settings(h.app);
      const same = await json(h.app, "PUT", "/qq/settings", {
        enabled: false,
        expected_revision: initial.revision,
      });
      expect((await body<QqSettingsResponse>(same)).revision).toBe(initial.revision);

      const enabled = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          enabled: true,
          expected_revision: initial.revision,
        }),
      );
      expect(enabled.enabled).toBe(true);
      expect(enabled.revision).toBe(initial.revision + 1);
      expect(
        (
          await json(h.app, "PUT", "/qq/settings", {
            enabled: false,
            expected_revision: initial.revision,
          })
        ).status,
      ).toBe(409);
    } finally {
      cleanup(h);
    }
  });

  it("saves the QQ-global judgement model, and 'leave it alone' stays different from 'clear it'", async () => {
    const h = setup();
    try {
      const initial = await settings(h.app);
      // 0038 (用户 2026-09-25): one judgement model for the whole QQ side. Unset is the old
      // behaviour — follow the bound assistant's conversation model — so it starts null.
      expect(initial.judgement_model_name).toBeNull();
      const chosen = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          judgement_model_name: "judge-model",
          expected_revision: initial.revision,
        }),
      );
      expect(chosen.judgement_model_name).toBe("judge-model");
      expect(chosen.revision).toBe(initial.revision + 1);
      // Omitting it (a save that only flips the switch) keeps the choice.
      const enabled = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          enabled: true,
          expected_revision: chosen.revision,
        }),
      );
      expect(enabled.judgement_model_name).toBe("judge-model");
      // `null` returns judgement to the bound assistant's model.
      const cleared = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          judgement_model_name: null,
          expected_revision: enabled.revision,
        }),
      );
      expect(cleared.judgement_model_name).toBeNull();
      // A blank name is refused at the boundary rather than stored as a model nobody can call.
      expect(
        (
          await json(h.app, "PUT", "/qq/settings", {
            judgement_model_name: "   ",
            expected_revision: cleared.revision,
          })
        ).status,
      ).toBe(422);
      expect((await settings(h.app)).judgement_model_name).toBeNull();
      // Re-saving the same value is not a change.
      const again = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          judgement_model_name: "judge-model",
          expected_revision: cleared.revision,
        }),
      );
      const same = await body<QqSettingsResponse>(
        await json(h.app, "PUT", "/qq/settings", {
          judgement_model_name: "judge-model",
          expected_revision: again.revision,
        }),
      );
      expect(same.revision).toBe(again.revision);
    } finally {
      cleanup(h);
    }
  });

  it("lists only conversations the intake actually saw, newest activity first", async () => {
    const h = setup();
    try {
      expect(
        await body<QqConversationListItem[]>(await h.app.request("/qq/conversations")),
      ).toEqual([]);
      insertEvent(h.orm, "e1", "20001", 1_000);
      insertEvent(h.orm, "e2", "20001", 1_500);
      insertEvent(h.orm, "e3", "20002", 1_200);
      const listed = await body<QqConversationListItem[]>(await h.app.request("/qq/conversations"));
      expect(listed.map((c) => c.peer_id)).toEqual(["20001", "20002"]);
      expect(listed[0]).toEqual({
        account_id: "10001",
        kind: "group",
        peer_id: "20001",
        messages: 2,
        last_at_seconds: 1_500,
        binding_id: null,
      });
    } finally {
      cleanup(h);
    }
  });
});

describe("QQ binding routes", () => {
  it("binds a conversation, and then the conversation list says so", async () => {
    const h = setup();
    try {
      insertEvent(h.orm, "e1", "20001", 1_000);
      const scheme = await createScheme(h.app, "方案");
      const created = await body<QqBindingResponse>(await createBinding(h.app, scheme.id));
      expect(created).toEqual({
        id: created.id,
        account_id: "10001",
        kind: "group",
        peer_id: "20001",
        agent_id: AGENT_ID,
        scheme_id: scheme.id,
        paused: false,
        // A freshly bound conversation follows its scheme for all four modules.
        triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
        // And it has no attention list until the user names somebody (0031).
        attention: { mode: "off", members: [] },
        share_web_memory: false,
        memory_batch_size: null,
        // Nothing has been observed with text yet, so no batch is waiting (2026-09-25).
        pending_observations: 0,
        revision: 1,
        authority_revision: 1,
      });
      const listed = await body<QqConversationListItem[]>(await h.app.request("/qq/conversations"));
      expect(listed[0]?.binding_id).toBe(created.id);
    } finally {
      cleanup(h);
    }
  });

  it("refuses a second binding for the same conversation", async () => {
    const h = setup();
    try {
      const scheme = await createScheme(h.app, "方案");
      expect((await createBinding(h.app, scheme.id)).status).toBe(201);
      expect((await createBinding(h.app, scheme.id)).status).toBe(409);
      expect(await body<QqBindingResponse[]>(await h.app.request("/qq/bindings"))).toHaveLength(1);
    } finally {
      cleanup(h);
    }
  });

  it("stores the attention list, normalizes it, and refuses a half-written pair", async () => {
    const h = setup();
    try {
      const scheme = await createScheme(h.app, "方案");
      const created = await body<QqBindingResponse>(
        await createBinding(h.app, scheme.id, {
          attention: { mode: "soft", members: ["30003", "20002", "30003"] },
        }),
      );
      // Deduplicated and sorted, so naming the same people in another order is not a change (0031).
      expect(created.attention).toEqual({ mode: "soft", members: ["20002", "30003"] });
      // A mode with nobody on it, and names with no mode, are both refused at the boundary.
      expect(
        (
          await createBinding(h.app, scheme.id, {
            peer_id: "20002",
            attention: { mode: "hard", members: [] },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await createBinding(h.app, scheme.id, {
            peer_id: "20002",
            attention: { mode: "off", members: ["30003"] },
          })
        ).status,
      ).toBe(422);
      expect(await body<QqBindingResponse[]>(await h.app.request("/qq/bindings"))).toHaveLength(1);
      // The update carries the whole list; a real change bumps the revision, `off` clears both.
      const updated = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
          attention: { mode: "hard", members: ["20002"] },
          expected_revision: created.revision,
        }),
      );
      expect(updated.attention).toEqual({ mode: "hard", members: ["20002"] });
      expect(updated.revision).toBe(created.revision + 1);
      const cleared = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
          attention: { mode: "off", members: [] },
          expected_revision: updated.revision,
        }),
      );
      expect(cleared.attention).toEqual({ mode: "off", members: [] });
    } finally {
      cleanup(h);
    }
  });

  it("refuses a binding to an unknown assistant or scheme, and a bad account", async () => {
    const h = setup();
    try {
      const scheme = await createScheme(h.app, "方案");
      expect((await createBinding(h.app, scheme.id, { agent_id: MISSING_ID })).status).toBe(404);
      expect((await createBinding(h.app, scheme.id, { scheme_id: MISSING_ID })).status).toBe(404);
      expect((await createBinding(h.app, scheme.id, { account_id: "abc" })).status).toBe(422);
      expect(await body<QqBindingResponse[]>(await h.app.request("/qq/bindings"))).toEqual([]);
    } finally {
      cleanup(h);
    }
  });

  it("pauses, resumes, and switches the organising count off with an explicit null", async () => {
    const h = setup();
    try {
      const scheme = await createScheme(h.app, "方案");
      const created = await body<QqBindingResponse>(await createBinding(h.app, scheme.id));

      const paused = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
          paused: true,
          memory_batch_size: 5,
          expected_revision: created.revision,
        }),
      );
      expect(paused.paused).toBe(true);
      expect(paused.memory_batch_size).toBe(5);
      // Pausing is an ordinary modification: it must not look like an authority change.
      expect(paused.authority_revision).toBe(created.authority_revision);
      expect(paused.revision).toBe(created.revision + 1);

      // `null` means "automatic organising off", so it must not be read as "not provided".
      const off = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
          memory_batch_size: null,
          expected_revision: paused.revision,
        }),
      );
      expect(off.memory_batch_size).toBeNull();
      expect(off.paused).toBe(true);
    } finally {
      cleanup(h);
    }
  });

  it("re-points a binding at another scheme and assistant under compare-and-swap", async () => {
    const h = setup();
    try {
      const first = await createScheme(h.app, "甲方案");
      const second = await createScheme(h.app, "乙方案");
      const created = await body<QqBindingResponse>(await createBinding(h.app, first.id));

      const moved = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
          scheme_id: second.id,
          expected_revision: created.revision,
        }),
      );
      expect(moved.scheme_id).toBe(second.id);
      // Changing which scheme speaks for the conversation is an ordinary change: the
      // assistant and the sharing authority are untouched.
      expect(moved.authority_revision).toBe(created.authority_revision);

      expect(
        (
          await json(h.app, "PUT", `/qq/bindings/${created.id}`, {
            paused: true,
            expected_revision: created.revision,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await json(h.app, "PUT", `/qq/bindings/${MISSING_ID}`, {
            paused: true,
            expected_revision: 1,
          })
        ).status,
      ).toBe(404);
    } finally {
      cleanup(h);
    }
  });

  it("refuses sharing until the user has confirmed which private chat is theirs", async () => {
    const h = setup();
    try {
      const scheme = await createScheme(h.app, "方案");
      // A group is refused outright: sharing is only ever about the user's own private chat.
      expect((await createBinding(h.app, scheme.id, { share_web_memory: true })).status).toBe(409);
      // So is a private chat, while no owner identity exists to compare it against.
      expect(
        (
          await createBinding(h.app, scheme.id, {
            kind: "private",
            peer_id: "30001",
            share_web_memory: true,
          })
        ).status,
      ).toBe(409);
      // Neither attempt left a half-enabled binding behind.
      expect(await body<QqBindingResponse[]>(await h.app.request("/qq/bindings"))).toEqual([]);
    } finally {
      cleanup(h);
    }
  });
});

describe("owner identity and web-memory sharing", () => {
  it("starts unconfigured, and refuses to confirm an owner before there is an account", async () => {
    const h = setup();
    try {
      expect(await body<QqOwnerResponse>(await h.app.request("/qq/owner"))).toEqual({
        configured: false,
        account_id: null,
        peer_id: null,
        revision: null,
      });
      // Without an assistant account, "this person is me" would be about no account at all.
      expect((await json(h.app, "PUT", "/qq/owner", { peer_id: "30001" })).status).toBe(409);
    } finally {
      cleanup(h);
    }
  });

  it("confirms the user's own private chat, and only then allows sharing there", async () => {
    const h = setup();
    try {
      const first = await settings(h.app);
      await json(h.app, "PUT", "/qq/settings", {
        account_id: "10001",
        expected_revision: first.revision,
      });
      // The identity row starts at revision 1 with no peer; naming the peer is a change, so
      // the confirmed identity is revision 2. The number is not a count of confirmations —
      // it is a change counter, and it exists to make a stale save detectable.
      const owner = await body<QqOwnerResponse>(
        await json(h.app, "PUT", "/qq/owner", { peer_id: "30001" }),
      );
      expect(owner).toEqual({
        configured: true,
        account_id: "10001",
        peer_id: "30001",
        revision: 2,
      });

      const scheme = await createScheme(h.app, "方案");
      // Another private chat is still refused: the identity names exactly one person.
      expect(
        (
          await createBinding(h.app, scheme.id, {
            kind: "private",
            peer_id: "30002",
            share_web_memory: true,
          })
        ).status,
      ).toBe(409);
      const own = await body<QqBindingResponse>(
        await createBinding(h.app, scheme.id, {
          kind: "private",
          peer_id: "30001",
          share_web_memory: true,
        }),
      );
      expect(own.share_web_memory).toBe(true);

      // Stopping the sharing needs no permission — it is always allowed to stop.
      const off = await body<QqBindingResponse>(
        await json(h.app, "PUT", `/qq/bindings/${own.id}`, {
          share_web_memory: false,
          expected_revision: own.revision,
        }),
      );
      expect(off.share_web_memory).toBe(false);
      // Sharing is an authority change, so it moves authority_revision; the ordinary revision
      // moves with it.
      expect(off.revision).toBe(own.revision + 1);
      expect(off.authority_revision).toBe(own.authority_revision + 1);
    } finally {
      cleanup(h);
    }
  });

  it("moves the owner identity under compare-and-swap rather than silently re-pointing it", async () => {
    const h = setup();
    try {
      const first = await settings(h.app);
      await json(h.app, "PUT", "/qq/settings", {
        account_id: "10001",
        expected_revision: first.revision,
      });
      await json(h.app, "PUT", "/qq/owner", { peer_id: "30001" });
      expect(
        (await json(h.app, "PUT", "/qq/owner", { peer_id: "30002", expected_revision: 5 })).status,
      ).toBe(409);
      const moved = await body<QqOwnerResponse>(
        await json(h.app, "PUT", "/qq/owner", { peer_id: "30002", expected_revision: 2 }),
      );
      expect(moved.peer_id).toBe("30002");
      expect(moved.revision).toBe(3);
      // A bare number is not an identity.
      expect((await json(h.app, "PUT", "/qq/owner", { peer_id: "not-a-number" })).status).toBe(422);
    } finally {
      cleanup(h);
    }
  });
});
