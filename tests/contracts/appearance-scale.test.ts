// 外观尺寸编译期通道的契约：字号轴与界面轴各自只认一个 CSS 变量，实际数值全部由
// tools/desktop/build/appearance-scale.mjs 在 Tailwind 编译之后统一改写，组件不需要
// 自己写缩放影子工具类。这里钉住「该改的改、不该改的一律不改」以及重跑不变（幂等）。
// 覆盖范围只到 CSS 文本转换本身；Vite 接线顺序、浏览器渲染与实际桌面入口仍由 Root 原生验证。

import { describe, expect, it } from "bun:test";
import postcss from "postcss";
import appearanceScale from "../../tools/desktop/build/appearance-scale.mjs";

const TEXT_SCALE = "var(--app-text-scale, 1)";
const INTERFACE_SCALE = "var(--app-interface-scale, 1)";

function compile(css: string): string {
  return postcss([appearanceScale()]).process(css, { from: undefined }).css;
}

describe("appearance scale compile pass", () => {
  it("scales concrete font sizes once, and leaves line-height to follow", () => {
    const out = compile(
      [
        ".text-xs{font-size:12px;line-height:var(--tw-leading,var(--text-xs--line-height))}",
        ".text-\\[13\\.5px\\]{font-size:13.5px}",
        ".text-\\[0\\.8rem\\]{font-size:.8rem}",
        ".title{font-size:22px!important}",
      ].join("\n"),
    );
    expect(out).toContain(`.text-xs{font-size:calc(12px * ${TEXT_SCALE});`);
    expect(out).toContain("line-height:var(--tw-leading,var(--text-xs--line-height))");
    expect(out).toContain(`font-size:calc(13.5px * ${TEXT_SCALE})`);
    expect(out).toContain(`font-size:calc(.8rem * ${TEXT_SCALE})`);
    // !important 属于声明本身，改写数值不能丢标记。
    expect(out).toContain(`font-size:calc(22px * ${TEXT_SCALE})!important`);
    expect(out.match(/--app-text-scale/g)?.length).toBe(4);
  });

  it("skips relative, keyword, zero, compound and @font-face sizes", () => {
    const source = [
      "h1{font-size:inherit}",
      "small{font-size:80%}",
      "code{font-size:1em}",
      ".zero{font-size:0!important}",
      ".compound{font-size:calc(13px + 1em)}",
      "@font-face{font-family:x;font-size:14px;src:url(a.woff2)}",
    ].join("\n");
    expect(compile(source)).toBe(source);
  });

  it("keeps the document element font size unscaled so rem spacing stays independent", () => {
    const out = compile(
      [
        "html{font-family:var(--app-font-family);font-size:14px;line-height:1.5}",
        "html,:host{font-size:14px}",
        ":root{--app-text-scale:1}",
        "body{font-size:14px}",
      ].join("\n"),
    );
    expect(out).toContain(
      "html{font-family:var(--app-font-family);font-size:14px;line-height:1.5}",
    );
    expect(out).toContain("html,:host{font-size:14px}");
    expect(out).toContain(":root{--app-text-scale:1}");
    expect(out).toContain(`body{font-size:calc(14px * ${TEXT_SCALE})}`);
  });

  it("rewrites Tailwind text token references only, never other var() or custom properties", () => {
    const out = compile(
      [
        ":root{--text-4xl:2.25rem;--spacing:.25rem}",
        ".md\\:text-4xl{font-size:var(--text-4xl)}",
        ".p-4{padding:calc(var(--spacing)*4)}",
        ".card{color:var(--text-muted);font-size:var(--app-font-family)}",
      ].join("\n"),
    );
    expect(out).toContain(":root{--text-4xl:2.25rem;--spacing:.25rem}");
    expect(out).toContain(`.md\\:text-4xl{font-size:calc(var(--text-4xl) * ${TEXT_SCALE})}`);
    expect(out).toContain(".p-4{padding:calc(var(--spacing)*4)}");
    expect(out).toContain(".card{color:var(--text-muted);font-size:var(--app-font-family)}");
  });

  it("divides viewport lengths by the interface scale and leaves media conditions alone", () => {
    const out = compile(
      [
        ".sheet{max-height:85dvh}",
        ".tall{height:calc(100vh - 3.5rem)}",
        ".drawer{width:min(22rem,100vw - 2rem)}",
        ".clamped{height:min(60svh,30rem)}",
        ".full{min-height:100svh}",
        ".push{margin-top:-10vh}",
        '.text{content:"100vh";background:url(a?w=100vh.png)}',
        "@media (height <= 50vh) and (max-width:640px){.sheet{max-height:85dvh}}",
      ].join("\n"),
    );
    expect(out).toContain(`.sheet{max-height:calc(85dvh / ${INTERFACE_SCALE})}`);
    expect(out).toContain(`.tall{height:calc(calc(100vh / ${INTERFACE_SCALE}) - 3.5rem)}`);
    expect(out).toContain(`.drawer{width:min(22rem,calc(100vw / ${INTERFACE_SCALE}) - 2rem)}`);
    expect(out).toContain(`.clamped{height:min(calc(60svh / ${INTERFACE_SCALE}),30rem)}`);
    expect(out).toContain(`.full{min-height:calc(100svh / ${INTERFACE_SCALE})}`);
    expect(out).toContain(`.push{margin-top:calc(-10vh / ${INTERFACE_SCALE})}`);
    // 字符串与 url() 里的 "vh" 不是长度；@media 条件量的是设备视口，不跟随 zoom。
    expect(out).toContain('.text{content:"100vh";background:url(a?w=100vh.png)}');
    expect(out).toContain("@media (height <= 50vh) and (max-width:640px)");
  });

  it("is idempotent: a second pass over the compiled output changes nothing", () => {
    const once = compile(
      [
        ":root{--app-text-scale:1;--app-interface-scale:1}",
        "html{font-size:14px}",
        "body{font-size:14px}",
        ".text-sm{font-size:13.5px;line-height:1.5}",
        ".md\\:text-4xl{font-size:var(--text-4xl)}",
        ".sheet{max-height:85dvh;height:calc(100vh - 3.5rem)}",
      ].join("\n"),
    );
    expect(compile(once)).toBe(once);
    expect(once.match(/--app-text-scale/g)?.length).toBe(4);
    expect(once.match(/--app-interface-scale/g)?.length).toBe(3);
  });
});
