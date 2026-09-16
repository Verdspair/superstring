using System.Diagnostics;

namespace Superstring.Desktop
{
    /// <summary>
    /// Stops only the Process handle created by this launcher. The server owns
    /// cancellation, persistence and SQLite closure; do not hard-kill it on a timer.
    /// Desktop preflight uses --no-build and has no Vite descendant to clean up.
    /// </summary>
    internal static class ProcessTree
    {
        public static void StopOwnedServer(Process server, string baseUrl, string token, Logger log)
        {
            if (server == null || server.HasExited) return;
            Readiness.PostStop(baseUrl, token, 5000);
            if (server.WaitForExit(8000)) return;
            if (log != null) log.Warn("服务仍在收尾；等待安全退出，不强杀可能正在写入的数据。");
            // Startup failure with no usable stop endpoint is bounded by the
            // server's 120-second initial-page window, not PID-based termination.
            server.WaitForExit();
        }
    }
}
