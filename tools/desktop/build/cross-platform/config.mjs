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

export function checkMacReleaseCredentials(env) {
  if (!env.CSC_LINK?.trim() && !env.CSC_NAME?.trim())
    throw new Error("MACOS_SIGNING_IDENTITY_REQUIRED");
  const groups = [
    ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    ["APPLE_KEYCHAIN_PROFILE"],
  ];
  if (!groups.some((keys) => keys.every((key) => env[key]?.trim()))) {
    throw new Error("MACOS_NOTARIZATION_CREDENTIALS_REQUIRED");
  }
}

export function createConfiguration({ root, stage, output, platform, arch, release = false }) {
  getTarget(platform, arch);
  const tools = path.join(root, "tools/desktop/build/cross-platform");
  const brand = path.join(stage, "brand");
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
      hardenedRuntime: release,
      forceCodeSigning: release,
      ...(release ? {} : { identity: "-" }),
      notarize: release,
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
