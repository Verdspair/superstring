import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
} from "electron";
import log from "electron-log/main";
import i18next from "i18next";
import { DesktopBackend, localRequest } from "./backend";
import { nativeLocales } from "./locales";
import { installDesktopPreferences } from "./preferences";
import { externalHttpUrl, installSessionSecurity, isServiceUrl } from "./security";

app.setName("Superstring");
function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
const smokeReport = argument("--desktop-smoke-report");
const customProfile = argument("--desktop-profile");
if (
  smokeReport &&
  (!path.isAbsolute(smokeReport) || !customProfile || !path.isAbsolute(customProfile))
) {
  throw new Error("DESKTOP_SMOKE_REQUIRES_ABSOLUTE_TEMP_PROFILE_AND_REPORT");
}
if (customProfile) {
  if (!path.isAbsolute(customProfile)) throw new Error("DESKTOP_PROFILE_MUST_BE_ABSOLUTE");
  mkdirSync(customProfile, { recursive: true, mode: 0o700 });
  app.setPath("userData", customProfile);
}
mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
const profileRoot = realpathSync(app.getPath("userData"));
app.setPath("userData", profileRoot);
app.setPath("sessionData", path.join(profileRoot, "chromium"));
app.setAppLogsPath(path.join(profileRoot, "logs"));
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.resolvePathFn = () => path.join(profileRoot, "logs", "desktop.log");
log.transports.console.level = false;

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: DesktopBackend | null = null;
let launching: Promise<void> | null = null;
let quitting = false;
let stopped = false;
let showingFailure = false;
let disposePreferences: (() => void) | null = null;
let configured = false;
const t = (key: string) => i18next.t(key);
const brand = path.join(process.resourcesPath, "service", "brand");
const openLogs = () => {
  void shell.openPath(app.getPath("logs"));
};

async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  // Do not forcibly kill a process with an open SQLite writer. A slow shutdown stays visible.
  const notice = smokeReport
    ? null
    : setTimeout(() => {
        void dialog
          .showMessageBox({
            type: "info",
            title: t("stopping"),
            message: t("stopping"),
            detail: t("stoppingDetail"),
            buttons: [t("wait"), t("logs")],
            cancelId: 0,
          })
          .then(({ response }) => {
            if (response === 1) openLogs();
          });
      }, 15_000);
  try {
    await backend?.stop();
    disposePreferences?.();
    tray?.destroy();
    stopped = true;
    app.quit();
  } finally {
    if (notice) clearTimeout(notice);
  }
}

async function fail(code: string): Promise<void> {
  log.error(code);
  if (smokeReport) {
    writeFileSync(
      smokeReport,
      JSON.stringify({ ok: false, error: code, platform: process.platform, arch: process.arch }),
    );
    await backend?.stop();
    app.exit(1);
    return;
  }
  if (quitting || showingFailure) return;
  showingFailure = true;
  const result = await dialog.showMessageBox({
    type: "error",
    title: t("failed"),
    message: t("failed"),
    detail: `${t("failedDetail")}\n\n${i18next.t("errorCode", { code })}`,
    buttons: [configured ? t("retry") : t("quit"), t("logs"), t("quit")],
    defaultId: 0,
    cancelId: 2,
  });
  showingFailure = false;
  if (result.response === 1) {
    openLogs();
    return fail(code);
  }
  if (result.response === 2 || !configured) return quit();
  window?.destroy();
  window = null;
  await backend?.stop();
  await launching;
  void launch();
}

function openWindow(): BrowserWindow {
  if (!backend?.origin) throw new Error("DESKTOP_SERVICE_NOT_READY");
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }
  const origin = backend.origin;
  const created = new BrowserWindow({
    title: "Superstring",
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    show: false,
    icon: path.join(brand, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      partition: "persist:superstring",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // Background Agent work belongs to the sidecar; the window may be fully closed.
      backgroundThrottling: true,
    },
  });
  window = created;
  const windowFailure = (code: string) => {
    if (window === created && !created.isDestroyed() && !quitting) void fail(code);
  };
  created.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpUrl(url);
    if (external && !isServiceUrl(external, origin)) void shell.openExternal(external);
    return { action: "deny" };
  });
  created.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isServiceUrl(event.url, origin)) event.preventDefault();
  });
  created.webContents.on("will-redirect", (event, url) => {
    if (!isServiceUrl(url, origin)) event.preventDefault();
  });
  created.webContents.on("will-attach-webview", (event) => event.preventDefault());
  created.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") windowFailure(`DESKTOP_RENDERER_${details.reason}`);
  });
  created.webContents.on("did-fail-load", (_event, errorCode, _description, _url, mainFrame) => {
    if (mainFrame && errorCode !== -3) windowFailure(`DESKTOP_PAGE_LOAD_${errorCode}`);
  });
  let closing = false;
  created.on("close", (event) => {
    if (quitting || stopped) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void backend
      ?.status()
      .then((status) => {
        if (status.close_action === "exit") void quit();
        else created.destroy();
      })
      .catch(() => {
        closing = false;
        windowFailure("DESKTOP_CLOSE_STATUS_FAILED");
      });
  });
  created.on("closed", () => {
    if (window === created) window = null;
  });
  created.once("ready-to-show", () => {
    if (!smokeReport) created.show();
  });
  void created.loadURL(origin).catch((error: { code?: string }) => {
    if (error.code !== "ERR_ABORTED") windowFailure("DESKTOP_PAGE_LOAD_FAILED");
  });
  return created;
}

function installMenus(): void {
  tray?.destroy();
  const show = () => {
    if (!quitting && backend?.origin) openWindow();
  };
  const menu = Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [
          {
            label: "Superstring",
            submenu: [
              { role: "about" as const, label: t("about") },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { label: t("quit"), accelerator: "CmdOrCtrl+Q", click: () => void quit() },
            ],
          },
        ]
      : []),
    {
      label: t("file"),
      submenu: [
        { label: t("open"), click: show },
        { role: "close", label: t("close") },
        ...(process.platform !== "darwin"
          ? [{ label: t("quit"), accelerator: "CmdOrCtrl+Q", click: () => void quit() }]
          : []),
      ],
    },
    {
      label: t("edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: t("view"),
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { label: t("window"), submenu: [{ role: "minimize" }, { role: "zoom" }] },
    {
      label: t("help"),
      submenu: [
        { label: t("logs"), click: openLogs },
        {
          label: t("profile"),
          click: () => {
            void shell.openPath(profileRoot);
          },
        },
        {
          label: t("releases"),
          click: () => {
            void shell.openExternal("https://github.com/Verdspair/superstring/releases");
          },
        },
        ...(process.platform !== "darwin" ? [{ role: "about" as const, label: t("about") }] : []),
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  const image = nativeImage.createFromPath(
    path.join(brand, process.platform === "darwin" ? "trayTemplate.png" : "icon.png"),
  );
  tray = new Tray(process.platform === "darwin" ? image : image.resize({ width: 24, height: 24 }));
  tray.setToolTip("Superstring");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("open"), click: show },
      { type: "separator" },
      { label: t("quit"), click: () => void quit() },
    ]),
  );
  tray.on("click", show);
}

async function smoke(created: BrowserWindow): Promise<void> {
  const origin = backend?.origin;
  if (!smokeReport || !backend || !origin) return;
  // Execute only our shipped document, after the UI has mounted, without any model/OneBot traffic.
  const mounted = await created.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 30000;
    const inspect = () => { if (document.querySelector('#root')?.childElementCount) resolve(true);
      else if (Date.now() > deadline) resolve(false); else setTimeout(inspect, 100); }; inspect();
  })`);
  let authenticated = await backend.status();
  const connectionDeadline = Date.now() + 10_000;
  while (authenticated.page_connections < 1 && Date.now() < connectionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    authenticated = await backend.status();
  }
  const rendererApis = await created.webContents.executeJavaScript(`(async () => {
    const agents = await fetch('/agents');
    const settings = await fetch('/desktop/settings');
    return agents.ok && Array.isArray(await agents.json()) && settings.ok &&
      ['background', 'exit'].includes((await settings.json()).close_action);
  })()`);
  const rejected = await localRequest(origin, "/agents");
  if (
    !mounted ||
    !rendererApis ||
    authenticated.state !== "ready" ||
    authenticated.page_connections < 1 ||
    rejected.status !== 403
  )
    throw new Error("DESKTOP_SMOKE_FAILED");
  const backgroundSaved = await created.webContents.executeJavaScript(`(async () => {
    const saved = await fetch('/desktop/settings').then(r => r.json());
    return fetch('/desktop/settings', {
      method: 'PUT', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({close_action:'background', expected_revision: saved.revision})
    }).then(r => r.ok);
  })()`);
  if (!backgroundSaved) throw new Error("DESKTOP_SMOKE_BACKGROUND_SETTING_FAILED");
  await new Promise<void>((resolve) => {
    created.once("closed", resolve);
    created.close();
  });
  if ((await backend.status()).close_action !== "background")
    throw new Error("DESKTOP_SMOKE_BACKGROUND_FAILED");
  const reopened = openWindow();
  await new Promise<void>((resolve) =>
    reopened.webContents.once("did-finish-load", () => resolve()),
  );
  if (!(await reopened.webContents.executeJavaScript("fetch('/agents').then(r => r.ok)")))
    throw new Error("DESKTOP_SMOKE_REOPEN_FAILED");
  quitting = true;
  reopened.destroy();
  await backend.stop();
  if (backend.exitCode !== 0) throw new Error("DESKTOP_SMOKE_SHUTDOWN_FAILED");
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
          backgroundReopen: true,
          gracefulStop: true,
        },
      },
      null,
      2,
    ),
  );
  stopped = true;
  app.quit();
}

function launch(): Promise<void> {
  if (quitting) return Promise.resolve();
  if (launching) return launching;
  launching = (async () => {
    const serviceRoot = realpathSync(path.join(process.resourcesPath, "service"));
    backend = new DesktopBackend({
      executable: path.join(serviceRoot, "superstring-server"),
      profileRoot,
      resourceRoot: path.join(serviceRoot, "resources"),
      log: (message) => log.info(message),
      onExit: (expected, code, signal) => {
        if (code !== 0) log.error(`Service exited: ${code ?? signal ?? "unknown"}`);
        if (!expected && !quitting)
          void fail(`DESKTOP_SERVICE_EXIT:${code ?? signal ?? "unknown"}`);
      },
    });
    await backend.start();
    if (quitting) return;
    const created = openWindow();
    if (smokeReport) {
      await new Promise<void>((resolve) =>
        created.webContents.once("did-finish-load", () => resolve()),
      );
      await smoke(created);
    }
  })()
    .catch((error: unknown) => {
      void fail(error instanceof Error ? error.message : "DESKTOP_START_FAILED");
    })
    .finally(() => {
      launching = null;
    });
  return launching;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (backend?.origin && !quitting) openWindow();
  });
  app.on("activate", () => {
    if (backend?.origin && !quitting) openWindow();
  });
  app.on("window-all-closed", () => {
    /* The saved background/exit setting owns this transition. */
  });
  app.on("before-quit", (event) => {
    if (!stopped) {
      event.preventDefault();
      void quit();
    }
  });
  void app
    .whenReady()
    .then(async () => {
      await i18next.init({
        resources: nativeLocales,
        lng: app.getLocale().startsWith("zh") ? "zh-CN" : "en",
        fallbackLng: "en",
      });
      const desktopSession = session.fromPartition("persist:superstring");
      installSessionSecurity(
        desktopSession,
        () => (backend?.origin ? { origin: backend.origin, token: backend.token } : null),
        () => window?.webContents ?? null,
      );
      disposePreferences = await installDesktopPreferences({
        ipcMain,
        profileDirectory: profileRoot,
        webContents: () => window?.webContents ?? null,
        origin: () => backend?.origin ?? null,
        onError: (code) => log.error(code),
        onLocaleChange: (locale) => {
          void i18next
            .changeLanguage(locale ?? (app.getLocale().startsWith("zh") ? "zh-CN" : "en"))
            .then(() => {
              if (configured && !quitting) installMenus();
            });
        },
        onBootstrapError: (code) => {
          void fail(code);
        },
      });
      installMenus();
      configured = true;
      await launch();
    })
    .catch((error: unknown) => {
      void fail(error instanceof Error ? error.message : "DESKTOP_INIT_FAILED");
    });
}
