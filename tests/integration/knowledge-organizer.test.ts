import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { ModelUnavailableError } from "../../src/server/errors";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createRuntime } from "../../src/server/runtime";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { knowledgeSegments } from "../../src/server/services/knowledge-segments";

let business: BusinessDbHandle;
let repo: KnowledgeRepository;
let gateway: ModelGateway;
let calls: Parameters<ModelGateway["complete"]>[0][];
const text = "\uFEFF低于10°C时禁止启动。\r\n阈值42.5，例外仅限维护模式。𠮷";
const output = JSON.stringify({
  summary: "设备条件",
  tags: ["设备"],
  body: "低于10°C禁止启动；阈值42.5。",
});
const workers: KnowledgeOrganizer[] = [];
function worker(options: Partial<ConstructorParameters<typeof KnowledgeOrganizer>[0]> = {}) {
  const result = new KnowledgeOrganizer({ db: business.db, gateway, ...options });
  workers.push(result);
  return result;
}
function add(source = text) {
  return repo.importDocument({ category_id: "default", name: "合成资料", original_text: source });
}
function status() {
  return business.db
    .query<{ status: string; error_code: string | null }, []>(
      "SELECT status, error_code FROM knowledge_jobs ORDER BY rowid DESC LIMIT 1",
    )
    .get();
}
function assertEmptyDrafts() {
  expect(business.db.query("SELECT id FROM knowledge_drafts").all()).toEqual([]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function settings(auto: boolean) {
  const old = repo.settings();
  return repo.updateSettings({ ...old, auto_enabled: auto, expected_revision: old.revision });
}
function busyChat() {
  business.db.exec(
    `INSERT INTO sessions (id, user_id, agent_id, title, created_at, updated_at, client_request_id, agent_config_snapshot) SELECT 'test-session', (SELECT id FROM users LIMIT 1), id, 'synthetic', 'now', 'now', 'synthetic-session', '{}' FROM agents LIMIT 1`,
  );
  business.db
    .query(
      "INSERT INTO turns (id, session_id, client_request_id, runtime_config_snapshot, generation_status, lease_expires_at, created_at) VALUES ('test-turn', 'test-session', 'synthetic', '{}', 'active', ?, 'now')",
    )
    .run(new Date(Date.now() + 60000).toISOString());
}
beforeEach(() => {
  business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  repo = new KnowledgeRepository(business.db);
  calls = [];
  gateway = {
    config: { baseUrl: "http://synthetic.invalid/v1", model: "synthetic", timeoutSeconds: 1 },
    async listModels() {
      return ["synthetic"];
    },
    async loadedContextCapacity() {
      return 16000;
    },
    async probeModelLoaded() {
      return true;
    },
    async complete(options) {
      calls.push(options);
      return output;
    },
    async *streamChat() {
      yield "synthetic";
    },
  };
});
afterEach(async () => {
  for (const item of workers.splice(0)) await item.stop();
  business.close();
});

describe("knowledge original segmentation", () => {
  it("preserves BOM, CRLF, astral characters, decimals and all original offsets", () => {
    const source = `${text}\n\n${text}`;
    const chunks = knowledgeSegments(source, 45);
    expect(chunks.map((chunk) => chunk.body).join("")).toBe(source);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.body).toBe(source.slice(chunk.start, chunk.end));
      expect(chunk.start).toBe(index === 0 ? 0 : chunks[index - 1]?.end);
      expect(chunk.body.isWellFormed()).toBe(true);
    }
    expect(chunks.some((chunk) => chunk.body.includes("42.5"))).toBe(true);
  });
  it("segments English sentences without splitting decimal values", () => {
    const source = "Speed is 42.5. Stop below 10 degrees. Keep 3.14 intact.";
    const chunks = knowledgeSegments(source, 20);
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.body).join("")).toBe(source);
    expect(chunks[0]?.body).toBe("Speed is 42.5.");
    expect(chunks[2]?.body).toContain("3.14");
  });
  it("does not cut an oversized sentence or drop leading punctuation", () => {
    const source = `！？\r\n${"长".repeat(2000)}42.5。`;
    expect(
      knowledgeSegments(source, 20)
        .map((chunk) => chunk.body)
        .join(""),
    ).toBe(source);
    expect(knowledgeSegments(source, 20).at(-1)?.body).toContain(`${"长".repeat(2000)}42.5。`);
    expect(knowledgeSegments("")).toEqual([]);
    expect(() => knowledgeSegments(text, 0)).toThrow();
  });
});

describe("durable knowledge organizer", () => {
  it("publishes an entire draft and exact original chunks without granting access", async () => {
    const doc = add();
    expect(await worker().runCycle()).toBe(true);
    const result = repo.detail(doc.id);
    expect(result.organization_status).toBe("succeeded");
    expect(result.original_text).toBe(text);
    expect(result.agent_ids).toEqual([]);
    expect(result.draft?.body).toContain("42.5");
    expect(result.draft?.sources).toEqual([
      {
        type: "document",
        document_id: doc.id,
        version: 1,
        start: 0,
        end: text.length,
        draft_start: 0,
        draft_end: JSON.parse(output).body.length,
        valid: true,
      },
    ]);
    expect(
      business.db.query<{ body: string }, []>("SELECT body FROM knowledge_chunks").get()?.body,
    ).toBe(text);
    expect(calls[0]?.model).toBe("synthetic");
    expect(calls[0]?.responseSchema).toBeDefined();
  });
  it("uses configured model and reuses successful draft after off/on", async () => {
    repo.updateSettings({
      auto_enabled: true,
      model_name: "explicit-model",
      context_budget: 4096,
      expected_revision: 1,
    });
    const doc = add();
    const instance = worker();
    await instance.runCycle();
    settings(false);
    expect(repo.detail(doc.id).content.content_origin).toBe("original");
    settings(true);
    expect(await instance.runCycle()).toBe(false);
    expect(calls[0]?.model).toBe("explicit-model");
    expect(repo.detail(doc.id).content.content_origin).toBe("derived");
  });
  it("inherits the shared default at claim and never changes the running model", async () => {
    business.db.exec("UPDATE organization_settings SET model_name = 'before-claim';");
    add();
    business.db.exec("UPDATE organization_settings SET model_name = 'claimed-model';");
    gateway.loadedContextCapacity = async () => {
      business.db.exec("UPDATE organization_settings SET model_name = 'after-claim';");
      return 16000;
    };
    await worker().runCycle();
    expect(calls[0]?.model).toBe("claimed-model");
    expect(business.db.query("SELECT model_name FROM knowledge_drafts").get()).toEqual({
      model_name: "claimed-model",
    });
  });
  it("keeps the knowledge override ahead of the shared default", async () => {
    business.db.exec("UPDATE organization_settings SET model_name = 'shared-default';");
    repo.updateSettings({
      auto_enabled: true,
      model_name: "knowledge-override",
      context_budget: 4096,
      expected_revision: 1,
    });
    add();
    await worker().runCycle();
    expect(calls[0]?.model).toBe("knowledge-override");
  });
  it("does not overwrite manual original preference", async () => {
    const doc = add();
    repo.updateDocument(doc.id, { content_mode: "original", expected_revision: doc.revision });
    await worker().runCycle();
    expect(repo.detail(doc.id).draft).not.toBeNull();
    expect(repo.detail(doc.id).content.content_origin).toBe("original");
  });
  it("does not call model while disabled", async () => {
    settings(false);
    add();
    expect(await worker().runCycle()).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("records unavailable model without partial draft or automatic hot retries", async () => {
    const doc = add();
    gateway.complete = async () => {
      throw new ModelUnavailableError();
    };
    const instance = worker();
    await instance.runCycle();
    expect(status()?.error_code).toBe("MODEL_SERVICE_UNAVAILABLE");
    assertEmptyDrafts();
    expect(repo.detail(doc.id).content.body).toBe(text);
    expect(await instance.runCycle()).toBe(false);
    settings(false);
    settings(true);
    expect(status()?.status).toBe("queued");
  });
  it("rejects unknown capacity before generation", async () => {
    add();
    gateway.loadedContextCapacity = async () => null;
    await worker().runCycle();
    expect(status()?.error_code).toBe("MODEL_CAPACITY_UNAVAILABLE");
    expect(calls).toHaveLength(0);
  });
  it("rejects a complete oversized sentence instead of truncating it", async () => {
    add("原".repeat(10000));
    await worker().runCycle();
    expect(status()?.error_code).toBe("KNOWLEDGE_INPUT_TOO_LARGE");
    expect(calls).toHaveLength(0);
  });
  for (const result of [
    "not json",
    '{"summary":"s","tags":[],"body":"b","sources":[]}',
    '{"summary":"s","tags":[],"body":" "}',
  ]) {
    it(`rejects invalid structured result ${result.slice(0, 20)}`, async () => {
      add();
      gateway.complete = async () => result;
      await worker().runCycle();
      expect(status()?.error_code).toBe("KNOWLEDGE_INVALID_RESULT");
      assertEmptyDrafts();
    });
  }
  it("processes long documents in bounded complete segments and publishes once", async () => {
    const source = "启动条件为低于10°C禁用，维护模式除外，阈值42.5。\n".repeat(80);
    const doc = add(source);
    gateway.complete = async (options) => {
      assertEmptyDrafts();
      calls.push(options);
      return output;
    };
    await worker().runCycle();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((call) => call.messages[1]?.content).join("")).toBe(source);
    expect(repo.detail(doc.id).draft?.sources.length).toBe(calls.length);
  });
  it("discards every partial result when a later segment fails", async () => {
    add("这是第一部分。".repeat(300));
    let count = 0;
    gateway.complete = async () => {
      if (++count === 2) throw new ModelUnavailableError();
      return output;
    };
    await worker().runCycle();
    expect(count).toBe(2);
    assertEmptyDrafts();
    expect(business.db.query("SELECT id FROM knowledge_chunks").all()).toEqual([]);
  });
  it("rolls back all publication writes on a database failure", async () => {
    add();
    business.db.exec(
      "CREATE TEMP TRIGGER fail_draft BEFORE INSERT ON knowledge_drafts BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    await worker().runCycle();
    assertEmptyDrafts();
    expect(business.db.query("SELECT id FROM knowledge_chunks").all()).toEqual([]);
    expect(status()?.status).toBe("failed");
  });
  for (const mutation of ["edit", "disable", "delete", "token"] as const) {
    it(`rejects late publication after ${mutation}`, async () => {
      const doc = add();
      gateway.complete = async () => {
        if (mutation === "edit")
          repo.updateDocument(doc.id, { expected_revision: doc.revision, original_text: "新原文" });
        if (mutation === "disable") settings(false);
        if (mutation === "delete") repo.deleteDocument(doc.id, doc.revision);
        if (mutation === "token")
          business.db.query("UPDATE knowledge_jobs SET token = 'new-owner'").run();
        return output;
      };
      await worker().runCycle();
      assertEmptyDrafts();
      if (mutation === "edit") expect(status()?.status).toBe("queued");
      if (mutation === "disable") expect(status()?.status).toBe("cancelled");
      if (mutation === "token")
        expect(
          business.db.query<{ token: string }, []>("SELECT token FROM knowledge_jobs").get()?.token,
        ).toBe("new-owner");
    });
  }
  it("refuses concurrent cycles and a second worker while a lease is live", async () => {
    add();
    add();
    const entered = deferred<void>();
    const result = deferred<string>();
    gateway.complete = async () => {
      entered.resolve();
      return result.promise;
    };
    const instance = worker();
    const running = instance.runCycle();
    await entered.promise;
    expect(await instance.runCycle()).toBe(false);
    expect(await worker().runCycle()).toBe(false);
    result.resolve(output);
    await running;
  });
  it("recovers an expired lease with a new token", async () => {
    add();
    business.db.exec(
      "UPDATE knowledge_jobs SET status = 'running', token = 'dead-owner', lease_expires_at = '2000-01-01'",
    );
    await worker().runCycle();
    expect(status()?.status).toBe("succeeded");
  });
  it("does not claim while a chat is active", async () => {
    add();
    busyChat();
    expect(await worker().runCycle()).toBe(false);
    expect(status()?.status).toBe("queued");
  });
  it("aborts an in-flight job for chat and returns it to the queue", async () => {
    add();
    const entered = deferred<void>();
    const result = deferred<string>();
    let signal: AbortSignal | undefined;
    gateway.complete = async (options) => {
      signal = options.signal;
      entered.resolve();
      return result.promise;
    };
    const running = worker({ heartbeatIntervalMs: 5 }).runCycle();
    await entered.promise;
    busyChat();
    await running;
    expect(signal?.aborted).toBe(true);
    expect(status()?.status).toBe("queued");
    result.resolve(output);
    await Promise.resolve();
    assertEmptyDrafts();
  });
  it("stops a non-cooperating gateway without leaving a running job", async () => {
    add();
    const entered = deferred<void>();
    const result = deferred<string>();
    gateway.complete = async () => {
      entered.resolve();
      return result.promise;
    };
    const instance = worker();
    const running = instance.runCycle();
    await entered.promise;
    await instance.stop();
    await running;
    expect(status()?.status).toBe("queued");
    result.resolve(output);
    await Promise.resolve();
    assertEmptyDrafts();
  });
  it("times out a non-cooperating capacity probe", async () => {
    add();
    const result = deferred<number>();
    gateway.loadedContextCapacity = () => result.promise;
    await worker({ jobTimeoutMs: 20 }).runCycle();
    expect(status()?.error_code).toBe("KNOWLEDGE_TIMEOUT");
    result.resolve(16000);
    assertEmptyDrafts();
  });
  it("renews a live lease without holding a model-call transaction", async () => {
    add();
    gateway.complete = async () => {
      expect(business.db.inTransaction).toBe(false);
      const before = business.db
        .query<{ lease_expires_at: string }, []>("SELECT lease_expires_at FROM knowledge_jobs")
        .get();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = business.db
        .query<{ lease_expires_at: string }, []>("SELECT lease_expires_at FROM knowledge_jobs")
        .get();
      expect((after?.lease_expires_at ?? "") > (before?.lease_expires_at ?? "")).toBe(true);
      return output;
    };
    await worker({ heartbeatIntervalMs: 5, leaseMs: 500 }).runCycle();
    expect(status()?.status).toBe("succeeded");
  });
  it("rechecks capacity for each segment and rejects later capacity loss", async () => {
    add("这是长文分段测试。".repeat(300));
    let probes = 0;
    gateway.loadedContextCapacity = async () => (++probes === 1 ? 16000 : null);
    await worker().runCycle();
    expect(probes).toBe(2);
    expect(calls).toHaveLength(1);
    expect(status()?.error_code).toBe("MODEL_CAPACITY_UNAVAILABLE");
    assertEmptyDrafts();
  });
  it("rechecks document revision after a capacity probe", async () => {
    const doc = add();
    gateway.loadedContextCapacity = async () => {
      repo.updateDocument(doc.id, { expected_revision: doc.revision, original_text: "替换资料" });
      return 16000;
    };
    await worker().runCycle();
    expect(calls).toHaveLength(0);
    assertEmptyDrafts();
    expect(status()?.status).toBe("queued");
  });
  it("rejects output beyond the reserved UTF-8 budget", async () => {
    add();
    gateway.complete = async () =>
      JSON.stringify({ summary: "s", tags: [], body: "超".repeat(1000) });
    await worker().runCycle();
    expect(status()?.error_code).toBe("KNOWLEDGE_OUTPUT_TOO_LARGE");
    assertEmptyDrafts();
  });
  it("cannot publish after lease expiration even before heartbeat runs", async () => {
    add();
    gateway.complete = async () => {
      business.db.exec("UPDATE knowledge_jobs SET lease_expires_at = '2000-01-01'");
      return output;
    };
    await worker().runCycle();
    expect(status()?.error_code).toBe("KNOWLEDGE_JOB_INVALIDATED");
    assertEmptyDrafts();
  });
  it("runtime starts organizer and drains it before database close", async () => {
    add();
    const entered = deferred<void>();
    const result = deferred<string>();
    gateway.complete = async () => {
      entered.resolve();
      return result.promise;
    };
    const runtime = createRuntime({ business, gateway, browserStateSecret: "synthetic-secret" });
    const realClose = business.close;
    business.close = () => {
      expect(status()?.status).toBe("queued");
      realClose();
    };
    runtime.start();
    await entered.promise;
    await runtime.stop();
    await runtime.stop();
    result.resolve(output);
    business.close = () => {};
  });
});
