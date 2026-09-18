using System;
using System.IO;

namespace Superstring.Desktop
{
    /// <summary>
    /// Walks up from the executable to a package.json named "superstring".
    /// Supports dev dist/desktop and installed app layouts without fixed paths.
    /// </summary>
    internal static class ProjectLocator
    {
        public static string ExeDirectory
        {
            get
            {
                // Support both launched EXE and test harness.
                var loc = System.Reflection.Assembly.GetExecutingAssembly().Location;
                return string.IsNullOrEmpty(loc) ? Directory.GetCurrentDirectory() : Path.GetDirectoryName(loc);
            }
        }

        /// <summary>
        /// Walk up looking for a package.json whose "name" is "superstring".
        /// Returns null if not found (caller decides what to do).
        /// </summary>
        public static string FindRoot(string startDir)
        {
            if (string.IsNullOrEmpty(startDir)) return null;
            DirectoryInfo dir = new DirectoryInfo(startDir);
            while (dir != null)
            {
                string pkg = Path.Combine(dir.FullName, "package.json");
                if (File.Exists(pkg) && IsSuperstringPackage(pkg))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
            return null;
        }

        private static bool IsSuperstringPackage(string pkgPath)
        {
            try
            {
                string text = File.ReadAllText(pkgPath);
                // Match the package name without adding a JSON parser dependency.
                int i = text.IndexOf("\"name\"", StringComparison.Ordinal);
                if (i < 0) return false;
                int colon = text.IndexOf(':', i);
                if (colon < 0) return false;
                int q1 = text.IndexOf('"', colon + 1);
                if (q1 < 0) return false;
                int q2 = text.IndexOf('"', q1 + 1);
                if (q2 < 0) return false;
                string name = text.Substring(q1 + 1, q2 - q1 - 1).Trim();
                return name == "superstring";
            }
            catch
            {
                return false;
            }
        }
    }
}
