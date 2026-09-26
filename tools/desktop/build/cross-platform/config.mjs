import path from "node:path";

export const APP_ID = "io.github.verdspair.superstring";
export const HOMEPAGE = "https://github.com/Verdspair/superstring";
export const TARGETS = [
  { platform: "darwin", arch: "arm64", runner: "macos-15", extensions: ["dmg", "zip"] },
  { platform: "darwin", arch: "x64", runner: "macos-15-intel", extensions: ["dmg", "zip"] },
  { platform: "linux", arch: "x64", runner: "ubuntu-24.04", extensions: ["AppImage", "deb"] },
  { platform: "linux", arch: "arm64", runner: "ubuntu-24.04-arm", extensions: ["AppImage", "deb"] },
];

export function getTarget(platform, arch) {
  const target = TARGETS.find((item) => item.platform === platform && item.arch === arch);
  if (!target) throw new Error(`Unsupported desktop target: ${platform}-${arch}`);
  return target;
}

export function normalizeMacSigningEnvironment(env) {
  // An unset Actions secret expands to "". Builder interprets a defined empty
  // CSC_LINK as the working directory, then attempts to import it as a file.
  if (env.CSC_LINK !== undefined && !env.CSC_LINK.trim()) delete env.CSC_LINK;
}

// 签名是"有凭据就签、没有就出未签名包"：缺凭据不再中止发布，但结果必须如实记录，
// 由构建结果与冒烟报告把 signed/unsigned 一路带到发布说明与用户文档。
export function macSigningPlan(env) {
  const hasIdentity = Boolean(env.CSC_LINK?.trim() || env.CSC_NAME?.trim());
  const groups = [
    ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    ["APPLE_KEYCHAIN_PROFILE"],
  ];
  const hasNotarization = groups.some((keys) => keys.every((key) => env[key]?.trim()));
  return {
    signed: hasIdentity && hasNotarization,
    missing: [
      ...(hasIdentity ? [] : ["MACOS_SIGNING_IDENTITY"]),
      ...(hasNotarization ? [] : ["MACOS_NOTARIZATION_CREDENTIALS"]),
    ],
  };
}

export function createConfiguration({
  root,
  stage,
  output,
  platform,
  arch,
  release = false,
  macSigning = "unsigned",
}) {
  getTarget(platform, arch);
  const tools = path.join(root, "tools/desktop/build/cross-platform");
  const brand = path.join(stage, "brand");
  const signedRelease = release && macSigning === "signed";
  return {
    appId: APP_ID,
    productName: "Superstring",
    executableName: "superstring",
    directories: {
      app: path.join(root, "dist/desktop-host"),
      buildResources: brand,
      output,
    },
    files: ["package.json", "main.cjs", "preload.cjs"],
    extraResources: [{ from: path.join(stage, "service"), to: "service", filter: ["**/*"] }],
    asar: true,
    // Both entry points are complete bundles. The official hook also prevents
    // builder from falling back to the repository's production node_modules.
    beforeBuild: async () => false,
    publish: null,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
    artifactName: "superstring-${version}-${os}-${arch}.${ext}",
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      ...(platform === "darwin" ? { enableEmbeddedAsarIntegrityValidation: true } : {}),
    },
    mac: {
      category: "public.app-category.productivity",
      minimumSystemVersion: "13.0",
      icon: path.join(brand, "icon.icns"),
      target: ["dmg", "zip"].map((target) => ({ target, arch: [arch] })),
      hardenedRuntime: signedRelease,
      forceCodeSigning: signedRelease,
      ...(signedRelease ? {} : { identity: "-" }),
      notarize: signedRelease,
      entitlements: path.join(tools, "entitlements.electron.plist"),
      entitlementsInherit: path.join(tools, "entitlements.electron.plist"),
      binaries: ["Contents/Resources/service/superstring-server"],
      sign: path.join(tools, "sign.mjs"),
    },
    linux: {
      executableName: "superstring",
      category: "Network;Chat",
      icon: path.join(brand, "icons"),
      target: ["AppImage", "deb"].map((target) => ({ target, arch: [arch] })),
      maintainer: `Verdspair (${HOMEPAGE})`,
      vendor: "Superstring contributors",
    },
  };
}

export function expectedArtifacts(version) {
  return [
    ...TARGETS.flatMap(({ platform, arch, extensions }) =>
      extensions.map((ext) => {
        // electron-builder's getArtifactArchName follows each package format.
        const artifactArch =
          arch === "x64" ? ({ deb: "amd64", AppImage: "x86_64" }[ext] ?? arch) : arch;
        return `superstring-${version}-${platform === "darwin" ? "mac" : platform}-${artifactArch}.${ext}`;
      }),
    ),
    `superstring-setup-${version}.exe`,
  ];
}
