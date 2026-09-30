#!/usr/bin/env node
// Page matrix for every settings destination this version added or changed.
//
// What it does: opens every settings destination this version added or changed in a real browser —
// at 1920/1440/390/320, in both languages — then applies every theme in light and dark on the
// densest page, plus system mode (the OS preference decides the scheme) and a reduced-motion pass.
// Assertions are objective (horizontal overflow, a page or group that did not render, a theme or a
// system preference that did not apply, console errors, failed or off-origin requests, focus that
// never becomes visible); screenshots are written next to the report for a person to look at.
// Pixel judgement stays with the person.
//
// Navigation: the shell (ADR0019) renders the primary destinations in a persistent <aside>
// (ProductNavigation); below 768px the same component lives inside the header's Sheet. The second
// click is a role=tab inside the screen itself, or — in the 系统能力 directory — a button row
// (`second: "row"`, not a tab). Both are matched by their localized label, so the page list carries
// the zh and en spellings; entries marked `landmark: "region"` are accepted only once their title
// landmark (the section aria-label) is up, so a click that never opened its destination fails
// instead of passing as the old page.
//
// Why a separate tool: only a real browser can be given a viewport, so this cannot be an assertion
// inside tests/web. This complements the in-app browser interaction checks.
//
// Usage (the Playwright module is not a project dependency, so point the tool at a directory that
// has one; nothing is installed by this script):
//   SUPERSTRING_PLAYWRIGHT=<dir with node_modules/playwright> \
//   SUPERSTRING_VISUAL_URL=http://127.0.0.1:17861 node tools/verify/verify-qq-pages-visual.mjs
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const url = process.env.SUPERSTRING_VISUAL_URL ?? "http://127.0.0.1:17861";
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

/**
 * Pages this version touched, with the nav labels a click needs and one content probe each.
 * `zh`/`en` are [primary destination, secondary destination?]; the secondary is a role=tab unless
 * `second: "row"` marks it as a row in the 系统能力 directory (a button row, not tabs), whose name
 * is the actual localized catalog label. The last label of an entry with `landmark: "region"` must
 * name the opened page's section title — the check that rejects "the click did not open it".
 * Probes are optional anchors that must exist *and* not clip their own content. 记忆查询与知识查询
 * 在助手编辑基线/读取草稿到位前只会渲染加载态（区域地标那时已经存在），所以这两页用关键数字
 * 输入框作探针：输入框出现才算详情真的加载完成，地标单独成立不再算数。
 */
const PAGES = [
  // 0.4.0 P7: 接入内的三个目的地与运行内的任务与审批，加上本版改过的模型能力与助手工具范围。
  { id: "mcp-servers", zh: ["接入", "MCP 服务"], en: ["Access", "MCP services"], probe: null },
  { id: "skill-catalog", zh: ["接入", "技能"], en: ["Access", "Skills"], probe: null },
  {
    id: "tool-grants",
    zh: ["接入", "工具授权"],
    en: ["Access", "Tool authorisation"],
    probe: null,
  },
  {
    id: "task-ledger",
    zh: ["运行", "任务与审批"],
    en: ["Runs", "Tasks and approvals"],
    probe: null,
  },
  // 0.4.0 P8: 系统能力一级目录与目录行打开的能力详情；执行设置、联网从运行、接入移归此处。
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
  // 第六项能力详情：会话历史摘要（link 类型，只说明与跳转）随本版路由新增，本轮补进清单。
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
  // 既有目的地：本轮未改，留在清单里守住回归。
  {
    id: "operating-mode",
    zh: ["接入", "会话绑定"],
    en: ["Access", "Conversation bindings"],
    probe: null,
  },
  {
    id: "qq-stickers",
    zh: ["资料", "表情素材"],
    en: ["Materials", "Sticker library"],
    probe: null,
  },
  {
    id: "qq-scheme-config",
    zh: ["接入", "共享方案"],
    en: ["Access", "Shared schemes"],
    probe: null,
  },
  { id: "qq-storage", zh: ["接入", "数据与保留"], en: ["Access", "Data & retention"], probe: null },
  { id: "long-memory", zh: ["资料", "记忆"], en: ["Materials", "Memory"], probe: null },
  // 资料里的知识库分区（文档页）随 P8 归入「资料」：原清单遗漏的既有目的地，本轮补上。
  { id: "knowledge-config", zh: ["资料", "文档"], en: ["Materials", "Documents"], probe: null },
  { id: "general", zh: ["偏好"], en: ["Preferences"], probe: null },
];
const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x1000", width: 1440, height: 1000 },
  { name: "390x844", width: 390, height: 844 },
  { name: "320x700", width: 320, height: 700 },
];
const LOCALES = ["zh-CN", "en"];

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

async function openPage(page, entry, labels) {
  // 切屏是懒加载的：点击后 main 里会先留着上一个界面，有时并排挂出 Suspense 占位。
  // 先记下点击前的文字，再把“就绪”定义成三条同时成立：
  // 占位消失、文字换成了别的内容、并且连续一段时间不再变化。
  const previous = await page.evaluate(() =>
    (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  // Primary destinations live in the persistent <aside>; below 768px the same component is mounted
  // inside the header's Sheet, so the trigger is the header's first button.
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
  // Selecting the section the screen already shows leaves the Sheet open; close it before the
  // in-page tab underneath can be clicked.
  if (compact) {
    await page.keyboard.press("Escape");
  }
  // 少数页面要先选中一条记录（例如助手的名称）才会渲染分区页签。
  if (entry.pick !== undefined) await page.locator(entry.pick).first().click();
  if (labels[1] !== undefined) {
    if (entry.second === "row") {
      // 系统能力目录的行是 button 行（不是页签）：行按钮的可访问名会拼上状态徽章与描述，
      // 整串比较不可能成立、宽松子串又可能命中别处；按“行内存在与行名完全一致的文本”
      // 定位该行，行名来自实际语言包，点完再由 landmark 证明目的地真的打开了。
      await page
        .getByRole("button")
        .filter({ has: page.getByText(labels[1], { exact: true }) })
        .click();
    } else {
      await page.getByRole("tab", { name: labels[1], exact: true }).click();
      // 页签的选中态是最直接的目的地信号：它先于分区内容出现，等它落定再等界面稳定。
      await page
        .getByRole("tab", { name: labels[1], exact: true, selected: true })
        .waitFor({ timeout: 15000 });
    }
  }
  if (entry.landmark === "region") {
    // 目的地地标：目录页与各能力详情都以 section[aria-label] 等于该条最后一个本地化标签
    // 作标题。地标不出现就不接受这次访问——停在上一页或目录页都不算“已打开目的地”。
    await page
      .getByRole("region", { name: labels[labels.length - 1], exact: true })
      .waitFor({ timeout: 15000 });
  }
  await page.waitForFunction(
    (before) => {
      const main = document.querySelector("main");
      if (main === null) return false;
      if (main.querySelector(':scope > [role="status"]') !== null) {
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

/** What every visit must satisfy, plus the numbers worth reporting when it does not. */
async function inspect(page, probe) {
  return page.evaluate((selector) => {
    const rootElement = document.documentElement;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const clipped = [];
    for (const element of document.querySelectorAll("body *")) {
      if (!visible(element)) continue;
      if (element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0) {
        const overflowX = getComputedStyle(element).overflowX;
        clipped.push({
          selector: `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0] ?? ""}`,
          overflowX,
          by: element.scrollWidth - element.clientWidth,
        });
      }
    }
    const content = document.querySelector("main");
    const probeNode = selector === null ? null : document.querySelector(selector);
    const describe = (element) =>
      `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ").join(".")}` : ""}`;
    let probeClipped = 0;
    let probeClipDetail = null;
    if (probeNode !== null) {
      probeClipped = Math.max(0, probeNode.scrollWidth - probeNode.clientWidth);
      if (probeClipped > 0) probeClipDetail = describe(probeNode);
      for (const child of probeNode.querySelectorAll("*")) {
        const by = child.scrollWidth - child.clientWidth;
        if (by > probeClipped) {
          probeClipped = by;
          probeClipDetail = describe(child);
        }
      }
    }
    return {
      scrollWidth: rootElement.scrollWidth,
      textLength: (content?.textContent ?? "").replace(/\s+/g, " ").trim().length,
      probePresent: selector === null ? true : probeNode !== null,
      probeClipped,
      probeClipDetail,
      clipped: clipped.slice(0, 5),
      theme: rootElement.dataset.theme ?? null,
      mode: rootElement.classList.contains("dark") ? "dark" : "light",
    };
  }, probe);
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
const watchPage = (page) => {
  const base = new URL(url);
  const state = { consoleErrors: [], failedRequests: [], externalRequests: [] };
  page.on("pageerror", (error) => state.consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(`console: ${message.text()}`);
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
        const labels = locale === "zh-CN" ? entry.zh : entry.en;
        const name = `${entry.id}-${locale}-${viewport.name}`;
        hygiene.reset();
        active = { name, page, hygiene };
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector("#superstring-shell");
        await openPage(page, entry, labels);
        // 探针必须真的出现：给足与页面级等待相同的 15s（它仍然必须存在，不是可选装饰）。
        if (entry.probe !== null) await page.waitForSelector(entry.probe, { timeout: 15000 });
        const metrics = await inspect(page, entry.probe);
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
          metrics,
          focus,
          hygiene: {
            consoleErrors: hygiene.consoleErrors.length,
            failedRequests: hygiene.failedRequests.length,
            externalRequests: hygiene.externalRequests.length,
          },
        });
        console.log(`[PASS] ${name}`);
      }
      await context.close();
    }
  }

  // Themes: the promise is sixteen palettes in two modes, so each is applied to the densest page and
  // checked for the same two things a page must never do — overflow or clip its own content.
  // Each combination gets its own context: appearance is read once at boot, so writing storage into
  // a live page and reloading races the app's own write-back.
  // 主题扫描挑清单里最密的一页（工具授权：分组授权 + 展开的助手范围与目录）。
  const themePage = PAGES.find((entry) => entry.id === "tool-grants");
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
      active = { name, page, hygiene: null };
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#superstring-shell");
      await openPage(page, themePage, themePage.zh);
      const metrics = await inspect(page, themePage.probe);
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
    active = { name, page, hygiene: null };
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage, themePage.zh);
    const metrics = await inspect(page, themePage.probe);
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
    active = { name, page, hygiene: null };
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage, themePage.zh);
    const metrics = await inspect(page, themePage.probe);
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

  const timestamp = new Date().toISOString();
  const report = {
    timestamp,
    scope: `§15 page matrix: ${PAGES.length} settings pages x ${VIEWPORTS.length} viewports x ${LOCALES.length} languages, plus ${THEMES.length} themes x 2 modes, system mode x 2 system preferences and a reduced-motion pass`,
    url,
    runDirectory: outputDir,
    browser: {
      engine: "chromium",
      version: browser.version(),
      channel: executablePath ? "custom executable" : channel,
    },
    passed: true,
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
  await captureFailure(error, active);
  throw error;
} finally {
  await browser.close();
}
