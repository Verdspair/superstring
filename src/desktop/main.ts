import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  screen,
  session,
  shell,
} from "electron";
import log from "electron-log/main";
import i18next from "i18next";
import {
  resolveFont,
  resolveInterfaceSize,
  resolveMode,
  resolveTextSize,
  resolveTheme,
} from "../shared/appearance";
import type { DesktopStartupPresentation } from "../shared/desktop-host";
import {
  DESKTOP_MOTION_MANAGED,
  DESKTOP_STARTUP_LOGS,
  DESKTOP_STARTUP_RETRY,
  DESKTOP_STARTUP_STATE,
  DESKTOP_WORKSPACE_READY,
  type DesktopStartupState,
} from "../shared/desktop-host";
import {
  CLOSE_ANIMATION_STORAGE_KEY,
  type DesktopPreferenceSnapshot,
  isCloseAnimationEnabled,
} from "../shared/desktop-preferences";
import { DESKTOP_APP_ID, MOTION_OVERLAY_URL } from "../shared/window-motion";
import { DesktopBackend, localRequest } from "./backend";
import { resolveHostLayout } from "./host-layout";
import { nativeLocales } from "./locales";
import { attachNativeWindowMotion, type NativeWindowMotion } from "./native/win32";
import { installDesktopPreferences } from "./preferences";
import { externalHttpUrl, installSessionSecurity, isServiceUrl } from "./security";
import { createWindowMotion, type WindowMotionController } from "./window-motion";
import { WindowStateManager } from "./window-state";

app.setName("Superstring");
if (process.platform === "win32") {
  // Aura's extra window-visibility fade would expose the desktop beneath our custom motion.
  // This leaves the renderer's startup, bounds, minimize, restore and close animations intact.
  app.commandLine.appendSwitch("wm-window-animations-disabled");
}
protocol.registerSchemesAsPrivileged([
  { scheme: "superstring", privileges: { standard: true, secure: true } },
]);
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const smokeReport = argument("--desktop-smoke-report");
const packagedUnix = app.isPackaged && process.platform !== "win32";
const profile =
  argument("--desktop-profile") ?? (packagedUnix ? app.getPath("userData") : undefined);
const serviceRoot =
  argument("--desktop-service-root") ??
  (packagedUnix ? path.join(process.resourcesPath, "service") : undefined);
const projectRoot = process.env.SUPERSTRING_DESKTOP_PROJECT_ROOT;
const installRoot = process.env.SUPERSTRING_DESKTOP_INSTALL_ROOT;
if (Boolean(profile) !== Boolean(serviceRoot))
  throw new Error("DESKTOP_PROFILE_AND_SERVICE_ROOT_REQUIRED_TOGETHER");
if (projectRoot && installRoot) throw new Error("DESKTOP_LAYOUT_ROOTS_CONFLICT");
if (!profile && !projectRoot && !installRoot) throw new Error("DESKTOP_EXPLICIT_LAYOUT_REQUIRED");
if (smokeReport && (!(profile || installRoot) || !path.isAbsolute(smokeReport)))
  throw new Error("DESKTOP_SMOKE_REQUIRES_ABSOLUTE_TEMP_PROFILE_AND_REPORT");
const layout =
  profile && serviceRoot
    ? resolveHostLayout({
        mode: "managed-profile",
        profileRoot: profile,
        resourceRoot: path.join(serviceRoot, "resources"),
        executable: path.join(
          serviceRoot,
          process.platform === "win32" ? "superstring-server.exe" : "superstring-server",
        ),
      })
    : installRoot
      ? resolveHostLayout({ mode: "installed", installRoot })
      : resolveHostLayout({ mode: "development-legacy", projectRoot: projectRoot as string });
mkdirSync(layout.profileRoot, { recursive: true, mode: 0o700 });
const profileRoot = realpathSync(layout.profileRoot);
app.setPath("userData", profileRoot);
app.setPath("sessionData", path.join(profileRoot, "chromium"));
app.setAppLogsPath(path.join(profileRoot, "logs"));
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.resolvePathFn = () => path.join(profileRoot, "logs", "desktop.log");
log.transports.console.level = false;

const startupFile = path.join(app.getAppPath(), "startup.html");
const startupUrl = "superstring://startup/";
if (process.platform === "win32") app.setAppUserModelId(DESKTOP_APP_ID);
let window: BrowserWindow | null = null;
let motion: WindowMotionController | null = null;
let motionNativeAttached = false;
let backend: DesktopBackend | null = null;
let launching: Promise<void> | null = null;
let quitting = false;
let disposePreferences: (() => void) | undefined;
let startupState: DesktopStartupState = { phase: "starting", message: "" };
const t = (key: string) => i18next.t(key);
const openLogs = () => {
  void shell.openPath(app.getPath("logs"));
};
const sameRect = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

let presentation: DesktopStartupPresentation;
/** Live close policy; the existing preference snapshot keeps it current before launch. */
let closeAnimationEnabled = true;
function updatePresentation(snapshot: DesktopPreferenceSnapshot) {
  closeAnimationEnabled = isCloseAnimationEnabled(snapshot[CLOSE_ANIMATION_STORAGE_KEY]);
  const theme = resolveTheme(snapshot["superstring-appearance"]);
  const mode = resolveMode(snapshot["superstring-appearance-mode"]);
  nativeTheme.themeSource = mode;
  presentation = {
    locale:
      snapshot["superstring-locale"] === "zh-CN"
        ? "zh-CN"
        : snapshot["superstring-locale"] === "en"
          ? "en"
          : app.getLocale().startsWith("zh")
            ? "zh-CN"
            : "en",
    theme: theme.id,
    mode,
    font: resolveFont(snapshot["superstring-appearance-font"]).id,
    textSize: resolveTextSize(snapshot["superstring-appearance-text-size"]).id,
    interfaceSize: resolveInterfaceSize(snapshot["superstring-appearance-interface-size"]).id,
    dark: nativeTheme.shouldUseDarkColors,
    css: `:root { --primary: light-dark(${theme.color}, ${theme.dark}); --ring: var(--primary); }`,
  };
  updateOverlay();
  publishStartup();
}
function updateOverlay() {
  window?.setTitleBarOverlay({
    symbolColor: nativeTheme.shouldUseDarkColors ? "#e4e4e7" : "#242b36",
  });
}
function publishStartup() {
  if (window && !window.isDestroyed() && window.webContents.getURL() === startupUrl)
    window.webContents.send(DESKTOP_STARTUP_STATE, { ...startupState, presentation });
}

function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  disposePreferences?.();
  backend?.terminate();
  // A close-initiated dispose is deferred to the main loop by the controller; a quit that
  // happens outside a close event disposes here, still before the window is destroyed.
  motion?.dispose();
  window?.destroy();
  // The headless Windows root owns the job and terminates every remaining descendant.
  app.exit(code);
}

async function fail(code: string) {
  if (quitting) return;
  log.error(code);
  backend?.terminate();
  if (smokeReport) {
    try {
      writeFileSync(
        smokeReport,
        JSON.stringify(
          { ok: false, error: code, platform: process.platform, arch: process.arch },
          null,
          2,
        ),
      );
    } finally {
      quit(1);
    }
    return;
  }
  startupState = {
    phase: "failed",
    message: `${t("failed")}
${i18next.t("errorCode", { code })}`,
  };
  const current = window;
  if (!current || current.isDestroyed()) {
    quit(1);
    return;
  }
  if (current.webContents.getURL() !== startupUrl) await current.loadURL(startupUrl);
  publishStartup();
}

function assertStartupSender(event: IpcMainInvokeEvent, args: unknown[]) {
  if (
    args.length ||
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== startupUrl
  )
    throw new Error("DESKTOP_STARTUP_FORBIDDEN");
}

function attachNativeMotion(current: BrowserWindow): NativeWindowMotion | null {
  // The win32 module guards koffi behind its own win32-x64 branch, so a plain import never
  // loads the native dependency on another platform.
  if (process.platform !== "win32") return null;
  const native = attachNativeWindowMotion(current, DESKTOP_APP_ID, (code) =>
    log.warn(`DESKTOP_WINDOW_MOTION_${code}`),
  );
  motionNativeAttached = native !== null;
  return native;
}

function createWindow() {
  const state = new WindowStateManager(profileRoot, {
    onError: (error, operation) => log.warn(`DESKTOP_WINDOW_STATE_${operation}: ${String(error)}`),
  });
  const bounds = state.validateBounds(screen.getAllDisplays().map((display) => display.workArea));
  const current = new BrowserWindow({
    title: "Superstring",
    icon: path.join(
      app.getAppPath(),
      process.platform === "win32" ? "superstring.ico" : "icon.png",
    ),
    ...bounds,
    minWidth: 480,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: nativeTheme.shouldUseDarkColors ? "#e4e4e7" : "#242b36",
      height: 36,
    },
    webPreferences: {
      preload: path.join(app.getAppPath(), "preload.cjs"),
      partition: "persist:superstring",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: true,
    },
  });
  window = current;
  const native = smokeReport ? null : attachNativeMotion(current);
  // A physical restore needs the attach success and the saved native placement metadata.
  const saved = state.bounds;
  const placement = saved.nativePlacement;
  if (native && placement && bounds.x !== undefined && bounds.y !== undefined) {
    const validated = { ...bounds, x: bounds.x, y: bounds.y };
    const display = screen.getDisplayMatching(validated);
    const metadata =
      display.id === placement.displayId &&
      display.scaleFactor === placement.scaleFactor &&
      sameRect(display.bounds, placement.displayBounds) &&
      sameRect(display.workArea, placement.workArea);
    if (
      metadata &&
      sameRect(validated, {
        x: saved.x ?? 0,
        y: saved.y ?? 0,
        width: saved.width,
        height: saved.height,
      })
    ) {
      // The saved logical DIP matches the validated constructor bounds and the display metadata
      // matches: apply the saved physical rect exactly. No DIP derivation, no corrective loop.
      if (!native.bypass(() => native.setPhysicalBounds(placement.bounds)))
        log.warn("DESKTOP_WINDOW_PLACEMENT_RESTORE_FAILED");
    } else {
      log.warn(
        `DESKTOP_WINDOW_PLACEMENT_DISPLAY_CHANGED: ${
          metadata ? "logical-clamp-changed" : "display-mismatch"
        }`,
      );
    }
  }
  // The saved maximize applies before the hook exists: the hook never intercepts it.
  if (saved.maximized) {
    if (native) native.bypass(() => current.maximize());
    else current.maximize();
  }
  // Smoke stays hook-free: no window hook, no overlay, no COM, one hidden window.
  motion = createWindowMotion(current, {
    native,
    log: (code) => log.warn(code),
    quit: () => quit(),
    // Live read of the one store-backed preference; no second cache, IPC or store.
    shouldAnimateClose: () => closeAnimationEnabled,
    // The existing manager owns the only write: no second state/cache/timer.
    onSettled: () => state.save(current),
  });
  // Windows with the motion controller attached own their first reveal; every other
  // platform/failure path keeps the original ready-to-show show.
  if (!motionNativeAttached && !smokeReport) current.once("ready-to-show", () => current.show());
  const disposeState = state.track(current, {
    isProgrammatic: () => motion?.isProgrammatic() ?? false,
    normalBounds: () => motion?.normalBounds() ?? current.getNormalBounds(),
    // The manager captures the physical normal itself; the provider only adds the live
    // display metadata, so the one state file keeps the single placement snapshot.
    nativePlacement: () => {
      if (!native) return null;
      const physical = native.getPhysicalBounds();
      if (!physical) return null;
      const display = screen.getDisplayMatching(current.getNormalBounds());
      return {
        bounds: physical,
        displayId: display.id,
        scaleFactor: display.scaleFactor,
        displayBounds: display.bounds,
        workArea: display.workArea,
      };
    },
  });
  state.save(current);
  current.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpUrl(url);
    if (external && (!backend?.origin || !isServiceUrl(external, backend.origin)))
      void shell.openExternal(external);
    return { action: "deny" };
  });
  current.webContents.on("will-frame-navigate", (event) => {
    if (
      !event.isMainFrame ||
      (event.url !== startupUrl && (!backend?.origin || !isServiceUrl(event.url, backend.origin)))
    )
      event.preventDefault();
  });
  current.webContents.on("will-redirect", (event, url) => {
    if (!backend?.origin || !isServiceUrl(url, backend.origin)) event.preventDefault();
  });
  current.webContents.on("will-attach-webview", (event) => event.preventDefault());
  current.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && !quitting)
      void fail(`DESKTOP_RENDERER_${details.reason}`);
  });
  current.webContents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    log.error(
      JSON.stringify({
        loadFailure: { code, description, url, startupFile, appPath: app.getAppPath() },
      }),
    );
    if (mainFrame && code !== -3 && !quitting) {
      if (url === startupUrl) quit(1);
      else void fail(`DESKTOP_PAGE_LOAD_${code}`);
    }
  });
  current.webContents.on("preload-error", (_event, preloadPath, error) =>
    log.error(`DESKTOP_PRELOAD_FAILED ${preloadPath}: ${error.message}`),
  );
  current.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) log.warn(message);
  });
  current.webContents.on("did-finish-load", publishStartup);
  current.on("close", (event) => {
    if (motion) motion.close(event);
    else quit();
  });
  current.on("closed", () => {
    disposeState();
    if (window === current) window = null;
  });
  return current;
}

async function smoke(current: BrowserWindow) {
  const origin = backend?.origin;
  if (!smokeReport || !backend || !origin) return;
  const rendered = await current.webContents.executeJavaScript(`new Promise(resolve => {
    const deadline=Date.now()+30000;
    const inspect=()=>{if(document.querySelector('#root')?.childElementCount)resolve(true);else if(Date.now()>deadline)resolve(false);else setTimeout(inspect,50)};inspect();
  })`);
  const authenticated = await current.webContents.executeJavaScript(
    `(async()=>{const r=await fetch('/agents');return r.ok&&Array.isArray(await r.json())})()`,
  );
  const rejected = await localRequest(origin, "/agents");
  const status = await backend.status();
  const facts = await current.webContents.executeJavaScript(
    `({bridge:window.superstringHost?.desktop===true,preferences:!!window.superstringPreferences,node:typeof require==='undefined',titlebar:CSS.supports('app-region','drag')})`,
  );
  log.info(
    JSON.stringify({
      smoke: { rendered, authenticated, rejected: rejected.status, status, facts },
    }),
  );
  if (
    !rendered ||
    !authenticated ||
    rejected.status !== 403 ||
    status.state !== "ready" ||
    !facts.bridge ||
    !facts.preferences ||
    !facts.node
  )
    throw new Error("DESKTOP_SMOKE_FAILED");
  writeFileSync(
    smokeReport,
    JSON.stringify(
      {
        ok: true,
        platform: process.platform,
        arch: process.arch,
        version: app.getVersion(),
        checks: {
          backend: true,
          renderer: true,
          authentication: true,
          closeStopsBackend: true,
          gracefulStop: false,
          directExit: true,
        },
        window: {
          count: BrowserWindow.getAllWindows().length,
          titleBarStyle: "hidden",
          overlay: motionNativeAttached,
          sandboxConfigured: true,
          contextIsolationConfigured: true,
          nodeIntegrationConfigured: false,
          ...facts,
        },
        layout: layout.mode,
      },
      null,
      2,
    ),
  );
  current.close();
}

function launch(): Promise<void> {
  if (quitting) return Promise.resolve();
  if (launching) return launching;
  launching = (async () => {
    const current = window ?? createWindow();
    startupState = { phase: "starting", message: t("starting") };
    if (current.webContents.getURL() !== startupUrl) await current.loadURL(startupUrl);
    // A close during the initial load must not reach presentation or backend launch.
    if (quitting || current.isDestroyed()) return;
    publishStartup();
    // The handoff phase settles the startup panel before the controller captures pixels.
    let startupPresentation = Promise.resolve();
    if (motion && !smokeReport) {
      startupState = { phase: "handoff", message: t("starting") };
      publishStartup();
      startupPresentation = motion
        .presentStartup()
        .catch((error: unknown) => log.error(`DESKTOP_STARTUP_PRESENT_FAILED: ${String(error)}`));
    }
    if (quitting || current.isDestroyed()) return;
    backend = new DesktopBackend({
      layout,
      log: (message) => log.info(message),
      onExit: (expected, code, signal) => {
        if (!expected && !quitting) {
          if (code === 0) quit();
          else void fail(`DESKTOP_SERVICE_EXIT:${code ?? signal ?? "unknown"}`);
        }
      },
    });
    const origin = await backend.start();
    if (quitting || current.isDestroyed()) return;
    // Backend failures reach the existing catch immediately; only successful navigation waits.
    await startupPresentation;
    if (
      quitting ||
      current.isDestroyed() ||
      backend.exitCode !== null ||
      (startupState as DesktopStartupState).phase === "failed"
    )
      return;
    if (motion && !smokeReport) await motion.navigate(origin);
    else await current.loadURL(origin);
    await smoke(current);
  })()
    .catch((error: unknown) =>
      fail(error instanceof Error ? error.message : "DESKTOP_START_FAILED"),
    )
    .finally(() => {
      launching = null;
    });
  return launching;
}

if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on("second-instance", () => {
    const current = window;
    if (!current || quitting) return;
    if (motionNativeAttached && motion) {
      // The serialized intent owner applies the restore; the leg focuses once settled.
      motion.request("restore");
      if (!current.isMinimized()) {
        current.show();
        current.focus();
      }
      return;
    }
    // Plain window without native attachment: the original direct behavior.
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  });
  app.on("window-all-closed", () => quit());
  app.on("before-quit", () => quit());
  void app
    .whenReady()
    .then(async () => {
      await i18next.init({
        resources: nativeLocales,
        lng: app.getLocale().startsWith("zh") ? "zh-CN" : "en",
        fallbackLng: "en",
      });
      const desktopSession = session.fromPartition("persist:superstring");
      const startupAssets = new Map([
        [startupUrl, { file: startupFile, type: "text/html; charset=utf-8" }],
        [
          MOTION_OVERLAY_URL,
          {
            file: path.join(app.getAppPath(), "motion-overlay.html"),
            type: "text/html; charset=utf-8",
          },
        ],
        [
          "superstring://startup/appearance.css",
          { file: path.join(app.getAppPath(), "appearance.css"), type: "text/css; charset=utf-8" },
        ],
        ...readdirSync(path.join(app.getAppPath(), "fonts")).map(
          (name) =>
            [
              `superstring://startup/fonts/${name}`,
              { file: path.join(app.getAppPath(), "fonts", name), type: "font/woff2" },
            ] as const,
        ),
      ]);
      desktopSession.protocol.handle("superstring", (request) => {
        const asset = startupAssets.get(request.url);
        return request.method === "GET" && asset
          ? new Response(readFileSync(asset.file), { headers: { "Content-Type": asset.type } })
          : new Response(null, { status: 404 });
      });
      installSessionSecurity(
        desktopSession,
        () => (backend?.origin ? { origin: backend.origin, token: backend.token } : null),
        () => window?.webContents ?? null,
        startupUrl,
      );
      ipcMain.handle(DESKTOP_STARTUP_RETRY, (event, ...args) => {
        assertStartupSender(event, args);
        if (startupState.phase !== "failed" || launching) return;
        void launch();
      });
      ipcMain.handle(DESKTOP_STARTUP_LOGS, (event, ...args) => {
        assertStartupSender(event, args);
        openLogs();
      });
      ipcMain.on(DESKTOP_MOTION_MANAGED, (event, ...args) => {
        // Sync capability probe from the preload at document load: one boolean read of the
        // main-process fact, no renderer state, no async race. The flag is the actual native
        // attachment, not mere controller existence; it never touches native/COM here.
        const sender = window && !window.isDestroyed() ? window.webContents : null;
        const authorized =
          !args.length &&
          sender !== null &&
          event.sender === sender &&
          event.senderFrame === sender.mainFrame &&
          (event.senderFrame.url === "" ||
            event.senderFrame.url === "about:blank" ||
            event.senderFrame.url === startupUrl ||
            (backend?.origin ? isServiceUrl(event.senderFrame.url, backend.origin) : false)) &&
          motionNativeAttached &&
          process.platform === "win32";
        if (!authorized) {
          log.warn("DESKTOP_MOTION_MANAGED_FORBIDDEN");
          event.returnValue = false;
          return;
        }
        event.returnValue = true;
      });
      ipcMain.handle(DESKTOP_WORKSPACE_READY, (event, ...args) => {
        const sender = window && !window.isDestroyed() ? window.webContents : null;
        const origin = backend?.origin ?? null;
        const authorized =
          !args.length &&
          sender !== null &&
          event.sender === sender &&
          event.senderFrame === sender.mainFrame &&
          origin !== null &&
          isServiceUrl(event.senderFrame.url, origin);
        if (!authorized) throw new Error("DESKTOP_WORKSPACE_READY_FORBIDDEN");
        motion?.workspaceReady(event.sender);
      });
      disposePreferences = await installDesktopPreferences({
        ipcMain,
        profileDirectory: profileRoot,
        webContents: () => window?.webContents ?? null,
        origin: () => backend?.origin ?? null,
        onError: (code) => log.error(code),
        onChange: updatePresentation,
        onLocaleChange: (locale) => {
          void i18next.changeLanguage(locale ?? "en");
        },
        onBootstrapError: (code) => {
          void fail(code);
        },
      });
      nativeTheme.on("updated", () => {
        if (presentation) presentation.dark = nativeTheme.shouldUseDarkColors;
        updateOverlay();
        publishStartup();
      });
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));
      await launch();
    })
    .catch((error) => {
      void fail(error instanceof Error ? error.message : "DESKTOP_INIT_FAILED");
    });
}
