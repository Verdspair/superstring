/* SPDX-License-Identifier: MIT */
/*
 * Own-window WndProc bridge for the Windows desktop motion surface.
 *
 * The whole window procedure stays in C: while not bypassed it swallows only
 * SC_MINIMIZE / SC_MAXIMIZE / SC_RESTORE, posts one private message to the same HWND, and
 * forwards everything else (SC_CLOSE included) to the original proc. Koffi calls the three
 * exports from main-loop JS only, so no JS/V8/FFI code ever runs inside an OS callback.
 *
 * One owned HWND, one static record. No queue, cache, persistence, allocation, CRT, or
 * logging. user32 + kernel32 only. All calls must be on the window's GUI thread.
 *
 * Exports (x64; __cdecl and WINAPI share the x64 ABI; HWND travels as void *):
 *   int bridge_attach(void *hwnd, unsigned int notificationMessage)
 *   int bridge_detach(void *hwnd)
 *   int bridge_set_bypass(void *hwnd, int enabled)   -> current depth (>= 0)
 *
 * bridge_attach/bridge_detach: 0 ok; -1 invalid window; -2 already attached;
 * -3 window-proc read/write failed; -4 notification outside WM_APP..0xBFFF;
 * -5 wrong thread; -6 WndProc chain mismatch (restored); -7 no such attachment;
 * -8 current proc is not the bridge (third-party subclass; record kept);
 * -9 restore failed (record kept).
 * bridge_set_bypass: enabled is a relative depth delta (+1 enter, -1 leave); leaving
 * clamps at 0. Returns the new depth, or a negative status.
 */
#include <windows.h>

#define BRIDGE_NOTIFY_MIN WM_APP
#define BRIDGE_NOTIFY_MAX 0xBFFF

typedef struct {
  HWND hwnd;
  WNDPROC originalProc;
  int bypassDepth;
  UINT notifyMsg;
} BridgeRecord;

static BridgeRecord g_bridge;

static int bridge_same_thread(HWND hwnd) {
  DWORD threadId;
  if (hwnd == NULL) return 0;
  threadId = GetWindowThreadProcessId(hwnd, NULL);
  return threadId != 0 && threadId == GetCurrentThreadId();
}

/* SetLastError(0) first: Set/GetWindowLongPtrW returns 0 both for a real zero and for
 * failure, so the error code is the only truthful discriminator. */
static int bridge_read_proc(HWND hwnd, LONG_PTR *out) {
  LONG_PTR value;
  SetLastError(0);
  value = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
  if (value == 0 && GetLastError() != 0) return 0;
  *out = value;
  return value != 0;
}

static int bridge_write_proc(HWND hwnd, LONG_PTR value, LONG_PTR *previous) {
  SetLastError(0);
  *previous = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, value);
  if (*previous == 0 && GetLastError() != 0) return 0;
  return 1;
}

static void bridge_clear(void) {
  g_bridge.hwnd = NULL;
  g_bridge.originalProc = NULL;
  g_bridge.bypassDepth = 0;
  g_bridge.notifyMsg = 0;
}

static LRESULT CALLBACK bridge_wndproc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  WNDPROC original = g_bridge.originalProc;
  int owned = g_bridge.hwnd == hwnd;
  if (original == NULL) return DefWindowProcW(hwnd, message, wParam, lParam);

  if (message == WM_NCDESTROY && owned) {
    LONG_PTR current = 0;
    LONG_PTR previous = 0;
    if (bridge_read_proc(hwnd, &current) && current == (LONG_PTR)bridge_wndproc)
      bridge_write_proc(hwnd, (LONG_PTR)original, &previous); /* restore original FIRST */
    {
      LRESULT result = CallWindowProcW(original, hwnd, message, wParam, lParam);
      bridge_clear(); /* clear AFTER forwarding; the window is gone */
      return result;
    }
  }

  if (message == WM_SYSCOMMAND && owned && g_bridge.bypassDepth == 0) {
    UINT command = (UINT)wParam & 0xFFF0u;
    if (g_bridge.notifyMsg != 0 &&
        (command == SC_MINIMIZE || command == SC_MAXIMIZE || command == SC_RESTORE)) {
      if (PostMessageW(hwnd, g_bridge.notifyMsg, (WPARAM)command, lParam)) return 0;
      /* Post failed: forward, so the user's native click is never silently swallowed. */
    }
  }
  return CallWindowProcW(original, hwnd, message, wParam, lParam);
}

__declspec(dllexport) int __cdecl bridge_attach(void *rawHwnd, unsigned int notificationMessage) {
  HWND hwnd = (HWND)rawHwnd;
  LONG_PTR original = 0;
  LONG_PTR previous = 0;
  LONG_PTR current = 0;
  if (g_bridge.hwnd != NULL) return -2; /* one own HWND only; reject a second attach */
  if (hwnd == NULL || !IsWindow(hwnd)) return -1;
  if (!bridge_same_thread(hwnd)) return -5;
  if (notificationMessage < BRIDGE_NOTIFY_MIN || notificationMessage > BRIDGE_NOTIFY_MAX) return -4;
  if (!bridge_read_proc(hwnd, &original)) return -3;
  if (!bridge_write_proc(hwnd, (LONG_PTR)bridge_wndproc, &previous)) return -3;
  if (previous != original ||
      !bridge_read_proc(hwnd, &current) || current != (LONG_PTR)bridge_wndproc) {
    LONG_PTR ignored = 0;
    bridge_write_proc(hwnd, original, &ignored); /* chain moved under us: put it back */
    return -6;
  }
  g_bridge.hwnd = hwnd;
  g_bridge.originalProc = (WNDPROC)original;
  g_bridge.bypassDepth = 0;
  g_bridge.notifyMsg = (UINT)notificationMessage;
  return 0;
}

__declspec(dllexport) int __cdecl bridge_detach(void *rawHwnd) {
  HWND hwnd = (HWND)rawHwnd;
  LONG_PTR current = 0;
  LONG_PTR previous = 0;
  if (g_bridge.hwnd == NULL) return 0; /* idempotent */
  if (hwnd == NULL || hwnd != g_bridge.hwnd) return -7;
  if (!bridge_same_thread(hwnd)) return -5;
  if (!bridge_read_proc(hwnd, &current)) return -3;
  if (current != (LONG_PTR)bridge_wndproc) return -8; /* never overwrite a third-party subclass */
  if (!bridge_write_proc(hwnd, (LONG_PTR)g_bridge.originalProc, &previous)) return -9;
  if (previous != (LONG_PTR)bridge_wndproc) return -9; /* record kept: chain changed mid-call */
  bridge_clear(); /* SetWindowLongPtrW succeeded first; clear the record after */
  return 0;
}

__declspec(dllexport) int __cdecl bridge_set_bypass(void *rawHwnd, int enabled) {
  HWND hwnd = (HWND)rawHwnd;
  if (g_bridge.hwnd == NULL || hwnd == NULL || hwnd != g_bridge.hwnd) return -7;
  if (!bridge_same_thread(hwnd)) return -5;
  if (enabled > 0) {
    g_bridge.bypassDepth += enabled;
  } else if (enabled < 0) {
    g_bridge.bypassDepth += enabled;
    if (g_bridge.bypassDepth < 0) g_bridge.bypassDepth = 0; /* clamp on leave; no queue */
  }
  return g_bridge.bypassDepth;
}
