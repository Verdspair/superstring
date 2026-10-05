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
// Navigation: the shell (ADR0019) renders the primary destinations in a persistent <aside>
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
// The default page list is complete; SUPERSTRING_VISUAL_PAGES accepts an exact comma-separated
// subset (unknown IDs fail). SUPERSTRING_VISUAL_THEME_PAGE defaults to tool-grants and must be
// selected; a focused batch can use execution-ledger or scheme-bindings without changing defaults.
// --ui-frozen records before/after source hashes and rejects HMR or changes during the matrix.
// Conversation coverage IDs: conversation-{web|qq}-messages and
// conversation-{web|qq}-{activity|tasks}-{current|global}; select only seeded fixture channels.
// Defaults to bundled Chromium; optionally set SUPERSTRING_VISUAL_BROWSER_CHANNEL=msedge
// or SUPERSTRING_VISUAL_BROWSER_EXECUTABLE for an existing isolated verification browser.
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
 * Optional probes must exist and must not clip their content. Memory/knowledge numeric inputs
 * prove that the editing baseline loaded; their section landmarks alone are insufficient.
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
    labelKeys: ["workspace.extensions", "connections.grants.title"],
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
    probe: 'input[type="number"]',
    landmark: "region",
  },
  {
    id: "knowledge-tools",
    zh: ["系统能力", "知识查询"],
    en: ["System capabilities", "Knowledge query"],
    second: "row",
    probe: 'input[type="number"]',
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
    zh: ["模型服务", "服务与模型"],
    en: ["Model services", "Services & models"],
    probe: null,
  },
  {
    id: "agent-capabilities",
    zh: ["Agent", "模型与上下文"],
    en: ["Agent", "Models & context"],
    probe: null,
    // 助手页先要打开一个助手，右侧才会出现分区页签。
    pick: "[data-agent-open]",
  },
  // operating-mode 保留旧页面 ID；真实点击路径与新连接路由相同。
  ...["operating-mode", "qq-connection"].map((id) => ({
    id,
    labelKeys: ["workspace.schemes", "connections.transportPage.tab"],
    pick: '[data-scheme-app-open="qq"]',
    qqAppTab: "connection",
    probe: 'input[autocomplete="new-password"]',
  })),
  {
    id: "qq-stickers",
    zh: ["资料", "表情素材"],
    en: ["Materials", "Sticker library"],
    probe: null,
  },
  // 方案目录保持目录；详情先选方案，再验证方案设置/使用会话与原四参数页签。
  {
    id: "scheme-library",
    labelKeys: ["workspace.schemes"],
    probe: null,
    landmark: "region",
  },
  {
    id: "qq-app-schemes",
    labelKeys: ["workspace.schemes", "workspace.schemes"],
    pick: '[data-scheme-app-open="qq"]',
    qqAppTab: "schemes",
    probe: "[data-scheme-open]",
  },
  {
    id: "qq-scheme-config",
    labelKeys: ["workspace.schemes"],
    probe: null,
    pick: ['[data-scheme-app-open="qq"]', "[data-scheme-open]"],
    schemeView: "settings",
    finalTabKeys: [
      "connections.whenToParticipate",
      "connections.howToRespond",
      "connections.whatToRead",
      "connections.mediaAndExpression",
    ],
  },
  {
    id: "scheme-bindings",
    labelKeys: ["workspace.schemes", "schemes.bindings.viewBindings"],
    probe: '[data-scheme-view="bindings"]',
    pick: ['[data-scheme-app-open="qq"]', "[data-scheme-open]"],
    schemeView: "bindings",
    finalTabKeys: ["schemes.bindings.viewSettings", "schemes.bindings.viewBindings"],
  },
  {
    id: "qq-storage",
    labelKeys: ["workspace.schemes", "connections.dataRetention"],
    pick: '[data-scheme-app-open="qq"]',
    qqAppTab: "storage",
    probe: null,
  },
  { id: "long-memory", zh: ["资料", "记忆"], en: ["Materials", "Memory"], probe: null },
  // 资料里的知识库配置页（文档页），挂在「资料」分区下。
  { id: "knowledge-config", zh: ["资料", "文档"], en: ["Materials", "Documents"], probe: null },
  { id: "general", zh: ["偏好"], en: ["Preferences"], probe: null },
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
    entry.conversation === undefined || ["web", "qq"].includes(entry.conversation),
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
];

// The theme list is read from its one source rather than copied, so a new theme is covered here
// without editing this file. Only the THEMES block is read: MODES has the same `{ id, name }` shape
// and would otherwise contribute "system"/"light"/"dark" as if they were palettes.
const appearanceSource = readFileSync(resolve(root, "src/shared/appearance.ts"), "utf8");
const themesBlock = /export const THEMES = \[([\s\S]*?)\] as const;/.exec(appearanceSource)?.[1];
if (themesBlock === undefined)
  throw new Error("THEMES block not found in src/shared/appearance.ts");
const THEMES = [...themesBlock.matchAll(/\{ id: "([a-z]+)", name: "/g)].map((match) => match[1]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const slug = (value) => value.replace(/[^a-z0-9-]/gi, "-");

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
  const row = directory.locator("button[data-source-id]").first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  const sourceId = await row.getAttribute("data-source-id");
  const title = await row.getAttribute("aria-label");
  assert(sourceId && title, `${channel}: conversation row lacks its source ID/title`);
  const exactRow = directory.getByRole("button", { name: title, exact: true }).and(row);
  await exactRow.click();
  if (compact) {
    await page
      .getByRole("dialog", { name: t(locale, "workspace.conversation_index"), exact: true })
      .waitFor({ state: "hidden" });
  } else {
    await exactRow.and(page.locator('[aria-current="page"]')).waitFor({ timeout: 15000 });
  }
  await page.locator("main").getByRole("heading", { name: title, exact: true }).waitFor();
  return { sourceId, title };
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
    if (entry.conversation === "web") {
      await main
        .getByRole("textbox", { name: t(locale, "workspace.enter_a_message"), exact: true })
        .waitFor();
    } else {
      const panel = main.getByRole("tabpanel", {
        name: t(locale, "workspace.message_history"),
        exact: true,
      });
      await panel.waitFor();
      await panel
        .getByText(t(locale, "workspace.loading_conversation"), { exact: true })
        .waitFor({ state: "hidden", timeout: 15000 });
    }
    await page.locator(entry.probe).waitFor({ state: "visible", timeout: 15000 });
  } else throw new Error(`${entry.id}: unsupported conversation view`);
}

async function waitSchemeView(page, schemeId, view, locale) {
  assert(schemeId, "Scheme detail has no picked scheme ID");
  const main = page.locator("main");
  const titleKey =
    view === "settings" ? "schemes.bindings.viewSettings" : "schemes.bindings.viewBindings";
  for (const key of ["schemes.bindings.viewSettings", "schemes.bindings.viewBindings"])
    await main
      .getByRole("tab", { name: t(locale, key), exact: true })
      .waitFor({ state: "visible", timeout: 15000 });
  await main
    .getByRole("tab", { name: t(locale, titleKey), exact: true, selected: true })
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
  } else {
    for (const key of [
      "connections.whenToParticipate",
      "connections.howToRespond",
      "connections.whatToRead",
      "connections.mediaAndExpression",
    ])
      await main
        .getByRole("tab", { name: t(locale, key), exact: true })
        .waitFor({ state: "visible", timeout: 15000 });
    await main
      .locator('[role="tabpanel"][data-state="active"]')
      .waitFor({ state: "visible", timeout: 15000 });
  }
}

const QQ_APP_TAB_KEYS = {
  schemes: "workspace.schemes",
  connection: "connections.transportPage.tab",
  storage: "connections.dataRetention",
};

async function waitQqApp(page, target, locale) {
  const main = page.locator("main");
  const app = main.getByRole("region", { name: t(locale, "schemes.qq.appTitle"), exact: true });
  await app.waitFor();
  let tabs = app.getByRole("tablist");
  for (const key of Object.values(QQ_APP_TAB_KEYS))
    tabs = tabs.filter({ has: page.getByRole("tab", { name: t(locale, key), exact: true }) });
  await tabs.waitFor({ state: "visible", timeout: 15000 });
  assert((await tabs.count()) === 1, "QQ app must have one management tablist");
  assert((await tabs.getByRole("tab").count()) === 3, "QQ app must have exactly three tabs");
  await tabs
    .getByRole("tab", { name: t(locale, QQ_APP_TAB_KEYS[target]), exact: true, selected: true })
    .waitFor({ timeout: 15000 });
  assert(
    (await main
      .getByRole("tab", { name: t(locale, "connections.conversationBindings"), exact: true })
      .count()) === 0,
    "QQ management must not restore a peer binding tab",
  );
  if (target === "connection") {
    for (const key of ["connections.assistantAccount", "connections.websocketAddress"])
      await main.getByRole("textbox", { name: t(locale, key), exact: true }).waitFor();
    const token = main.getByLabel(t(locale, "connections.accessToken"), { exact: true });
    await token.waitFor();
    assert((await token.count()) === 1, "QQ connection must expose only one inline token form");
    await main
      .getByRole("checkbox", { name: t(locale, "connections.enableQq"), exact: true })
      .waitFor();
    await waitEnabled(
      page,
      main.getByRole("button", { name: t(locale, "connections.saveAccessSettings"), exact: true }),
    );
  } else if (target === "schemes") {
    await waitEnabled(page, main.locator("button[data-scheme-open]").first());
  } else {
    await main
      .getByRole("heading", { name: t(locale, "connections.storage.title"), exact: true })
      .waitFor();
    for (const group of ["observations", "speech", "sends", "nicknames", "stickers", "media"]) {
      const section = main
        .getByRole("heading", { name: t(locale, `connections.storage.${group}`), exact: true })
        .locator("xpath=ancestor::section[1]");
      await section.locator("dl dd").first().waitFor();
    }
    await main
      .getByRole("heading", { name: t(locale, "connections.storage.runtime"), exact: true })
      .waitFor();
    await main
      .getByRole("heading", { name: t(locale, "connections.storage.sweep"), exact: true })
      .waitFor();
    await waitEnabled(
      page,
      main.getByRole("button", { name: t(locale, "connections.common.refresh"), exact: true }),
    );
  }
  return { app: "qq", tab: target };
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
    "connections.grants.title",
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
  else await region.getByRole("table").waitFor();
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
  if (compact) {
    await page.locator('header button[aria-haspopup="dialog"]').first().click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
  }
  await page.locator("aside").first().getByRole("button", { name: labels[0], exact: true }).click();
  if (compact) {
    await page.keyboard.press("Escape");
    await page.locator("aside").waitFor({ state: "hidden" });
  }
  const navigation = { schemeId: null, conversation: null };
  if (entry.conversation)
    navigation.conversation = await selectConversation(page, entry.conversation, locale);
  for (const selector of entry.pick === undefined ? [] : [entry.pick].flat()) {
    const record = page.locator("main").locator(selector).first();
    await record.waitFor({ state: "visible", timeout: 15000 });
    if (entry.schemeView && selector === "[data-scheme-open]") {
      navigation.schemeId = await record.getAttribute("data-scheme-open");
      assert(navigation.schemeId, `${entry.id}: picked record has no scheme ID`);
    }
    await record.click();
    if (selector === '[data-scheme-app-open="qq"]')
      navigation.qqApp = await waitQqApp(page, "schemes", locale);
  }
  // 先证明 pick 落到真实编辑器，再切使用会话；不能只靠两个详情任务 Tab 的文字。
  if (entry.schemeView) await waitSchemeView(page, navigation.schemeId, "settings", locale);
  if (labels[1] !== undefined) {
    if (entry.second === "row") {
      await page
        .getByRole("button")
        .filter({ has: page.getByText(labels[1], { exact: true }) })
        .click();
    } else {
      const parent = entry.view
        ? page.getByRole("tablist", { name: t(locale, "workspace.conversation_view"), exact: true })
        : page.locator("main");
      await parent.getByRole("tab", { name: labels[1], exact: true }).click();
      await parent
        .getByRole("tab", { name: labels[1], exact: true, selected: true })
        .waitFor({ timeout: 15000 });
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
  if (entry.schemeView) await waitSchemeView(page, navigation.schemeId, entry.schemeView, locale);
  if (entry.qqAppTab) navigation.qqApp = await waitQqApp(page, entry.qqAppTab, locale);
  if (entry.extension) await waitExtensions(page, entry, locale);
  if (entry.id === "scheme-library") {
    await waitEnabled(page, page.locator('main button[data-scheme-app-open="qq"]'));
    await waitEnabled(
      page,
      page
        .locator("main")
        .getByRole("button", { name: t(locale, "connections.transportPage.tab"), exact: true }),
    );
  }
  for (const key of entry.finalTabKeys ?? [])
    await page.getByRole("tab", { name: t(locale, key), exact: true }).waitFor({ timeout: 15000 });
  if (entry.landmark === "region")
    await page
      .getByRole("region", { name: labels[labels.length - 1], exact: true })
      .waitFor({ timeout: 15000 });
  if (entry.probe !== null) await page.waitForSelector(entry.probe, { timeout: 15000 });
  // 对话可能一开始就是此视图，但必须已由选中态、scope 与真实内容证明，不能因字多就放行。
  await waitSettled(
    page,
    entry.view || entry.schemeView || entry.qqAppTab || entry.extension ? null : previous,
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
  const visible = (element) => {
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = styleOf(node);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
        return false;
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
      const box = clipBox(ancestor);
      const hiddenX = ["hidden", "clip"].includes(style.overflowX);
      const hiddenY = ["hidden", "clip"].includes(style.overflowY);
      const byX = hiddenX ? Math.max(0, box.left - rect.left, rect.right - box.right) : 0;
      const byY = hiddenY ? Math.max(0, box.top - rect.top, rect.bottom - box.bottom) : 0;
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
  return page.evaluate(measureVisualPage, probe);
}

async function inspectFocus(page) {
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body)
      return { reached: false, description: "body", visible: false };
    const style = getComputedStyle(element);
    // 现行控件用 focus-visible:ring（box-shadow）表示焦点，旧实现用 outline——两者都算可见。
    const visible =
      (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none";
    return {
      reached: true,
      description: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`,
      visible,
    };
  });
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
    url,
    phase: active?.name ?? "setup",
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
    passed: false,
    screenshots: [],
    page: null,
    metrics: active?.metrics ?? null,
    completedChecks: results.length,
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
    ([nextLocale, nextTheme, nextMode]) => {
      localStorage.setItem("superstring-locale", nextLocale);
      localStorage.setItem("superstring-appearance", nextTheme);
      localStorage.setItem("superstring-appearance-mode", nextMode);
    },
    [locale, theme, mode],
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
  const state = { consoleErrors: [], failedRequests: [], externalRequests: [] };
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
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    if (!reason.includes("ERR_ABORTED"))
      state.failedRequests.push(`${request.url()} (${reason || "unknown"})`);
  });
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.protocol === "data:" || target.protocol === "blob:") return;
    if (target.host !== base.host) state.externalRequests.push(request.url());
  });
  state.reset = () => {
    state.consoleErrors.length = 0;
    state.failedRequests.length = 0;
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
        theme: "slate",
        mode: "light",
        viewport,
      });
      const page = await context.newPage();
      const hygiene = watchPage(page);
      for (const entry of PAGES) {
        const name = `${entry.id}-${locale}-${viewport.name}`;
        hygiene.reset();
        active = { name, page, hygiene };
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector("#superstring-shell");
        const navigation = await openPage(page, entry, locale);
        const metrics = await inspect(page, entry.probe);
        active.metrics = metrics;
        assert(
          metrics.scrollWidth <= viewport.width,
          `${name}: horizontal overflow (${metrics.scrollWidth} > ${viewport.width})`,
        );
        assert(metrics.textLength > 40, `${name}: settings content is empty`);
        assert(metrics.probePresent, `${name}: missing ${entry.probe}`);
        assert(
          metrics.probeClipped === 0,
          `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
        );
        assert(
          metrics.theme === "slate" && metrics.mode === "light",
          `${name}: appearance not applied`,
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
        const focus = await inspectFocus(page);
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
        results.push({
          name,
          passed: true,
          navigation: { ...navigation, view: entry.view ?? null, scope: entry.scope ?? null },
          metrics,
          focus,
          hygiene: {
            consoleErrors: hygiene.consoleErrors.length,
            failedRequests: hygiene.failedRequests.length,
            externalRequests: hygiene.externalRequests.length,
          },
        });
        console.log(`[PASS] ${name}`);
        // 方案设置保留四参数 Tab；绑定详情覆盖两个任务 Tab。切换前后均校验实际内容和
        // picked scheme ID；隐藏的旧编辑器/只有标题的读取态不能替代已加载的绑定看板。
        if (entry.finalTabKeys !== undefined) {
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
            await page.getByRole("tab", { name: tabName, exact: true }).click();
            await page
              .getByRole("tab", { name: tabName, exact: true, selected: true })
              .waitFor({ timeout: 15000 });
            await waitSchemeView(page, navigation.schemeId, nextView, locale);
            await waitSettled(page);
            const tabProbe =
              nextView === "bindings" ? entry.probe : '[role="tabpanel"][data-state="active"]';
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
              tabMetrics.theme === "slate" && tabMetrics.mode === "light",
              `${tabCheck}: appearance not applied`,
            );
            const tabFocus = await inspectFocus(page);
            assert(
              tabFocus.reached && tabFocus.visible,
              `${tabCheck}: no visible keyboard focus (${JSON.stringify(tabFocus)})`,
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
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#superstring-shell");
      await openPage(page, themePage, "zh-CN");
      const metrics = await inspect(page, themePage.probe);
      active.metrics = metrics;
      assert(metrics.theme === theme, `${name}: theme not applied (${metrics.theme})`);
      assert(metrics.mode === mode, `${name}: mode not applied (${metrics.mode})`);
      assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
      assert(
        metrics.probeClipped === 0,
        `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
      );
      results.push({ name, passed: true, metrics });
      console.log(`[PASS] ${name}`);
      if (theme === firstTheme || theme === lastTheme) {
        const file = `qq-pages-${slug(name)}.png`;
        await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
        screenshots.push(file);
      }
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
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage, "zh-CN");
    const metrics = await inspect(page, themePage.probe);
    active.metrics = metrics;
    assert(metrics.theme === theme, `${name}: theme not applied (${metrics.theme})`);
    assert(metrics.mode === scheme, `${name}: system preference not honoured (${metrics.mode})`);
    assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
    assert(
      metrics.probeClipped === 0,
      `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
    );
    results.push({ name, passed: true, metrics });
    console.log(`[PASS] ${name}`);
    const file = `qq-pages-${slug(name)}.png`;
    await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
    screenshots.push(file);
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
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage, "zh-CN");
    const metrics = await inspect(page, themePage.probe);
    active.metrics = metrics;
    assert(metrics.scrollWidth <= 1440, `${name}: horizontal overflow`);
    assert(metrics.textLength > 40, `${name}: settings content is empty`);
    assert(
      metrics.probeClipped === 0,
      `${name}: ${metrics.probeClipDetail} clips its content by ${metrics.probeClipped}px`,
    );
    results.push({ name, passed: true, metrics });
    console.log(`[PASS] ${name}`);
    await context.close();
  }

  checkFreeze();
  const timestamp = new Date().toISOString();
  const report = {
    timestamp,
    scope: `§15 page matrix: ${PAGES.length} workspace pages/views x ${VIEWPORTS.length} viewports x ${LOCALES.length} languages, plus ${THEMES.length} themes x 2 modes, system mode x 2 system preferences and a reduced-motion pass`,
    url,
    runDirectory: outputDir,
    browser: {
      engine: "chromium",
      version: browser.version(),
      channel: executablePath ? "custom executable" : channel,
    },
    passed: true,
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
