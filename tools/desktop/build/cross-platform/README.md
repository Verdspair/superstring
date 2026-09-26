# macOS and Linux desktop distributions

The Electron host is bundled separately from the compiled Bun service. The
existing Windows C# build remains `tools/installer/build-package.mjs`.

## Native builds

Install the pinned root lockfile on a native build runner, then use:

```sh
node tools/desktop/build/cross-platform/build.mjs --platform=darwin --arch=arm64
node tools/desktop/build/cross-platform/build.mjs --platform=darwin --arch=x64
node tools/desktop/build/cross-platform/build.mjs --platform=linux --arch=x64
node tools/desktop/build/cross-platform/build.mjs --platform=linux --arch=arm64
```

Run only the command matching that runner. `--dir` produces an unpacked
application for development. Outputs are in `dist/desktop-packages/<platform>-<arch>`.
The generated `build-result.json` identifies the package and the native app.
Desktop builds require macOS 13 or later; Linux packages target glibc desktops.
Linux x64 artifacts use the package-format conventions `amd64.deb` and
`x86_64.AppImage`; the CI lane and smoke identity remain `linux-x64`.

The CI workflow is the intended place to build all architectures. It does not
require a developer workstation to download Electron runtimes for other
architectures, cross-compiled Bun binaries, containers, or virtual machines.
For source-only dependency setup, `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips the
Electron runtime download. Do not use that option on actual packaging runners.

## Layout and ownership

```text
resources/
  app.asar                       main.cjs, preload.cjs, package.json
  service/
    superstring-server           native compiled Bun executable
    resource-manifest.json        whitelisted static resource inventory
    resources/{web,migrations,licenses}/
    brand/{icon.png,trayTemplate.png,trayTemplate@2x.png}
```

The preload exposes only the reviewed preference bridge. It remains sandboxed
and carries no service token or arbitrary filesystem interface. All writable
data belongs in the runtime-selected user profile, never this package tree.

`collectPackageFiles()` remains the source of the business-resource whitelist.
The pinned `license-checker-rseidelsohn` scanner traverses the complete installed
production dependency closure, including the frontend and host. The package adds
`production-dependencies.json` and a readable `production-dependencies.txt`, with
original license and NOTICE text but no build-machine paths. A missing direct
dependency or license text fails the build. Existing pinned notices, including
Bun's, remain present, alongside the project's original MIT `LICENSE`. The official
`beforeBuild` hook marks the complete JS bundles as externally prepared, preventing
builder from collecting a second copy of the repository's dependencies. Electron's
distribution includes its own and Chromium's
notices. Binary hashes are taken
from final distributables after signing, not from an unsigned sidecar that
codesign will subsequently change.

The canonical brand SVG is rendered by the existing Resvg dependency. macOS
`iconutil` builds ICNS; Linux gets the freedesktop PNG sizes. No icon encoder,
package-manager hook, code-signing engine, or update engine is implemented here.

## Signing and publication

Ordinary branch/PR builds are validation artifacts. macOS uses an explicit
ad-hoc signature and no notarization for those builds. They must not be
described as Gatekeeper-approved public releases.

`--release` requires macOS signing and notarization credentials. The workflow
uses these repository secrets:

- `MACOS_CERTIFICATE`: base64 Developer ID Application PKCS#12 certificate.
- `MACOS_CERTIFICATE_PASSWORD`: certificate password.
- `APPLE_API_KEY_BASE64`: base64 App Store Connect team API `.p8` key.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: corresponding API identity.

The build wrapper also accepts electron-builder's Apple ID/application password
or notarization keychain-profile credentials for an explicitly configured
release invocation. Incomplete credentials fail before packaging; builder's
otherwise optional notarization must not be silently skipped.

Official electron-builder owns packaging, fuse changes and notarization.
Its official macOS signer applies Electron entitlements to the host/helpers and
Bun's documented JavaScriptCore entitlements only to the service executable.
The workflow verifies the signature, Gatekeeper assessment and stapled ticket
on the extracted release app. ZIPs cannot themselves be stapled.

Only an explicit workflow dispatch with `release=true` and an existing
`v<package.json version>` tag can create a draft release. The release job uses
the `desktop-release` environment; configure its required reviewers in repository
settings. It never creates a tag or automatically publishes the draft. Regular
build jobs have read-only repository permissions. The aggregate job checks all
nine expected artifacts (eight macOS/Linux packages plus the existing Windows
installer) and generates a sorted `SHA256SUMS` from final bytes.

## Evidence and limits

Before platform packaging, a source job installs with Electron download disabled,
runs type checking, migration inventory, the packaging tests, new desktop
contracts, and the existing desktop lifecycle/profile/settings/access, brand and
POSIX launcher regressions. Build runners use Node 24.21.0 for the pinned license
scanner; the application's Bun version remains pinned independently.

The four native CI lanes run the packaged application with an isolated profile
whose path contains spaces and non-ASCII characters. A successful report must
prove backend readiness, renderer DOM, authentication and graceful service stop.
The smoke harness also reads the actual Electron fuse wire using the official
`@electron/fuses` API. It never calls a real model or logs into/sends QQ messages.

macOS smoke launches the app extracted from the generated ZIP and verifies the
DMG container. Linux smoke installs and launches the generated DEB under Xvfb
as the regular runner user with Chromium sandboxing enabled. The maintained
electron-builder DEB hooks supply Ubuntu's AppArmor user-namespace profile.
AppImage extraction compares its host/service/resource payload with that tested
installation; this is not a claim of a FUSE-mounted graphical launch.

AppImage users need FUSE and a working Chromium sandbox on their distribution.
On Ubuntu 24.04, the DEB is the integrated installation path. This project does
not turn off Chromium sandboxing or modify system-wide AppArmor/user-namespace
policy to make portable packages appear to work. Native Wayland/tray behavior
and a FUSE-mounted launch need desktop-session validation beyond Xvfb.

Signed/notarized outputs include signing timestamps; the pipeline records exact
final checksums and pinned inputs without claiming byte-identical signed DMGs.

## References

- [electron-builder v26 configuration](https://www.electron.build/v26/docs/configuration/)
- [Bun standalone executables and signing](https://bun.sh/docs/bundler/executables)
- [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [AppImage FUSE requirements](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
- [GitHub native runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Production dependency license scanner](https://github.com/RSeidelsohn/license-checker-rseidelsohn)
