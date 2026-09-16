import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(resolve(projectRoot, "src/web/styles.css"), "utf8");
const app = readFileSync(resolve(projectRoot, "src/web/App.tsx"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? "";
}

describe("R5 视觉契约", () => {
  it("冻结9版高位双引号、延展弦端与实心节点，不恢复R1", () => {
    const brand = app.split("    brand: (")[1]?.split("    settings: (")[0] ?? "";
    expect(brand.match(/<path\b/g)).toHaveLength(6);
    expect(brand.match(/<circle\b/g)).toHaveLength(2);
    expect(brand).toContain('strokeWidth="1.7"');
    expect(brand).toContain('<g strokeWidth="1.3">');
    expect(brand).toContain('strokeWidth="1.4"');
    expect(brand).toContain("M7.6 10h8.8a1.6");
    expect(brand).toContain("M1.85 2.55");
    expect(brand).toContain("M22.15 4.4025");
    expect(brand).toContain(
      "M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75",
    );
    expect(brand).toContain('cx="10.065" cy="13.1" r="1.6" fill="currentColor" stroke="none"');
    expect(brand).toContain('cx="13.935" cy="15.5" r="1.6" fill="currentColor" stroke="none"');
    expect(brand).not.toContain("M7.2 8.2");
    expect(brand).not.toContain('r="0.85"');
    expect(brand).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("冻结原版浅色、暗色和语义颜色令牌", () => {
    for (const token of [
      "--superstring-tone-deep: #26364a",
      "--superstring-tone-light: #edf2f7",
      "--superstring-tone-line: #dce2e9",
      "--superstring-tone-soft: #f7f8fa",
      "--ac-accent: #4266b0",
      "--ac-surface: #232b36",
      "--ac-text: #e7ebf2",
      "--ac-muted: #b0bac9",
      "--ac-accent: #a1bcff",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain("#ef7d35");
    expect(css).not.toContain("#e8712d");
    expect(css).not.toContain("#df6e29");
  });

  it("冻结桌面侧栏、聊天列、气泡和 composer 尺寸", () => {
    expect(css).toContain("--superstring-sidebar-width: clamp(210px, 16vw, 236px)");
    expect(rule("#superstring-shell")).toContain(
      "grid-template-columns: var(--superstring-sidebar-width) minmax(0, 1fr)",
    );
    expect(rule(".settings-button")).toMatch(/width:\s*34px/);
    expect(rule(".settings-button")).toMatch(/right:\s*10px/);
    expect(rule(".settings-button")).toMatch(/bottom:\s*10px/);
    expect(rule(".messages")).toContain("width: min(1080px, 100%)");
    expect(rule(".bubble")).toContain("max-width: min(72%, 760px)");
    expect(rule(".bubble")).toContain("padding: 8px 11px");
    expect(rule(".composer-wrap")).toContain("left: 50%");
    expect(rule(".composer-wrap")).toContain("width: min(880px, calc(100% - 32px))");
    expect(rule(".composer-wrap")).toContain("bottom: 16px");
    // 用户澄清（2026-09-15）：保留此前居中风格，只把内容区从 760px 加宽到 880px。
    expect(rule(".settings-content,\n.agent-settings")).toContain("width: min(880px, 100%)");
    expect(rule(".settings-content,\n.agent-settings")).toContain("margin: 0 auto");
    expect(rule(".settings-content,\n.agent-settings")).toContain("padding: 16px 0 80px");
    expect(app).not.toContain('className="settings-back-slot"');
    expect(app).toContain("<SettingsHeader onBack={closeAgentSettings} />");
    expect(rule(".settings-back .icon")).toContain("width: 16px");
  });

  it("冻结 1100/760/600/480 四级响应式合同", () => {
    for (const breakpoint of [1100, 760, 600, 480]) {
      expect(css).toContain(`@media (max-width: ${breakpoint}px)`);
    }
    expect(css).toContain("--superstring-sidebar-width: clamp(196px, 20vw, 216px)");
    expect(css).toContain("max-height: 31vh");
    expect(css).toContain("height: 69vh");
    expect(css).toContain("min-height: 600px");
    expect(css).toContain("max-width: 88%");
    expect(css).not.toContain("@media (max-width: 640px)");
    expect(css).not.toContain("@media (max-width: 980px)");
  });

  it("冻结暗色自动适配、reduced-motion 与加载圆环", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(rule(".superstring-loading-ring")).toContain(
      "animation: superstring-loading-turn 760ms linear infinite",
    );
    expect(css).toMatch(/\.superstring-loading-ring\s*\{\s*animation:\s*none;/);
    expect(rule(".processing-status")).toContain("right: 12px");
    expect(rule(".processing-status")).toContain("bottom: 12px");
  });

  it("保留 heading host 和分区图标，助手按确认方案改为人形", () => {
    expect(rule(".heading-icon-host")).toContain("width: 21px");
    expect(rule(".heading-icon-host")).toContain("height: 21px");
    expect(rule(".heading-icon-host")).toContain("color: var(--superstring-tone-deep)");
    for (const path of [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18",
      'circle cx="12" cy="8" r="3.5"',
      "M5 20v-1a7 7 0 0 1 14 0v1",
      "M5 6c0-2 3.1-3 7-3s7 1 7 3",
      "M4 5h16v12H9l-5 3V5Z",
      "M12 12a4 4 0 1 0 0-8",
      "M12 21a9 9 0 1 0 0-18",
      "M8 3v5M16 3v5M6 8h12",
      "M5 12h.01M12 12h.01M19 12h.01",
    ]) {
      expect(app).toContain(path);
    }
  });

  it("冻结 Agent 与分区折叠的可访问选择语义和紧凑密度", () => {
    expect(app).toContain('aria-controls="superstring-agent-workspace"');
    expect(app).toContain("aria-pressed={editorAgentId === agent.id}");
    expect(app).toContain("aria-pressed={item.key === activeSection}");
    expect(app).toContain("requestSectionNavigation(item.key)");
    expect(rule(".section-nav button")).toContain("min-height: 48px");
    expect(rule(".section-nav button")).toContain("justify-content: center");
    expect(rule(".section-nav button strong")).toContain("font-size: 13px");
    expect(rule(".section-nav button small")).toContain("font-size: 11px");
  });

  it("保留主按钮主题填充与 1px 主题描边", () => {
    expect(rule("button")).toContain("border: 1px solid var(--superstring-tone-line)");
    for (const selector of ["button.primary", "button.primary:hover:not(:disabled)"]) {
      expect(rule(selector)).toContain("background: var(--superstring-tone-deep)");
      expect(rule(selector)).toContain("border-color: var(--superstring-tone-deep)");
    }
  });

  it("冻结折叠行图标主题色与中性背景", () => {
    // 设计约定，修订版）：统一 18px 主图标 / 16px 折叠箭头 / 1.7 线宽；
    // 列表与折叠行不铺主题色块；用户明确保留主按钮主题填充及 1px 主题描边。
    const rowIcons = rule(
      ".agent-settings > details > summary > .icon:not(.chevron),\n.appearance-settings > details > summary > .icon:not(.chevron),\nbutton.settings-entry > .icon",
    );
    expect(rowIcons).toContain("width: 18px");
    expect(rowIcons).toContain("stroke-width: 1.7");
    expect(rowIcons).toContain("color: var(--superstring-tone-deep)");
    const rowChevrons = rule(
      ".agent-settings > details > summary > .chevron,\n.appearance-settings > details > summary > .chevron",
    );
    expect(rowChevrons).toContain("width: 16px");
    expect(rowChevrons).toContain("stroke-width: 1.7");
    expect(rule(".section-nav .icon")).toContain("width: 18px");
    expect(rule(".section-nav .icon")).toContain("color: var(--superstring-tone-deep)");
    expect(rule(".settings-entry > .icon")).toContain("color: var(--superstring-tone-deep)");
    expect(rule(".session-list button.active")).toContain("background: var(--ac-surface)");
    expect(rule(".agent-editor-list button.active")).toContain("background: var(--ac-surface)");
    expect(css).not.toContain(".group > summary:hover");
    expect(css).not.toContain(".agent-selector > summary:hover");
  });

  it("冻结加宽后仍居中的内容区与简洁聊天空态", () => {
    for (const selector of [".chat-content", ".composer-wrap"]) {
      expect(rule(selector)).toContain("left: 50%");
      expect(rule(selector)).toContain("transform: translateX(-50%)");
    }
    expect(rule(".messages")).toContain("margin: 0 auto");
    expect(rule(".empty-chat")).toContain("margin: 0 auto");
    expect(rule(".empty-chat")).toContain("align-items: center");
    expect(rule(".empty-chat")).toContain("text-align: center");
    expect(rule(".empty-chat h2")).toContain("font-size: 18px");
    expect(rule(".empty-chat h2")).toContain("font-weight: 500");
    expect(rule(".empty-chat p")).toContain("font-size: 12px");
    expect(app).not.toContain("<span>↗</span>");
    expect(app).not.toContain("从左侧新建会话，选择要对话的助手。");
    expect(app).toContain("点击“新建任务”，开启与助手的对话。");
  });

  it("冻结「统一行规格」：三级设置页的折叠行共用同一套几何与字体", () => {
    // 修复前实测：同一页三行高 55.5 / 56.5 / 73.8px，字号 13/13/14px，内边距 8/8/7px，
    // 说明行字号 12/12/11px。统一后 8 个行全部为 58px / 9px 12px / 10px / 13px / 11px。
    const rows = rule(
      ".agent-settings > details > summary,\n.appearance-settings > details > summary",
    );
    expect(rows).toContain("min-height: 58px");
    expect(rows).toContain("padding: 9px 12px");
    expect(rows).toContain("gap: 10px");
    expect(rows).toContain("font-size: 13px");
    const smalls = rule(
      ".agent-settings > details > summary small,\n.appearance-settings > details > summary small",
    );
    expect(smalls).toContain("font-size: 11px");
    expect(smalls).toContain("margin-top: 2px");
    // 设置中心的入口行必须与折叠行同高同内边距，否则两级页面一进一出会跳一下。
    expect(rule("button.settings-entry")).toContain("min-height: 58px");
    expect(rule("button.settings-entry")).toContain("padding: 9px 12px");
    // 分组标题规则不得再顺手改折叠行（曾把「批量管理」撑到 14px + 16px 上边距）。
    expect(rule(".config-group-heading")).toContain("font-size: 14px");
    expect(css).not.toContain(".agent-settings > .group > summary strong");
    // 返回按钮里的图标必须在 32px 方框内居中，不能被行的 flex-start 顶到顶部。
    expect(rule(".back-link.icon-button .icon")).toContain("align-self: center");
    // 说明段落不带列表描边（外观页曾多出 1px 边框，比助手设置页高 2px）。
    expect(rule(".appearance-settings > p")).toContain("border: 0");
    // 小控件 / 消息气泡此前各写各的圆角（6/7/9/10px），全部回到 --ac-radius；
    // 圆形（50%）保留。
    for (const raw of [
      "border-radius: 6px",
      "border-radius: 7px",
      "border-radius: 9px",
      "border-radius: 10px",
    ]) {
      expect(css).not.toContain(raw);
    }
    // 字重只用标准档位：按钮基准 550、标题 650 都已归入 500 / 600。
    expect(css).not.toContain("font-weight: 550");
    expect(css).not.toContain("font-weight: 650");
  });

  it("内层配置分行，顶层块与设置中心统一 12px 间距", () => {
    expect(rule(".group > summary")).toContain("display: flex");
    expect(rule(".group > summary")).toContain("padding: 8px 12px");
    expect(rule(".group > summary strong")).toContain("display: block");
    expect(rule(".group > summary small")).toContain("font-weight: 400");
    expect(rule(".group > summary > .chevron")).toContain("flex: 0 0 16px");
    expect(rule(".agent-settings > details,\n.appearance-settings > details")).toContain(
      "margin: 0",
    );
    expect(
      rule(".agent-settings > details + details,\n.appearance-settings > details + details"),
    ).toContain("margin-top: 12px");
    expect(rule(".settings-list")).toContain("gap: 12px");
    expect(rule("button.settings-entry")).toContain("border-radius: var(--ac-radius)");
    expect(css).not.toContain("padding: 9px 10px");
  });

  it("分列表使用单色功能图标替代编号，不移动说明行", () => {
    for (const name of [
      "profile",
      "instructions",
      "chip",
      "plug",
      "search",
      "shield",
      "scope",
      "archive",
      "clock",
      "hand",
      "memory",
      "compress",
      "sliders",
      "chat",
    ]) {
      expect(app).toContain(`"${name}"`);
    }
    expect(app).toContain("const CONFIG_LIST_ICONS = {");
    expect(app).toContain("{listIcon ? label : title}");
    expect(rule(".config-list-icon")).toContain("display: inline-flex");
    const icon = rule(".config-list-icon .icon");
    expect(icon).toContain("width: 18px");
    expect(icon).toContain("height: 18px");
    expect(icon).toContain("stroke-width: 1.7");
    expect(icon).toContain("fill: none");
    expect(icon).toContain("stroke-linecap: round");
    expect(rule(".config-list-icon")).not.toContain("background");
  });

  it("冻结两级折叠层级与不带虚构 ARIA 角色的列表容器", () => {
    // The source builds `details > summary` + `div.superstring-agent-choices`
    // (agent_layout.py:108-120) and puts `aria-pressed`/`aria-controls` on each
    // ROW button — the container itself has no role. Modelling it as a
    // radiogroup/group invented semantics the source does not have.
    expect(app).toContain('<details className="agent-selector" ref={selectorRef}>');
    expect(app).toContain('<div className="agent-editor-list">');
    expect(app).not.toMatch(/className="agent-editor-list"[\s\S]{0,80}?role=/);
    expect(app).toContain('<details className="section-selector">');
    // The section rows must go through the dirty guard, never `setActiveSection`.
    expect(app).not.toContain("onClick={() => setActiveSection(item.key)}");
  });
});
