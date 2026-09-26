#!/usr/bin/env node
// §15 page matrix for the current five-section navigation and settings pages.
//
// What it does: opens every settings page this version added or changed in a real browser — at
// 1920/1440/390/320, in both languages — and then applies every theme in light and dark on the
// densest page. Assertions are objective (horizontal overflow, a page or group that did not render,
// a theme that did not apply, focus that never becomes visible); screenshots are written next to the
// report for a person to look at. Pixel judgement stays with the person.
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
const outputDir = resolve(root, "artifacts/validation");
mkdirSync(outputDir, { recursive: true });

/** Pages this version touched, with the nav labels a click needs and one content probe each. */
const PAGES = [
  { id: "general", zh: ["偏好", "通用"], en: ["Preferences", "General"], probe: null },
  {
    // 运行模式现在是模式列表 + 「QQ」分组（第三方 App 接入整体搬到这里，
    // 取代原来未开放的「主动聊天模式」占位），所以这一页的探针落在那三段 QQ 配置上。
    id: "operating-mode",
    zh: ["接入", "运行模式与连接"],
    en: ["Access", "Modes and connections"],
    probe: "#qq-access-conversations",
  },
  {
    id: "models",
    zh: ["Agent", "默认模型"],
    en: ["Agent", "Default models"],
    probe: ".model-page-toolbar",
  },
  {
    id: "qq-stickers",
    zh: ["接入", "表情素材"],
    en: ["Access", "Sticker library"],
    probe: "#qq-stickers",
  },
  {
    id: "qq-scheme-config",
    zh: ["接入", "聊天方案"],
    en: ["Access", "Chat schemes"],
    probe: "#qq-scheme-speech",
  },
  {
    id: "qq-storage",
    zh: ["接入", "存储与诊断"],
    en: ["Access", "Storage and diagnostics"],
    probe: "#qq-storage-verdicts",
  },
  {
    id: "long-memory",
    zh: ["资料", "长期记忆"],
    en: ["Materials", "Long-term memory"],
    probe: null,
  },
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

async function openPage(page, labels) {
  // The primary navigation is rendered once, inside a Radix dialog at <=760px.
  const compactTrigger = page.locator(".mobile-navigation-bar button");
  const compact = await compactTrigger.isVisible();
  if (compact) await compactTrigger.click();
  await page
    .locator(".app-primary-nav")
    .getByRole("button", { name: labels[0], exact: true })
    .click();
  // Selecting the current section can leave the same destination active. Close its
  // navigation dialog explicitly before using the secondary page links behind it.
  if (compact) {
    await page.keyboard.press("Escape");
    await page.locator(".mobile-navigation-dialog").waitFor({ state: "hidden" });
  }
  await page
    .locator(".settings-secondary-nav")
    .getByRole("button", { name: labels[1], exact: true })
    .click();
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
    const content = document.querySelector(".settings-content");
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
    const visible = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    return {
      reached: true,
      description: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(" ")[0]}` : ""}`,
      visible,
    };
  });
}

const contextOptions = async (browser, { locale, theme, mode, viewport }) => {
  const context = await browser.newContext({
    viewport,
    colorScheme: mode === "dark" ? "dark" : "light",
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
      for (const entry of PAGES) {
        const labels = locale === "zh-CN" ? entry.zh : entry.en;
        const name = `${entry.id}-${locale}-${viewport.name}`;
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector("#superstring-shell");
        await openPage(page, labels);
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
        const focus = await inspectFocus(page);
        assert(focus.reached, `${name}: keyboard focus never leaves the body`);
        assert(
          focus.visible,
          `${name}: focused element has no visible outline (${JSON.stringify(focus)})`,
        );
        if (viewport.width === 1440 || (viewport.width < 400 && locale === "zh-CN")) {
          const file = `qq-pages-${slug(name)}.png`;
          await page.screenshot({ path: resolve(outputDir, file), fullPage: true });
          screenshots.push(file);
        }
        results.push({ name, passed: true, metrics, focus });
        console.log(`[PASS] ${name}`);
      }
      await context.close();
    }
  }

  // Themes: the promise is sixteen palettes in two modes, so each is applied to the densest page and
  // checked for the same two things a page must never do — overflow or clip its own content.
  // Each combination gets its own context: appearance is read once at boot, so writing storage into
  // a live page and reloading races the app's own write-back.
  const storagePage = PAGES.find((entry) => entry.id === "qq-storage");
  const firstTheme = THEMES[0];
  const lastTheme = THEMES[THEMES.length - 1];
  for (const theme of THEMES) {
    for (const mode of ["light", "dark"]) {
      const name = `qq-storage-theme-${theme}-${mode}`;
      const context = await contextOptions(browser, {
        locale: "zh-CN",
        theme,
        mode,
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#superstring-shell");
      await openPage(page, storagePage.zh);
      await page.waitForSelector("#qq-storage-verdicts", { timeout: 5000 });
      const metrics = await inspect(page, "#qq-storage-verdicts");
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

  const timestamp = new Date().toISOString();
  const report = {
    timestamp,
    scope: `§15 page matrix: ${PAGES.length} settings pages x ${VIEWPORTS.length} viewports x ${LOCALES.length} languages, plus ${THEMES.length} themes x 2 modes`,
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
