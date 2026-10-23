import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveHostLayout } from "../../src/desktop/host-layout";

const projectRoot = path.resolve("synthetic-project");
const profileRoot = path.resolve("synthetic-profile");
const resourceRoot = path.resolve("synthetic-service/resources");
const executable = path.resolve("synthetic-service/superstring-server.exe");
const installRoot = path.resolve("synthetic-install");

describe("host layout", () => {
  test("development runs the project server from the checkout with its installed bun", () => {
    const layout = resolveHostLayout({ mode: "development-legacy", projectRoot });
    expect(layout).toEqual({
      mode: "development-legacy",
      profileRoot: path.join(projectRoot, "artifacts", "state", "electron-host"),
      projectRoot,
      executable: path.join(projectRoot, "node_modules", "bun", "bin", "bun.exe"),
      args: ["run", path.join("src", "server", "index.ts")],
      cwd: projectRoot,
      resourceRoot: projectRoot,
    });
  });

  test("development honors an explicit host profile and bun override", () => {
    const layout = resolveHostLayout({
      mode: "development-legacy",
      projectRoot,
      profileRoot,
      bunExecutable: path.resolve("tools/bun.exe"),
    });
    expect(layout.profileRoot).toBe(profileRoot);
    expect(layout.executable).toBe(path.resolve("tools/bun.exe"));
  });

  test("development never resolves bun from PATH", () => {
    const layout = resolveHostLayout({ mode: "development-legacy", projectRoot });
    const bunDirectory = path.join(projectRoot, "node_modules", "bun", "bin");
    expect(path.isAbsolute(layout.executable)).toBe(true);
    expect(path.dirname(layout.executable)).toBe(bunDirectory);
  });

  test("managed and installed resolve the compiled pair from their roots", () => {
    const layout = resolveHostLayout({
      mode: "managed-profile",
      profileRoot,
      resourceRoot,
      executable,
    });
    expect(layout).toEqual({
      mode: "managed-profile",
      profileRoot,
      executable,
      args: [],
      cwd: profileRoot,
      resourceRoot,
    });
    expect(layout.projectRoot).toBeUndefined();
    expect(layout.appRoot).toBeUndefined();
    expect(
      resolveHostLayout({
        mode: "installed",
        installRoot,
        hostProfileRoot: profileRoot,
      }),
    ).toEqual({
      mode: "installed",
      appRoot: installRoot,
      envMode: "installed",
      profileRoot,
      executable: path.join(installRoot, "app", "superstring-server.exe"),
      args: [],
      cwd: installRoot,
      resourceRoot: path.join(installRoot, "app", "resources"),
    });
    expect(resolveHostLayout({ mode: "installed", installRoot }).profileRoot).toBe(
      path.join(installRoot, "userdata", "state", "electron-host"),
    );
  });

  test("relative and drive roots are rejected before a child is spawned", () => {
    expect(() =>
      resolveHostLayout({ mode: "development-legacy", projectRoot: "relative" }),
    ).toThrow("DESKTOP_HOST_LAYOUT_PROJECT_ROOT_MUST_BE_ABSOLUTE");
    expect(() =>
      resolveHostLayout({
        mode: "managed-profile",
        profileRoot,
        resourceRoot,
        executable: "relative.exe",
      }),
    ).toThrow("DESKTOP_HOST_LAYOUT_EXECUTABLE_MUST_BE_ABSOLUTE");
    const driveRoot = `${path.parse(process.cwd()).root}`;
    expect(() =>
      resolveHostLayout({
        mode: "managed-profile",
        profileRoot: driveRoot,
        resourceRoot,
        executable,
      }),
    ).toThrow("DESKTOP_HOST_LAYOUT_PROFILE_ROOT_CANNOT_BE_DRIVE_ROOT");
    expect(() => resolveHostLayout({ mode: "installed", installRoot: "relative" })).toThrow(
      "DESKTOP_HOST_LAYOUT_INSTALL_ROOT_MUST_BE_ABSOLUTE",
    );
    expect(() =>
      resolveHostLayout({ mode: "installed", installRoot, hostProfileRoot: "relative" }),
    ).toThrow("DESKTOP_HOST_LAYOUT_HOST_PROFILE_ROOT_MUST_BE_ABSOLUTE");
    expect(() => resolveHostLayout({ mode: "installed", installRoot: driveRoot })).toThrow(
      "DESKTOP_HOST_LAYOUT_INSTALL_ROOT_CANNOT_BE_DRIVE_ROOT",
    );
  });
});
