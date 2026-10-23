import { ipcRenderer } from "electron";
import {
  MOTION_PREPARE,
  MOTION_REPLY,
  MOTION_RUN,
  type MotionPrepare,
  type MotionReply,
  type MotionRun,
} from "../shared/window-motion";
import { type MotionSurface, startMotionRenderer } from "./motion-overlay-renderer";

// The renderer shares this isolated world; no pixel buffer is copied into the page world.
const surface: MotionSurface = {
  onPrepare(listener: (payload: MotionPrepare) => void) {
    const receive = (_event: Electron.IpcRendererEvent, payload: MotionPrepare) =>
      listener(payload);
    ipcRenderer.on(MOTION_PREPARE, receive);
  },
  onRun(listener: (payload: MotionRun) => void) {
    const receive = (_event: Electron.IpcRendererEvent, payload: MotionRun) => listener(payload);
    ipcRenderer.on(MOTION_RUN, receive);
  },
  reply(message: MotionReply) {
    ipcRenderer.send(MOTION_REPLY, message);
  },
};

window.addEventListener("DOMContentLoaded", () => startMotionRenderer(surface), { once: true });
