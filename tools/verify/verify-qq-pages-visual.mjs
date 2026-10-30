#!/usr/bin/env node
// Page matrix for every workspace destination this version added or changed.
//
// What it does: opens every workspace destination this version added or changed in a real browser —
// at 1920/1440/390/320, in both languages — then applies every theme in light and dark on the
// densest page, plus system mode (the OS preference decides the scheme) and a reduced-motion pass.
// Assertions are objective (horizontal overflow, a page or group that did not render, a theme or a
// system preference that did not apply, console errors, failed or off-origin requests, focus that
// never becomes visible); screenshots are written next to the report for a person to look at.
// Pixel judgement stays with the person.
//
// Navigation: the shell renders the primary destinations in a persistent <aside>
// (ProductNavigation); below 768px the same component lives inside the header's Sheet. A second
// click opens an exact localized tab or catalog row; optional `pick` clicks select a real record
// before that tab, and `scope` clicks the conversation hub's current/global buttons afterwards.
// New destinations read explicit `labelKeys` from translation.json, rejecting missing keys without
// a fallback. Selected tabs, scope buttons and destination content must all agree; opening an old
// page or only rendering a loading shell is not an accepted visit.
//
// Why a separate tool: only a real browser can be given a viewport, so this cannot be an assertion
// inside tests/web. This complements the in-app browser interaction checks.
//
// Usage (the Playwright module is not a project dependency, so point the tool at a directory that
// has one; nothing is installed by this script):
//   SUPERSTRING_PLAYWRIGHT=<dir with node_modules/playwright> \
//   SUPERSTRING_VISUAL_URL=http://127.0.0.1:17861 node tools/verify/verify-qq-pages-visual.mjs
// The page list covers selected scenarios, not all product surfaces; SUPERSTRING_VISUAL_PAGES accepts an exact comma-separated
// subset (unknown IDs fail). SUPERSTRING_VISUAL_THEME_PAGE defaults to tool-grants and must be
// selected; a focused batch can use execution-ledger or scheme-bindings without changing defaults.
// --ui-frozen records before/after source hashes and rejects HMR or changes during the matrix.
// qq-group-config opens from a QQ group's "本群配置" control (real entry, no synthetic route).
// Conversation coverage IDs: conversation-{web|qq}-messages and
// conversation-{web|qq}-{activity|tasks}-{current|global}; select only seeded fixture channels.
// Defaults to bundled Chromium; optionally set SUPERSTRING_VISUAL_BROWSER_CHANNEL=msedge
// or SUPERSTRING_VISUAL_BROWSER_EXECUTABLE for an existing isolated verification browser.
// Optional SUPERSTRING_VISUAL_FONT, SUPERSTRING_VISUAL_TEXT_SIZE and
// SUPERSTRING_VISUAL_INTERFACE_SIZE select one combination, validated against shared IDs.
// Unset dimensions retain the application's default; the script does not run a 27-fold matrix.
// Synthetic object scenarios require SUPERSTRING_VISUAL_AGENT_ID / _NAME,
// SUPERSTRING_VISUAL_WEB_SOURCE_ID / _SOURCE_TITLE, SUPERSTRING_VISUAL_QQ_GROUP_SOURCE_ID / _SOURCE_TITLE,
// and SUPERSTRING_VISUAL_SCHEME_ID / _NAME as appropriate; no real data is authorized.
// Conversation picks and task detail/evidence require SUPERSTRING_VISUAL_READY pointing to the same-run synthetic ready JSON under validation;
// conversation source/title/canonical identity and task ID/action/argument marker/source identity must agree with it.
// Reports and screenshots land in artifacts/validation unless SUPERSTRING_VISUAL_OUT names
// another (relative to the dev tree) directory — use the latter to keep phase evidence together.
// Each run writes into its own run-<timestamp> subdirectory of that directory, so an earlier
// run's evidence (screenshots, report, failure files) is never overwritten. A failing run writes
// qq-pages-failure-<timestamp>.json plus the failing page's screenshot before rethrowing, instead
// of only closing the browser.
//
// Locale and appearance are seeded into the three localStorage keys the product reads at start-up
// (superstring-locale / superstring-appearance / superstring-appearance-mode). In a plain browser
// this is the only locale source the product has — the desktop preference bridge
// (window.superstringPreferences, src/web/desktop-preferences.ts) is absent outside the desktop
// shell, and the language control is never touched, so this tool never writes a backend
// preference. Labels are always matched with the exact localized spelling from the language packs;
// there is deliberately no either-language fallback for a page this tool failed to open.

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const uiFrozen = process.argv.includes("--ui-frozen");
const url = process.env.SUPERSTRING_VISUAL_URL ?? "http://127.0.0.1:17861";
function sourceFingerprints() {
  const result = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Linked source refused");
      if (entry.isDirectory()) walk(file);
      else
        result[relative(root, file).replaceAll("\\", "/")] = createHash("sha256")
          .update(readFileSync(file))
          .digest("hex");
    }
  };
  for (const directory of ["src/web", "src/shared"]) walk(resolve(root, directory));
  const probe = fileURLToPath(import.meta.url);
  if (lstatSync(probe).isSymbolicLink()) throw new Error("Linked probe refused");
  result[relative(root, probe).replaceAll("\\", "/")] = createHash("sha256")
    .update(readFileSync(probe))
    .digest("hex");
  return result;
}
const LOCALES = ["zh-CN", "en"];
const translations = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(resolve(root, `src/web/i18n/locales/${locale}/translation.json`), "utf8"),
    ),
  ]),
);
function t(locale, key) {
  const value = translations[locale]?.[key];
  if (!Object.hasOwn(translations[locale] ?? {}, key) || typeof value !== "string" || !value.trim())
    throw new Error(`Missing translation key: ${locale}:${key}`);
  return value;
}
function labelsOf(entry, locale) {
  return (
    entry.labelKeys?.map((key) => t(locale, key)) ?? (locale === "zh-CN" ? entry.zh : entry.en)
  );
}

/**
 * `zh`/`en` or strict `labelKeys` describe [primary, secondary?]. `pick` selects a record before
 * the secondary tab; `second: "row"` opens a capability row instead. `conversation` selects a
 * real index row after filtering by channel; `scope` explicitly clicks current/global and checks
 * both pressed states, even when no selected conversation makes the hub default to global.
 * `schemeView` requires the picked scheme's editor/binding board, not just its tab labels.
 * Optional probes must exist and must not clip their content. Agent selection is explicit:
 * set SUPERSTRING_VISUAL_AGENT_ID and SUPERSTRING_VISUAL_AGENT_NAME to the synthetic fixture.
 */
const ALL_PAGES = [
  // 扩展仅管理 MCP / Skills / 外部工具授权；严格读取新一级标签，绝不回退旧接入。
  {
    id: "mcp-servers",
    labelKeys: ["workspace.extensions", "connections.mcp.title"],
    extension: "mcp",
    probe: null,
  },
  {
    id: "skill-catalog",
    labelKeys: ["workspace.extensions", "connections.skills.title"],
    extension: "skills",
    probe: null,
  },
  {
    id: "tool-grants",
    labelKeys: ["workspace.extensions", "connections.tools.title"],
    extension: "grants",
    probe: null,
  },
  {
    id: "task-ledger",
    labelKeys: ["workspace.conversations", "connections.tasks.title"],
    view: "tasks",
    scope: "global",
    probe: null,
  },
  {
    id: "execution-ledger",
    labelKeys: ["workspace.conversations", "workspace.runtime_observability"],
    view: "activity",
    scope: "global",
    probe: null,
  },
  // Web 与 QQ 的三种视图、两种运行范围均从目录行真实点击进入；消息记录没有全局开关。
  ...["web", "qq"].flatMap((channel) => [
    {
      id: `conversation-${channel}-messages`,
      labelKeys: ["workspace.conversations", "workspace.message_history"],
      conversation: channel,
      view: "messages",
      probe: channel === "web" ? "main textarea" : 'main [role="tabpanel"]',
    },
    ...["current", "global"].flatMap((scope) => [
      {
        id: `conversation-${channel}-activity-${scope}`,
        labelKeys: ["workspace.conversations", "workspace.runtime_observability"],
        conversation: channel,
        view: "activity",
        scope,
        probe: null,
      },
      {
        id: `conversation-${channel}-tasks-${scope}`,
        labelKeys: ["workspace.conversations", "connections.tasks.title"],
        conversation: channel,
        view: "tasks",
        scope,
        probe: null,
      },
    ]),
  ]),
  // 系统能力一级目录与目录行打开的能力详情；执行设置、联网从运行、接入移归此处。
  // 目录行是 button 行而不是页签，行名与详情页 section[aria-label] 共用同一 nameKey，
  // 所以标签取实际语言包（capabilities.*.name / connections.web.title），不做宽松回退。
  {
    id: "system-capabilities",
    zh: ["系统能力"],
    en: ["System capabilities"],
    probe: null,
    landmark: "region",
  },
  {
    id: "memory-tools",
    zh: ["系统能力", "记忆查询"],
    en: ["System capabilities", "Memory query"],
    second: "row",
    probe: null,
    explicitAgent: true,
    landmark: "region",
  },
  {
    id: "knowledge-tools",
    zh: ["系统能力", "知识查询"],
    en: ["System capabilities", "Knowledge query"],
    second: "row",
    probe: null,
    explicitAgent: true,
    landmark: "region",
  },
  {
    id: "media-tools",
    zh: ["系统能力", "媒体与表情"],
    en: ["System capabilities", "Media and stickers"],
    second: "row",
    probe: null,
    landmark: "region",
  },
  {
    id: "web-access",
    zh: ["系统能力", "联网"],
    en: ["System capabilities", "Web access"],
    second: "row",
    probe: null,
    landmark: "region",
  },
  {
    id: "qq-members",
    labelKeys: ["workspace.capabilities", "capabilities.members.name"],
    second: "row",
    probe: null,
    landmark: "region",
  },
  {
    id: "execution-settings",
    zh: ["系统能力", "任务与执行限制"],
    en: ["System capabilities", "Tasks and execution limits"],
    second: "row",
    probe: null,
    landmark: "region",
  },
  // 会话历史摘要页（系统能力下以 link 类型入口打开，只负责展示与跳转说明）。
  {
    id: "session-history",
    zh: ["系统能力", "会话历史摘要"],
    en: ["System capabilities", "Session history summary"],
    second: "row",
    probe: null,
    landmark: "region",
  },
  {
    id: "model-services",
    labelKeys: ["workspace.model_services"],
    probe: null,
  },
  {
    id: "model-service-add",
    labelKeys: ["workspace.model_services"],
    overlay: "model-service-add",
    probe: '[role="dialog"]',
  },
  ...[
    ["agent-identity", "strict.task.identity"],
    ["agent-capabilities", "strict.task.models"],
    ["agent-tools", "strict.tools.title"],
    ["agent-materials", "strict.reading.title"],
  ].map(([id, agentTask]) => ({
    id,
    labelKeys: ["library.assistant"],
    agentTask,
    probe: '[role="tabpanel"][data-state="active"]',
  })),
  // operating-mode 保留旧页面 ID；真实点击路径与新连接路由相同。
  ...["operating-mode", "qq-connection"].map((id) => ({
    id,
    labelKeys: ["workspace.schemes"],
    qqAppTab: "connection",
    probe: 'input[autocomplete="new-password"]',
  })),
  {
    id: "qq-stickers",
    zh: ["资料", "表情素材"],
    en: ["Materials", "Sticker library"],
    probe: null,
  },
  // 方案目录保持目录；详情先选方案，再验证方案设置/使用会话两 view，以及设置内六目的分组。
  {
    id: "scheme-library",
    labelKeys: ["workspace.schemes"],
    probe: null,
    landmark: "region",
  },
  {
    id: "qq-app-schemes",
    labelKeys: ["workspace.schemes"],
    qqAppTab: "schemes",
    probe: "[data-scheme-open]",
  },
  {
    id: "qq-scheme-config",
    labelKeys: ["workspace.schemes"],
    probe: null,
    pick: "[data-scheme-open]",
    schemeView: "settings",
    // 六目的分组（发言时机/回复方式/消息读取/历史压缩/图片理解/表情发送）取代旧四参数 Tab。
    finalTabKeys: [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ],
  },
  {
    id: "scheme-bindings",
    labelKeys: ["workspace.schemes", "schemes.bindings.viewBindings"],
    probe: '[data-scheme-view="bindings"]',
    pick: "[data-scheme-open]",
    schemeView: "bindings",
    finalTabKeys: ["schemes.bindings.viewSettings", "schemes.bindings.viewBindings"],
  },
  {
    id: "qq-storage",
    labelKeys: ["workspace.schemes"],
    qqAppTab: "storage",
    probe: null,
  },
  // 本群配置（qq-group-config）只从真实入口进入：QQ 群的「本群控制」控件里的「本群配置」按钮
  // （QqGroupControls → openQqGroupConfig，走统一导航守卫）。不新造路由、不直连内部状态。
  {
    id: "qq-group-config",
    labelKeys: ["workspace.conversations"],
    conversation: "qq",
    groupConfig: true,
    probe: null,
    finalTabKeys: [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
      "schemes.qq.groupConfig.capabilities",
    ],
  },
  { id: "long-memory", zh: ["资料", "记忆"], en: ["Materials", "Memory"], probe: null },
  {
    id: "memory-manual-sheet",
    zh: ["资料", "记忆"],
    en: ["Materials", "Memory"],
    overlay: "memory-manual",
    probe: '[role="dialog"]',
  },
  {
    id: "memory-rebuild-sheet",
    zh: ["资料", "记忆"],
    en: ["Materials", "Memory"],
    overlay: "memory-rebuild",
    probe: '[role="dialog"]',
  },
  // 资料里的知识库配置页（文档页），挂在「资料」分区下。
  { id: "knowledge-config", zh: ["资料", "文档"], en: ["Materials", "Documents"], probe: null },
  {
    id: "knowledge-settings-sheet",
    zh: ["资料", "文档"],
    en: ["Materials", "Documents"],
    overlay: "knowledge-settings",
    probe: '[role="dialog"]',
  },
  {
    id: "qq-events",
    labelKeys: ["workspace.schemes"],
    qqAppTab: "connection",
    qqTask: "events",
    probe: null,
  },
  {
    id: "qq-runtime",
    labelKeys: ["workspace.schemes"],
    qqAppTab: "connection",
    qqTask: "runtime",
    probe: null,
  },
  { id: "general", zh: ["偏好"], en: ["Preferences"], probe: null },
  {
    id: "knowledge-document",
    zh: ["资料", "文档"],
    en: ["Materials", "Documents"],
    overlay: "knowledge-document",
    probe: '[role="dialog"]',
  },
  {
    id: "knowledge-grants",
    zh: ["资料", "文档"],
    en: ["Materials", "Documents"],
    overlay: "knowledge-grants",
    probe: '[role="dialog"]',
  },
  {
    id: "knowledge-import",
    zh: ["资料", "文档"],
    en: ["Materials", "Documents"],
    overlay: "knowledge-import",
    probe: '[role="dialog"]',
  },
  {
    id: "memory-owned-detail",
    zh: ["资料", "记忆"],
    en: ["Materials", "Memory"],
    overlay: "memory-owned",
    probe: '[role="dialog"]',
  },
  {
    id: "memory-received-detail",
    zh: ["资料", "记忆"],
    en: ["Materials", "Memory"],
    overlay: "memory-received",
    probe: '[role="dialog"]',
  },
  {
    id: "memory-source-preview",
    zh: ["资料", "记忆"],
    en: ["Materials", "Memory"],
    overlay: "memory-source-preview",
    probe: '[role="dialog"]',
  },
  {
    id: "sticker-detail",
    zh: ["资料", "表情素材"],
    en: ["Materials", "Sticker library"],
    overlay: "sticker-detail",
    probe: '[role="dialog"]',
  },
  {
    id: "model-service-edit",
    labelKeys: ["workspace.model_services"],
    overlay: "model-service-edit",
    probe: '[role="dialog"]',
  },
  {
    id: "workspace-search",
    labelKeys: ["workspace.capabilities"],
    overlay: "search",
    probe: '[role="dialog"]',
  },
  {
    id: "library-scroll-return",
    labelKeys: ["workspace.materials", "library.memory"],
    libraryScroll: true,
    probe: null,
  },
  {
    id: "skill-detail",
    labelKeys: ["workspace.extensions", "connections.skills.title"],
    extension: "skills",
    overlay: "skill-detail",
    probe: '[role="dialog"]',
  },
  {
    id: "tool-detail",
    labelKeys: ["workspace.extensions", "connections.tools.title"],
    extension: "grants",
    overlay: "tool-detail",
    probe: '[role="dialog"]',
  },
  {
    id: "agent-navigation-guard",
    labelKeys: ["library.assistant"],
    agentTask: "strict.task.identity",
    overlay: "agent-guard",
    probe: '[role="tabpanel"][data-state="active"]',
  },
  {
    id: "agent-identity-save",
    labelKeys: ["library.assistant"],
    agentTask: "strict.task.identity",
    overlay: "agent-save",
    probe: '[role="tabpanel"][data-state="active"]',
  },
  {
    id: "task-detail",
    labelKeys: ["workspace.conversations", "connections.tasks.title"],
    view: "tasks",
    scope: "global",
    overlay: "task-detail",
    probe: '[role="dialog"]',
  },
  {
    id: "task-run-detail",
    labelKeys: ["workspace.conversations", "connections.tasks.title"],
    view: "tasks",
    scope: "global",
    overlay: "task-run",
    probe: '[data-slot="dialog-content"]',
  },
  {
    id: "task-run-evidence",
    labelKeys: ["workspace.conversations", "connections.tasks.title"],
    view: "tasks",
    scope: "global",
    overlay: "task-evidence",
    probe: '[data-slot="dialog-content"]',
  },
  {
    id: "trace-detail",
    labelKeys: ["workspace.conversations", "workspace.runtime_observability"],
    view: "activity",
    scope: "global",
    traceDetail: true,
    probe: null,
  },
  {
    id: "trace-compare",
    labelKeys: ["workspace.conversations", "workspace.runtime_observability"],
    view: "activity",
    scope: "global",
    traceCompare: true,
    probe: null,
  },
  {
    id: "activity-filter",
    labelKeys: ["workspace.conversations", "workspace.runtime_observability"],
    view: "activity",
    scope: "global",
    overlay: "activity-filter",
    probe: '[role="dialog"]',
  },
  {
    id: "context-usage",
    labelKeys: ["workspace.conversations", "workspace.message_history"],
    conversation: "web",
    view: "messages",
    overlay: "context-usage",
    probe: '[role="dialog"]',
  },
  {
    id: "conversation-details",
    labelKeys: ["workspace.conversations", "workspace.message_history"],
    conversation: "web",
    view: "messages",
    overlay: "conversation-details",
    probe: '[role="dialog"]',
  },
  {
    id: "conversation-create",
    labelKeys: ["workspace.conversations", "workspace.message_history"],
    conversation: "web",
    view: "messages",
    overlay: "conversation-create",
    probe: '[role="dialog"]',
  },
  {
    id: "scheme-binding-editor",
    labelKeys: ["workspace.schemes", "schemes.bindings.viewBindings"],
    pick: "[data-scheme-open]",
    schemeView: "bindings",
    overlay: "binding-editor",
    probe: '[role="dialog"]',
  },
  {
    id: "global-bindings",
    labelKeys: ["workspace.schemes"],
    globalBindings: true,
    probe: '[data-bindings-scope="global"]',
  },
  {
    id: "scheme-scroll-return",
    labelKeys: ["workspace.schemes"],
    pick: "[data-scheme-open]",
    schemeView: "settings",
    schemeScroll: true,
    probe: '[role="tabpanel"][data-state="active"]',
  },
  {
    id: "scheme-create-dialog",
    labelKeys: ["workspace.schemes"],
    overlay: "scheme-create",
    probe: '[role="dialog"]',
  },
  {
    id: "global-binding-add",
    labelKeys: ["workspace.schemes"],
    globalBindings: true,
    overlay: "binding-add",
    probe: '[role="dialog"]',
  },
  {
    id: "qq-private-config",
    labelKeys: ["workspace.conversations"],
    conversation: "qq-private",
    groupConfig: true,
    probe: null,
    finalTabKeys: [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ],
  },
];
const requestedPages = process.env.SUPERSTRING_VISUAL_PAGES?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const unknownPages = requestedPages?.filter((id) => !ALL_PAGES.some((entry) => entry.id === id));
if (unknownPages?.length)
  throw new Error(`SUPERSTRING_VISUAL_PAGES contains unknown pages: ${unknownPages.join(", ")}`);
const PAGES = requestedPages
  ? ALL_PAGES.filter((entry) => requestedPages.includes(entry.id))
  : ALL_PAGES;
if (!PAGES.length) throw new Error("No visual pages selected");
const requestedThemePage = process.env.SUPERSTRING_VISUAL_THEME_PAGE ?? "tool-grants";
const THEME_PAGE = PAGES.find((entry) => entry.id === requestedThemePage);
if (!THEME_PAGE) throw new Error("Theme page must be included in the selected visual pages");
for (const entry of PAGES) {
  assert(
    entry.scope === undefined || ["current", "global"].includes(entry.scope),
    `${entry.id}: invalid scope`,
  );
  assert(
    entry.view === undefined || ["messages", "activity", "tasks"].includes(entry.view),
    `${entry.id}: invalid view`,
  );
  assert(
    entry.scope === undefined || ["activity", "tasks"].includes(entry.view),
    `${entry.id}: scope needs an activity/tasks view`,
  );
  assert(
    entry.scope !== "current" || entry.conversation !== undefined,
    `${entry.id}: current scope needs a conversation pick`,
  );
  assert(
    entry.conversation === undefined || ["web", "qq", "qq-private"].includes(entry.conversation),
    `${entry.id}: invalid conversation channel`,
  );
  assert(
    entry.schemeView === undefined || ["settings", "bindings"].includes(entry.schemeView),
    `${entry.id}: invalid scheme view`,
  );
  assert(
    entry.qqAppTab === undefined || ["schemes", "connection", "storage"].includes(entry.qqAppTab),
    `${entry.id}: invalid QQ app tab`,
  );
  assert(
    entry.groupConfig === undefined || entry.groupConfig === true,
    `${entry.id}: invalid groupConfig flag`,
  );
  assert(
    entry.groupConfig !== true || ["qq", "qq-private"].includes(entry.conversation),
    `${entry.id}: groupConfig needs a QQ conversation pick`,
  );
  assert(
    entry.extension === undefined || ["mcp", "skills", "grants"].includes(entry.extension),
    `${entry.id}: invalid extension tab`,
  );
  for (const locale of LOCALES) {
    const labels = labelsOf(entry, locale);
    assert(labels?.length >= 1 && labels.length <= 2, `${entry.id}: invalid navigation labels`);
    for (const key of entry.finalTabKeys ?? []) t(locale, key);
    if (entry.id === "scheme-library") t(locale, "connections.transportPage.tab");
    if (entry.qqAppTab) {
      for (const key of [
        "workspace.schemes",
        "connections.transportPage.tab",
        "connections.dataRetention",
        "connections.enableQq",
        "connections.assistantAccount",
        "connections.websocketAddress",
        "connections.accessToken",
        "connections.saveAccessSettings",
        "schemes.qq.appTitle",
        "connections.storage.title",
        "connections.storage.runtime",
        "connections.storage.sweep",
        "connections.common.refresh",
      ])
        t(locale, key);
    }
    if (entry.extension) {
      for (const key of [
        "workspace.extensions",
        "connections.mcp.title",
        "connections.skills.title",
        "connections.grants.title",
        "connections.refreshState",
        "connections.common.refresh",
        "connections.enableQq",
        "connections.conversationBindings",
        "connections.grants.group.builtin",
      ])
        t(locale, key);
    }
    if (entry.schemeView) {
      for (const key of [
        "connections.chooseAChatScheme",
        "schemes.bindings.viewSettings",
        "schemes.bindings.viewBindings",
        "schemes.bindings.add",
        "schemes.bindings.refresh",
      ])
        t(locale, key);
    }
    if (entry.view) {
      t(locale, "workspace.conversation_view");
      if (entry.view === "activity") {
        for (const key of [
          "observability.executionWorkspace",
          "observability.searchRuntimeRecords",
          "observability.loadingRuns",
          "observability.loadingProcessingState",
          "observability.integrated.globalTitle",
        ])
          t(locale, key);
        if (entry.scope === "current") t(locale, "workspace.conversationHub.activityTitle");
      }
      if (entry.view === "tasks") {
        t(locale, "connections.tasks.filterStatus");
        t(locale, "connections.tasks.filterConversation");
        t(locale, "connections.tasks.currentConversationScope");
        t(locale, "connections.common.refresh");
      }
      if (entry.view === "messages") {
        t(locale, "workspace.enter_a_message");
        t(locale, "workspace.loading_conversation");
        t(locale, "workspace.conversationHub.scope");
      }
    }
    if (entry.scope) {
      for (const key of [
        "workspace.conversationHub.scope",
        "workspace.conversationHub.scopeCurrent",
        "workspace.conversationHub.scopeGlobal",
      ])
        t(locale, key);
    }
    if (entry.conversation) {
      for (const key of [
        "workspace.conversation_index",
        "workspace.open_conversation_index",
        "workspace.conversation_channels",
        "workspace.message_history",
        entry.conversation === "web" ? "channel.web" : "channel.onebot",
      ])
        t(locale, key);
    }
  }
}
// The theme list is read from its one source rather than copied, so a new theme is covered here
// without editing this file. Only the THEMES block is read: MODES has the same `{ id, name }` shape
// and would otherwise contribute "system"/"light"/"dark" as if they were palettes.
const appearanceSource = readFileSync(resolve(root, "src/shared/appearance.ts"), "utf8");
const themesBlock = /export const THEMES = \[([\s\S]*?)\] as const;/.exec(appearanceSource)?.[1];
if (themesBlock === undefined)
  throw new Error("THEMES block not found in src/shared/appearance.ts");
const THEMES = [...themesBlock.matchAll(/\{ id: "([a-z]+)", name: "/g)].map((match) => match[1]);
// The main page matrix uses the first currently selectable palette from the shared owner.
// THEMES remains the full set so the separate compatibility scan keeps retired palettes covered.
const selectableBlock =
  /export const SELECTABLE_THEMES = THEMES\.filter\(\(theme\) =>\s*\[([^\]]+)\]\.includes\(theme\.id\),\s*\)/.exec(
    appearanceSource,
  )?.[1];
if (selectableBlock === undefined)
  throw new Error("SELECTABLE_THEMES list not found in src/shared/appearance.ts");
const SELECTABLE_THEMES = [...selectableBlock.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
if (!SELECTABLE_THEMES.length || SELECTABLE_THEMES.some((id) => !THEMES.includes(id)))
  throw new Error("Invalid SELECTABLE_THEMES list in src/shared/appearance.ts");
const MATRIX_THEME = SELECTABLE_THEMES[0];

// IDs and storage keys come from the shared appearance owner; scale numbers come from CSS.
function appearanceIds(name) {
  const body = new RegExp(String.raw`export const ${name} = \[([\s\S]*?)\] as const;`).exec(
    appearanceSource,
  )?.[1];
  if (body === undefined) throw new Error(`${name} block not found`);
  const ids = [...body.matchAll(/\{ id: "([a-z]+)"/g)].map((match) => match[1]);
  if (!ids.length) throw new Error(`${name} has no IDs`);
  return ids;
}
function storageKey(name) {
  const value = new RegExp(`export const ${name} = "([^"]+)";`).exec(appearanceSource)?.[1];
  if (!value) throw new Error(`${name} not found`);
  return value;
}
const appearanceDimensions = Object.fromEntries(
  [
    ["font", "FONTS", "FONT_STORAGE_KEY", "SUPERSTRING_VISUAL_FONT", 0],
    ["textSize", "TEXT_SIZES", "TEXT_SIZE_STORAGE_KEY", "SUPERSTRING_VISUAL_TEXT_SIZE", 1],
    [
      "interfaceSize",
      "INTERFACE_SIZES",
      "INTERFACE_SIZE_STORAGE_KEY",
      "SUPERSTRING_VISUAL_INTERFACE_SIZE",
      1,
    ],
  ].map(([axis, list, key, env, defaultIndex]) => {
    const ids = appearanceIds(list);
    const requested = process.env[env];
    if (requested !== undefined && !ids.includes(requested))
      throw new Error(`${env} must be one of: ${ids.join(", ")}`);
    return [
      axis,
      {
        ids,
        key: storageKey(key),
        requested: requested ?? null,
        expected: requested ?? ids[defaultIndex],
      },
    ];
  }),
);
const appearanceCss = readFileSync(resolve(root, "src/web/styles.css"), "utf8");
function cssScale(selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...appearanceCss.matchAll(new RegExp(String.raw`${escaped}\s*\{([^}]*)\}`, "g"))];
  const values = blocks.flatMap((match) => {
    const value = new RegExp(String.raw`${property}:\s*([0-9.]+)\s*;`).exec(match[1])?.[1];
    return value === undefined ? [] : [value];
  });
  if (values.length !== 1) throw new Error(`Expected one CSS scale: ${selector} ${property}`);
  const value = values[0];
  if (value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0)
    throw new Error(`Missing or invalid CSS scale: ${selector} ${property}`);
  return Number(value);
}
for (const [axis, attribute, property] of [
  ["textSize", "text-size", "--app-text-scale"],
  ["interfaceSize", "interface-size", "--app-interface-scale"],
]) {
  const dimension = appearanceDimensions[axis];
  const selector =
    dimension.expected === dimension.ids[1]
      ? ":root"
      : `html[data-${attribute}="${dimension.expected}"]`;
  dimension.expectedScale = cssScale(selector, property);
}

const playwrightRoot = process.env.SUPERSTRING_PLAYWRIGHT;
if (!playwrightRoot) {
  console.error(
    "SUPERSTRING_PLAYWRIGHT must point at a directory containing node_modules/playwright",
  );
  process.exit(2);
}
const { chromium } = createRequire(resolve(playwrightRoot, "package.json"))("playwright");
// 每轮一个时间戳子目录：报告、截图与失败证据同放其中，不覆盖任何既有证据。
const outputBase = resolve(root, process.env.SUPERSTRING_VISUAL_OUT ?? "artifacts/validation");
const runStamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outputDir = resolve(outputBase, `run-${runStamp}`);
mkdirSync(outputDir, { recursive: true });
const sourceBefore = sourceFingerprints();
const freeze = { requested: uiFrozen, sourceBefore, checked: false };

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x1000", width: 1440, height: 1000 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x700", width: 320, height: 700 },
  { name: "320x480", width: 320, height: 480 },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const slug = (value) => value.replace(/[^a-z0-9-]/gi, "-");

function schemeDetailTab(main, key, locale) {
  return key === "schemes.bindings.viewBindings"
    ? main.locator('button[role="tab"][data-scheme-usage]')
    : main.getByRole("tab", { name: t(locale, key), exact: true });
}

async function waitSettled(page, previous = null) {
  await page.evaluate(() => {
    window.__settle = undefined;
  });
  await page.waitForFunction(
    (before) => {
      const main = document.querySelector("main");
      if (main === null || main.querySelector(':scope > [role="status"]') !== null) {
        window.__settle = undefined;
        return false;
      }
      const text = (main.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length <= 40 || text === before) {
        window.__settle = undefined;
        return false;
      }
      if (window.__settle?.text !== text) {
        window.__settle = { text, at: performance.now() };
        return false;
      }
      return performance.now() - window.__settle.at > 200;
    },
    previous,
    { timeout: 15000 },
  );
}

async function waitEnabled(page, locator) {
  await locator.and(page.locator(":enabled")).waitFor({ state: "visible", timeout: 15000 });
}

async function uniqueVisible(locator, message) {
  await locator.waitFor({ state: "visible", timeout: 15000 });
  assert((await locator.count()) === 1, message);
  return locator;
}

function conversationCanvas(page) {
  return page.locator("#conversation-canvas");
}

async function selectedCanvas(page, title) {
  const canvas = await uniqueVisible(conversationCanvas(page), "Selected canvas must be unique");
  await uniqueVisible(
    canvas.getByRole("heading", { name: title, exact: true }),
    "Selected canvas title must be unique",
  );
  return canvas;
}

async function exactSurfaceProbe(page, surface) {
  await uniqueVisible(surface, "Final probe surface must be unique");
  const id = await surface.getAttribute("id");
  assert(id, "Final probe surface has no existing DOM ID");
  const selector = `[id=${JSON.stringify(id)}]`;
  assert((await page.locator(selector).count()) === 1, "Final probe DOM ID is not unique");
  return selector;
}

async function namedDialogSurface(page, name, slot) {
  return uniqueVisible(
    page.getByRole("dialog", { name, exact: true }).and(page.locator(`[data-slot="${slot}"]`)),
    `Expected one ${name} ${slot} portal`,
  );
}

async function dialogSurface(page, locale, titleKey, slot) {
  return namedDialogSurface(page, t(locale, titleKey), slot);
}

async function qqConfigRegion(page, entry, locale) {
  const title = t(
    locale,
    entry.conversation === "qq-private"
      ? "qq.conversation.privateConfig"
      : "schemes.qq.groupConfigTitle",
  );
  const region = page.locator("main").getByRole("region", { name: title, exact: true });
  await uniqueVisible(region, "QQ configuration region must be unique");
  await region.getByRole("heading", { name: title, exact: true }).waitFor();
  return region;
}

async function inspectVisit(page, navigation) {
  const metrics = await inspect(page, navigation.probe);
  return { ...metrics, probe: navigation.probe };
}

function visualReady() {
  const readyPath = process.env.SUPERSTRING_VISUAL_READY;
  assert(readyPath, "Synthetic scenarios require the same-run ready file");
  const readyFile = resolve(readyPath);
  const readyRelative = relative(resolve(root, "artifacts/validation"), readyFile);
  assert(
    readyRelative &&
      !readyRelative.startsWith("..") &&
      resolve(root, "artifacts/validation", readyRelative) === readyFile,
    "Ready file must be under validation",
  );
  const ready = JSON.parse(readFileSync(readyFile, "utf8"));
  assert(ready.ready === true && ready.url === url, "Synthetic ready instance mismatch");
  return ready;
}

function visualConversation(channel) {
  const ready = visualReady();
  const key = channel === "web" ? "web" : channel === "qq-private" ? "qqPrivate" : "qqGroup";
  const prefix = channel === "web" ? "WEB" : channel === "qq-private" ? "QQ_PRIVATE" : "QQ_GROUP";
  const source = ready.seed?.namedConversations?.[key];
  assert(
    source?.sourceId &&
      source.title &&
      source.canonicalId &&
      source.sourceId === process.env[`SUPERSTRING_VISUAL_${prefix}_SOURCE_ID`] &&
      source.title === process.env[`SUPERSTRING_VISUAL_${prefix}_SOURCE_TITLE`],
    `${channel}: synthetic ready conversation identity mismatch`,
  );
  const canonical = process.env[`SUPERSTRING_VISUAL_${prefix}_CANONICAL_ID`];
  if (canonical) assert(canonical === source.canonicalId, `${channel}: canonical ID mismatch`);
  return { sourceId: source.sourceId, title: source.title, canonicalId: source.canonicalId };
}

async function selectConversation(page, channel, locale) {
  const compact = page.viewportSize().width < 768;
  if (compact) {
    await page
      .getByRole("button", { name: t(locale, "workspace.open_conversation_index"), exact: true })
      .click();
    await page
      .getByRole("dialog", { name: t(locale, "workspace.conversation_index"), exact: true })
      .waitFor();
  }
  const directory = page.getByRole("region", {
    name: t(locale, "workspace.conversation_index"),
    exact: true,
  });
  const channelTab = directory
    .getByRole("tablist", { name: t(locale, "workspace.conversation_channels"), exact: true })
    .getByRole("tab", {
      name: t(locale, channel === "web" ? "channel.web" : "channel.onebot"),
      exact: true,
    });
  await channelTab.click();
  await channelTab.and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 15000 });
  // 当前 IndexRecord 的真实行标识是 data-source-id，aria-label 正好是会话标题；不点击管理/头像按钮。
  const expected = visualConversation(channel);
  const { sourceId, title } = expected;
  const exactRow = directory
    .getByRole("button", { name: title, exact: true })
    .and(directory.locator("button[data-source-id]"));
  await uniqueVisible(exactRow, `${channel}: synthetic directory row must be unique`);
  assert(
    (await exactRow.getAttribute("data-source-id")) === sourceId,
    `${channel}: conversation source ID mismatch`,
  );
  await exactRow.click();
  if (compact) {
    await page
      .getByRole("dialog", { name: t(locale, "workspace.conversation_index"), exact: true })
      .waitFor({ state: "hidden" });
  } else {
    await exactRow.and(page.locator('[aria-current="page"]')).waitFor({ timeout: 15000 });
  }
  await selectedCanvas(page, title);
  return expected;
}

async function assertScope(page, scope, locale) {
  const group = page.getByRole("group", {
    name: t(locale, "workspace.conversationHub.scope"),
    exact: true,
  });
  for (const value of ["current", "global"]) {
    await group
      .getByRole("button", {
        name: t(
          locale,
          value === "current"
            ? "workspace.conversationHub.scopeCurrent"
            : "workspace.conversationHub.scopeGlobal",
        ),
        exact: true,
        pressed: value === scope,
      })
      .waitFor({ timeout: 15000 });
  }
}

async function messageCanvasReady(page, channel, locale) {
  const canvas = conversationCanvas(page);
  await uniqueVisible(canvas, "Message canvas must be unique");
  if (channel === "web") {
    await uniqueVisible(
      canvas.getByRole("textbox", { name: t(locale, "workspace.enter_a_message"), exact: true }),
      "Web composer must be unique in the selected canvas",
    );
  } else {
    const panel = canvas.getByRole("tabpanel", {
      name: t(locale, "workspace.message_history"),
      exact: true,
    });
    await uniqueVisible(panel, "QQ message viewport must be unique in the selected canvas");
    await panel
      .getByText(t(locale, "workspace.loading_conversation"), { exact: true })
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  return canvas;
}

async function waitConversationView(page, entry, locale) {
  const main = page.locator("main");
  if (entry.scope) await assertScope(page, entry.scope, locale);
  if (entry.view === "activity") {
    const region = main.getByRole("region", {
      name: t(locale, "observability.executionWorkspace"),
      exact: true,
    });
    await region.waitFor();
    await region
      .getByRole("textbox", { name: t(locale, "observability.searchRuntimeRecords"), exact: true })
      .waitFor();
    await region
      .getByText(t(locale, "observability.loadingRuns"), { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
    if (entry.scope === "current") {
      await main
        .getByRole("region", {
          name: t(locale, "workspace.conversationHub.activityTitle"),
          exact: true,
        })
        .waitFor();
      await main
        .getByText(t(locale, "observability.loadingProcessingState"), { exact: true })
        .waitFor({ state: "hidden", timeout: 15000 });
    } else {
      await region
        .getByRole("heading", {
          name: t(locale, "observability.integrated.globalTitle"),
          exact: true,
        })
        .waitFor();
    }
  } else if (entry.view === "tasks") {
    await main
      .getByRole("heading", { name: t(locale, "connections.tasks.title"), exact: true })
      .waitFor();
    await main
      .getByRole("combobox", { name: t(locale, "connections.tasks.filterStatus"), exact: true })
      .waitFor();
    await waitEnabled(
      page,
      main.getByRole("button", { name: t(locale, "connections.common.refresh"), exact: true }),
    );
    const conversationFilter = main.getByRole("combobox", {
      name: t(locale, "connections.tasks.filterConversation"),
      exact: true,
    });
    if (entry.scope === "global") await conversationFilter.waitFor();
    else {
      assert(
        (await conversationFilter.count()) === 0,
        `${entry.id}: current tasks expose a global conversation filter`,
      );
      await main
        .getByText(t(locale, "connections.tasks.currentConversationScope"), { exact: true })
        .waitFor();
    }
  } else if (entry.view === "messages") {
    assert(
      (await main
        .getByRole("group", { name: t(locale, "workspace.conversationHub.scope"), exact: true })
        .count()) === 0,
      `${entry.id}: message history unexpectedly exposes runtime scope controls`,
    );
    await messageCanvasReady(page, entry.conversation, locale);
  } else throw new Error(`${entry.id}: unsupported conversation view`);
}

async function waitSchemeView(page, schemeId, view, locale) {
  assert(schemeId, "Scheme detail has no picked scheme ID");
  const main = page.locator("main");
  const titleKey =
    view === "settings" ? "schemes.bindings.viewSettings" : "schemes.bindings.viewBindings";
  for (const key of ["schemes.bindings.viewSettings", "schemes.bindings.viewBindings"])
    await schemeDetailTab(main, key, locale).waitFor({ state: "visible", timeout: 15000 });
  await schemeDetailTab(main, titleKey, locale)
    .and(page.locator('[aria-selected="true"]'))
    .waitFor({ timeout: 15000 });
  // 设置编辑器常驻隐藏：保留的 select 值仍必须属于点开的同一方案，而不是上一个编辑器。
  await page.waitForFunction(
    ({ label, expected }) =>
      [...document.querySelectorAll("main select[aria-label]")].some(
        (select) => select.getAttribute("aria-label") === label && select.value === expected,
      ),
    { label: t(locale, "connections.chooseAChatScheme"), expected: schemeId },
    { timeout: 15000 },
  );
  if (view === "bindings") {
    const board = main.locator('[data-scheme-view="bindings"]');
    await board.waitFor({ state: "visible", timeout: 15000 });
    // data-scheme-id 是已加载绑定内容的身份锚点；容器/Tab 先出现但仍在读取时不算就绪。
    await page.waitForFunction(
      (expected) => {
        const board = document.querySelector('main [data-scheme-view="bindings"]');
        return (
          board?.getAttribute("data-scheme-id") === expected ||
          board?.querySelector("[data-scheme-id]")?.getAttribute("data-scheme-id") === expected
        );
      },
      schemeId,
      { timeout: 15000 },
    );
    await waitEnabled(
      page,
      board.getByRole("button", { name: t(locale, "schemes.bindings.add"), exact: true }),
    );
    await waitEnabled(
      page,
      board.getByRole("button", { name: t(locale, "schemes.bindings.refresh"), exact: true }),
    );
    const probe = 'main [data-scheme-view="bindings"]';
    await uniqueVisible(page.locator(probe), "Current scheme binding board must be unique");
    return probe;
  } else {
    for (const key of [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ])
      await main
        .getByRole("tab", { name: t(locale, key), exact: true })
        .waitFor({ state: "visible", timeout: 15000 });
    const keys = [
      "schemes.sections.participation",
      "schemes.sections.response",
      "schemes.sections.contextReading",
      "schemes.sections.historyCompression",
      "schemes.sections.imageUnderstanding",
      "schemes.sections.stickerSending",
    ];
    const selected = keys
      .map((key) =>
        main.getByRole("tab", {
          name: t(locale, key),
          exact: true,
          selected: true,
        }),
      )
      .reduce((result, tab) => result.or(tab));
    await uniqueVisible(selected, "Scheme settings must have one selected task tab");
    const panelId = await selected.getAttribute("aria-controls");
    assert(panelId, "Selected scheme task has no existing controlled panel ID");
    const panel = main.locator(`[id=${JSON.stringify(panelId)}]`).and(main.getByRole("tabpanel"));
    return exactSurfaceProbe(page, panel);
  }
}

async function waitQqApp(page, target, locale) {
  const main = page.locator("main");
  let probe = null;
  if (target === "schemes") {
    const id = process.env.SUPERSTRING_VISUAL_SCHEME_ID;
    const name = process.env.SUPERSTRING_VISUAL_SCHEME_NAME;
    assert(id && name, "QQ schemes require synthetic scheme ID and name");
    const row = main
      .locator("button[data-scheme-open]")
      .filter({ has: page.getByText(name, { exact: true }) });
    await waitEnabled(page, row);
    assert((await row.getAttribute("data-scheme-open")) === id, "QQ scheme identity mismatch");
    probe = 'main [data-qq-retained-scroll="schemes"]';
    await uniqueVisible(page.locator(probe), "Scheme catalog owner must be unique");
  } else if (target === "connection") {
    await main
      .getByRole("heading", { name: t(locale, "schemes.qq.connectionTitle"), exact: true })
      .waitFor();
    for (const key of [
      "connections.transportPage.tab",
      "schemes.qq.eventsTitle",
      "schemes.qq.runtimeTitle",
    ])
      await main.getByRole("tab", { name: t(locale, key), exact: true }).waitFor();
    await main
      .getByRole("tab", {
        name: t(locale, "connections.transportPage.tab"),
        exact: true,
        selected: true,
      })
      .waitFor();
    probe = await exactSurfaceProbe(
      page,
      main.getByLabel(t(locale, "connections.accessToken"), { exact: true }),
    );
  } else if (target === "storage") {
    await main
      .getByRole("heading", { name: t(locale, "connections.dataRetention"), exact: true })
      .waitFor();
    await main
      .getByRole("button", { name: t(locale, "connections.common.refresh"), exact: true })
      .waitFor();
  } else throw new Error(`Unsupported QQ destination: ${target}`);
  return { app: "qq", tab: target, probe };
}

async function waitExtensions(page, entry, locale) {
  const region = page.locator("main").getByRole("region", {
    name: t(locale, "workspace.extensions"),
    exact: true,
  });
  await region.waitFor();
  const tabs = region.getByRole("tablist");
  await tabs.waitFor();
  assert((await tabs.count()) === 1, "Extensions must have one tablist");
  assert((await tabs.getByRole("tab").count()) === 3, "Extensions must have exactly three tabs");
  for (const key of [
    "connections.mcp.title",
    "connections.skills.title",
    "connections.tools.title",
  ])
    await tabs.getByRole("tab", { name: t(locale, key), exact: true }).waitFor();
  for (const key of [
    "connections.transportPage.tab",
    "connections.dataRetention",
    "connections.conversationBindings",
  ])
    assert(
      (await tabs.getByRole("tab", { name: t(locale, key), exact: true }).count()) === 0,
      `Extensions exposes QQ tab: ${key}`,
    );
  assert(
    (await region.locator(':scope > header [data-slot="badge"]').count()) === 0,
    "Extensions header has a QQ status badge",
  );
  for (const key of ["connections.refreshState", "connections.enableQq"])
    assert(
      (await region
        .getByRole(key === "connections.enableQq" ? "checkbox" : "button", {
          name: t(locale, key),
          exact: true,
        })
        .count()) === 0,
      `Extensions exposes QQ control: ${key}`,
    );
  assert(
    (await region
      .locator('input[autocomplete="new-password"], [data-scheme-view="bindings"]')
      .count()) === 0,
    "Extensions exposes QQ form or binding editor",
  );
  await region.getByRole("heading", { name: labelsOf(entry, locale)[1], exact: true }).waitFor();
  await waitEnabled(
    page,
    region.getByRole("button", { name: t(locale, "connections.common.refresh"), exact: true }),
  );
  if (entry.extension === "grants")
    assert(
      (await region
        .getByRole("heading", { name: t(locale, "connections.grants.group.builtin"), exact: true })
        .count()) === 0,
      "Extensions grants include built-in resources",
    );
  else if (entry.extension === "skills")
    await region.locator('[data-skill-name="synthetic-inspection"]').waitFor();
  else
    await region
      .getByRole("heading", { name: t(locale, "connections.mcp.title"), exact: true })
      .waitFor();
}

function visualAgent() {
  const id = process.env.SUPERSTRING_VISUAL_AGENT_ID;
  const name = process.env.SUPERSTRING_VISUAL_AGENT_NAME;
  assert(
    id && name,
    "Agent scenarios require SUPERSTRING_VISUAL_AGENT_ID and SUPERSTRING_VISUAL_AGENT_NAME for a synthetic fixture",
  );
  return { id, name };
}

async function waitAgentTask(page, locale, task, agent) {
  const main = page.locator("main");
  const title = t(locale, "agent.configuration.title").replace("{name}", agent.name);
  await main.getByRole("heading", { name: title, exact: true }).waitFor();
  await main
    .locator('[data-visual="agent-workspace-toolbar"]')
    .getByText(agent.id.slice(0, 8), { exact: true })
    .waitFor();
  const tab = main.getByRole("tab", { name: t(locale, task), exact: true });
  await tab.click();
  await main.getByRole("tab", { name: t(locale, task), exact: true, selected: true }).waitFor();
  const panel = main.getByRole("tabpanel", { name: t(locale, task), exact: true });
  await panel.waitFor();
  if (task === "strict.task.identity")
    await panel.getByLabel(t(locale, "library.name"), { exact: true }).waitFor();
  else if (task === "strict.task.models") await panel.getByTestId("agent-context-card").waitFor();
  else if (task === "strict.tools.title")
    await panel
      .getByRole("textbox", { name: t(locale, "connections.tools.search"), exact: true })
      .waitFor();
  else if (task === "strict.reading.title") {
    await panel.getByLabel(t(locale, "agent.materials.memoryBytes"), { exact: true }).waitFor();
    await panel.getByText(t(locale, "agent.materials.knowledge"), { exact: true }).waitFor();
  } else throw new Error(`Unsupported Agent task: ${task}`);
  return exactSurfaceProbe(page, panel);
}

async function closeVisualSurface(page, { probe, returnFocus, closeControl = null }) {
  const surface = await uniqueVisible(page.locator(probe), "Close target must be unique");
  const target = await surface.evaluate((node) => ({
    id: node.id,
    slot: node.getAttribute("data-slot"),
    state: node.getAttribute("data-state"),
    blocked: !!node.closest('[inert],[hidden],[aria-hidden="true"]'),
  }));
  assert(
    target.id && target.state === "open" && !target.blocked,
    "Close target must be the identified interactive open surface",
  );
  const trace = { probe, target, returnFocus, steps: [] };
  if (active?.page === page) {
    active.overlayCloseTrace ??= [];
    active.overlayCloseTrace.push(trace);
  }
  const parents = await page.evaluate(
    (id) =>
      [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .filter((node) => node.id !== id)
        .map((node) => node.id),
    target.id,
  );
  assert(parents.every(Boolean), "Underlying open surfaces must have existing DOM IDs");
  const assertNoGuard = async () => {
    const guards = page.locator('[role="alertdialog"][data-state="open"]:visible');
    assert(
      (await guards.count()) === 0,
      "Close encountered a confirmation/dirty guard; refusing to discard",
    );
  };
  await assertNoGuard();
  const tooltips = page.locator('[data-slot="tooltip-content"]:visible');
  const tooltipCount = await tooltips.count();
  assert(tooltipCount <= 1, "Close requires one unambiguous highest Tooltip layer");
  let tooltipDismissed = false;
  if (tooltipCount === 1) {
    const tooltipProbe = await exactSurfaceProbe(page, tooltips);
    const tooltip = page.locator(tooltipProbe);
    const state = await tooltip.getAttribute("data-state");
    trace.steps.push({ action: "tooltip-before", probe: tooltipProbe, state });
    if (state !== "closed") {
      await page.keyboard.press("Escape");
      tooltipDismissed = true;
    }
    await tooltip.waitFor({ state: "hidden", timeout: 15000 });
    assert(
      (await surface.getAttribute("data-state")) === "open" && (await surface.isVisible()),
      "Tooltip Escape must leave the original surface open",
    );
    await assertNoGuard();
    trace.steps.push({
      action: tooltipDismissed ? "tooltip-escape" : "tooltip-exit",
      parentStillOpen: true,
    });
  }
  if (tooltipDismissed && (closeControl || target.slot !== "popover-content")) {
    const close =
      closeControl ??
      surface.locator(
        target.slot === "sheet-content"
          ? 'button[data-slot="sheet-close"]'
          : 'button[data-slot="dialog-close"]',
      );
    await uniqueVisible(close, "Original surface must have one existing close control");
    await close.click();
    trace.steps.push({ action: "surface-close-click" });
  } else {
    // With no higher layer, one Escape must close this exact surface, not its parent.
    await page.keyboard.press("Escape");
    trace.steps.push({ action: "surface-escape" });
  }
  await page.waitForFunction(
    (id) =>
      document.getElementById(id)?.getAttribute("data-state") !== "open" ||
      [...document.querySelectorAll('[role="alertdialog"][data-state="open"]')].some(
        (node) => node.getClientRects().length > 0,
      ),
    target.id,
    { timeout: 15000 },
  );
  await assertNoGuard();
  await surface.waitFor({ state: "hidden", timeout: 15000 });
  for (const id of parents)
    assert(
      await page
        .locator(`[id=${JSON.stringify(id)}]`)
        .evaluate((node) => node.getAttribute("data-state") === "open"),
      "Closing the target also closed an underlying surface",
    );
  await page.waitForFunction(
    (key) => {
      const trigger = window[key];
      return trigger?.isConnected && document.activeElement === trigger;
    },
    returnFocus,
    { timeout: 15000 },
  );
  trace.steps.push({ action: "target-hidden-focus-returned", preservedParents: parents });
  return trace;
}

async function closeVisitOverlay(page, entry, navigation, locale) {
  if (!entry.overlay || ["agent-guard", "agent-save"].includes(entry.overlay)) return null;
  const traces = [];
  if (entry.overlay === "task-run" || entry.overlay === "task-evidence") {
    traces.push(
      await closeVisualSurface(page, {
        probe: navigation.probe,
        returnFocus: "__visualNestedTrigger",
      }),
    );
    traces.push(
      await closeVisualSurface(page, {
        probe: navigation.parentOverlayProbe,
        returnFocus: "__visualOverlayTrigger",
      }),
    );
  } else {
    traces.push(
      await closeVisualSurface(page, {
        probe: navigation.probe,
        returnFocus: "__visualOverlayTrigger",
        closeControl:
          entry.overlay === "context-usage"
            ? page.locator(navigation.probe).getByRole("button", {
                name: t(locale, "workspace.close_context_usage"),
                exact: true,
              })
            : null,
      }),
    );
  }
  return traces;
}

async function compactNavigationSnapshot(page, navigation, phase, guardProbe = null) {
  const state = await page.evaluate(
    ({ id, guardProbe }) => {
      const describe = (node) => {
        if (!node) return null;
        const blocked = [];
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (
            ancestor.hidden ||
            ancestor.hasAttribute("inert") ||
            ancestor.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden"
          )
            blocked.push({
              id: ancestor.id || null,
              tag: ancestor.tagName.toLowerCase(),
              hidden: ancestor.hidden,
              inert: ancestor.hasAttribute("inert"),
              ariaHidden: ancestor.getAttribute("aria-hidden"),
              display: style.display,
              visibility: style.visibility,
            });
        }
        const rect = node.getBoundingClientRect();
        const labelled = (node.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ");
        return {
          id: node.id || null,
          role: node.getAttribute("role"),
          name: node.getAttribute("aria-label") ?? labelled,
          state: node.getAttribute("data-state"),
          hidden: node.hidden,
          ariaHidden: node.getAttribute("aria-hidden"),
          blocked,
          visible: rect.width > 0 && rect.height > 0 && blocked.length === 0,
          containsFocus: node.contains(document.activeElement),
        };
      };
      return {
        at: performance.now(),
        url: location.href,
        navigation: describe(document.getElementById(id)),
        guard: guardProbe ? describe(document.querySelector(guardProbe)) : null,
        active: describe(document.activeElement),
        hasFocus: document.hasFocus(),
        dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(
          describe,
        ),
        currentNavigation: [...document.querySelectorAll('[aria-current="page"]')]
          .filter(
            (node) =>
              node.getClientRects().length && !node.closest('[hidden],[aria-hidden="true"]'),
          )
          .map((node) => (node.textContent ?? "").trim())
          .slice(0, 8),
        visibleHeading: [...document.querySelectorAll("main h1,main h2")]
          .filter(
            (node) =>
              node.getClientRects().length && !node.closest('[hidden],[aria-hidden="true"]'),
          )
          .map((node) => (node.textContent ?? "").trim())
          .slice(0, 8),
      };
    },
    { id: navigation.id, guardProbe },
  );
  const snapshot = { phase, navigationId: navigation.id, guardProbe, ...state };
  if (active?.page === page) {
    active.compactNavigationTrace ??= [];
    active.compactNavigationTrace.push(snapshot);
  }
  return snapshot;
}

async function closeCompactNavigation(
  page,
  locale,
  navigation,
  guardProbe = null,
  focusDestinationProbe = null,
) {
  assert(navigation?.id && navigation.probe, "Original compact navigation identity is required");
  await compactNavigationSnapshot(page, navigation, "close-entry", guardProbe);
  if (guardProbe) {
    // A closed guard still hides its parent until its exit Presence detaches.
    await page.locator(guardProbe).waitFor({ state: "detached", timeout: 15000 });
    await compactNavigationSnapshot(page, navigation, "dismissed-guard-detached", guardProbe);
  }
  assert(
    (await page.locator('[role="alertdialog"][data-state="open"]').count()) === 0,
    "Compact navigation handoff encountered an open guard; refusing to discard",
  );
  const otherOpen = await page.evaluate((id) => {
    if (document.getElementById(id)?.getAttribute("data-state") !== "open") return false;
    return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some((node) => {
      if (node.id === id || node.getAttribute("data-state") !== "open") return false;
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect();
      return (
        style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
      );
    });
  }, navigation.id);
  assert(
    !otherOpen,
    "Navigation remains open behind destination or guard; refusing to dismiss another surface",
  );
  await page.waitForFunction(
    (id) => {
      const node = document.getElementById(id);
      if (!node || node.getAttribute("data-state") === "closed") return true;
      if (node.getAttribute("data-state") !== "open") return false;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (
          ancestor.hidden ||
          ancestor.hasAttribute("inert") ||
          ancestor.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    navigation.id,
    { timeout: 15000 },
  );
  const state = await compactNavigationSnapshot(
    page,
    navigation,
    "parent-handoff-ready",
    guardProbe,
  );
  const surface = page.locator(navigation.probe);
  if (state.navigation?.state === "open") {
    await closeVisualSurface(page, {
      probe: navigation.probe,
      returnFocus: "__visualNavigationTrigger",
      closeControl: surface.getByRole("button", {
        name: t(locale, "workspace.close_navigation"),
        exact: true,
      }),
    });
    await compactNavigationSnapshot(
      page,
      navigation,
      "navigation-closed-focus-returned",
      guardProbe,
    );
  } else {
    assert(
      !state.navigation || state.navigation.state === "closed",
      "Unexpected navigation close state",
    );
    await surface.waitFor({ state: "hidden", timeout: 15000 });
    await page.waitForFunction(
      (destinationProbe) => {
        const focused = document.activeElement;
        const trigger = window.__visualNavigationTrigger;
        if (trigger?.isConnected && focused === trigger) return true;
        const destination = destinationProbe ? document.querySelector(destinationProbe) : null;
        if (
          !destination ||
          destination.getAttribute("data-state") !== "open" ||
          !destination.contains(focused)
        )
          return false;
        for (let node = focused; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (
            node.hidden ||
            node.hasAttribute("inert") ||
            node.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden"
          )
            return false;
        }
        const rect = focused.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
      focusDestinationProbe,
      { timeout: 15000 },
    );
    const focusDestination = await compactNavigationSnapshot(
      page,
      navigation,
      "committed-navigation-auto-closed-focus-destination",
      guardProbe,
    );
    focusDestination.allowedDestinationProbe = focusDestinationProbe;
  }
}

async function openCompactNavigation(page, locale) {
  const trigger = page.getByRole("button", {
    name: t(locale, "workspace.conversations_and_navigation"),
    exact: true,
  });
  await uniqueVisible(trigger, "Compact navigation trigger must be unique");
  const controlledId = await trigger.getAttribute("aria-controls");
  await trigger.evaluate((node) => {
    window.__visualNavigationTrigger = node;
  });
  await trigger.click();
  const surface = await dialogSurface(
    page,
    locale,
    "workspace.conversations_and_navigation",
    "sheet-content",
  );
  const probe = await exactSurfaceProbe(page, surface);
  const id = await surface.getAttribute("id");
  assert(id, "Compact navigation surface has no existing DOM ID");
  if (controlledId)
    assert(controlledId === id, "Navigation trigger must control original surface ID");
  const navigation = { id, probe };
  await compactNavigationSnapshot(page, navigation, "navigation-opened");
  return navigation;
}

async function openOverlay(trigger) {
  await trigger.evaluate((element) => {
    window.__visualOverlayTrigger = element;
  });
  await trigger.click();
}

async function fixtureBindingRow(page, board, expectedScope, locale) {
  const schemeName = process.env.SUPERSTRING_VISUAL_SCHEME_NAME;
  const schemeId = process.env.SUPERSTRING_VISUAL_SCHEME_ID;
  assert(schemeId && schemeName, "binding rows require an explicit synthetic scheme ID and name");
  const owner = board.locator("..").and(page.locator("fieldset[data-scheme-id]"));
  assert((await owner.count()) === 1, "Binding controls must have exactly one owning fieldset");
  assert((await owner.getAttribute("data-scheme-id")) === expectedScope, "Binding scope mismatch");
  if (expectedScope === "all") {
    const picker = board.getByRole("combobox", {
      name: t(locale, "schemes.bindings.chooseScheme"),
      exact: true,
    });
    const options = await picker
      .locator("option")
      .evaluateAll(
        (nodes, name) =>
          nodes.filter((node) => node.textContent?.trim() === name).map((node) => node.value),
        schemeName,
      );
    assert(
      options.length === 1 && options[0] === schemeId,
      "Synthetic scheme option identity mismatch",
    );
  }
  const row = owner.getByRole("listitem").filter({ has: page.getByText("30003", { exact: true }) });
  await row.waitFor();
  assert((await row.count()) === 1, "Synthetic binding row must be unique");
  await row.getByText("30003", { exact: true }).waitFor();
  await row.getByText(t(locale, "connections.group"), { exact: true }).waitFor();
  await row
    .getByText(`${t(locale, "schemes.qq.groupConfig.account")} 90001`, { exact: true })
    .waitFor();
  await row
    .getByText(`${t(locale, "schemes.qq.groupConfig.baseScheme")}: ${schemeName}`, { exact: true })
    .waitFor();
  return row;
}

async function openPage(page, entry, locale) {
  assert(ALL_PAGES.includes(entry), `Unknown visual page: ${entry?.id}`);
  const labels = labelsOf(entry, locale);
  const previous = await page.evaluate(() =>
    (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  const compact = page.viewportSize().width < 768;
  await page.waitForFunction(async (mobile) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const trigger = document.querySelector('header button[aria-haspopup="dialog"]');
    const aside = document.querySelector("aside");
    return mobile ? !!trigger && !aside : !!aside;
  }, compact);
  const navigation = { schemeId: null, conversation: null, probe: entry.probe };
  if (compact) {
    const compactNavigation = await openCompactNavigation(page, locale);
    const navDialog = page.locator(compactNavigation.probe);
    await navDialog.locator("aside").getByRole("button", { name: labels[0], exact: true }).click();
    await compactNavigationSnapshot(page, compactNavigation, "destination-clicked");
    const focusDestinationProbe =
      entry.id === "general"
        ? await exactSurfaceProbe(
            page,
            await dialogSurface(page, locale, "library.preferences", "sheet-content"),
          )
        : null;
    await closeCompactNavigation(page, locale, compactNavigation, null, focusDestinationProbe);
    navigation.compactTrace = active?.page === page ? active.compactNavigationTrace : null;
  } else {
    await page
      .locator("aside")
      .first()
      .getByRole("button", { name: labels[0], exact: true })
      .click();
  }
  if (entry.agentTask) {
    const agent = visualAgent();
    const record = page
      .locator("main")
      .getByRole("button", { name: agent.name, exact: true })
      .and(page.locator("button[data-agent-open]"));
    await record.waitFor({ state: "visible", timeout: 15000 });
    assert(
      (await record.getAttribute("data-agent-open")) === agent.id,
      `${entry.id}: Agent ID mismatch`,
    );
    assert((await record.innerText()).trim() === agent.name, `${entry.id}: Agent name mismatch`);
    await record.click();
    navigation.probe = await waitAgentTask(page, locale, entry.agentTask, agent);
    navigation.agent = agent;
  }
  if (entry.conversation)
    navigation.conversation = await selectConversation(page, entry.conversation, locale);
  if (entry.qqAppTab === "connection" || entry.qqAppTab === "storage") {
    const key =
      entry.qqAppTab === "connection" ? "schemes.qq.connectionTitle" : "connections.dataRetention";
    await page
      .locator("main")
      .getByRole("button", { name: t(locale, key), exact: true })
      .click();
  }
  for (const selector of entry.pick === undefined ? [] : [entry.pick].flat()) {
    const main = page.locator("main");
    let record = main.locator(selector);
    if (selector === "[data-scheme-open]") {
      const schemeId = process.env.SUPERSTRING_VISUAL_SCHEME_ID;
      const schemeName = process.env.SUPERSTRING_VISUAL_SCHEME_NAME;
      assert(schemeId && schemeName, `${entry.id}: explicit synthetic scheme ID and name required`);
      record = record.filter({ has: page.getByText(schemeName, { exact: true }) });
      await record.waitFor({ state: "visible", timeout: 15000 });
      assert(
        (await record.getAttribute("data-scheme-open")) === schemeId,
        `${entry.id}: scheme ID mismatch`,
      );
    } else await record.waitFor({ state: "visible", timeout: 15000 });
    if (entry.schemeView && selector === "[data-scheme-open]") {
      navigation.schemeId = await record.getAttribute("data-scheme-open");
      assert(navigation.schemeId, `${entry.id}: picked record has no scheme ID`);
    }
    await record.click();
  }
  // 先证明 pick 落到真实编辑器，再切使用会话；不能只靠两个详情任务 Tab 的文字。
  if (entry.schemeView) await waitSchemeView(page, navigation.schemeId, "settings", locale);
  if (labels[1] !== undefined) {
    if (entry.second === "row") {
      const directory = page.getByRole("region", {
        name: t(locale, "workspace.capabilities"),
        exact: true,
      });
      const label = `${t(locale, "connections.components.primaryConfig")} · ${labels[1]}`;
      await directory.getByRole("button", { name: label, exact: true }).click();
    } else {
      const parent = entry.view
        ? page.getByRole("tablist", { name: t(locale, "workspace.conversation_view"), exact: true })
        : page.locator("main");
      const tab =
        entry.schemeView === "bindings"
          ? schemeDetailTab(parent, "schemes.bindings.viewBindings", locale)
          : parent.getByRole("tab", { name: labels[1], exact: true });
      await tab.click();
      await tab.and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 15000 });
    }
  }
  if (entry.scope) {
    const group = page.getByRole("group", {
      name: t(locale, "workspace.conversationHub.scope"),
      exact: true,
    });
    await group
      .getByRole("button", {
        name: t(
          locale,
          entry.scope === "current"
            ? "workspace.conversationHub.scopeCurrent"
            : "workspace.conversationHub.scopeGlobal",
        ),
        exact: true,
      })
      .click();
    await assertScope(page, entry.scope, locale);
  }
  if (entry.view) await waitConversationView(page, entry, locale);
  if (entry.view === "messages" && !entry.overlay) {
    navigation.probe =
      entry.conversation === "web"
        ? "#conversation-canvas textarea"
        : `#conversation-canvas [role="tabpanel"][aria-label=${JSON.stringify(t(locale, "workspace.message_history"))}]`;
    await uniqueVisible(page.locator(navigation.probe), "Message probe must be unique");
  }
  // The directory and selected canvas intentionally share QQ controls; only the selected canvas owns this task.
  if (entry.groupConfig) {
    const isPrivate = entry.conversation === "qq-private";
    const expected = navigation.conversation;
    assert(expected, "QQ configuration requires a selected synthetic conversation");
    const canvas = await selectedCanvas(page, expected.title);
    await page
      .getByRole("tablist", {
        name: t(locale, "workspace.conversation_view"),
        exact: true,
      })
      .getByRole("tab", {
        name: t(locale, "workspace.message_history"),
        exact: true,
        selected: true,
      })
      .waitFor();
    await messageCanvasReady(page, entry.conversation, locale);
    const controls = canvas.getByRole("group", {
      name: t(
        locale,
        isPrivate ? "qq.conversation.controls" : "schemes.qq.groupConfig.controls.label",
      ),
      exact: true,
    });
    await uniqueVisible(controls, "Selected QQ controls must be unique");
    const configure = controls.getByRole("button", {
      name: t(
        locale,
        isPrivate ? "qq.conversation.privateConfig" : "schemes.qq.groupConfig.controls.configure",
      ),
      exact: true,
    });
    await waitEnabled(page, configure);
    const configResponse = page.waitForResponse((response) => {
      const target = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        target.origin === new URL(url).origin &&
        target.pathname === `/qq/bindings/${encodeURIComponent(expected.sourceId)}/config`
      );
    });
    await configure.click();
    const response = await configResponse;
    assert(response.status() === 200, "Selected QQ configuration read failed");
    const detail = await response.json();
    assert(
      detail.binding?.id === expected.sourceId &&
        detail.binding.kind === (isPrivate ? "private" : "group") &&
        detail.binding.peer_id === (isPrivate ? "20002" : "30003") &&
        detail.binding.account_id === "90001",
      "Selected QQ configuration binding identity mismatch",
    );
    const region = await qqConfigRegion(page, entry, locale);
    const context = region.locator("[data-group-context]");
    await uniqueVisible(context, "Selected QQ configuration context must be unique");
    await context.getByText(isPrivate ? "20002" : "30003", { exact: true }).waitFor();
    await context
      .getByText(`${t(locale, "schemes.qq.groupConfig.account")} 90001`, { exact: true })
      .waitFor();
    if (isPrivate)
      assert(
        (await region
          .getByRole("tab", { name: t(locale, "schemes.qq.groupConfig.capabilities"), exact: true })
          .count()) === 0,
        "Private configuration exposes group capabilities",
      );
    navigation.qqBindingId = detail.binding.id;
    navigation.probe = await exactSurfaceProbe(
      page,
      region.locator('[role="tabpanel"][data-state="active"]'),
    );
  }
  if (entry.schemeView) {
    const probe = await waitSchemeView(page, navigation.schemeId, entry.schemeView, locale);
    if (entry.probe !== null && !entry.overlay) navigation.probe = probe;
  }
  if (entry.qqAppTab) {
    navigation.qqApp = await waitQqApp(page, entry.qqAppTab, locale);
    if (entry.probe !== null) navigation.probe = navigation.qqApp.probe;
  }
  if (entry.qqTask) {
    const main = page.locator("main");
    const key = entry.qqTask === "events" ? "schemes.qq.eventsTitle" : "schemes.qq.runtimeTitle";
    const tab = main.getByRole("tab", { name: t(locale, key), exact: true });
    await tab.click();
    await tab.and(page.locator('[aria-selected="true"]')).waitFor();
    if (entry.qqTask === "events") {
      for (const filter of ["all", "message", "notice", "request", "meta_event"]) {
        const eventTab = main.getByRole("tab", {
          name: t(locale, `connections.stream.filter.${filter}`),
          exact: true,
        });
        await eventTab.click();
        await eventTab.and(page.locator('[aria-selected="true"]')).waitFor();
      }
    } else
      await main
        .getByText(t(locale, "connections.execution.qqRetryGroup"), { exact: true })
        .waitFor();
  }
  if (entry.extension) await waitExtensions(page, entry, locale);
  if (entry.id === "system-capabilities")
    await page
      .getByRole("region", { name: t(locale, "workspace.capabilities"), exact: true })
      .getByRole("textbox", { name: t(locale, "capabilities.directory.search"), exact: true })
      .waitFor();
  if (["web-access", "media-tools", "qq-members", "execution-settings"].includes(entry.id)) {
    const region = page.getByRole("region", { name: labels[labels.length - 1], exact: true });
    if (entry.id === "execution-settings")
      await region
        .getByRole("navigation", { name: t(locale, "connections.execution.title"), exact: true })
        .waitFor();
    else {
      const module =
        entry.id === "web-access" ? "web" : entry.id === "media-tools" ? "qqMedia" : "qqMembers";
      await region
        .getByRole("checkbox", {
          name: t(locale, `connections.execution.modules.${module}`),
          exact: true,
        })
        .waitFor();
    }
  }
  if (entry.id === "session-history") {
    const region = page.getByRole("region", { name: labels[labels.length - 1], exact: true });
    const select = region.getByRole("combobox", {
      name: t(locale, "agent.materials.chooseAgent"),
      exact: true,
    });
    const open = region.getByRole("button", {
      name: t(locale, "capabilities.session.open"),
      exact: true,
    });
    assert(
      (await select.inputValue()) === "" && (await open.isDisabled()),
      "Session history must require explicit Agent selection",
    );
  }
  if (entry.id === "model-services")
    await page
      .locator("main")
      .getByRole("button", { name: t(locale, "models.addProvider"), exact: true })
      .waitFor();
  if (["knowledge-config", "knowledge-settings-sheet"].includes(entry.id)) {
    await page
      .getByRole("region", { name: t(locale, "library.document.library"), exact: true })
      .getByRole("textbox", { name: t(locale, "library.search.documents"), exact: true })
      .waitFor();
  }
  if (["long-memory", "memory-manual-sheet", "memory-rebuild-sheet"].includes(entry.id)) {
    await page
      .getByRole("region", { name: t(locale, "library.memory.library"), exact: true })
      .getByRole("combobox", { name: t(locale, "library.agent.owner"), exact: true })
      .waitFor();
  }
  if (entry.id === "qq-stickers") {
    await page
      .getByRole("region", { name: t(locale, "library.sticker.library.2"), exact: true })
      .getByRole("textbox", { name: t(locale, "library.search.assets"), exact: true })
      .waitFor();
  }
  if (entry.id === "general") {
    const preferences = page.getByRole("dialog", {
      name: t(locale, "library.preferences"),
      exact: true,
    });
    await preferences
      .getByRole("heading", { name: t(locale, "library.make.this.workspace.yours"), exact: true })
      .waitFor();
  }
  if (entry.id === "scheme-library") {
    await page
      .locator("main")
      .getByRole("textbox", { name: t(locale, "schemes.search"), exact: true })
      .waitFor();
    await waitEnabled(
      page,
      page
        .locator("main")
        .getByRole("button", { name: t(locale, "schemes.qq.connectionTitle"), exact: true }),
    );
  }
  for (const key of entry.finalTabKeys ?? []) {
    const owner = entry.groupConfig ? await qqConfigRegion(page, entry, locale) : page;
    const tab =
      entry.schemeView === "bindings"
        ? schemeDetailTab(page.locator("main"), key, locale)
        : owner.getByRole("tab", { name: t(locale, key), exact: true });
    await tab.waitFor({ timeout: 15000 });
  }
  if (entry.landmark === "region") {
    const region = page.getByRole("region", { name: labels[labels.length - 1], exact: true });
    await (entry.id === "scheme-library"
      ? region.filter({ has: page.locator('[data-qq-retained-scroll="schemes"]') })
      : region
    ).waitFor({ timeout: 15000 });
  }
  if (["knowledge-document", "knowledge-grants", "knowledge-import"].includes(entry.overlay)) {
    const main = page.locator("main");
    const region = main.getByRole("region", {
      name: t(locale, "library.document.library"),
      exact: true,
    });
    if (entry.overlay === "knowledge-import") {
      await openOverlay(
        region.getByRole("button", { name: t(locale, "library.import.document"), exact: true }),
      );
    } else {
      await region
        .getByRole("textbox", { name: t(locale, "library.search.documents"), exact: true })
        .fill("Synthetic document");
      const row = region
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: "Synthetic document", exact: true }) });
      await row.waitFor();
      const trigger =
        entry.overlay === "knowledge-document"
          ? row.getByRole("button", { name: "Synthetic document", exact: true })
          : row.getByRole("button", { name: `1 ${t(locale, "library.assistant")}`, exact: true });
      await openOverlay(trigger);
    }
    const titleKey =
      entry.overlay === "knowledge-document"
        ? "library.document.workbench"
        : entry.overlay === "knowledge-grants"
          ? "library.agent.access"
          : "library.import.document";
    const dialog = await dialogSurface(page, locale, titleKey, "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.waitFor();
    if (entry.overlay === "knowledge-document")
      assert(
        (await dialog.getByLabel(t(locale, "library.name"), { exact: true }).inputValue()) ===
          "Synthetic document",
        "Document identity mismatch",
      );
    if (entry.overlay === "knowledge-grants")
      await dialog.getByText("Synthetic document", { exact: true }).waitFor();
    if (entry.overlay === "knowledge-import")
      await dialog.getByLabel(t(locale, "library.name"), { exact: true }).waitFor();
  }
  if (entry.overlay === "memory-source-preview") {
    const region = page.getByRole("region", {
      name: t(locale, "library.memory.library"),
      exact: true,
    });
    const owner = region.getByRole("combobox", {
      name: t(locale, "library.agent.owner"),
      exact: true,
    });
    assert((await owner.inputValue()) === visualAgent().id, "Memory owner mismatch");
    await region
      .getByRole("textbox", { name: t(locale, "library.search.memories"), exact: true })
      .fill("own-needle");
    await region.getByRole("button", { name: t(locale, "library.search"), exact: true }).click();
    await openOverlay(region.getByRole("button", { name: "own-needle", exact: true }));
    const dialog = await namedDialogSurface(page, "own-needle", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    const sourcesResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        /\/memory\/entries\/[^/]+\/sources$/.test(requestUrl.pathname)
      );
    });
    await dialog.getByRole("tab", { name: t(locale, "library.sources"), exact: true }).click();
    await dialog.getByText(t(locale, "memoryPreview.independentUser"), { exact: true }).waitFor();
    const response = await sourcesResponse;
    assert(response.status() === 200, "Synthetic source projection failed");
    const sources = await response.json();
    assert(
      sources.total === 2 && sources.checked_sources === 2 && sources.nextOffset === null,
      "Synthetic Web turn must expose both source records",
    );
    const canonicalId = process.env.SUPERSTRING_VISUAL_WEB_CANONICAL_ID;
    assert(canonicalId, "Synthetic Web canonical ID required for source selection");
    const items = sources.items;
    assert(
      items.length === 2 &&
        items.every(
          (item) =>
            item.state === "available" &&
            item.channel === "web" &&
            item.conversation_id === canonicalId &&
            item.source_key &&
            item.revision &&
            item.participant &&
            item.occurred_at,
        ),
      "Synthetic Web source records are incomplete or unavailable",
    );
    assert(
      new Set(items.map((item) => item.source_key)).size === 2,
      "Synthetic Web source keys are not distinct",
    );
    const originals = dialog.getByRole("button", {
      name: t(locale, "memoryPreview.openOriginal"),
      exact: true,
    });
    await originals.first().waitFor();
    assert(
      (await originals.count()) === items.length,
      "Source controls do not match the projection",
    );
    const matches = [];
    const sourceBodies = [];
    for (const [index, item] of items.entries()) {
      const previewUrl = new URL(response.url());
      previewUrl.pathname = previewUrl.pathname.replace(/\/sources$/, "/source-preview");
      previewUrl.search = new URLSearchParams({
        source_key: item.source_key,
        revision: item.revision,
        offset: "0",
        limit: "4096",
      }).toString();
      const previewResponse = await page.request.get(previewUrl.href);
      assert(previewResponse.status() === 200, "Synthetic source preview failed");
      const preview = await previewResponse.json();
      assert(
        preview.source_key === item.source_key &&
          preview.revision === item.revision &&
          preview.conversation_id === canonicalId,
        "Synthetic source identity mismatch",
      );
      sourceBodies.push(preview.text);
      if (preview.text === "SYNTHETIC_WEB_source-a") matches.push({ index, item });
    }
    assert(
      matches.length === 1 && sourceBodies.includes("SYNTHETIC_WEB_ANSWER_source-a"),
      "Synthetic user and assistant source bodies are missing or ambiguous",
    );
    const selected = matches[0];
    const original = originals.nth(selected.index);
    const card = original.locator("..");
    await card
      .getByText(`${selected.item.channel} · ${t(locale, "agent.memory.read.available")}`, {
        exact: true,
      })
      .waitFor();
    await card
      .getByText(`${selected.item.participant} · ${selected.item.occurred_at}`, { exact: true })
      .waitFor();
    const previewResponse = page.waitForResponse((candidate) => {
      const requestUrl = new URL(candidate.url());
      return (
        candidate.request().method() === "GET" &&
        requestUrl.pathname.endsWith("/source-preview") &&
        requestUrl.searchParams.get("source_key") === selected.item.source_key &&
        requestUrl.searchParams.get("revision") === selected.item.revision
      );
    });
    await original.click();
    assert((await previewResponse).status() === 200, "Selected source request failed");
    await dialog.getByText("SYNTHETIC_WEB_source-a", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: t(locale, "memoryPreview.backSources"), exact: true })
      .click();
    await originals.first().waitFor();
    assert((await originals.count()) === items.length, "Returning lost source controls");
  }
  if (entry.overlay === "memory-owned") {
    const region = page.getByRole("region", {
      name: t(locale, "library.memory.library"),
      exact: true,
    });
    const owner = region.getByRole("combobox", {
      name: t(locale, "library.agent.owner"),
      exact: true,
    });
    const agent = visualAgent();
    assert((await owner.inputValue()) === agent.id, "Memory owner does not match synthetic Agent");
    await region
      .getByRole("textbox", { name: t(locale, "library.search.memories"), exact: true })
      .fill("own-needle");
    await region.getByRole("button", { name: t(locale, "library.search"), exact: true }).click();
    const trigger = region.getByRole("button", { name: "own-needle", exact: true });
    await openOverlay(trigger);
    const dialog = await namedDialogSurface(page, "own-needle", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.getByText("synthetic needle", { exact: true }).waitFor();
    for (const key of [
      "library.sources",
      "library.correct",
      "library.memory.accessTitle",
      "library.configuration.snapshot",
    ]) {
      const tab = dialog.getByRole("tab", { name: t(locale, key), exact: true });
      await tab.click();
      await dialog
        .getByRole("tab", { name: t(locale, key), exact: true, selected: true })
        .waitFor();
    }
  }
  if (entry.overlay === "memory-received") {
    const region = page.getByRole("region", {
      name: t(locale, "library.memory.library"),
      exact: true,
    });
    const agent = visualAgent();
    const owner = region.getByRole("combobox", {
      name: t(locale, "library.agent.owner"),
      exact: true,
    });
    assert((await owner.inputValue()) === agent.id, "Received memory owner mismatch");
    await region
      .getByRole("combobox", { name: t(locale, "agent.memory.view"), exact: true })
      .selectOption("received");
    await region
      .getByRole("textbox", { name: t(locale, "library.search.memories"), exact: true })
      .fill("shared-needle");
    await region.getByRole("button", { name: t(locale, "library.search"), exact: true }).click();
    const trigger = region.getByRole("button", { name: "shared-needle", exact: true });
    await openOverlay(trigger);
    const dialog = await namedDialogSurface(page, "shared-needle", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.getByText(t(locale, "memoryPreview.receivedReadOnly"), { exact: true }).waitFor();
    const canonicalId = process.env.SUPERSTRING_VISUAL_WEB_CANONICAL_ID;
    assert(canonicalId, "memory-received requires the synthetic Web canonical ID");
    const principal = dialog.getByRole("combobox", {
      name: t(locale, "agent.memory.principal"),
      exact: true,
    });
    await principal.selectOption(canonicalId);
    await dialog.getByText("synthetic shared needle", { exact: true }).waitFor();
    assert(
      (await dialog
        .getByRole("tab", { name: t(locale, "library.correct"), exact: true })
        .count()) === 0,
      "Received reader exposes owner correction",
    );
    await dialog.getByRole("tab", { name: t(locale, "library.sources"), exact: true }).click();
    await dialog.getByText(t(locale, "memoryPreview.independentUser"), { exact: true }).waitFor();
  }
  if (entry.overlay === "sticker-detail") {
    const name = "Synthetic sticker";
    const label = t(locale, "library.open.value").replace("{0}", name);
    await openOverlay(page.locator("main").getByRole("button", { name: label, exact: true }));
    const dialog = await namedDialogSurface(page, name, "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    assert(
      (await dialog.getByLabel(t(locale, "library.name"), { exact: true }).inputValue()) === name,
      "Sticker identity mismatch",
    );
  }
  if (entry.overlay === "model-service-edit") {
    const main = page.locator("main");
    const row = main
      .getByRole("row")
      .filter({ has: page.getByText("Synthetic provider", { exact: true }) });
    await openOverlay(
      row.getByRole("button", { name: t(locale, "models.configure"), exact: true }),
    );
    const dialog = await dialogSurface(page, locale, "models.editProvider", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    assert(
      (await dialog.getByLabel(t(locale, "models.name"), { exact: true }).inputValue()) ===
        "Synthetic provider",
      "Provider identity mismatch",
    );
  }
  if (entry.overlay === "skill-detail" || entry.overlay === "tool-detail") {
    const region = page.getByRole("region", {
      name: t(locale, "workspace.extensions"),
      exact: true,
    });
    const skill = entry.overlay === "skill-detail";
    const row = region.locator(
      skill ? '[data-skill-name="synthetic-inspection"]' : '[data-tool-name="memory.query"]',
    );
    const title = skill ? "synthetic-inspection" : "memory.query";
    await row.getByText(title, { exact: true }).waitFor();
    await openOverlay(
      row.getByRole("button", {
        name: t(locale, skill ? "connections.skills.view" : "connections.tools.details"),
        exact: true,
      }),
    );
    const dialog = await namedDialogSurface(page, title, "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
  }
  if (entry.overlay === "search") {
    if (compact) await openCompactNavigation(page, locale);
    const trigger = page.locator("#workspace-search-trigger");
    await openOverlay(trigger);
    const dialog = await dialogSurface(page, locale, "workspace.search_and_jump", "dialog-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog
      .getByRole("combobox", {
        name: t(locale, "workspace.search_and_jump"),
        exact: true,
      })
      .waitFor();
  }
  if (entry.schemeScroll) {
    const main = page.locator("main");
    const viewport = main.locator('[data-slot="scroll-area-viewport"]').filter({
      has: page.getByRole("tab", {
        name: t(locale, "schemes.sections.participation"),
        exact: true,
      }),
    });
    await viewport.waitFor();
    const initial = await viewport.evaluate((el) => {
      window.__visualSchemeScrollViewport = el;
      el.scrollTop = Math.min(60, el.scrollHeight - el.clientHeight);
      return el.scrollTop;
    });
    assert(initial > 0, "Scheme task has no scroll range to verify");
    const responseTab = main.getByRole("tab", {
      name: t(locale, "schemes.sections.response"),
      exact: true,
    });
    const participationTab = main.getByRole("tab", {
      name: t(locale, "schemes.sections.participation"),
      exact: true,
    });
    await responseTab.evaluate((targetNode) => {
      const viewport = targetNode.closest('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport !== window.__visualSchemeScrollViewport)
        throw new Error("Target tab must belong to the exact same scheme scroll-area-viewport");
      const tablist = targetNode.closest('[role="tablist"]');
      if (!tablist || !viewport.contains(tablist))
        throw new Error("Scheme target tab must belong to its original task tablist");
      const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
      const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
      if (selected.length !== 1 || selected[0] === targetNode)
        throw new Error("Scheme task departure must start from the other selected task");
      const departureTab = selected[0];
      window.__visualSchemeScrollBaseline = null;
      const handler = (event) => {
        if (!event.isTrusted) return;
        const hitTab = event.target?.closest?.('[role="tab"]');
        if (hitTab !== targetNode && !targetNode.contains(event.target)) return;
        document.removeEventListener("mousedown", handler, true);
        const selectedTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
        if (selectedTab !== departureTab)
          throw new Error("Scheme departure task changed before its trusted mouse event");
        window.__visualSchemeScrollBaseline = {
          expected: viewport.scrollTop,
          exactTab: targetNode.getAttribute("id") || targetNode.textContent?.trim(),
          currentSelected:
            selectedTab?.getAttribute("id") || selectedTab?.textContent?.trim() || null,
          guardScope: viewport.getAttribute("data-slot") || "scroll-area-viewport",
          trusted: event.isTrusted,
        };
      };
      window.__visualSchemeScrollCleanup = () => {
        document.removeEventListener("mousedown", handler, true);
        delete window.__visualSchemeScrollCleanup;
        delete window.__visualSchemeScrollViewport;
      };
      document.addEventListener("mousedown", handler, true);
    });
    await responseTab.click();
    await main
      .getByRole("tab", {
        name: t(locale, "schemes.sections.response"),
        exact: true,
        selected: true,
      })
      .waitFor();
    const baseline = await page.evaluate(() => {
      window.__visualSchemeScrollCleanup?.();
      delete window.__visualSchemeScrollViewport;
      const b = window.__visualSchemeScrollBaseline;
      delete window.__visualSchemeScrollBaseline;
      delete window.__visualSchemeScrollViewport;
      return b;
    });
    assert(baseline && baseline.trusted, "Scheme task trusted departure event was not captured");
    assert(
      typeof baseline.expected === "number" && baseline.expected > 0,
      "Scheme task departure scroll must be a positive number",
    );
    const expected = baseline.expected;
    const responseScrollTop = await viewport.evaluate((el) => el.scrollTop);
    assert(
      Math.abs(responseScrollTop - expected) > 1,
      "Scheme tasks must have distinct scroll positions",
    );
    await participationTab.click();
    await main
      .getByRole("tab", {
        name: t(locale, "schemes.sections.participation"),
        exact: true,
        selected: true,
      })
      .waitFor();
    const actual = await viewport.evaluate((el) => el.scrollTop);
    assert(Math.abs(actual - expected) <= 1, "Scheme task scroll not restored");
    navigation.schemeScroll = {
      initial,
      expected,
      actual,
      exactTab: baseline.exactTab,
      currentSelected: baseline.currentSelected,
      guardScope: baseline.guardScope,
      responseScrollTop,
      restored: Math.abs(actual - expected) <= 1,
    };
  }
  if (entry.globalBindings) {
    const main = page.locator("main");
    await main
      .getByRole("button", { name: t(locale, "schemes.workspace.bindings"), exact: true })
      .click();
    const board = main.locator('[data-bindings-scope="global"]:visible');
    await board.waitFor();
    await board
      .getByRole("button", { name: t(locale, "schemes.bindings.add"), exact: true })
      .waitFor();
    await fixtureBindingRow(page, board, "all", locale);
    if (entry.probe !== null && !entry.overlay)
      navigation.probe = 'main [data-qq-retained-scroll="groups"] [data-bindings-scope="global"]';
  }
  if (entry.overlay === "scheme-create") {
    await openOverlay(
      page
        .locator("main")
        .getByRole("button", { name: t(locale, "connections.newScheme"), exact: true }),
    );
    const dialog = await dialogSurface(page, locale, "connections.newScheme", "dialog-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.getByLabel(t(locale, "connections.schemeName"), { exact: true }).waitFor();
    assert(
      await dialog
        .getByRole("button", { name: t(locale, "connections.confirm"), exact: true })
        .isDisabled(),
      "Blank scheme may not be created",
    );
  }
  if (entry.overlay === "binding-add") {
    const board = page.locator('[data-bindings-scope="global"]');
    await openOverlay(
      board.getByRole("button", { name: t(locale, "schemes.bindings.add"), exact: true }),
    );
    const dialog = await dialogSurface(
      page,
      locale,
      "conversation.entry.addGroup",
      "dialog-content",
    );
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog
      .getByRole("combobox", { name: t(locale, "connections.conversationType"), exact: true })
      .waitFor();
  }
  if (entry.traceCompare) {
    const ids = [
      process.env.SUPERSTRING_VISUAL_TRACE_ID,
      process.env.SUPERSTRING_VISUAL_SECOND_TRACE_ID,
    ];
    assert(
      ids.every(Boolean) && ids[0] !== ids[1],
      "trace-compare requires two distinct synthetic trace IDs",
    );
    const workspace = page.getByRole("region", {
      name: t(locale, "observability.executionWorkspace"),
      exact: true,
    });
    for (const id of ids) {
      const label = t(locale, "observability.compareValue").replace("{0}", id);
      await workspace.getByRole("checkbox", { name: label, exact: true }).check();
    }
    await workspace
      .getByRole("button", {
        name: t(locale, "observability.compareValueSelected").replace("{0}", "2"),
        exact: true,
      })
      .click();
    const compare = workspace.getByRole("region", {
      name: t(locale, "observability.compareTraces"),
      exact: true,
    });
    for (const id of ids) {
      const column = compare.getByRole("region", { name: id, exact: true });
      await column.getByRole("heading").waitFor();
    }
    await compare
      .getByRole("button", { name: t(locale, "observability.backToExecutions"), exact: true })
      .click();
    for (const id of ids)
      await workspace
        .getByRole("checkbox", {
          name: t(locale, "observability.compareValue").replace("{0}", id),
          exact: true,
        })
        .waitFor();
  }
  if (entry.traceDetail) {
    const traceId = process.env.SUPERSTRING_VISUAL_TRACE_ID;
    assert(traceId, "trace-detail requires synthetic trace ID");
    const workspace = page.getByRole("region", {
      name: t(locale, "observability.executionWorkspace"),
      exact: true,
    });
    const row = workspace.locator("button[data-trace-action]");
    const matches = await row.all();
    const identified = [];
    for (const candidate of matches)
      if ((await candidate.getAttribute("data-trace-action")) === traceId)
        identified.push(candidate);
    assert(identified.length === 1, "Synthetic trace action is missing or ambiguous");
    const exactRow = identified[0];
    await exactRow.waitFor();
    await exactRow.evaluate((target) => {
      const area = target.closest("[data-workspace-scroll]");
      if (!area) throw new Error("Trace row must have its original scroll owner");
      window.__visualTraceReturnBaseline = null;
      const capture = (event) => {
        if (!event.isTrusted || !target.contains(event.target)) return;
        document.removeEventListener("click", capture, true);
        window.__visualTraceReturnBaseline = {
          area,
          scrollTop: area.scrollTop,
          traceId: target.getAttribute("data-trace-action"),
          trusted: event.isTrusted,
        };
      };
      window.__visualTraceReturnCleanup = () =>
        document.removeEventListener("click", capture, true);
      document.addEventListener("click", capture, true);
    });
    try {
      await exactRow.click();
    } finally {
      await page.evaluate(() => {
        window.__visualTraceReturnCleanup?.();
        delete window.__visualTraceReturnCleanup;
      });
    }
    const departure = await page.evaluate(() => {
      const baseline = window.__visualTraceReturnBaseline;
      return (
        baseline && {
          scrollTop: baseline.scrollTop,
          traceId: baseline.traceId,
          trusted: baseline.trusted,
        }
      );
    });
    assert(departure?.trusted && departure.traceId === traceId, "Trace departure identity missing");
    const details = workspace.getByRole("region", {
      name: t(locale, "observability.traceDetails"),
      exact: true,
    });
    await details
      .getByRole("tab", { name: t(locale, "observability.fullTimeline"), exact: true })
      .waitFor();
    await details
      .getByRole("button", { name: t(locale, "observability.backToExecutions"), exact: true })
      .click();
    await exactRow.waitFor();
    await page.waitForFunction(
      (id) => document.activeElement?.getAttribute("data-trace-action") === id,
      traceId,
    );
    const restored = await exactRow.evaluate((target) => {
      const baseline = window.__visualTraceReturnBaseline;
      const area = target.closest("[data-workspace-scroll]");
      if (!baseline || !area || area !== baseline.area)
        throw new Error("Trace return must retain its original scroll owner");
      delete window.__visualTraceReturnBaseline;
      return area.scrollTop;
    });
    assert(Math.abs(restored - departure.scrollTop) <= 1, "Trace return did not restore scroll");
    navigation.traceReturn = { expected: departure.scrollTop, actual: restored, traceId };
  }
  if (entry.overlay === "agent-save") {
    const main = page.locator("main");
    const field = main
      .getByRole("tabpanel", { name: t(locale, "strict.task.identity"), exact: true })
      .getByLabel(t(locale, "library.description"), { exact: true });
    const initial = await field.inputValue();
    const changed = `${initial} synthetic save`;
    const save = main.getByRole("button", { name: t(locale, "library.save.agent"), exact: true });
    await field.fill(changed);
    await waitEnabled(page, save);
    await save.click();
    await main
      .getByRole("button", { name: t(locale, "library.discard.changes"), exact: true })
      .and(page.locator(":disabled"))
      .waitFor();
    assert((await field.inputValue()) === changed, "Saved value not retained");
    await field.fill(initial);
    await waitEnabled(page, save);
    await save.click();
    await main
      .getByRole("button", { name: t(locale, "library.discard.changes"), exact: true })
      .and(page.locator(":disabled"))
      .waitFor();
    assert((await field.inputValue()) === initial, "Synthetic save restore failed");
  }
  if (entry.overlay === "agent-guard") {
    const main = page.locator("main");
    const agent = visualAgent();
    const field = main
      .getByRole("tabpanel", { name: t(locale, "strict.task.identity"), exact: true })
      .getByLabel(t(locale, "library.description"), { exact: true });
    const before = await field.inputValue();
    await field.fill(`${before} synthetic guard draft`);
    const leave = async () => {
      const compactNavigation = compact ? await openCompactNavigation(page, locale) : null;
      await page
        .locator("aside")
        .getByRole("button", { name: t(locale, "workspace.capabilities"), exact: true })
        .click();
      return compactNavigation;
    };
    let compactNavigation = await leave();
    const guard = page.getByRole("alertdialog", {
      name: t(locale, "workspace.this_section_has_unsaved_changes"),
      exact: true,
    });
    let guardProbe = await exactSurfaceProbe(page, guard);
    await guard
      .getByRole("button", { name: t(locale, "workspace.stay_here"), exact: true })
      .click();
    if (compact) await closeCompactNavigation(page, locale, compactNavigation, guardProbe);
    assert(
      (await field.inputValue()) === `${before} synthetic guard draft`,
      "Stay discarded the Agent draft",
    );
    compactNavigation = await leave();
    guardProbe = await exactSurfaceProbe(page, guard);
    await guard
      .getByRole("button", { name: t(locale, "workspace.discard_and_continue"), exact: true })
      .click();
    if (compact) await closeCompactNavigation(page, locale, compactNavigation, guardProbe);
    await page
      .getByRole("region", { name: t(locale, "workspace.capabilities"), exact: true })
      .waitFor();
    compactNavigation = compact ? await openCompactNavigation(page, locale) : null;
    await page
      .locator("aside")
      .getByRole("button", { name: t(locale, "library.assistant"), exact: true })
      .click();
    if (compact) await closeCompactNavigation(page, locale, compactNavigation);
    await waitAgentTask(page, locale, "strict.task.identity", agent);
    assert((await field.inputValue()) === before, "Discard failed to restore the Agent draft");
  }
  if (entry.overlay === "activity-filter") {
    const region = page.getByRole("region", {
      name: t(locale, "observability.executionWorkspace"),
      exact: true,
    });
    await openOverlay(
      region.getByRole("button", { name: t(locale, "observability.addFilter"), exact: true }),
    );
    const field = page.getByLabel(t(locale, "observability.traceId"), { exact: true });
    await uniqueVisible(field, "Filter trace ID field must be unique");
    const dialog = field.locator(
      'xpath=ancestor::*[@role="dialog" and @data-slot="popover-content"]',
    );
    navigation.probe = await exactSurfaceProbe(page, dialog);
  }
  if (entry.overlay === "conversation-create") {
    if (compact)
      await page
        .getByRole("button", { name: t(locale, "workspace.open_conversation_index"), exact: true })
        .click();
    const directory = page.getByRole("region", {
      name: t(locale, "workspace.conversation_index"),
      exact: true,
    });
    const trigger = directory.getByRole("button", {
      name: t(locale, "conversation.entry.trigger"),
      exact: true,
    });
    await trigger.evaluate((element) => {
      window.__visualOverlayTrigger = element;
    });
    await trigger.click();
    await page
      .getByRole("menuitem", { name: t(locale, "conversation.entry.newChat"), exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: t(locale, "workspace.start_a_new_conversation"),
      exact: true,
    });
    await dialog.getByLabel(t(locale, "workspace.new_chats"), { exact: true }).waitFor();
    await dialog.getByLabel(t(locale, "workspace.conversation_name"), { exact: true }).waitFor();
    const surface = await dialogSurface(
      page,
      locale,
      "workspace.start_a_new_conversation",
      "dialog-content",
    );
    navigation.probe = await exactSurfaceProbe(page, surface);
  }
  if (entry.overlay === "conversation-details") {
    const expected = navigation.conversation;
    assert(expected, "conversation-details requires a selected synthetic conversation");
    const canvas = await selectedCanvas(page, expected.title);
    await openOverlay(
      canvas.getByRole("button", {
        name: t(locale, "workspace.conversation_details"),
        exact: true,
      }),
    );
    const dialog = await dialogSurface(
      page,
      locale,
      "workspace.conversation_details",
      "sheet-content",
    );
    await dialog.getByText(expected.title, { exact: true }).waitFor();
    for (const [key, value] of [
      ["workspace.conversation_id", expected.canonicalId],
      ["workspace.source_binding", expected.sourceId],
    ]) {
      const row = dialog.locator("dl > div").filter({
        has: page.getByText(t(locale, key), { exact: true }).and(page.locator("dt")),
      });
      await uniqueVisible(row, `Conversation identity field must be unique: ${key}`);
      assert(
        (await row.locator("dd").innerText()).trim() === value,
        `Conversation ${key} mismatch`,
      );
    }
    const mode = dialog.getByRole("combobox", {
      name: t(locale, "conversations.memoryReadMode.selectLabel"),
      exact: true,
    });
    await uniqueVisible(mode, "Conversation memory mode must be unique in details");
    await waitEnabled(page, mode);
    const modeNode = await mode.elementHandle();
    assert(modeNode, "Conversation memory mode node missing");
    try {
      await page.waitForFunction(
        (node) => node.isConnected && !node.disabled && node.value === "agent_shared",
        modeNode,
        { timeout: 15000 },
      );
    } finally {
      await modeNode.dispose();
    }
    assert(
      (await mode.inputValue()) === "agent_shared",
      "Synthetic conversation memory mode mismatch",
    );
    navigation.probe = await exactSurfaceProbe(page, dialog);
  }
  if (entry.overlay === "context-usage") {
    const expected = navigation.conversation;
    assert(expected, "context-usage requires a selected synthetic conversation");
    const canvas = await selectedCanvas(page, expected.title);
    const trigger = canvas
      .getByRole("button", {
        name: t(locale, "workspace.context_usage"),
        exact: true,
      })
      .or(
        canvas.getByRole("button", {
          name: t(locale, "workspace.context_usage_text_only"),
          exact: true,
        }),
      );
    await uniqueVisible(trigger, "Selected canvas must have one context usage trigger");
    await openOverlay(trigger);
    const dialog = await dialogSurface(page, locale, "workspace.context_usage", "popover-content");
    await dialog
      .getByRole("button", { name: t(locale, "workspace.close_context_usage"), exact: true })
      .waitFor();
    navigation.probe = await exactSurfaceProbe(page, dialog);
  }
  if (["task-detail", "task-run", "task-evidence"].includes(entry.overlay)) {
    const taskId = process.env.SUPERSTRING_VISUAL_TASK_ID;
    const title = process.env.SUPERSTRING_VISUAL_WEB_SOURCE_TITLE;
    const readyPath = process.env.SUPERSTRING_VISUAL_READY;
    assert(
      taskId && title && readyPath,
      "task-detail requires synthetic task ID, Web title and same-run ready file",
    );
    const ready = visualReady();
    const task = ready.seed?.task;
    assert(
      ready.ready === true &&
        ready.url === url &&
        task?.id === taskId &&
        task.action &&
        task.argumentsMarker &&
        task.conversationId === ready.seed.namedConversations?.web?.canonicalId &&
        task.source?.id === ready.seed.runs?.first?.source?.id &&
        task.source?.revision === ready.seed.runs?.first?.source?.revision &&
        task.source?.kind === "web_turn" &&
        task.source?.kind === ready.seed.runs?.first?.source?.kind &&
        task.originRunId === ready.seed.runs?.first?.runId &&
        ready.seed.namedConversations?.web?.sourceId ===
          process.env.SUPERSTRING_VISUAL_WEB_SOURCE_ID &&
        ready.seed.namedConversations?.web?.title === title,
      "Synthetic task ready identity/source mismatch",
    );
    const main = page.locator("main");
    const row = main.getByRole("row").filter({ has: page.getByText(title, { exact: true }) });
    const taskResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        requestUrl.origin === new URL(url).origin &&
        requestUrl.pathname === `/v2/permissions/tasks/${encodeURIComponent(taskId)}`
      );
    });
    await openOverlay(
      row.getByRole("button", { name: t(locale, "connections.tasks.open"), exact: true }),
    );
    const response = await taskResponse;
    assert(response.status() === 200, "Synthetic task detail read failed");
    const detail = await response.json();
    assert(
      detail.id === task.id &&
        detail.conversationId === task.conversationId &&
        detail.originRunId === task.originRunId &&
        detail.calls?.some((item) => item.ordinal === task.ordinal && item.name === task.action),
      "Synthetic task response identity mismatch",
    );
    const dialog = await dialogSurface(page, locale, "connections.tasks.detail", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.getByText(taskId, { exact: true }).waitFor();
    await dialog.getByText(task.action, { exact: true }).waitFor();
    const call = dialog
      .locator("section")
      .filter({ has: page.getByText(task.action, { exact: true }) });
    await call
      .getByRole("button", { name: t(locale, "connections.tasks.arguments"), exact: true })
      .click();
    await call.locator("pre").getByText(task.argumentsMarker, { exact: false }).waitFor();
    if (entry.overlay === "task-run" || entry.overlay === "task-evidence") {
      const runId = process.env.SUPERSTRING_VISUAL_RUN_ID;
      assert(runId, "task-run requires synthetic run ID");
      const trigger = dialog.getByRole("button", {
        name: t(locale, "observability.runDetails"),
        exact: true,
      });
      await trigger.evaluate((element) => {
        window.__visualNestedTrigger = element;
      });
      await trigger.click();
      const run = await dialogSurface(page, locale, "observability.runDetails", "dialog-content");
      navigation.parentOverlayProbe = navigation.probe;
      navigation.probe = await exactSurfaceProbe(page, run);
      const details = run.getByRole("region", {
        name: t(locale, "observability.selectedRunDetails"),
        exact: true,
      });
      await details.getByText(runId, { exact: true }).waitFor();
      if (entry.overlay === "task-evidence") {
        const calls = details.locator("button[data-run-id][data-step-id]");
        await calls.waitFor();
        assert(
          (await calls.count()) === 1 && (await calls.getAttribute("data-run-id")) === runId,
          "Synthetic run call identity mismatch",
        );
        await calls.click();
        const evidence = details.getByRole("region", {
          name: t(locale, "observability.modelEvidence"),
          exact: true,
        });
        await evidence
          .getByRole("button", { name: t(locale, "observability.modelInput"), exact: true })
          .click();
        const input = evidence.getByRole("region", {
          name: t(locale, "observability.modelInput"),
          exact: true,
        });
        const field = input.getByRole("textbox", {
          name: t(locale, "observability.findInThisContent"),
          exact: true,
        });
        await field.waitFor();
        const reader = field.locator("xpath=ancestor::section[1]");
        await reader.getByText("SYNTHETIC_WEB_source-a", { exact: true }).waitFor();
        await field.fill("source-a");
        await reader
          .getByText(t(locale, "observability.valueMatches").replace("{0}", "1"), { exact: true })
          .waitFor();
      }
    }
  }
  if (entry.overlay === "binding-editor") {
    const board = page.locator('main [data-bindings-scope="scheme"]:visible');
    await board.waitFor();
    const schemeId = process.env.SUPERSTRING_VISUAL_SCHEME_ID;
    assert(schemeId, "binding-editor requires a synthetic scheme ID");
    const row = await fixtureBindingRow(page, board, schemeId, locale);
    await openOverlay(
      row.getByRole("button", { name: t(locale, "connections.manage"), exact: true }),
    );
    const dialog = await namedDialogSurface(
      page,
      `${t(locale, "connections.group")} 30003`,
      "sheet-content",
    );
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog
      .getByText(`${t(locale, "schemes.qq.groupConfig.account")} 90001`, { exact: true })
      .waitFor();
  }
  if (entry.overlay === "model-service-add") {
    const main = page.locator("main");
    await openOverlay(
      main.getByRole("button", { name: t(locale, "models.addProvider"), exact: true }),
    );
    const dialog = await dialogSurface(page, locale, "models.addProvider", "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.getByLabel(t(locale, "models.name"), { exact: true }).waitFor();
    await dialog.getByLabel(t(locale, "models.baseUrl"), { exact: true }).waitFor();
  }
  if (entry.libraryScroll) {
    const main = page.locator("main");
    const scroller = main.getByTestId("library-workspace-scroll");
    const scrollerHandle = await scroller.elementHandle();
    assert(scrollerHandle, "Library scroll owner missing");
    const observation = { snapshots: [], events: [], network: [], expected: null, actual: null };
    const inFlight = new Set();
    let droppedNetwork = 0;
    const logNetwork = (entry) => {
      if (observation.network.length < 160) observation.network.push(entry);
      else droppedNetwork++;
    };
    const networkStart = (request) => {
      if (new URL(request.url()).origin !== new URL(url).origin) return;
      inFlight.add(request);
      logNetwork({
        event: "start",
        method: request.method(),
        path: new URL(request.url()).pathname,
      });
    };
    const networkEnd = (request) => {
      if (inFlight.delete(request))
        logNetwork({
          event: "settled",
          method: request.method(),
          path: new URL(request.url()).pathname,
        });
    };
    page.on("request", networkStart);
    page.on("requestfinished", networkEnd);
    page.on("requestfailed", networkEnd);
    const frame = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    const snap = async (phase) => {
      const state = await page.evaluate((owner) => {
        const rect = (element) => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom };
        };
        const current = document.querySelector('[data-testid="library-workspace-scroll"]');
        const tabs = [...owner.querySelectorAll('[role="tab"]')].map((tab) => {
          const box = tab.getBoundingClientRect(),
            viewport = owner.getBoundingClientRect();
          return {
            text: (tab.textContent ?? "").trim(),
            selected: tab.getAttribute("aria-selected"),
            rect: rect(tab),
            fullyVisible:
              box.top >= viewport.top &&
              box.bottom <= viewport.bottom &&
              box.left >= viewport.left &&
              box.right <= viewport.right,
          };
        });
        const active = document.activeElement;
        return {
          at: performance.now(),
          sameNode: owner === current,
          connected: owner.isConnected,
          scrollTop: owner.scrollTop,
          scrollHeight: owner.scrollHeight,
          clientHeight: owner.clientHeight,
          rect: rect(owner),
          tabs,
          active: active
            ? {
                tag: active.tagName.toLowerCase(),
                id: active.id || null,
                role: active.getAttribute("role"),
                text: (active.textContent ?? "").trim().slice(0, 100),
              }
            : null,
          hasFocus: document.hasFocus(),
        };
      }, scrollerHandle);
      observation.snapshots.push({
        phase,
        ...state,
        pendingObservedSinceInstrumentation: inFlight.size,
      });
    };
    let failure = null;
    try {
      await scrollerHandle.evaluate((owner) => {
        const events = [];
        let dropped = 0;
        const record = (event) => {
          if (events.length >= 160) {
            dropped++;
            return;
          }
          const target = event.target instanceof Element ? event.target : null;
          events.push({
            type: event.type,
            at: performance.now(),
            scrollTop: owner.scrollTop,
            scrollHeight: owner.scrollHeight,
            clientHeight: owner.clientHeight,
            selected: [...owner.querySelectorAll('[role="tab"][aria-selected="true"]')].map(
              (node) => (node.textContent ?? "").trim(),
            ),
            target: target
              ? {
                  tag: target.tagName.toLowerCase(),
                  role: target.getAttribute("role"),
                  text: (target.textContent ?? "").trim().slice(0, 80),
                }
              : null,
          });
        };
        owner.addEventListener("scroll", record, { passive: true });
        owner.addEventListener("pointerdown", record, { passive: true });
        owner.addEventListener("click", record, { passive: true });
        owner.addEventListener("focusin", record, { passive: true });
        const observer = new MutationObserver(() => record({ type: "dom-commit", target: owner }));
        observer.observe(owner, {
          subtree: true,
          attributes: true,
          attributeFilter: ["hidden", "aria-selected"],
        });
        window.__visualLibraryScrollObservation = {
          owner,
          events,
          record,
          observer,
          getDropped: () => dropped,
        };
      });
      await frame();
      await snap("initial-layout");
      const expected = await scroller.evaluate((el) => {
        window.__visualLibraryScrollObservation.setAt = performance.now();
        el.scrollTop = Math.min(80, el.scrollHeight - el.clientHeight);
        return el.scrollTop;
      });
      observation.expected = expected;
      await snap("after-set");
      await frame();
      await snap("after-set-frames");
      assert(expected > 0, "Synthetic memory page has no scroll range to verify");
      await snap("before-documents-click");
      await main.getByRole("tab", { name: t(locale, "library.documents"), exact: true }).click();
      await snap("after-documents-click");
      await main
        .getByRole("region", { name: t(locale, "library.document.library"), exact: true })
        .waitFor();
      await frame();
      await snap("documents-visible-frames");
      await snap("before-memory-click");
      await main.getByRole("tab", { name: t(locale, "library.memory"), exact: true }).click();
      await snap("after-memory-click");
      await main
        .getByRole("region", { name: t(locale, "library.memory.library"), exact: true })
        .waitFor();
      await frame();
      await snap("memory-visible-frames");
      await snap("memory-network-observation");
      const actual = await scroller.evaluate((el) => el.scrollTop);
      observation.actual = actual;
      assert(Math.abs(actual - expected) <= 1, "Memory tab scroll not restored");
      navigation.libraryScrollObservation = observation;
    } catch (error) {
      await snap("failure").catch(() => {});
      failure = error;
    } finally {
      const captured = await page
        .evaluate(() => {
          const state = window.__visualLibraryScrollObservation;
          if (!state) return { events: [], dropped: null };
          state.observer.disconnect();
          for (const name of ["scroll", "pointerdown", "click", "focusin"])
            state.owner.removeEventListener(name, state.record);
          delete window.__visualLibraryScrollObservation;
          return { events: state.events, dropped: state.getDropped(), setAt: state.setAt ?? null };
        })
        .catch(() => ({ events: [], dropped: null }));
      observation.events = captured.events;
      const afterSetFrames = observation.snapshots.find(
        (snapshot) => snapshot.phase === "after-set-frames",
      );
      observation.setScrollEventSeen =
        captured.setAt !== null &&
        captured.setAt !== undefined &&
        !!afterSetFrames &&
        captured.events.some(
          (event) =>
            event.type === "scroll" && event.at >= captured.setAt && event.at <= afterSetFrames.at,
        );
      observation.droppedEvents = captured.dropped;
      observation.droppedNetwork = droppedNetwork;
      observation.pendingObservedAtEnd = inFlight.size;
      page.off("request", networkStart);
      page.off("requestfinished", networkEnd);
      page.off("requestfailed", networkEnd);
      await scrollerHandle.dispose();
      if (failure) console.error(`LIBRARY_SCROLL_OBSERVATION ${JSON.stringify(observation)}`);
    }
    if (failure)
      throw new Error(
        `${String(failure)}; libraryScrollObservation=${JSON.stringify(observation)}`,
        { cause: failure },
      );
  }
  if (entry.overlay === "knowledge-settings") {
    const key = "library.organization.workspace.budget";
    await openOverlay(
      page.locator("main").getByRole("button", { name: t(locale, key), exact: true }),
    );
    const dialog = await dialogSurface(page, locale, key, "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
  }
  if (entry.overlay === "memory-manual" || entry.overlay === "memory-rebuild") {
    const buttonKey =
      entry.overlay === "memory-manual"
        ? "library.organize.memories.from.a.conversation"
        : "library.rebuildSearchProjection";
    const titleKey = entry.overlay === "memory-manual" ? buttonKey : "library.rebuild.title";
    const button = page
      .locator("main")
      .getByRole("button", { name: t(locale, buttonKey), exact: true });
    await waitEnabled(page, button);
    await openOverlay(button);
    const dialog = await dialogSurface(page, locale, titleKey, "sheet-content");
    navigation.probe = await exactSurfaceProbe(page, dialog);
    await dialog.waitFor();
    if (entry.overlay === "memory-manual")
      await dialog.getByLabel(t(locale, "library.source.conversation"), { exact: true }).waitFor();
  }
  if (entry.explicitAgent) {
    const agent = visualAgent();
    const region = page.getByRole("region", { name: labels[labels.length - 1], exact: true });
    const select = region.getByRole("combobox", {
      name: t(locale, "agent.materials.chooseAgent"),
      exact: true,
    });
    const configure = region.getByRole("button", {
      name: t(locale, "agent.materials.configureAgent"),
      exact: true,
    });
    await select.waitFor();
    assert((await select.inputValue()) === "", `${entry.id}: Agent is preselected`);
    assert(
      await configure.isDisabled(),
      `${entry.id}: configure must be disabled without an Agent`,
    );
    await page.waitForFunction(
      ({ label, id, name }) => {
        const node = [...document.querySelectorAll("select")].find(
          (item) => item.getAttribute("aria-label") === label,
        );
        return [...(node?.options ?? [])].some(
          (option) => option.value === id && option.textContent?.trim() === name,
        );
      },
      { label: t(locale, "agent.materials.chooseAgent"), id: agent.id, name: agent.name },
      { timeout: 15000 },
    );
    const option = select.getByRole("option", { name: agent.name, exact: true });
    assert(
      (await option.count()) === 1 && (await option.getAttribute("value")) === agent.id,
      `${entry.id}: synthetic Agent option mismatch`,
    );
    await select.selectOption(agent.id);
    await waitEnabled(page, configure);
    await configure.click();
    await waitAgentTask(page, locale, "strict.reading.title", agent);
    await page
      .locator("main")
      .getByRole("button", { name: t(locale, "library.all.assistants"), exact: true })
      .click();
    await region.waitFor();
    navigation.agent = agent;
  }
  if (entry.agentTask)
    navigation.probe = await exactSurfaceProbe(
      page,
      page.locator("main").getByRole("tabpanel", {
        name: t(locale, entry.agentTask),
        exact: true,
      }),
    );
  if (navigation.probe !== null)
    await uniqueVisible(page.locator(navigation.probe), "Final visit probe must be unique");
  // 对话可能一开始就是此视图，但必须已由选中态、scope 与真实内容证明，不能因字多就放行。
  await waitSettled(
    page,
    entry.view ||
      entry.schemeView ||
      entry.qqAppTab ||
      entry.extension ||
      entry.agentTask ||
      entry.explicitAgent ||
      entry.overlay ||
      entry.globalBindings ||
      entry.libraryScroll
      ? null
      : previous,
  );
  return navigation;
}

/** Browser-only measurement, also exercised verbatim by the standalone synthetic smoke. */
export function measureVisualPage(selector) {
  // A one-pixel allowance is only for fractional layout/glyph rounding, not scroll extents.
  const epsilon = 1;
  const rootElement = document.documentElement;
  const probeNode = selector === null ? null : document.querySelector(selector);
  const styles = new Map();
  const styleOf = (element) => {
    if (!styles.has(element)) styles.set(element, getComputedStyle(element));
    return styles.get(element);
  };
  const describe = (element) =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("data-slot") ? `[data-slot="${element.getAttribute("data-slot")}"]` : ""}${element.getAttribute("class") ? `.${element.getAttribute("class").split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  const rectOf = (rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  });
  const legacyClipRect = (style) => {
    if (!["absolute", "fixed"].includes(style.position)) return null;
    const match =
      /^rect\(\s*(auto|-?(?:\d+\.?\d*|\.\d+)px)\s*,\s*(auto|-?(?:\d+\.?\d*|\.\d+)px)\s*,\s*(auto|-?(?:\d+\.?\d*|\.\d+)px)\s*,\s*(auto|-?(?:\d+\.?\d*|\.\d+)px)\s*\)$/.exec(
        style.clip,
      );
    if (!match) return null;
    const value = (item, fallback) => (item === "auto" ? fallback : parseFloat(item));
    return {
      top: value(match[1], -Infinity),
      right: value(match[2], Infinity),
      bottom: value(match[3], Infinity),
      left: value(match[4], -Infinity),
    };
  };
  const visible = (element) => {
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = styleOf(node);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
        return false;
      const legacyClip = legacyClipRect(style);
      if (
        legacyClip &&
        (legacyClip.right <= legacyClip.left || legacyClip.bottom <= legacyClip.top)
      )
        return false;
      // A 50% inset on every side clips the entire box, including its descendants.
      // Keep partially clipped boxes in the measurement so real truncation is reported.
      const inset = /^inset\(\s*50(?:\.0+)?%(?:\s+50(?:\.0+)?%){0,3}\s*\)$/.test(style.clipPath);
      if (inset) return false;
    }
    return true;
  };
  const hasColor = (color) =>
    color !== "transparent" &&
    !/^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) &&
    !/\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
  const paintsBox = (style) =>
    hasColor(style.backgroundColor) ||
    style.backgroundImage !== "none" ||
    ["Left", "Right", "Top", "Bottom"].some(
      (side) =>
        parseFloat(style[`border${side}Width`]) > 0 &&
        !["none", "hidden"].includes(style[`border${side}Style`]) &&
        hasColor(style[`border${side}Color`]),
    );
  const clipBox = (element) => {
    const rect = element.getBoundingClientRect();
    const style = styleOf(element);
    const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    const left =
      rect.left + (element.clientLeft ?? parseFloat(style.borderLeftWidth) ?? 0) * scaleX;
    const top = rect.top + (element.clientTop ?? parseFloat(style.borderTopWidth) ?? 0) * scaleY;
    return {
      left,
      top,
      right:
        left +
        (element.clientWidth ||
          rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)) *
          scaleX,
      bottom:
        top +
        (element.clientHeight ||
          rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)) *
          scaleY,
    };
  };
  const issues = [];
  const add = (element, kind, original, start = element, text = null) => {
    if (original.width <= 0 || original.height <= 0) return;
    const rect = rectOf(original);
    for (let ancestor = start; ancestor; ancestor = ancestor.parentElement) {
      const style = styleOf(ancestor);
      if (style.display === "contents") continue;
      const box = clipBox(ancestor);
      const hiddenX = ["hidden", "clip"].includes(style.overflowX);
      const hiddenY = ["hidden", "clip"].includes(style.overflowY);
      const legacy = legacyClipRect(style);
      const border = ancestor.getBoundingClientRect();
      const legacyX = legacy
        ? Math.max(
            0,
            border.left + legacy.left - rect.left,
            rect.right - border.left - legacy.right,
          )
        : 0;
      const legacyY = legacy
        ? Math.max(0, border.top + legacy.top - rect.top, rect.bottom - border.top - legacy.bottom)
        : 0;
      const byX = Math.max(
        legacyX,
        hiddenX ? Math.max(0, box.left - rect.left, rect.right - box.right) : 0,
      );
      const byY = Math.max(
        legacyY,
        hiddenY ? Math.max(0, box.top - rect.top, rect.bottom - box.bottom) : 0,
      );
      if (Math.max(byX, byY) > epsilon) {
        issues.push({
          element,
          selector: describe(element),
          kind,
          text,
          by: Math.max(byX, byY),
          byX,
          byY,
          rect: rectOf(original),
          clippingAncestor: describe(ancestor),
          clipRect: rectOf(box),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        });
        return;
      }
      // Content beyond an auto/scroll viewport is reachable, not lost. Only its currently
      // exposed part can be clipped by an outer hidden/clip ancestor. Its OWN hidden text
      // was checked above before reaching this scroll container.
      if (["auto", "scroll"].includes(style.overflowX)) {
        rect.left = Math.max(rect.left, box.left);
        rect.right = Math.min(rect.right, box.right);
      }
      if (["auto", "scroll"].includes(style.overflowY)) {
        rect.top = Math.max(rect.top, box.top);
        rect.bottom = Math.min(rect.bottom, box.bottom);
      }
      if (rect.right <= rect.left || rect.bottom <= rect.top) return;
    }
  };
  const elements = [...document.querySelectorAll("body *")];
  for (const element of elements) {
    if (!visible(element) || element.matches("script, style, option")) continue;
    const style = styleOf(element);
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim() || !hasColor(style.color))
        continue;
      const range = document.createRange();
      const start = node.textContent.search(/\S/);
      const end = node.textContent.trimEnd().length;
      range.setStart(node, start);
      range.setEnd(node, end);
      for (const rect of range.getClientRects())
        add(element, "text-range", rect, element, node.textContent.trim().slice(0, 160));
    }
    if (
      element instanceof SVGGraphicsElement &&
      !element.matches("svg, g, defs, clipPath, mask, symbol, use")
    ) {
      // Measure painted SVG geometry, not the unpainted viewport or a transparent hit target.
      const fill = style.fill !== "none" && hasColor(style.fill) && Number(style.fillOpacity) > 0;
      const stroke =
        style.stroke !== "none" && hasColor(style.stroke) && Number(style.strokeOpacity) > 0;
      if (fill || stroke) {
        const bbox = element.getBBox();
        const matrix = element.getScreenCTM();
        if (matrix) {
          const pad = stroke ? parseFloat(style.strokeWidth) / 2 : 0;
          const points = [
            [bbox.x - pad, bbox.y - pad],
            [bbox.x + bbox.width + pad, bbox.y - pad],
            [bbox.x - pad, bbox.y + bbox.height + pad],
            [bbox.x + bbox.width + pad, bbox.y + bbox.height + pad],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
          const left = Math.min(...points.map((point) => point.x));
          const right = Math.max(...points.map((point) => point.x));
          const top = Math.min(...points.map((point) => point.y));
          const bottom = Math.max(...points.map((point) => point.y));
          add(
            element,
            "svg-paint",
            { left, right, top, bottom, width: right - left, height: bottom - top },
            element.parentElement,
          );
        }
      }
    } else if (paintsBox(style) || element.matches("img, canvas, video")) {
      add(element, "painted-child", element.getBoundingClientRect(), element.parentElement);
    }
    if (
      element instanceof HTMLInputElement &&
      ["text", "search", "url", "email", "tel", "password", "number"].includes(element.type)
    ) {
      const text = element.value || element.placeholder;
      if (text) {
        // Native input text is not in the DOM Range tree and always has a single-line
        // internal clipping viewport, even when computed overflow is visible/auto.
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        context.font = style.font;
        context.fontKerning = style.fontKerning;
        const displayText =
          element.type === "password" && element.value ? "•".repeat(text.length) : text;
        const spacing = parseFloat(style.letterSpacing) || 0;
        const width =
          context.measureText(displayText).width + Math.max(0, displayText.length - 1) * spacing;
        const available =
          element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (width > available + epsilon) {
          issues.push({
            element,
            selector: describe(element),
            kind: "input-text",
            text: displayText.slice(0, 160),
            by: width - available,
            byX: width - available,
            byY: 0,
            rect: rectOf(element.getBoundingClientRect()),
            clippingAncestor: `${describe(element)} (native text viewport)`,
            clipRect: rectOf(clipBox(element)),
            textWidth: width,
            availableWidth: available,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          });
        }
      }
    }
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      // Empty transparent pseudos have no visible content. This is not a button exemption:
      // the element's indicator, SVG paint and text still pass through the same ancestor checks.
      if (
        ["none", "normal"].includes(pseudoStyle.content) ||
        pseudoStyle.display === "none" ||
        Number(pseudoStyle.opacity) === 0 ||
        (!paintsBox(pseudoStyle) && ['""', "''"].includes(pseudoStyle.content))
      )
        continue;
      if (
        pseudoStyle.position === "absolute" &&
        Number.isFinite(parseFloat(pseudoStyle.left)) &&
        Number.isFinite(parseFloat(pseudoStyle.top))
      ) {
        const box = clipBox(element);
        const left = box.left + parseFloat(pseudoStyle.left);
        const top = box.top + parseFloat(pseudoStyle.top);
        const width =
          parseFloat(pseudoStyle.width) +
          (pseudoStyle.boxSizing === "border-box"
            ? 0
            : parseFloat(pseudoStyle.paddingLeft) +
              parseFloat(pseudoStyle.paddingRight) +
              parseFloat(pseudoStyle.borderLeftWidth) +
              parseFloat(pseudoStyle.borderRightWidth));
        const height =
          parseFloat(pseudoStyle.height) +
          (pseudoStyle.boxSizing === "border-box"
            ? 0
            : parseFloat(pseudoStyle.paddingTop) +
              parseFloat(pseudoStyle.paddingBottom) +
              parseFloat(pseudoStyle.borderTopWidth) +
              parseFloat(pseudoStyle.borderBottomWidth));
        add(element, `painted-pseudo${pseudo}`, {
          left,
          top,
          right: left + width,
          bottom: top + height,
          width,
          height,
        });
      }
    }
  }
  const publicIssue = ({ element, ...detail }) => detail;
  const probeIssues = issues.filter(
    ({ element }) => probeNode && (element === probeNode || probeNode.contains(element)),
  );
  const worst = probeIssues.reduce(
    (result, issue) => (!result || issue.by > result.by ? issue : result),
    null,
  );
  const checkboxHitareas = elements
    .filter(
      (element) =>
        element.matches('[data-slot="checkbox"]') &&
        visible(element) &&
        element.scrollWidth > element.clientWidth + epsilon,
    )
    .map((element) => {
      const after = getComputedStyle(element, "::after");
      const descendants = [element, ...element.querySelectorAll("*")];
      const contentIssues = issues.filter((issue) => descendants.includes(issue.element));
      return {
        selector: describe(element),
        scrollBy: element.scrollWidth - element.clientWidth,
        pseudo: {
          content: after.content,
          background: after.backgroundColor,
          painted: paintsBox(after),
          left: after.left,
          right: after.right,
        },
        indicatorRects: [...element.querySelectorAll('[data-slot="checkbox-indicator"], svg')].map(
          (child) => ({ selector: describe(child), rect: rectOf(child.getBoundingClientRect()) }),
        ),
        visibleContentClipped: contentIssues.length > 0,
      };
    });
  return {
    scrollWidth: rootElement.scrollWidth,
    textLength: (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, " ").trim()
      .length,
    probePresent: selector === null ? true : probeNode !== null,
    probeClipped: worst?.by ?? 0,
    probeClipDetail: worst
      ? `${worst.selector} (${worst.kind}; clipped by ${worst.clippingAncestor})`
      : null,
    probeClipEvidence: probeIssues.slice(0, 20).map(publicIssue),
    clipped: issues.slice(0, 20).map(publicIssue),
    clippedCount: issues.length,
    checkboxHitareas,
    theme: rootElement.dataset.theme ?? null,
    mode: rootElement.classList.contains("dark") ? "dark" : "light",
  };
}

/** What every visit must satisfy, plus the numbers worth reporting when it does not. */
async function inspect(page, probe) {
  if (probe !== null)
    await uniqueVisible(
      page.locator(probe),
      "Final measurement probe must have one visible target",
    );
  const metrics = await page.evaluate(measureVisualPage, probe);
  const appearance = await page.evaluate((dimensions) => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      font: root.dataset.font ?? null,
      textSize: root.dataset.textSize ?? null,
      interfaceSize: root.dataset.interfaceSize ?? null,
      textScale: Number(style.getPropertyValue("--app-text-scale").trim() || NaN),
      interfaceScale: Number(style.getPropertyValue("--app-interface-scale").trim() || NaN),
      zoom: style.zoom,
      fontFamily: style.fontFamily,
      stored: Object.fromEntries(
        Object.entries(dimensions).map(([axis, dimension]) => [
          axis,
          localStorage.getItem(dimension.key),
        ]),
      ),
    };
  }, appearanceDimensions);
  metrics.appearance = appearance;
  for (const [axis, dimension] of Object.entries(appearanceDimensions))
    assert(
      appearance[axis] === dimension.expected,
      `${axis}: expected ${dimension.expected}, got ${appearance[axis]}`,
    );
  for (const [axis, actual] of [
    ["textSize", appearance.textScale],
    ["interfaceSize", appearance.interfaceScale],
  ])
    assert(
      Number.isFinite(actual) && actual === appearanceDimensions[axis].expectedScale,
      `${axis}: computed scale ${actual} does not match CSS ${appearanceDimensions[axis].expectedScale}`,
    );
  const zoom = Number(appearance.zoom);
  assert(
    Number.isFinite(zoom) && zoom === appearanceDimensions.interfaceSize.expectedScale,
    `interfaceSize: computed zoom ${appearance.zoom} does not match CSS ${appearanceDimensions.interfaceSize.expectedScale}`,
  );
  assert(appearance.fontFamily.trim(), "Computed font family is empty");
  return metrics;
}

async function inspectFocus(page, locale) {
  await page.evaluate(() => {
    delete window.__visualNaturalFocusTarget;
  });
  const snapshot = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      const body = !element || element === document.body || element === document.documentElement;
      const style = element && !body ? getComputedStyle(element) : null;
      const rect = element && !body ? element.getBoundingClientRect() : null;
      const ancestry = [];
      for (let node = element; node && ancestry.length < 12; node = node.parentElement) {
        const computed = getComputedStyle(node);
        ancestry.push({
          tag: node.tagName.toLowerCase(),
          id: node.id || null,
          role: node.getAttribute("role"),
          hidden: node.hidden,
          inert: node.inert,
          ariaHidden: node.getAttribute("aria-hidden"),
          display: computed.display,
          visibility: computed.visibility,
        });
      }
      const focusable =
        !!element &&
        !body &&
        element instanceof HTMLElement &&
        !element.matches(':disabled,[aria-disabled="true"]') &&
        !element.closest('[inert],[hidden],[aria-hidden="true"]') &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        (element.tabIndex >= 0 ||
          element.matches('a[href],button,input,select,textarea,[contenteditable="true"]'));
      const paint = (node) => {
        const computed = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
          outlineStyle: computed.outlineStyle,
          outlineWidth: computed.outlineWidth,
          outlineColor: computed.outlineColor,
          boxShadow: computed.boxShadow,
          borderColor: computed.borderColor,
          display: computed.display,
          visibility: computed.visibility,
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      };
      const inputPaint = style ? paint(element) : null;
      const group =
        element instanceof HTMLElement
          ? element.closest('[data-slot="input-group"][role="group"]')
          : null;
      const groupPaint = group ? paint(group) : null;
      const storedBaseline = group ? (window.__visualInputGroupBaseline?.get(group) ?? null) : null;
      const baseline =
        storedBaseline?.controlNode === element
          ? Object.fromEntries(
              Object.entries(storedBaseline).filter(([key]) => key !== "controlNode"),
            )
          : null;
      const focusVisible = !!element && element.matches(":focus-visible");
      const naturalTarget = window.__visualNaturalFocusTarget;
      const sameNaturalTarget =
        !naturalTarget || (naturalTarget.control === element && naturalTarget.group === group);
      const groupEligible =
        !!group &&
        group.contains(element) &&
        sameNaturalTarget &&
        focusVisible &&
        !group.closest('[inert],[hidden],[aria-hidden="true"]') &&
        groupPaint.display !== "none" &&
        groupPaint.visibility !== "hidden" &&
        groupPaint.rect.width > 0 &&
        groupPaint.rect.height > 0;
      const directVisible =
        !!style &&
        ((style.outlineStyle !== "none" && style.outlineWidth !== "0px") ||
          style.boxShadow !== "none");
      const changedOutline =
        !!baseline &&
        groupPaint.outlineStyle !== "none" &&
        parseFloat(groupPaint.outlineWidth) > 0 &&
        (groupPaint.outlineStyle !== baseline.outlineStyle ||
          groupPaint.outlineWidth !== baseline.outlineWidth ||
          groupPaint.outlineColor !== baseline.outlineColor);
      const changedShadow =
        !!baseline &&
        groupPaint.boxShadow !== "none" &&
        groupPaint.boxShadow !== baseline.boxShadow &&
        /(?:[1-9]\d*|0?\.\d*[1-9]\d*)px/.test(groupPaint.boxShadow);
      const groupControl =
        !!group && element.matches('[data-slot="input-group-control"],[data-slot="command-input"]');
      const visible = groupControl
        ? groupEligible && (changedOutline || changedShadow)
        : directVisible;
      return {
        hasFocus: document.hasFocus(),
        body,
        focusable,
        visible,
        focusVisible,
        sameNaturalTarget,
        inputPaint,
        inputGroup: group
          ? { eligible: groupEligible, paint: groupPaint, baseline, changedOutline, changedShadow }
          : null,
        description: element
          ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`
          : "none",
        modal: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(
          (node) => ({
            role: node.getAttribute("role"),
            state: node.getAttribute("data-state"),
            hidden: node.hidden,
          }),
        ),
        ancestry,
      };
    });
  const trace = [{ action: "before", ...(await snapshot()) }];
  if (trace[0].inputGroup?.eligible && !trace[0].inputGroup.baseline) {
    const handles = await page.evaluateHandle(() => {
      const control = document.activeElement;
      const group = control?.closest('[data-slot="input-group"][role="group"]');
      const dialog = control?.closest('[role="dialog"][data-state="open"]');
      const command = control?.matches('[data-slot="command-input"]');
      if (command && dialog && group) window.__visualNaturalFocusTarget = { control, group };
      return { control, group, dialog, command };
    });
    try {
      const command = await page.evaluate(
        () => document.activeElement?.matches('[data-slot="command-input"]') ?? false,
      );
      // The command palette's visible guidance is non-interactive and remains inside the modal.
      if (command) {
        const dialog = page.getByRole("dialog", {
          name: t(locale, "workspace.search_and_jump"),
          exact: true,
        });
        const guidance = dialog.locator("span:visible").filter({
          hasText: t(
            locale,
            "workspace.search_pages_or_loaded_conversations_use_the_arrow_keys_to_select_and_en",
          ),
        });
        await uniqueVisible(guidance, "Command guidance must be unique and visible");
        try {
          await guidance.click();
        } catch (error) {
          throw new Error(
            `Natural baseline click failed: ${String(error)}; trace=${JSON.stringify(trace)}`,
          );
        }
        const observation = await page.evaluate(({ control, group, dialog }) => {
          const describe = (node) =>
            node
              ? {
                  tag: node.tagName?.toLowerCase() ?? null,
                  id: node.id || null,
                  role: node.getAttribute?.("role") ?? null,
                }
              : null;
          const identity =
            !!control?.isConnected &&
            !!group?.isConnected &&
            !!dialog?.isConnected &&
            group.contains(control) &&
            dialog.contains(group);
          const state = {
            identity,
            active: describe(document.activeElement),
            hasFocus: document.hasFocus(),
            focusVisible: !!control?.matches(":focus-visible"),
            controlActive: document.activeElement === control,
          };
          if (identity && !state.focusVisible) {
            const style = getComputedStyle(group),
              rect = group.getBoundingClientRect();
            const cs = getComputedStyle(control),
              cr = control.getBoundingClientRect();
            if (
              rect.width &&
              rect.height &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              !group.closest('[hidden],[inert],[aria-hidden="true"]')
            ) {
              window.__visualInputGroupBaseline?.set(group, {
                controlNode: control,
                boxShadow: style.boxShadow,
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
                outlineColor: style.outlineColor,
                borderColor: style.borderColor,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                control: {
                  outlineStyle: cs.outlineStyle,
                  outlineWidth: cs.outlineWidth,
                  outlineColor: cs.outlineColor,
                  boxShadow: cs.boxShadow,
                  borderColor: cs.borderColor,
                  rect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
                },
              });
              state.baselineRecorded = true;
            }
          }
          return state;
        }, handles);
        trace.push({ action: "click-dialog-guidance", ...observation });
      }
    } finally {
      await handles.dispose();
    }
  }
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    const state = await snapshot();
    trace.push({ action: key, ...state });
    if (state.focusable && state.hasFocus && state.sameNaturalTarget)
      return { reached: true, visible: state.visible, description: state.description, trace };
    if (!state.body && state.sameNaturalTarget) break;
  }
  const last = trace[trace.length - 1];
  return { reached: false, visible: false, description: last.description, trace };
}
/**
 * A failing run must leave evidence behind. The throw used to reach `finally`, close the browser
 * and leave nothing to look at; from now on the current page's state, its screenshot and the
 * hygiene collected so far are written next to the report (unique timestamped names, an earlier
 * run's files are never overwritten) and only then the error is rethrown.
 */
async function captureFailure(error, active) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const detail = {
    timestamp: new Date().toISOString(),
    appearanceDimensions,
    url,
    phase: active?.name ?? "setup",
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
    passed: false,
    screenshots: [],
    page: null,
    metrics: active?.metrics ?? null,
    completedChecks: results.length,
    compactNavigationTrace: active?.compactNavigationTrace ?? null,
    overlayCloseTrace: active?.overlayCloseTrace ?? null,
    completedScreenshots: [...screenshots],
    sourceActivity: [...sourceActivity],
    freeze,
    finalFreezeClaimed: false,
    hygiene: null,
  };
  if (active?.page) {
    const file = `qq-pages-failure-${slug(active.name ?? "unknown")}-${stamp}.png`;
    try {
      await active.page.screenshot({ path: resolve(outputDir, file), fullPage: true });
      detail.screenshots.push(file);
    } catch (screenshotError) {
      detail.screenshotError = String(screenshotError);
    }
    try {
      detail.page = await active.page.evaluate(() => ({
        htmlLang: document.documentElement.lang,
        dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(
          (node) => {
            const style = getComputedStyle(node),
              rect = node.getBoundingClientRect();
            return {
              role: node.getAttribute("role"),
              state: node.getAttribute("data-state"),
              hidden: node.hidden,
              ariaHidden: node.getAttribute("aria-hidden"),
              visible:
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0,
              name:
                node.getAttribute("aria-label") ??
                (node.getAttribute("aria-labelledby") ?? "")
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
                  .join(" "),
            };
          },
        ),
        storedLocale: localStorage.getItem("superstring-locale"),
        storedTheme: localStorage.getItem("superstring-appearance"),
        storedMode: localStorage.getItem("superstring-appearance-mode"),
        asideButtons: [...document.querySelectorAll("aside button")]
          .map((button) => (button.textContent ?? "").trim())
          .filter(Boolean),
        tabNames: [...document.querySelectorAll("[role=tab]")].map((tab) =>
          (tab.textContent ?? "").trim(),
        ),
        selectedTabs: [...document.querySelectorAll('[role=tab][aria-selected="true"]')].map(
          (tab) => (tab.textContent ?? "").trim(),
        ),
        statusTexts: [...document.querySelectorAll('[role="status"]')]
          .map((node) => (node.textContent ?? "").trim())
          .filter(Boolean),
        regions: [...document.querySelectorAll("section[aria-label]")].map((section) =>
          section.getAttribute("aria-label"),
        ),
        mainHead: (document.querySelector("main")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400),
      }));
    } catch (pageError) {
      detail.pageError = String(pageError);
    }
  }
  if (active?.hygiene) {
    detail.hygiene = {
      consoleErrors: [...active.hygiene.consoleErrors],
      failedRequests: [...active.hygiene.failedRequests],
      httpErrors: [...active.hygiene.httpErrors],
      externalRequests: [...active.hygiene.externalRequests],
    };
  }
  try {
    const destination = resolve(outputDir, `qq-pages-failure-${stamp}.json`);
    writeFileSync(destination, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    console.error(`QQ PAGES MATRIX FAILED in ${detail.phase} -> ${destination}`);
  } catch (writeError) {
    console.error(
      `QQ PAGES MATRIX FAILED in ${detail.phase}; failure report could not be written: ${writeError}`,
    );
  }
}

const contextOptions = async (
  browser,
  { locale, theme, mode, viewport, scheme, reducedMotion },
) => {
  const context = await browser.newContext({
    viewport,
    // 跟随系统时不注入系统偏好：由调用方给出的 scheme 扮演操作系统，
    // 应用应把它解析成同样的明暗（dataset.mode 仍是 system）。
    colorScheme: scheme ?? (mode === "dark" ? "dark" : "light"),
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  // Before the app boots: locale and appearance are read from storage on start-up. This is the
  // product's only locale source in a plain browser (readLocale in src/web/i18n/index.ts); the
  // desktop bridge that could restore preferences from the host is absent here, so nothing reads
  // a server-side value back over local storage.
  await context.addInitScript(
    ([nextLocale, nextTheme, nextMode, dimensions]) => {
      localStorage.setItem("superstring-locale", nextLocale);
      localStorage.setItem("superstring-appearance", nextTheme);
      localStorage.setItem("superstring-appearance-mode", nextMode);
      for (const { key, requested } of Object.values(dimensions))
        if (requested !== null) localStorage.setItem(key, requested);
      const baseline = new WeakMap();
      window.__visualInputGroupBaseline = baseline;
      const remember = (group) => {
        if (
          !document.styleSheets.length ||
          !group.isConnected ||
          group.contains(document.activeElement)
        )
          return;
        const style = getComputedStyle(group);
        const rect = group.getBoundingClientRect();
        if (
          !rect.width ||
          !rect.height ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          group.closest('[hidden],[inert],[aria-hidden="true"]')
        )
          return;
        const controls = group.querySelectorAll(
          '[data-slot="input-group-control"],[data-slot="command-input"]',
        );
        if (controls.length !== 1) return;
        const control = controls[0],
          controlStyle = getComputedStyle(control),
          controlRect = control.getBoundingClientRect();
        baseline.set(group, {
          controlNode: control,
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          borderColor: style.borderColor,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          control: {
            outlineStyle: controlStyle.outlineStyle,
            outlineWidth: controlStyle.outlineWidth,
            outlineColor: controlStyle.outlineColor,
            boxShadow: controlStyle.boxShadow,
            borderColor: controlStyle.borderColor,
            rect: {
              x: controlRect.x,
              y: controlRect.y,
              width: controlRect.width,
              height: controlRect.height,
            },
          },
        });
      };
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('[data-slot="input-group"][role="group"]')) remember(node);
            node.querySelectorAll('[data-slot="input-group"][role="group"]').forEach(remember);
          }
      }).observe(document, { childList: true, subtree: true });
      document.addEventListener(
        "focusout",
        (event) => {
          const group =
            event.target instanceof Element
              ? event.target.closest('[data-slot="input-group"][role="group"]')
              : null;
          if (group) requestAnimationFrame(() => remember(group));
        },
        true,
      );
    },
    [locale, theme, mode, appearanceDimensions],
  );
  return context;
};

/**
 * 控制台与网络的客观异常。诊断只在一次页面访问内累计，访问前清空、就绪后断言。
 * 取消（ERR_ABORTED）是导航与重渲染的正常副产品，不算异常；跨源请求一律算异常——
 * 本实例只应访问自己的回环地址。
 */
const sourceActivity = [];
function checkFreeze() {
  freeze.sourceAfter = sourceFingerprints();
  freeze.sourceChanges = [
    ...new Set([...Object.keys(sourceBefore), ...Object.keys(freeze.sourceAfter)]),
  ].filter((file) => sourceBefore[file] !== freeze.sourceAfter[file]);
  freeze.hmr = sourceActivity.filter((item) => item.type === "hmr" || item.type === "hmr-console");
  freeze.checked = true;
  freeze.valid = freeze.sourceChanges.length === 0 && freeze.hmr.length === 0;
  if (uiFrozen)
    assert(
      freeze.valid,
      `Frozen visual run invalid: ${freeze.sourceChanges.length} source changes, ${freeze.hmr.length} HMR events`,
    );
}
const watchPage = (page) => {
  const base = new URL(url);
  const state = { consoleErrors: [], failedRequests: [], httpErrors: [], externalRequests: [] };
  const pendingReads = new Map();
  let requestTimings = [];
  const finishRequest = (request, failure = null) => {
    const started = pendingReads.get(request);
    if (!started) return;
    pendingReads.delete(request);
    requestTimings.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      resourceType: request.resourceType(),
      durationMs: Math.round((performance.now() - started.at) * 10) / 10,
      failure,
    });
  };
  state.readTiming = () => ({
    completed: requestTimings.length,
    pending: pendingReads.size,
    slowest: [...requestTimings].sort((a, b) => b.durationMs - a.durationMs).slice(0, 8),
    qualification:
      "Client request duration, not server CPU or pure page read latency; no pass threshold",
  });
  page.on("requestfinished", (request) => finishRequest(request));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      sourceActivity.push({
        at: new Date().toISOString(),
        phase: active?.name,
        type: "navigation",
        url: frame.url(),
      });
  });
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (["update", "full-reload", "error"].includes(message.type))
          sourceActivity.push({
            at: new Date().toISOString(),
            phase: active?.name,
            type: "hmr",
            message,
          });
      } catch {
        /* Vite ping/non-JSON frames do not describe source changes. */
      }
    });
  });
  page.on("pageerror", (error) => state.consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(`console: ${message.text()}`);
    if (/\[vite\].*(hot updated|page reload)/i.test(message.text()))
      sourceActivity.push({
        at: new Date().toISOString(),
        phase: active?.name,
        type: "hmr-console",
        text: message.text(),
      });
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      state.httpErrors.push({ status: response.status(), url: response.url() });
  });
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    finishRequest(request, reason || "unknown");
    if (!reason.includes("ERR_ABORTED"))
      state.failedRequests.push(`${request.url()} (${reason || "unknown"})`);
  });
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.protocol === "data:" || target.protocol === "blob:") return;
    if (target.host === base.host) pendingReads.set(request, { at: performance.now() });
    if (target.host !== base.host) state.externalRequests.push(request.url());
  });
  state.reset = () => {
    pendingReads.clear();
    requestTimings = [];
    state.consoleErrors.length = 0;
    state.failedRequests.length = 0;
    state.httpErrors.length = 0;
    state.externalRequests.length = 0;
  };
  return state;
};

const executablePath = process.env.SUPERSTRING_VISUAL_BROWSER_EXECUTABLE;
const channel = process.env.SUPERSTRING_VISUAL_BROWSER_CHANNEL ?? "chromium";
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel }),
  headless: true,
});
const results = [];
const screenshots = [];
// 失败证据要指到“当时那一页”，所以每进入一次页面访问就更新 active；失败的截图与页面状态
// 都由 captureFailure 取自它。
let active = null;
try {
  for (const locale of LOCALES) {
    for (const viewport of VIEWPORTS) {
      const context = await contextOptions(browser, {
        locale,
        theme: MATRIX_THEME,
        mode: "light",
        viewport,
      });
      const page = await context.newPage();
      const hygiene = watchPage(page);
      for (const entry of PAGES) {
        const name = `${entry.id}-${locale}-${viewport.name}`;
        hygiene.reset();
        active = { name, page, hygiene };
        const visitStarted = performance.now();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#superstring-shell");
        const navigation = await openPage(page, entry, locale);
        navigation.readTiming = {
          ...hygiene.readTiming(),
          scriptedReadyMs: Math.round(performance.now() - visitStarted),
          readyQualification:
            "Navigation, scripted actions and normal animations included; not pure I/O",
        };
        const metrics = await inspectVisit(page, navigation);
        active.metrics = metrics;
        assert(
          metrics.scrollWidth <= viewport.width,
          `${name}: horizontal overflow (${metrics.scrollWidth} > ${viewport.width})`,
        );
        assert(metrics.textLength > 40, `${name}: settings content is empty`);
        assert(metrics.probePresent, `${name}: missing ${navigation.probe}`);
        assert(
          metrics.probeClipped === 0,
          `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
        );
        assert(
          metrics.theme === MATRIX_THEME && metrics.mode === "light",
          `${name}: appearance not applied`,
        );
        assert(
          hygiene.httpErrors.length === 0,
          `${name}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
        );
        assert(
          hygiene.consoleErrors.length === 0,
          `${name}: console error (${hygiene.consoleErrors[0]})`,
        );
        assert(
          hygiene.failedRequests.length === 0,
          `${name}: failed request (${hygiene.failedRequests[0]})`,
        );
        assert(
          hygiene.externalRequests.length === 0,
          `${name}: off-origin request (${hygiene.externalRequests[0]})`,
        );
        const focus = await inspectFocus(page, locale);
        assert(
          focus.reached,
          `${name}: keyboard focus never leaves the body (${JSON.stringify(focus)}, main: ${metrics.textLength} chars)`,
        );
        assert(
          focus.visible,
          `${name}: focused element has no visible outline (${JSON.stringify(focus)})`,
        );
        if (viewport.width === 1440 || (viewport.width < 400 && locale === "zh-CN")) {
          const file = `qq-pages-${slug(name)}.png`;
          await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
          screenshots.push(file);
        }
        const overlayClose = await closeVisitOverlay(page, entry, navigation, locale);
        results.push({
          name,
          passed: true,
          navigation: { ...navigation, view: entry.view ?? null, scope: entry.scope ?? null },
          metrics,
          focus,
          overlayClose,
          hygiene: {
            consoleErrors: hygiene.consoleErrors.length,
            failedRequests: hygiene.failedRequests.length,
            httpErrors: hygiene.httpErrors.length,
            externalRequests: hygiene.externalRequests.length,
          },
        });
        console.log(`[PASS] ${name}`);
        // 本群配置：逐一切六分组 + 第七「本群能力」页签，只校验活动 tabpanel 的内容；
        // 不走 waitSchemeView（那是详情 settings/bindings 两 view 的锚点，本页没有该选择器）。
        if (entry.finalTabKeys !== undefined && entry.groupConfig === true) {
          for (const [index, tabKey] of entry.finalTabKeys.entries()) {
            const tabName = t(locale, tabKey);
            const tabCheck = `${name}-tab-${index + 1}`;
            hygiene.reset();
            active = { name: tabCheck, page, hygiene };
            const region = await qqConfigRegion(page, entry, locale);
            await region.getByRole("tab", { name: tabName, exact: true }).click();
            await region
              .getByRole("tab", { name: tabName, exact: true, selected: true })
              .waitFor({ timeout: 15000 });
            const panel = region.getByRole("tabpanel", { name: tabName, exact: true });
            const tabProbe = await exactSurfaceProbe(page, panel);
            const tabMetrics = await inspect(page, tabProbe);
            active.metrics = tabMetrics;
            assert(
              tabMetrics.scrollWidth <= viewport.width,
              `${tabCheck}: horizontal overflow (${tabMetrics.scrollWidth} > ${viewport.width})`,
            );
            assert(tabMetrics.textLength > 40, `${tabCheck}: tab content is empty`);
            assert(tabMetrics.probePresent, `${tabCheck}: missing ${tabProbe}`);
            assert(
              tabMetrics.probeClipped === 0,
              `${tabCheck}: ${tabMetrics.probeClipDetail} clips its content by ${tabMetrics.probeClipped}px`,
            );
            assert(
              tabMetrics.theme === MATRIX_THEME && tabMetrics.mode === "light",
              `${tabCheck}: appearance not applied`,
            );
            const tabFocus = await inspectFocus(page, locale);
            assert(
              tabFocus.reached && tabFocus.visible,
              `${tabCheck}: no visible keyboard focus (${JSON.stringify(tabFocus)})`,
            );
            assert(
              hygiene.httpErrors.length === 0,
              `${tabCheck}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
            );
            assert(
              hygiene.consoleErrors.length === 0,
              `${tabCheck}: console error (${hygiene.consoleErrors[0]})`,
            );
            assert(
              hygiene.failedRequests.length === 0,
              `${tabCheck}: failed request (${hygiene.failedRequests[0]})`,
            );
            assert(
              hygiene.externalRequests.length === 0,
              `${tabCheck}: off-origin request (${hygiene.externalRequests[0]})`,
            );
            if (viewport.width === 1440 || (viewport.width < 400 && locale === "zh-CN")) {
              const file = `qq-pages-${slug(tabCheck)}.png`;
              await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
              screenshots.push(file);
            }
            results.push({
              name: tabCheck,
              passed: true,
              tab: tabName,
              schemeView: "group-config",
              bindingId: navigation.qqBindingId,
              probe: tabProbe,
              metrics: tabMetrics,
              focus: tabFocus,
              hygiene: {
                consoleErrors: hygiene.consoleErrors.length,
                failedRequests: hygiene.failedRequests.length,
                httpErrors: hygiene.httpErrors.length,
                externalRequests: hygiene.externalRequests.length,
              },
            });
            console.log(`[PASS] ${tabCheck} (${tabName})`);
          }
        }
        // 方案设置六分组 Tab；绑定详情覆盖 settings/bindings 两个 view。切换前后均校验实际内容与
        // picked scheme ID；隐藏的旧编辑器/只有标题的读取态不能替代已加载的绑定看板。
        if (entry.finalTabKeys !== undefined && entry.groupConfig !== true) {
          for (const [index, tabKey] of entry.finalTabKeys.entries()) {
            const tabName = t(locale, tabKey);
            const tabCheck = `${name}-tab-${index + 1}`;
            hygiene.reset();
            active = { name: tabCheck, page, hygiene };
            const nextView =
              entry.schemeView === "bindings"
                ? tabKey === "schemes.bindings.viewSettings"
                  ? "settings"
                  : "bindings"
                : "settings";
            if (entry.schemeView === "bindings") {
              const beforeView = index === 0 ? "bindings" : "settings";
              await waitSchemeView(page, navigation.schemeId, beforeView, locale);
            }
            const schemeTab =
              entry.schemeView === "bindings"
                ? schemeDetailTab(page.locator("main"), tabKey, locale)
                : page.getByRole("tab", { name: tabName, exact: true });
            await schemeTab.click();
            await schemeTab.and(page.locator('[aria-selected="true"]')).waitFor({ timeout: 15000 });
            const tabProbe = await waitSchemeView(page, navigation.schemeId, nextView, locale);
            await waitSettled(page);
            const tabMetrics = await inspect(page, tabProbe);
            active.metrics = tabMetrics;
            assert(
              tabMetrics.scrollWidth <= viewport.width,
              `${tabCheck}: horizontal overflow (${tabMetrics.scrollWidth} > ${viewport.width})`,
            );
            assert(tabMetrics.textLength > 40, `${tabCheck}: tab content is empty`);
            assert(tabMetrics.probePresent, `${tabCheck}: missing ${tabProbe}`);
            assert(
              tabMetrics.probeClipped === 0,
              `${tabCheck}: ${tabMetrics.probeClipDetail} clips its content by ${tabMetrics.probeClipped}px`,
            );
            assert(
              tabMetrics.theme === MATRIX_THEME && tabMetrics.mode === "light",
              `${tabCheck}: appearance not applied`,
            );
            const tabFocus = await inspectFocus(page, locale);
            assert(
              tabFocus.reached && tabFocus.visible,
              `${tabCheck}: no visible keyboard focus (${JSON.stringify(tabFocus)})`,
            );
            assert(
              hygiene.httpErrors.length === 0,
              `${tabCheck}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
            );
            assert(
              hygiene.consoleErrors.length === 0,
              `${tabCheck}: console error (${hygiene.consoleErrors[0]})`,
            );
            assert(
              hygiene.failedRequests.length === 0,
              `${tabCheck}: failed request (${hygiene.failedRequests[0]})`,
            );
            assert(
              hygiene.externalRequests.length === 0,
              `${tabCheck}: off-origin request (${hygiene.externalRequests[0]})`,
            );
            if (viewport.width === 1440 || (viewport.width < 400 && locale === "zh-CN")) {
              const file = `qq-pages-${slug(tabCheck)}.png`;
              await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
              screenshots.push(file);
            }
            results.push({
              name: tabCheck,
              passed: true,
              tab: tabName,
              schemeId: navigation.schemeId,
              schemeView: nextView,
              metrics: tabMetrics,
              focus: tabFocus,
              hygiene: {
                consoleErrors: hygiene.consoleErrors.length,
                failedRequests: hygiene.failedRequests.length,
                httpErrors: hygiene.httpErrors.length,
                externalRequests: hygiene.externalRequests.length,
              },
            });
            console.log(`[PASS] ${tabCheck} (${tabName})`);
          }
        }
      }
      await context.close();
    }
  }

  // Themes: the promise is sixteen palettes in two modes, so each is applied to the densest page and
  // checked for the same two things a page must never do — overflow or clip its own content.
  // Each combination gets its own context: appearance is read once at boot, so writing storage into
  // a live page and reloading races the app's own write-back.
  // 主题扫描挑清单里最密的一页（工具授权：分组授权 + 展开的助手范围与目录）。
  const themePage = THEME_PAGE;
  const firstTheme = THEMES[0];
  const lastTheme = THEMES[THEMES.length - 1];
  for (const theme of THEMES) {
    for (const mode of ["light", "dark"]) {
      const name = `${themePage.id}-theme-${theme}-${mode}`;
      const context = await contextOptions(browser, {
        locale: "zh-CN",
        theme,
        mode,
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      const hygiene = watchPage(page);
      active = { name, page, hygiene };
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#superstring-shell");
      const navigation = await openPage(page, themePage, "zh-CN");
      const metrics = await inspectVisit(page, navigation);
      active.metrics = metrics;
      assert(metrics.theme === theme, `${name}: theme not applied (${metrics.theme})`);
      assert(metrics.mode === mode, `${name}: mode not applied (${metrics.mode})`);
      assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
      assert(
        metrics.probeClipped === 0,
        `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
      );
      assert(
        hygiene.httpErrors.length === 0,
        `${name}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
      );
      if (theme === firstTheme || theme === lastTheme) {
        const file = `qq-pages-${slug(name)}.png`;
        await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
        screenshots.push(file);
      }
      const overlayClose = await closeVisitOverlay(page, themePage, navigation, "zh-CN");
      results.push({ name, passed: true, metrics, overlayClose });
      console.log(`[PASS] ${name}`);
      await context.close();
    }
  }

  // 跟随系统：模式交给系统偏好决定（dataset.mode 保持 system，解析出的明暗跟系统走）。
  // 解析只与系统明暗有关、与主题无关，所以两种系统偏好各取一个代表主题即可，不必再乘 16。
  for (const [scheme, theme] of [
    ["dark", firstTheme],
    ["light", lastTheme],
  ]) {
    const name = `${themePage.id}-system-${scheme}`;
    const context = await contextOptions(browser, {
      locale: "zh-CN",
      theme,
      // 存储里的模式是 system：由 scheme 扮演操作系统。
      mode: "system",
      scheme,
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const hygiene = watchPage(page);
    active = { name, page, hygiene };
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#superstring-shell");
    const navigation = await openPage(page, themePage, "zh-CN");
    const metrics = await inspectVisit(page, navigation);
    active.metrics = metrics;
    assert(metrics.theme === theme, `${name}: theme not applied (${metrics.theme})`);
    assert(metrics.mode === scheme, `${name}: system preference not honoured (${metrics.mode})`);
    assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
    assert(
      metrics.probeClipped === 0,
      `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
    );
    assert(
      hygiene.httpErrors.length === 0,
      `${name}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
    );
    const file = `qq-pages-${slug(name)}.png`;
    await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
    screenshots.push(file);
    const overlayClose = await closeVisitOverlay(page, themePage, navigation, "zh-CN");
    results.push({ name, passed: true, metrics, overlayClose });
    console.log(`[PASS] ${name}`);
    await context.close();
  }

  // 减少动效：系统要求少动画时应照常渲染——结构与内容不受影响，只是过渡不做动画。
  {
    const name = `${themePage.id}-reduced-motion`;
    const context = await contextOptions(browser, {
      locale: "zh-CN",
      theme: firstTheme,
      mode: "light",
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const hygiene = watchPage(page);
    active = { name, page, hygiene };
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#superstring-shell");
    const navigation = await openPage(page, themePage, "zh-CN");
    const metrics = await inspectVisit(page, navigation);
    active.metrics = metrics;
    assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
    assert(metrics.textLength > 40, `${name}: settings content is empty`);
    assert(
      metrics.probeClipped === 0,
      `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
    );
    assert(
      hygiene.httpErrors.length === 0,
      `${name}: HTTP error (${JSON.stringify(hygiene.httpErrors[0])})`,
    );
    const overlayClose = await closeVisitOverlay(page, themePage, navigation, "zh-CN");
    results.push({ name, passed: true, metrics, overlayClose });
    console.log(`[PASS] ${name}`);
    await context.close();
  }

  checkFreeze();
  const timestamp = new Date().toISOString();
  const report = {
    timestamp,
    appearanceDimensions,
    scope: `§15 page matrix: ${PAGES.length} workspace pages/views x ${VIEWPORTS.length} viewports x ${LOCALES.length} languages, plus ${THEMES.length} themes x 2 modes, system mode x 2 system preferences and a reduced-motion pass`,
    url,
    runDirectory: outputDir,
    browser: {
      engine: "chromium",
      version: browser.version(),
      channel: executablePath ? "custom executable" : channel,
    },
    passed: true,
    coverageLimitation:
      "Only listed scenarios were visited; this is not full surface, overlay, TTL, permission lifecycle or desktop WCO coverage.",
    unverifiedOrBlocked: [
      "Desktop WCO requires the actual desktop host",
      "Model inference, QQ login/send, MCP management and task approval are not exercised",
      "Expired/revoked source and received-reader access lifecycle require separate synthetic scenarios",
      "Scheme scroll retention, full dirty-guard failure/409/partial save, every overlay and every object are not fully covered",
      "Opening a confirmation and cancelling it does not prove the action",
    ],
    selectedPages: PAGES.map((entry) => entry.id),
    themePage: THEME_PAGE.id,
    sourceActivity,
    freeze,
    finalFreezeClaimed: uiFrozen && freeze.valid,
    screenshots,
    results,
  };
  const destination = resolve(
    outputDir,
    `qq-pages-visual-${timestamp.replaceAll(/[:.]/g, "-")}.json`,
  );
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `QQ PAGES MATRIX PASSED -> ${destination}\n  ${results.length} checks, ${screenshots.length} screenshots, ${THEMES.length} themes, run directory ${outputDir}`,
  );
} catch (error) {
  try {
    checkFreeze();
  } catch (freezeError) {
    freeze.error = String(freezeError);
  }
  await captureFailure(error, active);
  throw error;
} finally {
  await browser.close();
}
