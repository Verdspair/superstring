import path from "node:path";
import { app, type BrowserWindow } from "electron";
import type { TypeObject } from "koffi";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowIntent = "minimize" | "maximize" | "restore";

export interface NativeWindowMotion {
  setHandler(handler: ((intent: WindowIntent) => void) | null): void;
  bypass<T>(run: () => T): T;
  setTransitionsDisabled(disabled: boolean): void;
  resolveTarget(): Rect | null;
  // Raw physical-pixel placement of the own HWND. getPhysicalBounds is only meaningful
  // for an ordinary (non-maximized) window; the caller owns calling it before maximize.
  // No conversion, offset, or retry: null/false means the native call failed.
  getPhysicalBounds(): Rect | null;
  setPhysicalBounds(rect: Rect): boolean;
  dispose(): void;
}

// Own-window native motion surface for Windows x64. The window procedure lives in
// window-proc-bridge.c: while not bypassed it swallows SC_MINIMIZE/SC_MAXIMIZE/SC_RESTORE,
// posts WM_APP+0x5a1 to the own HWND, and always forwards SC_CLOSE and everything else to
// the original proc. JS calls only the three bridge exports from the main loop and reads
// the posted message through win.hookWindowMessage, so no JS ever runs inside an OS
// callback. One UIA COM resolver reads the own taskbar button rect in PHYSICAL pixels; the
// caller converts with screen.screenToDipRect. koffi is required lazily inside this
// win32-x64 branch and no other platform loads it. No persistent state, no frame log, no
// fallback geometry, and no second window procedure.

type KoffiModule = typeof import("koffi");

// The bridge posts the intent to this WM_APP message. The low 4 bits of SC_* are system
// reserved, so the notification carries the masked command.
const BRIDGE_NOTIFY_MESSAGE = 0x85a1; // WM_APP (0x8000) + 0x5a1
const SC_COMMAND_MASK = 0xfff0;
const SC_MINIMIZE = 0xf020;
const SC_MAXIMIZE = 0xf030;
const SC_RESTORE = 0xf120;
// Local sentinel for a bridge call that threw before it could return a status.
const BRIDGE_CALL_FAILED = -100;
const DWMWA_TRANSITIONS_FORCEDISABLED = 3;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;

const IID_IUIAUTOMATION = "30cbe57d-d9d0-452a-ab13-7ac5ac4825ee";
const CLSID_CUIAUTOMATION = "ff48dba4-60ef-4201-aa87-54103eef594e";
const UIA_AUTOMATION_ID_PROPERTY_ID = 30011;
const TREE_SCOPE_DESCENDANTS = 0x4;
const VT_BSTR = 8;
const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const S_OK = 0;
const S_FALSE = 1;

const SLOT_RELEASE = 2;
const SLOT_ELEMENT_FROM_HANDLE = 6;
const SLOT_CREATE_PROPERTY_CONDITION = 23;
const SLOT_ELEMENT_FIND_ALL = 6;
const SLOT_ELEMENT_GET_OFFSCREEN = 38;
const SLOT_ELEMENT_BOUNDING_RECT = 43;
const SLOT_ARRAY_GET_LENGTH = 3;
const SLOT_ARRAY_GET_ELEMENT = 4;

interface WindowApi {
  dwmSetWindowAttribute(hwnd: bigint, attribute: number, value: Buffer, size: number): unknown;
  getWindowRect(hwnd: bigint, rect: Buffer): unknown;
  setWindowPos(
    hwnd: bigint,
    insertAfter: bigint,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ): unknown;
}

interface TargetApi {
  findWindowW(className: string, windowName: string | null): unknown;
  coInitializeEx(reserved: null, flags: number): unknown;
  coUninitialize(): void;
  coCreateInstance(
    clsid: Buffer,
    outer: null,
    context: number,
    iid: Buffer,
    instance: Buffer,
  ): unknown;
  sysAllocString(value: string): unknown;
  variantClear(value: Buffer): unknown;
}

interface TargetTypes {
  variant: TypeObject;
  rect: TypeObject;
  release: TypeObject;
  elementFromHandle: TypeObject;
  createPropertyCondition: TypeObject;
  findAll: TypeObject;
  getCurrentIsOffscreen: TypeObject;
  getCurrentBoundingRectangle: TypeObject;
  arrayGetLength: TypeObject;
  arrayGetElement: TypeObject;
}

interface TargetResolver {
  resolve(aumid: string): Rect | null;
  dispose(): void;
}

interface BridgeApi {
  attach(hwnd: bigint, notificationMessage: number): number;
  detach(hwnd: bigint): number;
  setBypass(hwnd: bigint, delta: number): number;
}

interface Attachment {
  hwnd: bigint;
  bridge: BridgeApi;
  api: WindowApi;
  resolver: TargetResolver | null;
  handler: ((intent: WindowIntent) => void) | null;
  hooked: boolean;
  disposed: boolean;
  onError: (code: string) => void;
}

let active: Attachment | null = null;
let targetSurface: { api: TargetApi; types: TargetTypes } | null = null;
// One process-wide bridge: koffi loads the DLL once and every attachment reuses the same
// three exported functions, so a re-attach never re-loads or re-declares the library.
let bridgeSurface: BridgeApi | null = null;
// Same rule for the ordinary user32/dwmapi geometry calls: declared once per process.
let windowSurface: WindowApi | null = null;

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function report(onError: (code: string) => void, code: string): void {
  try {
    onError(code);
  } catch {
    return;
  }
}

function loadKoffi(): KoffiModule | null {
  // Bundled CJS keeps a real require: koffi is marked --external, so the runtime
  // require resolves it from the packaged app's own dependency, never from a dev path.
  try {
    return require("koffi") as KoffiModule;
  } catch {
    return null;
  }
}

function loadWindowApi(koffi: KoffiModule): WindowApi {
  if (windowSurface) return windowSurface;
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  windowSurface = {
    dwmSetWindowAttribute: dwmapi.func("__stdcall", "DwmSetWindowAttribute", "int32", [
      "uintptr",
      "uint32",
      "void *",
      "uint32",
    ]),
    getWindowRect: user32.func("__stdcall", "GetWindowRect", "int32", ["uintptr", "void *"]),
    setWindowPos: user32.func("__stdcall", "SetWindowPos", "int32", [
      "uintptr",
      "uintptr",
      "int32",
      "int32",
      "int32",
      "int32",
      "uint32",
    ]),
  };
  return windowSurface;
}

function bridgeLibraryPath(): string {
  const appPath = app.getAppPath();
  // A packaged app runs from resources/app.asar, so the compiled bridge sits in the
  // sibling unpacked tree. An unbundled app keeps it under <appPath>/native. No search
  // path and no development-tree fallback: a missing DLL is a reported failure.
  if (appPath.endsWith(".asar"))
    return path.join(`${appPath}.unpacked`, "native", "window-proc-bridge.dll");
  return path.join(appPath, "native", "window-proc-bridge.dll");
}

function loadBridge(koffi: KoffiModule): BridgeApi | null {
  if (bridgeSurface) return bridgeSurface;
  try {
    const library = koffi.load(bridgeLibraryPath());
    const attachBridge = library.func("__cdecl", "bridge_attach", "int", ["uintptr", "uint32"]);
    const detachBridge = library.func("__cdecl", "bridge_detach", "int", ["uintptr"]);
    const setBridgeBypass = library.func("__cdecl", "bridge_set_bypass", "int", ["uintptr", "int"]);
    bridgeSurface = {
      attach: (hwnd, notificationMessage) => toNumber(attachBridge(hwnd, notificationMessage)),
      detach: (hwnd) => toNumber(detachBridge(hwnd)),
      setBypass: (hwnd, delta) => toNumber(setBridgeBypass(hwnd, delta)),
    };
  } catch {
    // Nothing replaces the native window procedure: without the DLL the motion surface is
    // simply not attached. The failure is not cached, so a later attempt can still load.
    return null;
  }
  return bridgeSurface;
}

// The notification carries one masked SC_* command; anything else is ignored, so a stray
// WM_APP from another owner can never drive the motion controller.
function notifyIntent(wParam: Buffer): WindowIntent | null {
  if (wParam.length < 4) return null;
  const code = wParam.length >= 8 ? Number(wParam.readBigUInt64LE(0)) : wParam.readUInt32LE(0);
  const command = code & SC_COMMAND_MASK;
  if (command === SC_MINIMIZE) return "minimize";
  if (command === SC_MAXIMIZE) return "maximize";
  if (command === SC_RESTORE) return "restore";
  return null;
}

function setBridgeBypass(attachment: Attachment, delta: number): void {
  try {
    const depth = attachment.bridge.setBypass(attachment.hwnd, delta);
    if (depth < 0) report(attachment.onError, `WINDOW_HOOK_BYPASS_FAILED_${depth}`);
  } catch {
    report(
      attachment.onError,
      delta > 0 ? "WINDOW_HOOK_BYPASS_ENTER_FAILED" : "WINDOW_HOOK_BYPASS_LEAVE_FAILED",
    );
  }
}

function detachBridgeRecord(attachment: Attachment): number {
  try {
    return attachment.bridge.detach(attachment.hwnd);
  } catch {
    return BRIDGE_CALL_FAILED;
  }
}

// The Electron message hook is plain JS-side API, never FFI. A destroyed window already
// dropped its hooks, so the call is skipped rather than thrown.
function removeHook(win: BrowserWindow, attachment: Attachment): void {
  if (!attachment.hooked) return;
  attachment.hooked = false;
  try {
    if (!win.isDestroyed()) win.unhookWindowMessage(BRIDGE_NOTIFY_MESSAGE);
  } catch {
    report(attachment.onError, "WINDOW_UNHOOK_FAILED");
  }
}

function loadTargetApi(koffi: KoffiModule): TargetApi {
  const user32 = koffi.load("user32.dll");
  const ole32 = koffi.load("ole32.dll");
  const oleaut32 = koffi.load("oleaut32.dll");
  return {
    findWindowW: user32.func("__stdcall", "FindWindowW", "uintptr", ["str16", "str16"]),
    coInitializeEx: ole32.func("__stdcall", "CoInitializeEx", "int32", ["void *", "uint32"]),
    coUninitialize: ole32.func("__stdcall", "CoUninitialize", "void", []),
    coCreateInstance: ole32.func("__stdcall", "CoCreateInstance", "int32", [
      "void *",
      "void *",
      "uint32",
      "void *",
      "void *",
    ]),
    sysAllocString: oleaut32.func("__stdcall", "SysAllocString", "void *", ["str16"]),
    variantClear: oleaut32.func("__stdcall", "VariantClear", "int32", ["void *"]),
  };
}

function loadTargetTypes(koffi: KoffiModule): TargetTypes {
  const variant = koffi.struct({
    vt: "uint16_t",
    wReserved1: "uint16_t",
    wReserved2: "uint16_t",
    wReserved3: "uint16_t",
    bstrVal: "void *",
    unionTail: "uint64_t",
  });
  return {
    variant,
    rect: koffi.struct({
      left: "int32_t",
      top: "int32_t",
      right: "int32_t",
      bottom: "int32_t",
    }),
    release: koffi.proto("__stdcall", "uint32_t", ["void *"]),
    elementFromHandle: koffi.proto("__stdcall", "int32_t", ["void *", "uintptr_t", "void *"]),
    createPropertyCondition: koffi.proto("__stdcall", "int32_t", [
      "void *",
      "int32_t",
      variant,
      "void *",
    ]),
    findAll: koffi.proto("__stdcall", "int32_t", ["void *", "int32_t", "void *", "void *"]),
    getCurrentIsOffscreen: koffi.proto("__stdcall", "int32_t", ["void *", "void *"]),
    getCurrentBoundingRectangle: koffi.proto("__stdcall", "int32_t", ["void *", "void *"]),
    arrayGetLength: koffi.proto("__stdcall", "int32_t", ["void *", "void *"]),
    arrayGetElement: koffi.proto("__stdcall", "int32_t", ["void *", "int32_t", "void *"]),
  };
}

function loadTargetSurface(koffi: KoffiModule): { api: TargetApi; types: TargetTypes } {
  if (!targetSurface) {
    // koffi type registration is process-wide; create it once so a later attachment
    // never re-registers the same struct names.
    targetSurface = { api: loadTargetApi(koffi), types: loadTargetTypes(koffi) };
  }
  return targetSurface;
}

function guidBuffer(guid: string): Buffer {
  const match =
    /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{2})([0-9a-f]{2})-([0-9a-f]{12})$/.exec(
      guid.toLowerCase(),
    );
  if (!match) throw new Error("INVALID_GUID");
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(Number.parseInt(match[1], 16), 0);
  buffer.writeUInt16LE(Number.parseInt(match[2], 16), 4);
  buffer.writeUInt16LE(Number.parseInt(match[3], 16), 6);
  Buffer.from(match[4] + match[5], "hex").copy(buffer, 8);
  Buffer.from(match[6], "hex").copy(buffer, 10);
  return buffer;
}

// vtable slot N sits at byte offset N * 8 on x64; out parameters are transient buffers
// decoded after the call. Every HRESULT is compared in unsigned form.
function callSlot(
  koffi: KoffiModule,
  instance: unknown,
  slot: number,
  prototype: TypeObject,
  args: unknown[],
): number {
  const vtable = koffi.decode(instance, "void *");
  const method = koffi.decode(vtable, slot * 8, "void *");
  return toNumber(koffi.call(method, prototype, ...args));
}

function releaseInstance(koffi: KoffiModule, instance: unknown, release: TypeObject): void {
  try {
    callSlot(koffi, instance, SLOT_RELEASE, release, [instance]);
  } catch {
    return;
  }
}

function uninitialize(api: TargetApi): void {
  try {
    api.coUninitialize();
  } catch {
    return;
  }
}

function decodeRect(koffi: KoffiModule, rect: TypeObject, buffer: Buffer): Rect | null {
  const raw = koffi.decode(buffer, rect) as {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  const width = raw.right - raw.left;
  const height = raw.bottom - raw.top;
  if (!(width > 0 && height > 0)) return null;
  return { x: raw.left, y: raw.top, width, height };
}

function createTargetResolver(
  koffi: KoffiModule,
  api: TargetApi,
  types: TargetTypes,
): TargetResolver | null {
  const init = toNumber(api.coInitializeEx(null, COINIT_APARTMENTTHREADED)) >>> 0;
  // S_OK and S_FALSE both added one apartment reference; anything else added none.
  const ownsApartment = init === S_OK || init === S_FALSE;
  if (!ownsApartment) return null;
  let automation: unknown = null;
  try {
    const instance = Buffer.alloc(8);
    const created = toNumber(
      api.coCreateInstance(
        guidBuffer(CLSID_CUIAUTOMATION),
        null,
        CLSCTX_INPROC_SERVER,
        guidBuffer(IID_IUIAUTOMATION),
        instance,
      ),
    );
    if (created >>> 0 !== S_OK) {
      uninitialize(api);
      return null;
    }
    automation = koffi.decode(instance, "void *");
  } catch {
    uninitialize(api);
    return null;
  }
  if (!automation) {
    uninitialize(api);
    return null;
  }
  let disposed = false;
  return {
    resolve(aumid) {
      if (disposed || !automation) return null;
      let trayElement: unknown = null;
      let condition: unknown = null;
      let elements: unknown = null;
      let element: unknown = null;
      let variant: Buffer | null = null;
      try {
        const trayHandle = toBigInt(api.findWindowW("Shell_TrayWnd", null));
        if (!trayHandle) return null;
        const trayOut = Buffer.alloc(8);
        if (
          callSlot(koffi, automation, SLOT_ELEMENT_FROM_HANDLE, types.elementFromHandle, [
            automation,
            trayHandle,
            trayOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        trayElement = koffi.decode(trayOut, "void *");
        if (!trayElement) return null;
        const bstr = api.sysAllocString(`Appid: ${aumid}`);
        if (!bstr) return null;
        variant = Buffer.alloc(24);
        variant.writeUInt16LE(VT_BSTR, 0);
        variant.writeBigUInt64LE(toBigInt(bstr), 8);
        const conditionOut = Buffer.alloc(8);
        if (
          callSlot(
            koffi,
            automation,
            SLOT_CREATE_PROPERTY_CONDITION,
            types.createPropertyCondition,
            [
              automation,
              UIA_AUTOMATION_ID_PROPERTY_ID,
              koffi.decode(variant, types.variant),
              conditionOut,
            ],
          ) >>>
            0 !==
          S_OK
        )
          return null;
        condition = koffi.decode(conditionOut, "void *");
        if (!condition) return null;
        const elementsOut = Buffer.alloc(8);
        if (
          callSlot(koffi, trayElement, SLOT_ELEMENT_FIND_ALL, types.findAll, [
            trayElement,
            TREE_SCOPE_DESCENDANTS,
            condition,
            elementsOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        elements = koffi.decode(elementsOut, "void *");
        if (!elements) return null;
        const lengthOut = Buffer.alloc(4);
        if (
          callSlot(koffi, elements, SLOT_ARRAY_GET_LENGTH, types.arrayGetLength, [
            elements,
            lengthOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        // Exactly one own taskbar button; zero or many is unavailable, never a guess.
        if (lengthOut.readInt32LE(0) !== 1) return null;
        const elementOut = Buffer.alloc(8);
        if (
          callSlot(koffi, elements, SLOT_ARRAY_GET_ELEMENT, types.arrayGetElement, [
            elements,
            0,
            elementOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        element = koffi.decode(elementOut, "void *");
        if (!element) return null;
        const offscreenOut = Buffer.alloc(4);
        if (
          callSlot(koffi, element, SLOT_ELEMENT_GET_OFFSCREEN, types.getCurrentIsOffscreen, [
            element,
            offscreenOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        if (offscreenOut.readInt32LE(0) !== 0) return null;
        const rectOut = Buffer.alloc(16);
        if (
          callSlot(koffi, element, SLOT_ELEMENT_BOUNDING_RECT, types.getCurrentBoundingRectangle, [
            element,
            rectOut,
          ]) >>>
            0 !==
          S_OK
        )
          return null;
        return decodeRect(koffi, types.rect, rectOut);
      } catch {
        return null;
      } finally {
        // The VARIANT owns the BSTR; VariantClear is the single free and the condition
        // release never double-frees it. Every per-call object is released each resolve().
        if (variant) {
          try {
            api.variantClear(variant);
          } catch {
            // The release path must not throw.
          }
          variant = null;
        }
        if (element) releaseInstance(koffi, element, types.release);
        if (elements) releaseInstance(koffi, elements, types.release);
        if (condition) releaseInstance(koffi, condition, types.release);
        if (trayElement) releaseInstance(koffi, trayElement, types.release);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (automation) releaseInstance(koffi, automation, types.release);
      automation = null;
      if (ownsApartment) uninitialize(api);
    },
  };
}

function disposeAttachment(win: BrowserWindow, attachment: Attachment): void {
  if (attachment.disposed) return;
  attachment.disposed = true;
  attachment.handler = null;
  // Hold one bypass level before the hook goes away, so an intercepted command can never
  // outlive its listener even if the detach below fails. A successful detach clears it.
  if (!win.isDestroyed()) setBridgeBypass(attachment, 1);
  // The Electron hook is removed before the detach: an owned record must never post a
  // notification nobody reads. This is plain Electron API on the main loop, and the
  // controller already deferred teardown out of the close dispatch.
  removeHook(win, attachment);
  // A destroyed window is not an error here: the bridge cleared its own record on
  // WM_NCDESTROY, and bridge_detach then answers the idempotent 0.
  const status = detachBridgeRecord(attachment);
  if (attachment.resolver) {
    attachment.resolver.dispose();
    attachment.resolver = null;
  }
  if (status !== 0) {
    // The chain is still owned (or the call threw): report it, keep the single slot so no
    // second attachment can subclass the same HWND, and never unload the library.
    report(attachment.onError, `WINDOW_HOOK_DETACH_FAILED_${status}`);
    return;
  }
  if (active === attachment) active = null;
}

function attach(
  win: BrowserWindow,
  koffi: KoffiModule,
  onError: (code: string) => void,
): Attachment | null {
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
  if (hwnd === 0n) {
    report(onError, "WINDOW_HANDLE_UNAVAILABLE");
    return null;
  }
  const bridge = loadBridge(koffi);
  if (!bridge) {
    report(onError, "BRIDGE_LIBRARY_UNAVAILABLE");
    return null;
  }
  const attachment: Attachment = {
    hwnd,
    bridge,
    api: loadWindowApi(koffi),
    resolver: null,
    handler: null,
    hooked: false,
    disposed: false,
    onError,
  };
  // The listener exists before the bridge is armed, so no posted notification can fall
  // between the two steps; a failed attach removes it again.
  try {
    win.hookWindowMessage(BRIDGE_NOTIFY_MESSAGE, (wParam) => {
      const intent = notifyIntent(wParam);
      if (!intent) return;
      const handler = attachment.handler;
      if (!handler) {
        // The native side already swallowed the command, so dropping it is a real fault.
        report(attachment.onError, "INTENT_DROPPED_NO_HANDLER");
        return;
      }
      // Nothing runs inside the message hook itself: the controller request is queued on
      // the main loop and re-checked there, so setHandler(null) or dispose() drops it.
      setImmediate(() => {
        if (attachment.disposed || attachment.handler !== handler) return;
        try {
          handler(intent);
        } catch {
          report(attachment.onError, "HANDLER_FAILED");
        }
      });
    });
    attachment.hooked = true;
  } catch {
    report(onError, "WINDOW_HOOK_INSTALL_FAILED");
    return null;
  }
  let status = BRIDGE_CALL_FAILED;
  try {
    status = bridge.attach(hwnd, BRIDGE_NOTIFY_MESSAGE);
  } catch {
    status = BRIDGE_CALL_FAILED;
  }
  if (status !== 0) {
    // Every negative status leaves the WndProc chain untouched, so there is no native
    // state to roll back; the code is reported verbatim for the desktop log.
    removeHook(win, attachment);
    report(onError, `WINDOW_HOOK_INSTALL_FAILED_${status}`);
    return null;
  }
  // Until a handler is installed the bridge is held one level into bypass, so a physical
  // SC_MINIMIZE/MAXIMIZE/RESTORE still reaches the OS. setHandler() owns the transition.
  setBridgeBypass(attachment, 1);
  return attachment;
}

export function attachNativeWindowMotion(
  win: BrowserWindow,
  aumid: string,
  onError: (code: string) => void,
): NativeWindowMotion | null {
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  if (!aumid) {
    report(onError, "AUMID_REQUIRED");
    return null;
  }
  const koffi = loadKoffi();
  if (!koffi) {
    report(onError, "KOFFI_LOAD_FAILED");
    return null;
  }
  if (active) {
    // Single-window app: one live attachment at a time, no registry of past ones. The C
    // bridge owns the HWND and rejects a second attach, so this slot is released only
    // after the bridge confirms the detach.
    report(onError, "NATIVE_ALREADY_ATTACHED");
    return null;
  }
  let attachment: Attachment | null = null;
  try {
    attachment = attach(win, koffi, onError);
  } catch {
    report(onError, "NATIVE_ATTACH_FAILED");
    return null;
  }
  if (!attachment) return null;
  active = attachment;
  const attached = attachment;
  // The controller stays the single close owner. This only releases the attachment when
  // the window is destroyed by any other path; setImmediate keeps the native cleanup off
  // the close and destruction dispatch.
  win.once("closed", () => {
    setImmediate(() => {
      disposeAttachment(win, attached);
    });
  });
  return {
    setHandler(handler) {
      // Interception is armed only while a handler exists: the bridge is held one bypass
      // level when it has none, so null -> handler releases it and handler -> null re-arms
      // the forward path. Only this API moves that level; a repeated value is a no-op.
      const hadHandler = attached.handler !== null;
      const hasHandler = handler !== null;
      attached.handler = handler;
      if (attached.disposed || hadHandler === hasHandler) return;
      setBridgeBypass(attached, hasHandler ? -1 : 1);
    },
    bypass<T>(run: () => T): T {
      // The native counter, not a JS one: enter before the programmatic window action and
      // leave in the finally, so the bridge forwards rather than swallows. A disposed
      // surface owns no record, so no bridge call is made and run() still executes once.
      if (!attached.disposed) setBridgeBypass(attached, 1);
      try {
        return run();
      } finally {
        if (!attached.disposed) setBridgeBypass(attached, -1);
      }
    },
    setTransitionsDisabled(disabled: boolean) {
      if (attached.disposed) return;
      const value = Buffer.alloc(4);
      value.writeInt32LE(disabled ? 1 : 0, 0);
      let result = 0xffffffff;
      try {
        result =
          toNumber(
            attached.api.dwmSetWindowAttribute(
              attached.hwnd,
              DWMWA_TRANSITIONS_FORCEDISABLED,
              value,
              4,
            ),
          ) >>> 0;
      } catch {
        result = 0xffffffff;
      }
      if (result !== S_OK) report(attached.onError, "DWM_TRANSITIONS_FAILED");
    },
    getPhysicalBounds(): Rect | null {
      if (attached.disposed) return null;
      const buffer = Buffer.alloc(16);
      let read = false;
      try {
        read = toNumber(attached.api.getWindowRect(attached.hwnd, buffer)) !== 0;
      } catch {
        read = false;
      }
      if (!read) {
        report(attached.onError, "PLACEMENT_READ_FAILED");
        return null;
      }
      // GetWindowRect writes RECT {left, top, right, bottom} as four int32 values.
      const left = buffer.readInt32LE(0);
      const top = buffer.readInt32LE(4);
      return {
        x: left,
        y: top,
        width: buffer.readInt32LE(8) - left,
        height: buffer.readInt32LE(12) - top,
      };
    },
    setPhysicalBounds(rect: Rect): boolean {
      if (attached.disposed) return false;
      let applied = false;
      try {
        applied =
          toNumber(
            attached.api.setWindowPos(
              attached.hwnd,
              0n,
              rect.x,
              rect.y,
              rect.width,
              rect.height,
              SWP_NOZORDER | SWP_NOACTIVATE,
            ),
          ) !== 0;
      } catch {
        applied = false;
      }
      if (!applied) report(attached.onError, "PLACEMENT_RESTORE_FAILED");
      return applied;
    },
    resolveTarget(): Rect | null {
      if (attached.disposed) return null;
      let resolver = attached.resolver;
      if (!resolver) {
        try {
          const surface = loadTargetSurface(koffi);
          resolver = createTargetResolver(koffi, surface.api, surface.types);
        } catch {
          resolver = null;
        }
        if (!resolver) {
          report(attached.onError, "TARGET_RESOLVER_FAILED");
          return null;
        }
        attached.resolver = resolver;
      }
      const rect = resolver.resolve(aumid);
      if (!rect) report(attached.onError, "TARGET_UNAVAILABLE");
      return rect;
    },
    dispose() {
      disposeAttachment(win, attached);
    },
  };
}
