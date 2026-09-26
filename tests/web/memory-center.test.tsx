// Presentation-specific cases moved to fresh-product-workspaces.test.tsx.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryScopeView } from "../../src/shared/contracts";
import { api } from "../../src/web/api";

import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const agentId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-25T00:00:00.000Z";
const key = JSON.stringify(["qq", "10001", "group", "30003", agentId]);
const binding = { id: bindingId, revision: 2, memory_batch_size: 20, paused: false, enabled: true };
const scope: MemoryScopeView = {
  scope_key: key,
  count: 1,
  active_count: 1,
  pending: 4,
  binding,
  read_scope_keys: [key],
  write_scope_key: key,
  latest_job: {
    id: "job",
    kind: "manual",
    session_id: null,
    status: "succeeded",
    result_id: memoryId,
    error_code: null,
    created_at: now,
    finished_at: now,
  },
};
const memory = {
  id: memoryId,
  name: "group apples",
  summary: "apples",
  tags: [],
  kinds: [],
  scope: "reality_user",
  scope_key: key,
  status: "active" as const,
  created_at: now,
};
function setup(overrides: Partial<typeof api> = {}) {
  const client = {
    ...api,
    listMemoryScopes: vi.fn().mockResolvedValue([
      {
        ...scope,
        scope_key: agentId,
        read_scope_keys: null,
        write_scope_key: agentId,
        binding: null,
        pending: null,
      },
      scope,
    ]),
    listMemoryEntries: vi.fn().mockResolvedValue({ total: 1, items: [memory] }),
    updateQqBinding: vi.fn().mockResolvedValue({
      ...binding,
      memory_batch_size: 30,
      pending_observations: 4,
      revision: 3,
    }),
    organiseQqMemory: vi.fn().mockResolvedValue({ status: "queued", job_id: "job", pending: 4 }),
    getPolicy: vi
      .fn()
      .mockResolvedValue({ auto_enabled: true, every_turns: 20, target_chars: 1200, version: 3 }),
    ...overrides,
  };
  store.getState().resetForTests(client);
  store.setState({
    editorAgentId: agentId,
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "long-memory",
  });
  return client;
}
beforeEach(() => {
  selectLocale("zh-CN");
  setup();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory center", () => {
  it("keeps already-saved bindings saved when a later binding conflicts", async () => {
    const other = "44444444-4444-4444-8444-444444444444";
    setup({
      updateQqBinding: vi
        .fn()
        .mockResolvedValueOnce({ ...binding, revision: 3 })
        .mockRejectedValueOnce(new Error("conflict")),
    });
    store.getState().patchQqMemoryBatchDraft(bindingId, { value: "30", revision: 2 });
    store.getState().patchQqMemoryBatchDraft(other, { value: "40", revision: 5 });
    expect(await store.getState().saveQqMemoryBatchDrafts()).toBe(false);
    expect(Object.keys(store.getState().qqMemoryBatchDrafts)).toEqual([other]);
  });
});
