// 预热覆盖总检：登记表是唯一真源（8 space 全登记），编排器数据阶段与 store 出口接线。
// 各资源自身的服务级语义由 agent-preload / library-preload / connection-preload / preload-data-actions 各自覆盖。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntriesList, PersonaResponse } from "../../src/shared/contracts";
import type { KnowledgeDocument } from "../../src/shared/contracts/knowledge";
import { api } from "../../src/web/api";
import { clearAgentPreloadCache } from "../../src/web/services/agent-preload";
import type { ChunkPreloadItem } from "../../src/web/state/preload-orchestrator";
import { startChunkPreload } from "../../src/web/state/preload-orchestrator";
import { PRELOAD_REGISTRY } from "../../src/web/state/preload-registry";
import { useSuperstringStore as store } from "../../src/web/store";
import { ENVIRONMENT, SPACES } from "../../src/web/workspace/navigation";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 空闲调度手泵：不自动触发，测试手动 fire，未触发的空闲回调可被 cancel 注销。 */
function makePump() {
  const pumps: Array<() => void> = [];
  return {
    pumps,
    fire: (index: number) => pumps[index]?.(),
    scheduleIdle: (callback: () => void) => {
      const entry = () => callback();
      pumps.push(entry);
      return () => {
        const index = pumps.indexOf(entry);
        if (index >= 0) pumps.splice(index, 1);
      };
    },
  };
}

const registryEntry = (space: string) => {
  const entry = PRELOAD_REGISTRY.find((item) => item.space === space);
  expect(entry, `space ${space} must be registered`).toBeTruthy();
  return entry;
};

beforeEach(() => {
  clearAgentPreloadCache();
  store.getState().resetForTests();
  vi.restoreAllMocks();
});

describe("registry coverage (single source of truth)", () => {
  it("8 个导航 space 全登记且数据阶段自洽：eligible 必有 loadData，excluded 只留精准理由不发数据", () => {
    const navigationSpaces = [...SPACES, ...ENVIRONMENT].map((space) => space.id);
    const registered = PRELOAD_REGISTRY.map((entry) => entry.space);
    expect([...registered].sort()).toEqual([...navigationSpaces].sort());
    for (const entry of PRELOAD_REGISTRY) {
      if (entry.dataStatus === "eligible") {
        expect(typeof entry.loadData).toBe("function");
      } else {
        expect(entry.loadData).toBeUndefined();
        expect((entry.excludedReason ?? "").length).toBeGreaterThan(0);
      }
    }
  });
});

describe("orchestrator data phase", () => {
  it("chunk 落定后执行 loadData；失败被后台吞掉不阻塞后续项；preloadData:false 只载 chunk", async () => {
    const pump = makePump();
    const order: string[] = [];
    const items: ChunkPreloadItem[] = [
      {
        id: "a",
        loadChunk: async () => void order.push("chunk:a"),
        loadData: async () => {
          order.push("data:a");
          throw new Error("warm failed");
        },
      },
      {
        id: "b",
        loadChunk: async () => void order.push("chunk:b"),
        loadData: async () => void order.push("data:b"),
      },
    ];
    startChunkPreload({ items, concurrency: 1, scheduleIdle: pump.scheduleIdle });
    pump.fire(0);
    await flush();
    pump.fire(pump.pumps.length - 1);
    await flush();
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["chunk:a", "data:a", "chunk:b", "data:b"]);

    const chunkOnly: string[] = [];
    startChunkPreload({
      items: [
        {
          id: "x",
          loadChunk: async () => void chunkOnly.push("chunk:x"),
          loadData: async () => void chunkOnly.push("data:x"),
        },
      ],
      concurrency: 1,
      scheduleIdle: pump.scheduleIdle,
      preloadData: false,
    });
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(chunkOnly).toEqual(["chunk:x"]);
  });

  it("cancel() 之后未派发项不再载 chunk 也不再预热", async () => {
    const pump = makePump();
    const order: string[] = [];
    const items: ChunkPreloadItem[] = [
      {
        id: "a",
        loadChunk: async () => void order.push("chunk:a"),
        loadData: async () => void order.push("data:a"),
      },
      {
        id: "b",
        loadChunk: async () => void order.push("chunk:b"),
        loadData: async () => void order.push("data:b"),
      },
    ];
    const handle = startChunkPreload({
      items,
      concurrency: 1,
      scheduleIdle: pump.scheduleIdle,
    });
    pump.fire(0);
    await flush();
    handle.cancel();
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["chunk:a"]);
  });
});

describe("store outlets via registry loadData", () => {
  it("助手预热命中 bootstrap 后的目标助手：persona + 记忆前 100 条只发一次；草稿期让位", async () => {
    const getPersona = vi.fn().mockResolvedValue({
      agent_id: AGENT,
      core_identity: "x",
    } as PersonaResponse);
    const listMemoryEntries = vi.fn().mockResolvedValue({ total: 0, items: [] } as EntriesList);
    store.getState().resetForTests({
      ...api,
      getPersona,
      listMemoryEntries,
    } as unknown as typeof api);
    store.setState({
      selectedNewSessionAgentId: AGENT,
      agents: [],
      dirty: false,
    });

    const assistants = registryEntry("assistants");
    expect(assistants?.dataStatus).toBe("eligible");
    await assistants?.loadData?.();
    await assistants?.loadData?.();
    expect(getPersona).toHaveBeenCalledTimes(1);
    expect(listMemoryEntries).toHaveBeenCalledTimes(1);
    expect(listMemoryEntries).toHaveBeenCalledWith(AGENT, 0, 100);

    store.setState({ dirty: true });
    await assistants?.loadData?.();
    expect(getPersona).toHaveBeenCalledTimes(1);
    expect(listMemoryEntries).toHaveBeenCalledTimes(1);
  });

  it("知识预热走 background 首页一次：就绪后复用不重发，sticky excluded 资源无 loadData", async () => {
    const categories = [{ id: "default", name: "资料", revision: 1, document_count: 1 }];
    const settings = { revision: 1, auto_enabled: true, model_name: null, context_budget: 2048 };
    const document: KnowledgeDocument = {
      id: "33333333-3333-4333-8333-333333333333",
      category_id: "default",
      name: "预热资料",
      import_type: "md",
      content_mode: "draft",
      content_version: 1,
      revision: 2,
      created_at: NOW,
      updated_at: NOW,
      agent_ids: [],
      summary: "",
      tags: [],
      organization_status: "queued",
      error_code: null,
    };
    const listKnowledgeDocuments = vi
      .fn()
      .mockResolvedValue({ items: [document], next_cursor: null, total: 1 });
    store.getState().resetForTests({
      ...api,
      listKnowledgeDocuments,
      listKnowledgeCategories: vi.fn().mockResolvedValue(categories),
      getKnowledgeSettings: vi.fn().mockResolvedValue(settings),
    } as unknown as typeof api);

    const library = registryEntry("library");
    expect(library?.dataStatus).toBe("eligible");
    await library?.loadData?.();
    await library?.loadData?.();
    expect(listKnowledgeDocuments).toHaveBeenCalledTimes(1);
    expect(store.getState().knowledgeLoaded).toBe(true);

    // 无界/已由 bootstrap 覆盖的资源维持 excluded：登记表只承认精准理由，不给 loadData。
    for (const entry of PRELOAD_REGISTRY) {
      if (entry.space === "models") {
        expect(entry.dataStatus).toBe("excluded");
        expect(entry.loadData).toBeUndefined();
      }
    }
  });
});
