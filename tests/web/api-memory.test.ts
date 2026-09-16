import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-12T00:00:00.000000Z";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("R5 记忆 API 客户端", () => {
  it("使用冻结路由加载会话、轮次、分页、详情和任务状态", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond([{ id: SESSION_ID, title: "来源会话" }]))
      .mockResolvedValueOnce(
        respond({
          scope: "reality_user",
          turns: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              sequence_no: 1,
              user: "问",
              assistant: "答",
              processed: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(respond({ total: 0, items: [] }))
      .mockResolvedValueOnce(
        respond({
          id: MEMORY_ID,
          name: "名称",
          summary: "简介",
          tags: [],
          kinds: [],
          body: "正文",
          status: "active",
          scope: "reality_user",
          scope_key: AGENT_ID,
          created_at: NOW,
          config_snapshot: "{}",
        }),
      )
      .mockResolvedValueOnce(
        respond({
          id: JOB_ID,
          kind: "manual",
          session_id: SESSION_ID,
          status: "running",
          result_id: null,
          error_code: null,
          created_at: NOW,
          finished_at: null,
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.listMemorySessions(AGENT_ID);
    await api.listMemoryTurns(AGENT_ID, SESSION_ID, 20);
    await api.listMemoryEntries(AGENT_ID, 100, 100);
    await api.getMemoryEntry(AGENT_ID, MEMORY_ID);
    await api.getMemoryJob(AGENT_ID, JOB_ID);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/agents/${AGENT_ID}/memory/sessions`,
      `/agents/${AGENT_ID}/memory/sessions/${SESSION_ID}/turns?limit=20`,
      `/agents/${AGENT_ID}/memory/entries?offset=100&limit=100`,
      `/agents/${AGENT_ID}/memory/entries/${MEMORY_ID}`,
      `/agents/${AGENT_ID}/memory/jobs/${JOB_ID}`,
    ]);
  });
});
