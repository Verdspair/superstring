import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

let workAreas: WorkArea[] = [{ x: 0, y: 0, width: 1920, height: 1040 }];

import { WindowStateManager } from "../../src/desktop/window-state";

class FakeWindow extends EventEmitter {
  normalBounds = { x: 120, y: 80, width: 1000, height: 720 };
  maximizedBounds = { x: 0, y: 0, width: 1920, height: 1040 };
  maximized = false;
  minimized = false;

  isDestroyed() {
    return false;
  }

  isMaximized() {
    return this.maximized;
  }

  isMinimized() {
    return this.minimized;
  }

  getNormalBounds() {
    return { ...this.normalBounds };
  }

  getBounds() {
    return { ...(this.maximized ? this.maximizedBounds : this.normalBounds) };
  }
}

const asWindow = (win: FakeWindow) => win as unknown as BrowserWindow;

const profiles: string[] = [];
const profileRoot = () => {
  const value = mkdtempSync(path.join(tmpdir(), "superstring-window-state-"));
  profiles.push(value);
  return value;
};
const stateFile = (root: string) => path.join(root, "state", "window-state.json");
const readState = (root: string) => JSON.parse(readFileSync(stateFile(root), "utf-8"));

afterEach(() => {
  workAreas = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  for (const value of profiles.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("desktop window state", () => {
  it("persists normal bounds in the existing file format and restores them", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root);
    const win = new FakeWindow();
    win.normalBounds = { x: 140, y: 90, width: 1000, height: 740 };
    manager.save(asWindow(win));
    expect(readFileSync(stateFile(root), "utf-8")).toBe(
      JSON.stringify({ x: 140, y: 90, width: 1000, height: 740, maximized: false }, null, 2),
    );
    const restored = new WindowStateManager(root);
    expect(restored.bounds).toEqual({ x: 140, y: 90, width: 1000, height: 740, maximized: false });
    expect(restored.validateBounds(workAreas)).toEqual({ x: 140, y: 90, width: 1000, height: 740 });
  });

  it("skips the write when the bounds did not change", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root);
    const win = new FakeWindow();
    manager.save(asWindow(win));
    writeFileSync(stateFile(root), "unchanged");
    manager.save(asWindow(win));
    expect(readFileSync(stateFile(root), "utf-8")).toBe("unchanged");
  });

  it("stores the restored size while maximized and exposes maximized for the next launch", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root);
    const win = new FakeWindow();
    win.normalBounds = { x: 160, y: 100, width: 1100, height: 800 };
    win.maximized = true;
    manager.save(asWindow(win));
    expect(readState(root)).toEqual({ x: 160, y: 100, width: 1100, height: 800, maximized: true });
    expect(new WindowStateManager(root).bounds.maximized).toBe(true);
  });

  it("keeps the stored state while the window is minimized", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root);
    const win = new FakeWindow();
    win.normalBounds = { x: 160, y: 100, width: 1100, height: 800 };
    win.maximized = true;
    manager.save(asWindow(win));
    win.minimized = true;
    win.maximized = false;
    win.normalBounds = { x: 0, y: 0, width: 480, height: 480 };
    manager.save(asWindow(win));
    expect(manager.bounds).toEqual({ x: 160, y: 100, width: 1100, height: 800, maximized: true });
  });

  it("merges a move/resize burst into one trailing write", async () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    const dispose = manager.track(asWindow(win));
    for (let step = 0; step < 40; step += 1) {
      win.normalBounds = { x: 100 + step, y: 90 + step, width: 900 + step, height: 700 + step };
      win.emit("move");
      win.emit("resize");
    }
    expect(existsSync(stateFile(root))).toBe(false);
    await Bun.sleep(100);
    expect(readState(root)).toEqual({ x: 139, y: 129, width: 939, height: 739, maximized: false });
    dispose();
  });

  it("flushes pending state synchronously on close", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 60_000 });
    const win = new FakeWindow();
    manager.track(asWindow(win));
    win.normalBounds = { x: 640, y: 200, width: 1100, height: 800 };
    win.emit("move");
    expect(existsSync(stateFile(root))).toBe(false);
    win.emit("close");
    expect(readState(root)).toEqual({ x: 640, y: 200, width: 1100, height: 800, maximized: false });
  });

  it("does not persist programmatic move/resize bursts until they settle", async () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    let programmatic = true;
    const stableNormal = { x: 100, y: 90, width: 1000, height: 720 };
    win.normalBounds = { ...stableNormal };
    const dispose = manager.track(asWindow(win), {
      isProgrammatic: () => programmatic,
      normalBounds: () => ({ ...win.normalBounds }),
    });
    // While the controller drives the window the stored state must stay untouched: no
    // intermediate or stable frame may reach memory or the file.
    for (const rect of [{ x: 40, y: 40, width: 800, height: 600 }, stableNormal]) {
      win.normalBounds = rect;
      win.emit("move");
      win.emit("resize");
    }
    expect(existsSync(stateFile(root))).toBe(false);
    expect(manager.bounds).toEqual({ width: 1280, height: 860, maximized: false });
    // The final settle happens outside programmatic control, so the stable frame flushes.
    programmatic = false;
    win.normalBounds = { ...stableNormal };
    win.emit("move");
    await Bun.sleep(60);
    expect(readState(root)).toEqual({ ...stableNormal, maximized: false });
    dispose();
  });

  it("keeps the last stable snapshot when closed mid-programmatic", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 60_000 });
    const win = new FakeWindow();
    const stableNormal = { x: 120, y: 80, width: 1000, height: 720 };
    win.normalBounds = { ...stableNormal };
    manager.save(asWindow(win));
    let programmatic = true;
    const dispose = manager.track(asWindow(win), { isProgrammatic: () => programmatic });
    win.normalBounds = { x: 10, y: 10, width: 640, height: 480 };
    win.emit("move");
    win.emit("close");
    expect(readState(root)).toEqual({ ...stableNormal, maximized: false });
    programmatic = false;
    dispose();
  });

  it("saves supplied pre-max normal on a maximized programmatic ending", async () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    const preMaxNormal = { x: 140, y: 90, width: 1000, height: 740 };
    // FakeWindow.getNormalBounds() reports work-area geometry while maximized; without the
    // supplier this would pollute the stored pre-max normal bounds.
    const workAreaPollutedNormal = { x: 0, y: 0, width: 1920, height: 1040 };
    win.normalBounds = { ...preMaxNormal };
    let programmatic = false;
    let suppliedNormal: { x: number; y: number; width: number; height: number } = {
      ...workAreaPollutedNormal,
    };
    const dispose = manager.track(asWindow(win), {
      isProgrammatic: () => programmatic,
      normalBounds: () => ({ ...suppliedNormal }),
    });
    // Middle morphing frames: programmatic, neither maximized nor the final rect.
    programmatic = true;
    win.normalBounds = { x: 60, y: 60, width: 900, height: 640 };
    win.emit("move");
    expect(existsSync(stateFile(root))).toBe(false);
    // Ending leg: back to normal and not programmatic; the supplier must hand over the exact
    // pre-max normal rect instead of the maximized work-area rect the window reports.
    suppliedNormal = { ...preMaxNormal };
    programmatic = false;
    win.maximized = true;
    win.normalBounds = { ...workAreaPollutedNormal };
    win.emit("resize");
    await Bun.sleep(60);
    expect(readState(root)).toEqual({ ...preMaxNormal, maximized: true });
    dispose();
  });

  it("drops an off-screen position and clamps oversized bounds to the work area", () => {
    const root = profileRoot();
    workAreas = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: 1920, y: 0, width: 1280, height: 1000 },
    ];
    const manager = new WindowStateManager(root);
    const win = new FakeWindow();
    win.normalBounds = { x: 8000, y: 600, width: 900, height: 700 };
    manager.save(asWindow(win));
    expect(manager.validateBounds(workAreas)).toEqual({ width: 900, height: 700 });
    win.normalBounds = { x: 100, y: 100, width: 4000, height: 3000 };
    manager.save(asWindow(win));
    expect(manager.validateBounds(workAreas)).toEqual({
      x: 100,
      y: 100,
      width: 1920,
      height: 1040,
    });
    win.normalBounds = { x: 1700, y: 100, width: 800, height: 700 };
    manager.save(asWindow(win));
    expect(manager.validateBounds(workAreas)).toEqual({ x: 1700, y: 100, width: 800, height: 700 });
  });

  it("falls back to defaults on an unparsable file and reports read and write failures", () => {
    const root = profileRoot();
    mkdirSync(path.join(root, "state"), { recursive: true });
    writeFileSync(stateFile(root), "{torn");
    const failures: string[] = [];
    const manager = new WindowStateManager(root, {
      onError: (_error, operation) => failures.push(operation),
    });
    expect(manager.bounds).toEqual({ width: 1280, height: 860, maximized: false });
    expect(failures).toEqual(["load"]);
    const win = new FakeWindow();
    rmSync(stateFile(root));
    mkdirSync(stateFile(root));
    manager.save(asWindow(win));
    expect(failures).toEqual(["load", "save"]);
    expect(manager.bounds.width).toBe(1000);
  });

  it("captures the native placement provider on an ordinary save and drops it when the provider returns null", async () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    win.normalBounds = { x: 140, y: 90, width: 1000, height: 740 };
    const snapshot = {
      bounds: { x: 960, y: 480, width: 2000, height: 1400 },
      displayId: 3,
      scaleFactor: 2,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    };
    let provided: typeof snapshot | null = { ...snapshot };
    let providerCalls = 0;
    const dispose = manager.track(asWindow(win), {
      nativePlacement: () => {
        providerCalls += 1;
        return provided ? { ...provided } : null;
      },
    });
    // The explicit save is the immediate capture path: the ordinary physical snapshot lands
    // in memory and the file in one synchronous write.
    manager.save(asWindow(win));
    expect(providerCalls).toBe(1);
    expect(readState(root)).toEqual({
      x: 140,
      y: 90,
      width: 1000,
      height: 740,
      maximized: false,
      nativePlacement: snapshot,
    });
    expect(manager.bounds).toEqual({
      x: 140,
      y: 90,
      width: 1000,
      height: 740,
      maximized: false,
      nativePlacement: snapshot,
    });

    // A null provider read means the physical normal is gone or changed: the snapshot is
    // dropped while the valid logical bounds stay.
    provided = null;
    manager.save(asWindow(win));
    expect(readState(root)).toEqual({ x: 140, y: 90, width: 1000, height: 740, maximized: false });
    expect(manager.bounds).toEqual({ x: 140, y: 90, width: 1000, height: 740, maximized: false });
    expect(manager.bounds.nativePlacement).toBeUndefined();

    // A move/resize never reads the native provider synchronously (no Koffi re-entry inside
    // the WndProc forward): the physical read defers to the existing trailing merge timer.
    provided = { ...snapshot };
    win.normalBounds = { x: 180, y: 120, width: 1000, height: 740 };
    win.emit("move");
    win.emit("resize");
    expect(providerCalls).toBe(2);
    await Bun.sleep(60);
    expect(providerCalls).toBe(3);
    expect(readState(root)).toEqual({
      x: 180,
      y: 120,
      width: 1000,
      height: 740,
      maximized: false,
      nativePlacement: snapshot,
    });
    dispose();
  });

  it("keeps the retained ordinary snapshot across a maximized save and drops it only on a changed normal", () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    const snapshot = {
      bounds: { x: 960, y: 480, width: 2000, height: 1400 },
      displayId: 3,
      scaleFactor: 2,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    };
    win.normalBounds = { x: 140, y: 90, width: 1000, height: 740 };
    let providerCalls = 0;
    const dispose = manager.track(asWindow(win), {
      nativePlacement: () => {
        providerCalls += 1;
        return { ...snapshot };
      },
    });
    manager.save(asWindow(win));
    expect(providerCalls).toBe(1);

    // A maximized save never reads the provider again: no maximized physical pixels are
    // stored, and the last stable ordinary snapshot survives the maximize unchanged.
    win.maximized = true;
    manager.save(asWindow(win));
    expect(providerCalls).toBe(1);
    expect(readState(root)).toEqual({
      x: 140,
      y: 90,
      width: 1000,
      height: 740,
      maximized: true,
      nativePlacement: snapshot,
    });

    // A logical normal change while still maximized updates only the logical fields: the
    // retained ordinary snapshot stays because only an ordinary frame may refresh or drop it.
    win.normalBounds = { x: 300, y: 200, width: 1100, height: 800 };
    manager.save(asWindow(win));
    expect(providerCalls).toBe(1);
    expect(readState(root)).toEqual({
      x: 300,
      y: 200,
      width: 1100,
      height: 800,
      maximized: true,
      nativePlacement: snapshot,
    });
    dispose();
  });

  it("flushes the last retained snapshot on close without calling the native provider", async () => {
    const root = profileRoot();
    const manager = new WindowStateManager(root, { flushDelayMs: 20 });
    const win = new FakeWindow();
    const snapshot = {
      bounds: { x: 960, y: 480, width: 2000, height: 1400 },
      displayId: 3,
      scaleFactor: 2,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    };
    win.normalBounds = { x: 140, y: 90, width: 1000, height: 740 };
    let providerCalls = 0;
    const dispose = manager.track(asWindow(win), {
      nativePlacement: () => {
        providerCalls += 1;
        return { ...snapshot };
      },
    });
    manager.save(asWindow(win));
    expect(providerCalls).toBe(1);

    // The close callback performs a logical-only remember: no Koffi FFI may run there.
    win.emit("close");
    expect(providerCalls).toBe(1);
    expect(readState(root)).toEqual({
      x: 140,
      y: 90,
      width: 1000,
      height: 740,
      maximized: false,
      nativePlacement: snapshot,
    });

    // A logical normal change after the close flush defers the native read to the trailing
    // timer like any ordinary move/resize: the timer refresh is a fresh ordinary capture.
    win.normalBounds = { x: 500, y: 300, width: 1200, height: 900 };
    win.emit("move");
    expect(providerCalls).toBe(1);
    await Bun.sleep(60);
    expect(providerCalls).toBe(2);
    expect(readState(root)).toEqual({
      x: 500,
      y: 300,
      width: 1200,
      height: 900,
      maximized: false,
      nativePlacement: snapshot,
    });
    dispose();
  });
});
