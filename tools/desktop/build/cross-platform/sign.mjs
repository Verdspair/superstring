import path from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";

// Let the maintained signer own nested-code ordering and verification. Bun's
// JavaScriptCore permissions belong to the sidecar, not every Electron helper.
export default async function sign(options) {
  const bunEntitlements = fileURLToPath(new URL("./entitlements.bun.plist", import.meta.url));
  const sidecar = path.join(options.app, "Contents/Resources/service/superstring-server");
  const inherited = options.optionsForFile;
  await signAsync({
    ...options,
    optionsForFile: (file) => ({
      ...(inherited?.(file) ?? {}),
      ...(file === sidecar ? { entitlements: bunEntitlements } : {}),
    }),
  });
}
