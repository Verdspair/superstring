import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserStateConfig } from "../../src/shared/contracts";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import type { QqMessageFact } from "../../src/shared/contracts/qq-message";
import { createBrowserStateStorage } from "../../src/web/browser-state";
import {
  CACHE_KEYS,
  CACHE_LIMITS,
  loadDirectoryCache,
  loadQqEventsCache,
  loadWebChatCache,
  removeDirectoryCache,
  removeWebChatCache,
  saveDirectoryCache,
  saveQqEventsCache,
  saveWebChatCache,
} from "../../src/web/services/page-snapshot-cache";
import type { ChatItem } from "../../src/web/state/types";

const mockConfig: BrowserStateConfig = {
  secret: "test-secret-key-32-chars-long-!",
  storage_keys: {
    session: "superstring-session",
    agent: "superstring-agent",
  },
};

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const sampleFact: QqMessageFact = {
  id: "fact-1",
  platformMessageId: "plat-1",
  seq: 1,
  occurredAtSeconds: 1727697600,
  speaker: {
    role: "member",
    qq: "10001",
    groupCard: null,
    personalNickname: "User",
    legacyDisplayName: "User",
    nameState: "known",
    currentName: {
      groupCard: null,
      personalNickname: "User",
    },
  },
  parts: [{ kind: "text", text: "Fact text" }],
  mentions: [],
  replyTo: null,
  sources: [],
  completeness: "full",
};

const sampleEvent = (
  seq: number,
  overrides: Partial<ConversationEventView> = {},
): ConversationEventView => ({
  seq,
  eventKey: `ev-${seq}`,
  conversationId: "conv-1",
  kind: "inbound",
  source: { kind: "qq_event", id: `src-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `src-${seq}`, revision: "1" }],
  outputId: null,
  runId: null,
  wake: null,
  text: `Message ${seq}`,
  contentState: "active",
  media: [
    {
      id: "m-1",
      kind: "image",
      description: "Secret image description",
      availability: "available",
    },
  ],
  qqMessageFacts: [sampleFact],
  addressing: { reasons: ["private"], mentionIds: [] },
  deliveryStatus: null,
  messageStatus: null,
  participant: { id: "person", label: "User", role: "member" },
  occurredAt: "2026-09-30T12:00:00.000Z",
  recordedAt: "2026-09-30T12:00:00.000Z",
  ...overrides,
});

const sampleChat = (id: string, content: string): ChatItem => ({
  id,
  role: "assistant",
  content,
  status: "completed",
  errorCode: null,
  createdAt: "2026-09-30T12:00:00.000Z",
  completedAt: "2026-09-30T12:00:01.000Z",
});

describe("page-snapshot-cache unit tests", () => {
  it("1. write -> remove race: delayed write finishing after remove does NOT commit or resurrect cache", async () => {
    let unblockEncrypt!: () => void;
    const slowStorage = createBrowserStateStorage(mockConfig, sessionStorage);

    const origWrite = slowStorage.write;
    let writeStarted = false;
    slowStorage.write = async (k, v, isStale) => {
      writeStarted = true;
      await new Promise<void>((r) => {
        unblockEncrypt = r;
      });
      return origWrite(k, v, isStale);
    };

    const savePromise = saveWebChatCache(slowStorage, "session-1", "agent-1", 1, [
      sampleChat("m1", "Stale message"),
    ]);

    await vi.waitFor(() => expect(writeStarted).toBe(true));

    // Remove is called while write is blocked in encryption
    await removeWebChatCache(slowStorage, "session-1");

    // Unblock the slow encryption
    unblockEncrypt();
    await savePromise;

    // Cache must remain null! Pre-commit guard returned before setItem
    const loaded = await loadWebChatCache(slowStorage, "session-1", "agent-1");
    expect(loaded).toBeNull();
  });

  it("1b. directory write -> removeDirectoryCache race: delayed directory write finishing after remove does NOT commit or resurrect cache", async () => {
    let unblockEncrypt!: () => void;
    const slowStorage = createBrowserStateStorage(mockConfig, sessionStorage);

    const origWrite = slowStorage.write;
    let writeStarted = false;
    slowStorage.write = async (k, v, isStale) => {
      if (k === CACHE_KEYS.DIRECTORY) {
        writeStarted = true;
        await new Promise<void>((r) => {
          unblockEncrypt = r;
        });
      }
      return origWrite(k, v, isStale);
    };

    const sampleSummary: ConversationSummary = {
      id: "conv-dir-1",
      sourceId: "s-1",
      channel: "onebot11",
      topology: "shared",
      agentId: "agent-1",
      title: "Directory Test",
      bindingEpoch: 1,
      participants: [],
      updatedAt: "2026-09-30T12:00:00.000Z",
      lastSeq: 1,
      consumedSeq: 1,
    };

    const savePromise = saveDirectoryCache(slowStorage, [sampleSummary], 1);

    await vi.waitFor(() => expect(writeStarted).toBe(true));

    // Remove directory cache while write is blocked in encryption
    await removeDirectoryCache(slowStorage);

    // Unblock slow encryption
    unblockEncrypt();
    await savePromise;

    // Directory cache must remain null!
    const loaded = await loadDirectoryCache(slowStorage);
    expect(loaded).toBeNull();
  });

  it("2. out-of-order writes: slow write A finishing after fresh write B does NOT overwrite fresh commit", async () => {
    let unblockA!: () => void;
    const slowStorage = createBrowserStateStorage(mockConfig, sessionStorage);

    const origWrite = slowStorage.write;
    let aStarted = false;
    slowStorage.write = async (k, v, isStale) => {
      if (v?.includes("Write-A")) {
        aStarted = true;
        await new Promise<void>((r) => {
          unblockA = r;
        });
      }
      return origWrite(k, v, isStale);
    };

    // Start Write A (stale)
    const promiseA = saveWebChatCache(slowStorage, "session-order", "agent-1", 1, [
      sampleChat("mA", "Write-A (stale)"),
    ]);

    await vi.waitFor(() => expect(aStarted).toBe(true));

    // Write B starts and commits immediately
    await saveWebChatCache(slowStorage, "session-order", "agent-1", 2, [
      sampleChat("mB", "Write-B (fresh)"),
    ]);

    // Now unblock Write A
    unblockA();
    await promiseA;

    // Fresh Write B must remain intact! Stale Write A must have been intercepted before setItem
    const loaded = await loadWebChatCache(slowStorage, "session-order", "agent-1");
    expect(loaded?.messages[0]?.content).toBe("Write-B (fresh)");
  });

  it("3. total budget: strictly enforces the configured encrypted total cap across all cache keys including QQ events", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);

    const largeEvents = Array.from({ length: 50 }, (_, i) =>
      sampleEvent(i, { text: "A".repeat(4000) }),
    );

    for (let c = 1; c <= 5; c++) {
      await saveQqEventsCache(storage, `conv-${c}`, "agent-1", 1, largeEvents);
    }

    let totalStoredBytes = 0;
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(CACHE_KEYS.ALL_PREFIX)) {
        totalStoredBytes += (k.length + (sessionStorage.getItem(k)?.length ?? 0)) * 2;
      }
    }

    expect(totalStoredBytes).toBeLessThanOrEqual(CACHE_LIMITS.MAX_TOTAL_BYTES);
  });

  it("retains a scoped recent preview larger than the former 2 MiB budget", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const items = Array.from({ length: 200 }, (_, index) =>
      sampleEvent(index + 1, { text: "A".repeat(5000) }),
    );
    await saveQqEventsCache(storage, "conv-1", "agent-1", 1, items);
    const key = `${CACHE_KEYS.QQ_EVENTS_PREFIX}conv-1`;
    const storedBytes = (key.length + (sessionStorage.getItem(key)?.length ?? 0)) * 2;
    expect(storedBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(storedBytes).toBeLessThanOrEqual(CACHE_LIMITS.MAX_TOTAL_BYTES);
    expect(await loadQqEventsCache(storage, "conv-1", "agent-1", 1)).toHaveLength(200);
    expect(await loadQqEventsCache(storage, "conv-1", "other-agent", 1)).toBeNull();
  });

  it("4. scope check: currentAgentId known rejects cache with null or different agentId", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);

    // Save event cache with null agentId
    await saveQqEventsCache(storage, "conv-null-agent", null, 1, [sampleEvent(1)]);

    // When loading for known agent-1, null agent must be rejected!
    const loaded = await loadQqEventsCache(storage, "conv-null-agent", "agent-1", 1);
    expect(loaded).toBeNull();
  });

  it("5. expired source: redacts qqMessageFacts and media description, not just text", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const expiredEvent = sampleEvent(1, {
      source: {
        kind: "qq_media",
        id: "med-1",
        revision: "1",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    });

    await saveQqEventsCache(storage, "conv-exp", "agent-1", 1, [expiredEvent]);

    const loaded = await loadQqEventsCache(storage, "conv-exp", "agent-1", 1);
    expect(loaded).toHaveLength(1);
    const item = loaded?.[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.text).toBeNull();
    expect(item.contentState).toBe("expired");
    expect(item.qqMessageFacts).toEqual([]);
    expect(item.media[0]?.description).toBeNull();
    expect(item.media[0]?.availability).toBe("unavailable");
  });
});
