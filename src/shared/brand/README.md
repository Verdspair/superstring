# Superstring mark

`superstring.svg` is the only editable master. The original 24-unit artwork keeps
widely spaced quotation marks above a smaller conversation bubble, a vibrating
string and two connected nodes. The bubble, quotes and string use 1.7-, 1.3- and
1.4-unit strokes respectively; both nodes have a 1.6-unit radius.

- Web: `BrandLogo` references `#mark` with SVG `use`. Vite emits a shared asset;
  `?no-inline` keeps fragment references out of data URLs. The host supplies
  `currentColor` so all user themes work without separate logo variants.
- Favicon: the same SVG, with a standalone light/dark foreground rule.
- Desktop: `tools/desktop/build/brand-assets.mjs` uses resvg to render nine PNG
  sizes at build time. Both the icon builder and launcher embed these frames.
  System.Drawing performs standard frame selection and tinting; it does not parse SVG.
- macOS/Linux: `cross-platform/brand.mjs` reads the same master for PNGs and the
  macOS iconset; native macOS builds use `iconutil` to encode ICNS.

Keep generated PNG/ICO files in build output. Do not draw a separate desktop mark,
replace the brand with a functional icon, or duplicate the geometry in TSX/C#.
This is project-owned brand artwork; generic UI controls still use the component registry.

## 简体中文

`superstring.svg` 是唯一可编辑母版。原版采用 24 单位画布：分开的引号位于较小的对话框上方，框内是振动弦与两个节点；对话框、引号、弦的线宽分别为 1.7、1.3、1.4，节点半径为 1.6。

- 网页 `BrandLogo` 用 SVG `use` 引用 `#mark`，沿用 `currentColor` 跟随主题；`?no-inline` 保证片段引用指向资源文件而非 data URL。
- favicon 使用同一 SVG 的独立明暗配色规则。
- Windows 构建通过 `tools/desktop/build/brand-assets.mjs` 生成九种 PNG 尺寸，图标构建器与启动器嵌入同一批帧；System.Drawing 只选择尺寸和着色，不解释 SVG。
- macOS/Linux 的 `cross-platform/brand.mjs` 同样读取该母版，生成 PNG 与 macOS iconset，原生构建再调用 `iconutil` 编码 ICNS。

派生 PNG/ICO 留在构建目录，不另画桌面标志，不用功能图标替代品牌，也不在 TSX/C# 复制几何。普通 UI 控件继续使用组件库图标。
