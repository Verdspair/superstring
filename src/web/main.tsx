import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyMode, applyTheme, observeSystemAppearance, readMode, readTheme } from "./appearance";
import { initDesktopLifecycle } from "./desktop-lifecycle";
import "./styles.css";

applyTheme(readTheme());
applyMode(readMode());
observeSystemAppearance();
// Cross-tab preference changes also update actual colours outside Settings.
window.addEventListener("storage", (event) => {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (
    event.key !== null &&
    event.key !== "superstring-appearance" &&
    event.key !== "superstring-appearance-mode"
  )
    return;
  if (event.key === null || event.key === "superstring-appearance")
    delete document.documentElement.dataset.themeUnsaved;
  if (event.key === null || event.key === "superstring-appearance-mode")
    delete document.documentElement.dataset.modeUnsaved;
  applyTheme(readTheme());
  applyMode(readMode());
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
