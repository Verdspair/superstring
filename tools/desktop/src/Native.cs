using System;
using System.Runtime.InteropServices;

namespace Superstring.Desktop
{
    /// <summary>
    /// Thin P/Invoke layer for Win11 rounded window corners and explicit DPI
    /// awareness. All calls are best-effort and must never throw into the UI.
    /// </summary>
    internal static class Native
    {
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        public const int DWMWCP_ROUND = 2;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int dwAttribute, ref int pvAttribute, int cbAttribute);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value);

        public static void ApplyRoundedCorners(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                int pref = DWMWCP_ROUND;
                DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4);
            }
            catch
            {
                // Older OS: rounded corners are cosmetic only, ignore.
            }
        }

        public static void SetPerMonitorDpi()
        {
            try
            {
                // 2 == PROCESS_PER_MONITOR_DPI_AWARE (PerMonitorV2 comes from the manifest).
                SetProcessDpiAwareness(2);
            }
            catch
            {
                // Pre-Win8: the dpiAware manifest flag still applies.
            }
        }
    }
}
