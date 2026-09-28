#!/usr/bin/env node
// Page matrix for the current five-section navigation and settings pages.
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
// click is a role=tab inside the screen itself. Both are matched by their localized label, so the
// page list carries the zh and en spellings.
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
const outputDir = resolve(root, process.env.SUPERSTRING_VISUAL_OUT ?? "artifacts/validation");
mkdirSync(outputDir, { recursive: true });

/**
 * Pages this version touched, with the nav labels a click needs and one content probe each.
 * `zh`/`en` are [primary destination, secondary tab?]; the tab is optional (偏好 has none).
 * Probes are optional anchors that must exist *and* not clip their own content.
 */
const PAGES = [
  // 0.4.0 P7: 接入内的三个新目的地与运行内的两个，加上本版改过的模型能力与助手工具范围。
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
  {
    id: "execution-settings",
    zh: ["运行", "执行设置"],
    en: ["Runs", "Execution settings"],
    probe: null,
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

async function openPage(page, labels, pick) {
  // 切屏是懒加载的：点击后 main 里会先留着上一个界面，有时并排挂出 Suspense 占位。
  // 先记下点击前的文字，再把“就绪”定义成三条同时成立：
  // 占位消失、文字换成了别的内容、并且连续一段时间不再变化。
  const previous = await page.evaluate(() =>
    (document.querySelector("main")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  // Primary destinations live in the persistent <aside>; below 768px the same component is mounted
  // inside the header's Sheet, so the trigger is the header's first button.
  const primary = page.locator("aside").first();
  const compact = !(await primary.isVisible().catch(() => false));
  if (compact) await page.locator("header button[aria-label]").first().click();
  await page.locator("aside").first().getByRole("button", { name: labels[0], exact: true }).click();
  // Selecting the section the screen already shows leaves the Sheet open; close it before the
  // in-page tab underneath can be clicked.
  if (compact) {
    await page.keyboard.press("Escape");
  }
  // 少数页面要先选中一条记录（例如助手的名称）才会渲染分区页签。
  if (pick !== undefined) await page.locator(pick).first().click();
  if (labels[1] !== undefined) {
    await page.getByRole("tab", { name: labels[1], exact: true }).click();
    // 页签的选中态是最直接的目的地信号：它先于分区内容出现，等它落定再等界面稳定。
    await page
      .getByRole("tab", { name: labels[1], exact: true, selected: true })
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
  // Before the app boots: locale and appearance are read from storage on start-up.
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
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector("#superstring-shell");
        await openPage(page, labels, entry.pick);
        if (entry.probe !== null) await page.waitForSelector(entry.probe, { timeout: 5000 });
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
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#superstring-shell");
      await openPage(page, themePage.zh, themePage.pick);
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
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage.zh, themePage.pick);
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
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("#superstring-shell");
    await openPage(page, themePage.zh, themePage.pick);
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
    `QQ PAGES MATRIX PASSED -> ${destination}\n  ${results.length} checks, ${screenshots.length} screenshots, ${THEMES.length} themes`,
  );
} finally {
  await browser.close();
}
