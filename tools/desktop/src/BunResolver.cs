using System;
using System.Diagnostics;
using System.IO;

namespace Superstring.Desktop
{
    /// <summary>
    /// Resolves the Bun executable without depending on a global install:
    ///   1. SUPERSTRING_BUN_EXE (must exist; a bad value fails loudly)
    ///   2. &lt;root&gt;/node_modules/bun/bin/bun.exe
    ///   3. bun on PATH
    /// The project pins bun 1.4.2 strictly; any other version is rejected.
    /// </summary>
    internal static class BunResolver
    {
        public const string RequiredVersion = "1.4.2";

        public static string Resolve(string projectRoot, out string error)
        {
            error = null;

            string env = Environment.GetEnvironmentVariable("SUPERSTRING_BUN_EXE");
            if (!string.IsNullOrWhiteSpace(env))
            {
                env = env.Trim();
                if (!File.Exists(env))
                {
                    error = "SUPERSTRING_BUN_EXE is set but not found: " + env;
                    return null;
                }
                return env;
            }

            string local = Path.Combine(projectRoot, "node_modules", "bun", "bin", "bun.exe");
            if (File.Exists(local)) return local;

            local = Path.Combine(projectRoot, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe");
            if (File.Exists(local)) return local;
            error = "Project-local Bun is missing. Restore the pinned project dependencies.";
            return null;
        }

        public static bool VersionMatches(string bunExe, out string actual)
        {
            actual = RunVersion(bunExe);
            if (string.IsNullOrEmpty(actual)) return false;
            string a = actual.Trim().TrimStart('v', 'V');
            return a == RequiredVersion;
        }

        private static string RunVersion(string bunExe)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = bunExe,
                    Arguments = "--version",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(psi))
                {
                    if (p == null) return null;
                    var stdout = p.StandardOutput.ReadToEndAsync();
                    var stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(10000)) { p.Kill(); p.WaitForExit(); return null; }
                    if (p.ExitCode != 0) return null;
                    return stdout.Result.Trim();
                }
            }
            catch
            {
                return null;
            }
        }
    }
}
