using System;
using System.IO;

namespace Superstring.Desktop
{
    /// <summary>
    /// Resolves the superstring project root by walking UP from the executable
    /// directory until a package.json with name "superstring" is found. The path is
    /// never hard-coded (no "<repo>"), so the launcher works from any install
    /// location. Dev builds land in &lt;root&gt;/dist/desktop/superstring.exe, the
    /// installed build in &lt;root&gt;/app/superstring.exe; the walk-up below means
    /// neither location is hard-coded.
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
                // Lightweight, allocation-free check: the manifest must contain
                // "name" : "superstring" (whitespace tolerant). We avoid a full JSON
                // parser dependency here.
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
