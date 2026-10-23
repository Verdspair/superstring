using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace HeadlessHostFixture
{
    // Minimal synthetic Electron stand-in for tests/desktop/launcher-failure.test.mjs.
    // It never starts a real Electron, browser, server or service. Every role is
    // selected by an explicit argument, and the parent passes absolute paths only.
    internal static class FakeElectron
    {
        private static int Main(string[] args)
        {
            if (args.Length == 0) return 90;
            switch (args[0])
            {
                case "--exit": return RunExit(args);
                case "--hold": return RunHold(args);
                case "--grandchild": return RunGrandchild(args);
                case "--alive": return RunAlive(args);
                default: return 91;
            }
        }

        // Exits with the requested code after recording the env/config contract.
        private static int RunExit(string[] args)
        {
            int code = int.Parse(args[1]);
            var payload = new StringBuilder();
            payload.Append("{");
            payload.Append("\"role\":\"exit\",");
            payload.Append("\"pid\":" + Process.GetCurrentProcess().Id + ",");
            payload.Append("\"exitCode\":" + code + ",");
            payload.Append("\"projectRoot\":\"" + Escape(Environment.GetEnvironmentVariable("SUPERSTRING_DESKTOP_PROJECT_ROOT")) + "\",");
            payload.Append("\"arguments\":\"" + Escape(string.Join(" ", args)) + "\"");
            payload.Append("}\n");
            File.WriteAllText(args[2], payload.ToString(), new UTF8Encoding(false));
            return code;
        }

        // Starts one grandchild, records both owned pids, then waits to be reaped.
        private static int RunHold(string[] args)
        {
            string pidFile = args[1];
            string marker = args[2];
            string self = Process.GetCurrentProcess().MainModule.FileName;
            string ready = Path.Combine(Path.GetDirectoryName(pidFile), "grandchild-ready.json");
            var start = new ProcessStartInfo();
            start.FileName = self;
            start.Arguments = "--grandchild " + Quote(ready);
            start.UseShellExecute = false;
            start.WorkingDirectory = Path.GetDirectoryName(self);
            Process grandchild = Process.Start(start);
            if (grandchild == null) return 92;
            int grandchildPid = grandchild.Id;
            grandchild.Dispose();
            var payload = new StringBuilder();
            payload.Append("{");
            payload.Append("\"electronPid\":" + Process.GetCurrentProcess().Id + ",");
            payload.Append("\"grandchildPid\":" + grandchildPid + ",");
            payload.Append("\"projectRoot\":\"" + Escape(Environment.GetEnvironmentVariable("SUPERSTRING_DESKTOP_PROJECT_ROOT")) + "\"");
            payload.Append("}\n");
            File.WriteAllText(pidFile, payload.ToString(), new UTF8Encoding(false));
            File.WriteAllText(marker, "holding\n", new UTF8Encoding(false));
            while (true) Thread.Sleep(100);
        }

        private static int RunGrandchild(string[] args)
        {
            string ready = args[1];
            File.WriteAllText(ready,
                "{\"pid\":" + Process.GetCurrentProcess().Id + "}\n", new UTF8Encoding(false));
            while (true) Thread.Sleep(100);
        }

        // GetProcessById scoped to the pid recorded by the synthetic child. Exit 0
        // means alive, 1 means gone. The test never scans process names.
        private static int RunAlive(string[] args)
        {
            int pid = int.Parse(args[1]);
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    return process.HasExited ? 1 : 0;
                }
            }
            catch (ArgumentException) { return 1; }
            catch (InvalidOperationException) { return 1; }
        }

        private static string Quote(string value)
        {
            if (value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0) return value;
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string Escape(string value)
        {
            if (value == null) return "";
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
