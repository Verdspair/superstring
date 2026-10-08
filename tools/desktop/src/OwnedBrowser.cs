using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace Superstring.Desktop
{
    /// <summary>An isolated application window; its process, not a page connection, owns closing.</summary>
    internal sealed class OwnedBrowser : IDisposable
    {
        private readonly Process _process;
        private IntPtr _window;
        private IntPtr _windowEvents;
        private WindowEvent _windowCallback;
        private OwnedBrowser(Process process) { _process = process; }
        public bool HasExited { get { return _process.HasExited; } }

        public static OwnedBrowser Start(string url, string stateDirectory)
        {
            string[] candidates = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            string executable = Array.Find(candidates, File.Exists);
            if (executable == null) throw new InvalidOperationException("找不到 Microsoft Edge，无法打开独立应用窗口。");
            string profile = Path.Combine(stateDirectory, "browser-host");
            Directory.CreateDirectory(profile);
            var info = new ProcessStartInfo {
                FileName = executable,
                Arguments = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --disable-background-mode",
                UseShellExecute = false,
                CreateNoWindow = true
            };
            return new OwnedBrowser(Process.Start(info));
        }

        public bool Focus()
        {
            if (_process.HasExited) return false;
            _process.Refresh();
            IntPtr handle = _process.MainWindowHandle;
            if (handle == IntPtr.Zero || !IsOwnedWindow(handle)) return false;
            ShowWindow(handle, 9);
            SetForegroundWindow(handle);
            return IsOwnedWindow(handle) && IsWindowVisible(handle);
        }

        private bool IsOwnedWindow(IntPtr handle)
        {
            if (handle == IntPtr.Zero || !IsWindow(handle)) return false;
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            return processId == unchecked((uint)_process.Id);
        }

        public void OnExit(Action closed)
        {
            _process.EnableRaisingEvents = true;
            _process.Exited += (s, e) => closed();
            if (_process.HasExited) closed();
        }

        public void WatchWindowClose(Action closed)
        {
            _windowCallback = (hook, eventType, hwnd, objectId, childId, thread, time) =>
            {
                if (objectId != 0 || childId != 0 || hwnd == IntPtr.Zero) return;
                if (eventType == 0x8002 && _window == IntPtr.Zero && IsOwnedWindow(hwnd)
                    && GetAncestor(hwnd, 2) == hwnd && IsWindowVisible(hwnd))
                {
                    _process.Refresh();
                    if (_process.MainWindowHandle == hwnd) _window = hwnd;
                }
                if (eventType == 0x8001 && hwnd == _window) closed();
            };
            _windowEvents = SetWinEventHook(0x8001, 0x8002, IntPtr.Zero, _windowCallback,
                unchecked((uint)_process.Id), 0, 0);
            if (_windowEvents == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            _process.Refresh();
            IntPtr current = _process.MainWindowHandle;
            if (current != IntPtr.Zero && IsOwnedWindow(current) && IsWindowVisible(current)) _window = current;
        }

        public void Close()
        {
            if (_process.HasExited) return;
            _process.Refresh();
            _process.CloseMainWindow();
        }

        public void Dispose()
        {
            if (_windowEvents != IntPtr.Zero) { UnhookWinEvent(_windowEvents); _windowEvents = IntPtr.Zero; }
            _process.Dispose();
        }
        private delegate void WindowEvent(IntPtr hook, uint eventType, IntPtr window, int objectId,
            int childId, uint threadId, uint time);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWinEventHook(uint minimum, uint maximum, IntPtr module,
            WindowEvent callback, uint processId, uint threadId, uint flags);
        [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    }
}
