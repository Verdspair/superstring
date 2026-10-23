import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {
  applyFont,
  applyInterfaceSize,
  applyMode,
  applyTextSize,
  applyTheme,
  FONT_STORAGE_KEY,
  INTERFACE_SIZE_STORAGE_KEY,
  observeSystemAppearance,
  readFont,
  readInterfaceSize,
  readMode,
  readTextSize,
  readTheme,
  TEXT_SIZE_STORAGE_KEY,
} from "./appearance";
import { initDesktopLifecycle } from "./desktop-lifecycle";
import "./styles.css";

applyTheme(readTheme());
applyMode(readMode());
applyFont(readFont());
applyTextSize(readTextSize());
applyInterfaceSize(readInterfaceSize());
observeSystemAppearance();
// Cross-tab preference changes also update actual colours, the font and both size axes.
window.addEventListener("storage", (event) => {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (
    event.key !== null &&
    event.key !== "superstring-appearance" &&
    event.key !== "superstring-appearance-mode" &&
    event.key !== FONT_STORAGE_KEY &&
    event.key !== TEXT_SIZE_STORAGE_KEY &&
    event.key !== INTERFACE_SIZE_STORAGE_KEY
  )
    return;
  if (event.key === null || event.key === "superstring-appearance")
    delete document.documentElement.dataset.themeUnsaved;
  if (event.key === null || event.key === "superstring-appearance-mode")
    delete document.documentElement.dataset.modeUnsaved;
  if (event.key === null || event.key === FONT_STORAGE_KEY)
    delete document.documentElement.dataset.fontUnsaved;
  if (event.key === null || event.key === TEXT_SIZE_STORAGE_KEY)
    delete document.documentElement.dataset.textSizeUnsaved;
  if (event.key === null || event.key === INTERFACE_SIZE_STORAGE_KEY)
    delete document.documentElement.dataset.interfaceSizeUnsaved;
  applyTheme(readTheme());
  applyMode(readMode());
  applyFont(readFont());
  applyTextSize(readTextSize());
  applyInterfaceSize(readInterfaceSize());
});

// Desktop-mode liveness client. No-op unless the server injected the
// desktop-mode meta tag, so it is silent in normal mode. In desktop mode it
// also syncs the chosen appearance (theme + mode) to the server.
initDesktopLifecycle({
  getAppearance: () => ({ theme: readTheme(), mode: readMode() }),
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
