using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Superstring.Desktop
{
    /// <summary>
    /// Headless Windows host for the Electron desktop. It owns one project root:
    /// a named-slot SingleInstance claim (the existing mutex/pipe identity), one Job
    /// Object shared with the Electron child and its sidecar, and nothing else.
    /// There is no WinForms UI and no browser: the visible window belongs to Electron.
    /// </summary>
    internal static class DesktopHost
    {
        private const int ExitConfig = 2;
        private const int ExitSpawn = 3;
        private static readonly object LogLock = new object();
        private static string _logPath;

        public static int Main(string[] args)
        {
            ProcessEnvironment.NormalizeCurrentProcess();
            string hostDir = Path.GetDirectoryName(Path.GetFullPath(typeof(DesktopHost).Assembly.Location));
            if (Array.IndexOf(args, "--check-package") >= 0) {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                try {
                    var package = DesktopLayout.ResolveInstalled(hostDir);
                    Console.WriteLine("PACKAGE_OK root=" + package.Root + " state=" + package.StateDirectory + " logs=" + package.LogDirectory);
                    return 0;
                } catch (Exception error) {
                    Console.WriteLine("PACKAGE_REJECTED " + error.Message);
                    return 1;
                }
            }
            string configPath = null;
            var forward = new List<string>();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i].StartsWith("--desktop-host-config="))
                {
                    configPath = args[i].Substring("--desktop-host-config=".Length);
                    if (!Path.IsPathRooted(configPath)) { Console.Error.WriteLine("DESKTOP_HOST_CONFIG_REQUIRES_ABSOLUTE_PATH"); return ExitConfig; }
                    continue;
                }
                if (args[i] == "--desktop-host-config")
                {
                    if (i + 1 >= args.Length) { Console.Error.WriteLine("DESKTOP_HOST_CONFIG_REQUIRES_PATH"); return ExitConfig; }
                    configPath = args[++i];
                    if (!Path.IsPathRooted(configPath)) { Console.Error.WriteLine("DESKTOP_HOST_CONFIG_REQUIRES_ABSOLUTE_PATH"); return ExitConfig; }
                    continue;
                }
                if (args[i].StartsWith("--desktop-host-")) { Console.Error.WriteLine("DESKTOP_HOST_ARGUMENT_INVALID"); return ExitConfig; }
                forward.Add(args[i]);
            }
            if (configPath == null) configPath = Path.Combine(hostDir, "app", "desktop-host.json");
            _logPath = Path.Combine(hostDir, "logs", "desktop-host.log");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
            }
            catch { _logPath = null; }

            HostConfig config;
            try
            {
                config = HostConfig.Load(configPath);
            }
            catch (Exception error)
            {
                Log("CONFIG_INVALID " + error.Message);
                Console.Error.WriteLine("DESKTOP_HOST_CONFIG_INVALID: " + error.Message);
                return ExitConfig;
            }
            Log("start hostPid=" + Process.GetCurrentProcess().Id + " root=" + config.ProjectRoot
                + " electron=" + config.ElectronExecutable + " args=" + string.Join(" ", forward.ToArray()));

            var single = new SingleInstance();
            if (!single.TryAcquire(config.ProjectRoot))
            {
                // The same project root already owns the window. Reuse the existing pipe
                // protocol so the live instance (new host or the legacy launcher) reveals
                // itself instead of a second Electron competing for the same profile.
                ExistingInstanceResult result = single.NotifyExisting();
                Log("second-instance result=" + result);
                single.Release();
                return result == ExistingInstanceResult.Shown ? 0 : ExitSpawn;
            }
            MaintenanceLease runtimeLease = null;
            try {
                if (config.Installed) {
                    runtimeLease = MaintenanceLease.Acquire(config.ProjectRoot, false);
                    var installedLayout = DesktopLayout.ResolveInstalled(config.ProjectRoot);
                    installedLayout.PrepareInstalledStorage();
                }
            } catch (Exception error) {
                Log("INSTALLED_PREFLIGHT_FAILED " + error.Message);
                if (runtimeLease != null) runtimeLease.Dispose();
                single.Release();
                return ExitConfig;
            }
            single.StartPipeServer(() => Reveal(config, forward));

            DesktopProcesses processes = null;
            int exitCode = ExitSpawn;
            try
            {
                processes = new DesktopProcesses();
                var start = new ProcessStartInfo
                {
                    FileName = config.ElectronExecutable,
                    WorkingDirectory = Path.GetDirectoryName(config.ElectronExecutable),
                    UseShellExecute = false,
                };
                foreach (string argument in forward) start.Arguments += (start.Arguments.Length == 0 ? "" : " ") + Quote(argument);
                start.EnvironmentVariables.Remove("SUPERSTRING_DESKTOP_PROJECT_ROOT");
                start.EnvironmentVariables.Remove("SUPERSTRING_DESKTOP_INSTALL_ROOT");
                start.EnvironmentVariables[config.Installed ? "SUPERSTRING_DESKTOP_INSTALL_ROOT" : "SUPERSTRING_DESKTOP_PROJECT_ROOT"] = config.ProjectRoot;
                Log("launch electron");
                using (Process child = Process.Start(start))
                {
                    if (child == null) throw new InvalidOperationException("SPAWN_RETURNED_NULL");
                    Log("electron pid=" + child.Id);
                    child.WaitForExit();
                    Log("electron exit=" + child.ExitCode);
                    exitCode = child.ExitCode;
                }
            }
            catch (Exception error)
            {
                Log("SPAWN_FAILED " + error);
                Console.Error.WriteLine("DESKTOP_HOST_SPAWN_FAILED: " + error.Message);
                exitCode = ExitSpawn;
            }
            if (runtimeLease != null) runtimeLease.Dispose();
            single.Release();
            // The host is a job member so descendants inherit ownership without a spawn gap.
            // Terminate with the known result; closing the self-owned job would replace it.
            if (processes != null) processes.Terminate(exitCode);
            return exitCode;
        }

        /// <summary>Second launch of the same root: ask Electron's own single-instance lock
        /// to reveal the live window, then exit. A non-zero/failed launch means the live
        /// instance cannot be reached and the caller must not claim it was shown.</summary>
        private static ExistingInstanceResult Reveal(HostConfig config, List<string> forward)
        {
            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = config.ElectronExecutable,
                    WorkingDirectory = Path.GetDirectoryName(config.ElectronExecutable),
                    UseShellExecute = false,
                };
                start.Arguments = string.Join(" ", forward.ConvertAll(Quote).ToArray());
                start.EnvironmentVariables.Remove("SUPERSTRING_DESKTOP_PROJECT_ROOT");
                start.EnvironmentVariables.Remove("SUPERSTRING_DESKTOP_INSTALL_ROOT");
                start.EnvironmentVariables[config.Installed ? "SUPERSTRING_DESKTOP_INSTALL_ROOT" : "SUPERSTRING_DESKTOP_PROJECT_ROOT"] = config.ProjectRoot;
                using (Process child = Process.Start(start))
                {
                    if (child == null) return ExistingInstanceResult.Unavailable;
                    if (!child.WaitForExit(10000)) return ExistingInstanceResult.Unavailable;
                    Log("reveal exit=" + child.ExitCode);
                    return child.ExitCode == 0 ? ExistingInstanceResult.Shown : ExistingInstanceResult.Unavailable;
                }
            }
            catch (Exception error)
            {
                Log("REVEAL_FAILED " + error.Message);
                return ExistingInstanceResult.Unavailable;
            }
        }

        private static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            var text = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') text.Append('\\', slashes * 2 + 1);
                else text.Append('\\', slashes);
                slashes = 0;
                text.Append(c);
            }
            text.Append('\\', slashes * 2);
            return text.Append('"').ToString();
        }

        internal static void Log(string message)
        {
            if (_logPath == null) return;
            try
            {
                lock (LogLock)
                {
                    File.AppendAllText(_logPath, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                        + " " + message + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        private sealed class HostConfig
        {
            public int SchemaVersion;
            public bool Installed;
            public string ProjectRoot;
            public string ElectronExecutable;

            public static HostConfig Load(string file)
            {
                string text = File.ReadAllText(file, Encoding.UTF8);
                var map = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
                if (map == null) throw new InvalidDataException("desktop-host.json is not an object");
                var config = new HostConfig();
                config.SchemaVersion = ReadInt(map, "schemaVersion");
                if (config.SchemaVersion != 1)
                    throw new InvalidDataException("unsupported schemaVersion " + config.SchemaVersion);
                object installed;
                config.Installed = map.TryGetValue("installed", out installed) && installed is bool && (bool)installed;
                string declaredRoot = ReadString(map, "projectRoot");
                if (config.Installed && !Path.IsPathRooted(declaredRoot)) declaredRoot = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)), declaredRoot));
                config.ProjectRoot = CanonicalDirectory(declaredRoot, "projectRoot");
                config.ElectronExecutable = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(file)), ReadString(map, "electronExecutable")));
                if (!File.Exists(config.ElectronExecutable))
                    throw new FileNotFoundException("electronExecutable does not exist: " + config.ElectronExecutable);
                return config;
            }

            private static string CanonicalDirectory(string value, string name)
            {
                if (value.Length == 0 || !Path.IsPathRooted(value))
                    throw new InvalidDataException(name + " must be an absolute path");
                string full = Path.GetFullPath(value).TrimEnd('\\', '/');
                if (!Directory.Exists(full))
                    throw new DirectoryNotFoundException(name + " does not exist: " + full);
                return full;
            }

            private static string ReadString(Dictionary<string, object> map, string key)
            {
                object value;
                if (!map.TryGetValue(key, out value) || value == null) return "";
                return Convert.ToString(value);
            }

            private static int ReadInt(Dictionary<string, object> map, string key)
            {
                object value;
                if (!map.TryGetValue(key, out value) || value == null) return 0;
                return Convert.ToInt32(value);
            }
        }
    }
}
