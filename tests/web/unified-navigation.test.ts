import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { permissionSettingsDirty } from "../../src/web/features/access/permission-state";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace, SPACES } from "../../src/web/workspace/navigation";
import { SETTINGS_ROUTES } from "../../src/web/workspace/settings-routes";
import { summaryFixture } from "./helpers/chat-fixture";

const GROUP: ConversationSummary = {
  ...summaryFixture("group-binding"),
  id: "group",
  channel: "onebot11",
  topology: "shared",
  title: "同事群",
};

const permissionSnapshot = (): PermissionsResponse => ({
  revision: "r1",
  policy: {
    version: 1,
    execution: ExecutionPolicySchema.parse({}),
    grants: [{ resource: "mcp.demo.read", approved: false, revision: "v1", directories: [] }],
  },
  resources: [
    {
      name: "mcp.demo.read",
      resource: "mcp.demo.read",
      description: "Read",
      effect: "read",
      revision: "v1",
      approvalRequired: false,
    },
  ],
});

beforeEach(() => {
  store.getState().resetForTests();
});

describe("对话视图：默认值与守卫入口", () => {
  it("默认是消息/当前；同页切换保留显式全局范围", () => {
    expect(store.getState().conversationView).toBe("messages");
    expect(store.getState().conversationScope).toBe("current");

    store.setState({ page: "chat", settingsView: "hub" });
    store.getState().requestConversationView("activity", "global");
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "activity",
      conversationScope: "global",
      pendingNavigation: null,
    });
    // 未指定 scope 用 current。
    store.getState().requestConversationView("tasks");
    expect(store.getState().conversationView).toBe("tasks");
    expect(store.getState().conversationScope).toBe("current");
  });

  it("openChat 从全局观测返回消息/当前", () => {
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
    store.getState().openChat();
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
    });
  });

  it("忙碌拒绝：不改视图、不排队", () => {
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
      settingsSaving: true,
    });
    store.getState().requestConversationView("messages", "current");
    expect(store.getState()).toMatchObject({
      conversationView: "activity",
      conversationScope: "global",
      pendingNavigation: null,
    });
  });

  it("同页切换视图仍保护 QQ 草稿，取消不改变视图或范围", () => {
    store.setState({ page: "chat", settingsView: "hub" });
    store.setState({ qqInputs: { ...store.getState().qqInputs, manualPeer: "12345" } });
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "chat",
      settingsView: "hub",
      conversationView: "tasks",
      conversationScope: "global",
    });
    expect(store.getState().conversationView).toBe("messages");
    store.getState().cancelPendingNavigation();
    expect(store.getState().qqInputs.manualPeer).toBe("12345");
    expect(store.getState().conversationScope).toBe("current");
  });

  it("同页切视图也保护知识库草稿：确认后保存并落地，取消不改视图", async () => {
    const saveKnowledge = vi.fn().mockResolvedValue(true);
    store.setState({
      page: "chat",
      settingsView: "hub",
      knowledgeDirty: true,
      saveKnowledgeEditor: saveKnowledge,
    });
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
      navigationConfirmOpen: true,
      pendingNavigation: {
        kind: "page",
        page: "chat",
        settingsView: "hub",
        conversationView: "tasks",
        conversationScope: "global",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState().conversationView).toBe("messages");
    expect(store.getState().knowledgeDirty).toBe(true);

    store.getState().requestConversationView("tasks", "global");
    await store.getState().confirmSaveAndContinue();
    expect(saveKnowledge).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "tasks",
      conversationScope: "global",
      pendingNavigation: null,
      navigationConfirmOpen: false,
    });
  });

  it("同页切视图也保护权限草稿：先确认，取消保留权限稿", async () => {
    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn(async () => structuredClone(permissionSnapshot())),
    } as unknown as typeof api);
    store.setState({ page: "chat", settingsView: "hub" });
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({ loopMaxSteps: "20" });
    store.getState().requestConversationView("activity", "global");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
      navigationConfirmOpen: true,
    });
    store.getState().cancelPendingNavigation();
    expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(true);
    expect(store.getState().conversationScope).toBe("current");
  });

  it("同页切换会话先确认 QQ 草稿，放弃后才选择目标", async () => {
    store.setState({
      page: "chat",
      settingsView: "hub",
      summaryById: { [GROUP.id]: GROUP },
      directoryIds: [GROUP.id],
      qqInputs: { ...store.getState().qqInputs, manualPeer: "12345" },
    });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState().currentConversationId).toBeNull();
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "page",
      conversationId: GROUP.id,
      conversationView: "messages",
      conversationScope: "current",
    });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().currentConversationId).toBe(GROUP.id);
    expect(store.getState().qqInputs.manualPeer).toBe("");
    expect(store.getState().pendingNavigation).toBeNull();
  });
});

describe("三选一载荷：携带、取消与落地", () => {
  const dirtyKnowledge = () => {
    const saveKnowledge = vi.fn().mockResolvedValue(true);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      knowledgeDirty: true,
      saveKnowledgeEditor: saveKnowledge,
    });
    return saveKnowledge;
  };

  it("从设置页请求视图：pending 携带完整载荷，取消不泄漏", () => {
    dirtyKnowledge();
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState().page).toBe("settings");
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "chat",
      settingsView: "hub",
      conversationView: "tasks",
      conversationScope: "global",
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState()).toMatchObject({
      page: "settings",
      pendingNavigation: null,
      navigationConfirmOpen: false,
      conversationView: "messages",
      conversationScope: "current",
    });
  });

  it("保存失败：pending 保留全部载荷、视图未切换", async () => {
    const saveKnowledge = dirtyKnowledge();
    saveKnowledge.mockResolvedValue(false);
    store.getState().requestConversationView("activity", "global");
    await store.getState().confirmSaveAndContinue();
    expect(saveKnowledge).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      page: "settings",
      navigationConfirmOpen: true,
      conversationView: "messages",
      conversationScope: "current",
    });
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
  });

  it("同页仅切视图时仍走草稿守卫：未保存记忆纠正先确认，取消不改视图", () => {
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "messages",
      conversationScope: "current",
      memoryCorrectionDirty: true,
    });
    store.getState().requestConversationView("activity", "global");
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
      navigationConfirmOpen: true,
      pendingNavigation: {
        kind: "page",
        page: "chat",
        settingsView: "hub",
        conversationView: "activity",
        conversationScope: "global",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
      pendingNavigation: null,
    });
  });

  it("保存成功：载荷随真正导航落地", async () => {
    const saveKnowledge = dirtyKnowledge();
    store.getState().requestConversationView("tasks", "global");
    await store.getState().confirmSaveAndContinue();
    expect(saveKnowledge).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "tasks",
      conversationScope: "global",
      pendingNavigation: null,
      navigationConfirmOpen: false,
    });
  });

  it("放弃并继续：载荷照常落地", async () => {
    dirtyKnowledge();
    store.getState().requestConversationView("activity", "global");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "activity",
      conversationScope: "global",
      pendingNavigation: null,
    });
  });
});

describe("requestConversationNavigation 与忙碌边界", () => {
  const rememberGroup = () =>
    store.setState({
      summaryById: { [GROUP.id]: GROUP },
      directoryIds: [GROUP.id],
      currentConversationId: null,
    });

  it("选中成功后回消息/当前（即使原先停在全局观测）", async () => {
    rememberGroup();
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState()).toMatchObject({
      currentConversationId: GROUP.id,
      conversationView: "messages",
      conversationScope: "current",
    });
  });

  it("已选中同一会话但停在全局范围：先过 QQ 草稿守卫，取消不改范围", async () => {
    rememberGroup();
    store.setState({
      page: "chat",
      settingsView: "hub",
      currentConversationId: GROUP.id,
      conversationView: "messages",
      conversationScope: "global",
      qqInputs: { ...store.getState().qqInputs, manualPeer: "12345" },
    });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState()).toMatchObject({
      conversationScope: "global",
      navigationConfirmOpen: true,
      pendingNavigation: {
        kind: "page",
        page: "chat",
        settingsView: "hub",
        conversationId: GROUP.id,
        conversationView: "messages",
        conversationScope: "current",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState().conversationScope).toBe("global");
  });

  it("选择完成前切到任务/全局：迟到完成不覆盖新视图", async () => {
    rememberGroup();
    store.setState({ page: "chat", settingsView: "hub" });
    const selection = store.getState().requestConversationNavigation(GROUP.id);
    store.getState().requestConversationView("tasks", "global");
    await selection;
    expect(store.getState()).toMatchObject({
      currentConversationId: GROUP.id,
      conversationView: "tasks",
      conversationScope: "global",
    });
  });

  it("选择完成前离开到设置：迟到完成不回写视图", async () => {
    rememberGroup();
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
    const selection = store.getState().requestConversationNavigation(GROUP.id);
    store.getState().requestPageNavigation("settings", "workspace");
    await selection;
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      conversationView: "activity",
      conversationScope: "global",
    });
  });

  it("选择完成前更换 API 客户端：迟到完成不落到新客户端", async () => {
    rememberGroup();
    store.setState({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
    });
    const selection = store.getState().requestConversationNavigation(GROUP.id);
    store.setState({ apiClient: { ...store.getState().apiClient } });
    await selection;
    expect(store.getState()).toMatchObject({
      currentConversationId: GROUP.id,
      conversationView: "activity",
      conversationScope: "global",
    });
  });

  it("守卫拦截：会话与消息/当前一起放进 pending，取消不选择", async () => {
    rememberGroup();
    store.setState({ page: "settings", settingsView: "agents", dirty: true });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState()).toMatchObject({
      page: "settings",
      currentConversationId: null,
      pendingNavigation: {
        kind: "page",
        page: "chat",
        conversationId: GROUP.id,
        conversationView: "messages",
        conversationScope: "current",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState()).toMatchObject({ currentConversationId: null, page: "settings" });
  });

  it("放弃后按载荷选择会话并回消息/当前", async () => {
    rememberGroup();
    store.setState({
      page: "settings",
      settingsView: "agents",
      dirty: true,
      conversationView: "activity",
      conversationScope: "global",
    });
    await store.getState().requestConversationNavigation(GROUP.id);
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState()).toMatchObject({
      page: "chat",
      currentConversationId: GROUP.id,
      conversationView: "messages",
      conversationScope: "current",
    });
  });

  it("忙碌拒绝不能绕过守卫直接选择", async () => {
    rememberGroup();
    store.setState({ page: "chat", settingsView: "hub", settingsSaving: true });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState()).toMatchObject({
      currentConversationId: null,
      pendingNavigation: null,
    });
  });
});

describe("运行栏目归并：台账与任务归对话", () => {
  it("openSettingsRoute 的台账路由规范化到对话全局视图", () => {
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    store.getState().openSettingsRoute("execution-ledger");
    expect(store.getState()).toMatchObject({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
      pendingNavigation: null,
    });

    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    store.getState().openSettingsRoute("task-ledger");
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "tasks",
      conversationScope: "global",
    });
  });

  it("运行路由仍走未保存守卫，不恢复 legacy 观测设置页", () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      knowledgeDirty: true,
    });
    store.getState().openSettingsRoute("task-ledger");
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      conversationView: "messages",
      conversationScope: "current",
    });
    expect(store.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "chat",
      settingsView: "hub",
      conversationView: "tasks",
      conversationScope: "global",
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState().settingsView).toBe("workspace");
  });

  it("requestPageNavigation 的 observability 视图同样规范化到活动/全局", () => {
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    store.getState().requestPageNavigation("settings", "observability");
    expect(store.getState()).toMatchObject({
      page: "chat",
      settingsView: "hub",
      conversationView: "activity",
      conversationScope: "global",
      pendingNavigation: null,
    });
  });

  it("activeSpace 与 SPACES：台账/观测归对话，绑定与应用管理归方案，不再有运行栏目", () => {
    expect(SPACES.map((space) => space.id)).toEqual([
      "conversations",
      "assistants",
      "capabilities",
      "schemes",
      "library",
      "connections",
    ]);
    expect(
      activeSpace({ page: "settings", settingsView: "observability", settingsRoute: "basic" }),
    ).toBe("conversations");
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "execution-ledger",
      }),
    ).toBe("conversations");
    expect(
      activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: "task-ledger" }),
    ).toBe("conversations");
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "scheme-bindings",
      }),
    ).toBe("schemes");
    // QQ 应用级管理（方案目录/连接/数据）与旧 operating-mode 都归方案；接入只剩外置扩展。
    for (const route of ["qq-app-schemes", "qq-connection", "qq-storage"] as const) {
      expect(
        activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: route }),
      ).toBe("schemes");
    }
    expect(
      activeSpace({ page: "settings", settingsView: "operating-mode", settingsRoute: "basic" }),
    ).toBe("schemes");
    expect(
      activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: "mcp-servers" }),
    ).toBe("connections");
  });

  it("旧 operating-mode 入口规范化到 QQ 连接，并复用同一条三选守卫", () => {
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    store.getState().requestPageNavigation("settings", "operating-mode");
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
      pendingNavigation: null,
    });
    // 有 QQ 草稿：先确认，取消保持原位与草稿。
    store.setState({
      settingsRoute: "basic",
      qqInputs: { ...store.getState().qqInputs, manualPeer: "12345" },
    });
    store.getState().requestPageNavigation("settings", "operating-mode");
    expect(store.getState()).toMatchObject({
      settingsRoute: "basic",
      navigationConfirmOpen: true,
      pendingNavigation: {
        kind: "page",
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "qq-connection",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState().qqInputs.manualPeer).toBe("12345");
    expect(store.getState().settingsRoute).toBe("basic");
  });

  it("scheme-bindings 是方案下的首次发现入口：不伪造方案 ID", () => {
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    store.getState().openSettingsRoute("scheme-bindings");
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "scheme-bindings",
      qqSchemeEditor: null,
      pendingNavigation: null,
      error: null,
    });
  });

  it("台账路由仍登记在设置路由中（外部直达与命令面板的归属不变）", () => {
    const ids = SETTINGS_ROUTES.map((route) => route.id);
    expect(ids).toContain("execution-ledger");
    expect(ids).toContain("task-ledger");
    expect(ids).toContain("scheme-bindings");
  });
});

describe("导航忙碌边界：技术自检与初始化", () => {
  const rememberGroup = () =>
    store.setState({
      summaryById: { [GROUP.id]: GROUP },
      directoryIds: [GROUP.id],
      currentConversationId: null,
    });

  it("联网自检期间拒绝视图与会话导航", async () => {
    rememberGroup();
    store.setState({ page: "chat", settingsView: "hub", webAccessTesting: true });
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState()).toMatchObject({
      conversationView: "messages",
      conversationScope: "current",
      pendingNavigation: null,
    });
    await store.getState().requestConversationNavigation(GROUP.id);
    expect(store.getState()).toMatchObject({
      currentConversationId: null,
      pendingNavigation: null,
    });
  });

  it("忙碌时 openAgentSettings 不偷跑 editAgent 初始化", () => {
    const edit = vi.fn(async () => true);
    store.setState({
      page: "settings",
      settingsView: "agents",
      editorDraft: null,
      editorAgentId: "__new__",
      agents: [],
      settingsSaving: true,
      editAgent: edit,
    });
    store.getState().openAgentSettings();
    expect(edit).not.toHaveBeenCalled();

    store.setState({ settingsSaving: false });
    store.getState().openAgentSettings();
    expect(edit).toHaveBeenCalledWith("__new__");
  });

  it("确认保存沿用导航忙碌判定：读取装载中也拒绝并保留 pending", async () => {
    const saveKnowledge = vi.fn().mockResolvedValue(true);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      knowledgeDirty: true,
      saveKnowledgeEditor: saveKnowledge,
    });
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.setState({ knowledgeReadLoading: true });
    await store.getState().confirmSaveAndContinue();
    expect(saveKnowledge).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      page: "settings",
      pendingNavigation: { kind: "page", page: "chat" },
    });
  });

  it("确认放弃同样复用忙碌判定：联网自检中拒绝且不动 pending", async () => {
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      knowledgeDirty: true,
    });
    store.getState().requestConversationView("tasks", "global");
    expect(store.getState().pendingNavigation).toMatchObject({ kind: "page", page: "chat" });
    store.setState({ webAccessTesting: true });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState()).toMatchObject({
      page: "settings",
      pendingNavigation: { kind: "page", page: "chat" },
    });
    expect(store.getState().knowledgeDirty).toBe(true);
  });

  it("无 pending 时取消不写状态", () => {
    store.setState({ page: "chat", settingsView: "hub" });
    const before = store.getState();
    store.getState().cancelPendingNavigation();
    expect(store.getState()).toBe(before);
  });
});
