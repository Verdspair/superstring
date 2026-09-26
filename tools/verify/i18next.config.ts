import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["zh-CN", "en"],
  extract: {
    input: [
      "src/web/{screens,workspace,components,design-system}/**/*.{ts,tsx}",
      "src/web/App.tsx",
    ],
    output: "src/web/i18n/locales/{{language}}/{{namespace}}.json",
    keySeparator: false,
    nsSeparator: false,
    interpolationPrefix: "{",
    interpolationSuffix: "}",
    removeUnusedKeys: false,
    ignoreNamespaces: ["notices"],
    extractFromComments: false,
  },
  lint: {
    acceptedTags: "all",
    acceptedAttributes: ["title", "placeholder", "aria-label", "alt"],
    checkInterpolationParams: true,
    checkConcatenation: "warn",
  },
});
