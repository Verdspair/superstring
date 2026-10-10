using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    // Test-only substitutes for the launcher's peripheral services. The classes under
    // test (Launcher, MainForm, Readiness, ProcessTree, BunResolver) are compiled from
    // the real product sources at test runtime; nothing here is reachable from product.
    internal enum ExistingInstanceResult { Shown, Unavailable }
    internal static class GlyphRenderer { public static void Draw(Graphics g, Rectangle r, Color c) { } }

    internal static class DesktopAppearance
    {
        internal sealed class ResolvedPalette { public Color Surface, Text, Muted, Deep, Line, Soft, Accent; }
        public static bool IsThemeId(string x) { return x == "slate"; }
        public static bool IsModeId(string x) { return x == "system" || x == "light" || x == "dark"; }
        public static ResolvedPalette Resolve(string a, string b)
        {
            return new ResolvedPalette { Surface = Color.White, Text = Color.Black, Muted = Color.Gray, Deep = Color.DarkBlue, Line = Color.LightGray, Soft = Color.WhiteSmoke, Accent = Color.Blue };
        }
    }

    internal sealed class DesktopLayout
    {
        public bool Installed = true;
        public string Root { get { return Environment.GetEnvironmentVariable("PROBE_DIR"); } }
        public string StateDirectory { get { return Path.Combine(Root, "state"); } }
        // Installed mode serves the probe exe itself; the child becomes the fake parent role.
        public string ServerExecutable { get { return Assembly.GetExecutingAssembly().Location; } }
        public void ConfigureInstalledEnvironment(ProcessStartInfo psi) { psi.EnvironmentVariables["PROBE_ROLE"] = "fake-parent"; }
        public void ValidateInstalledResources() { }
    }

    internal sealed class Logger
    {
        private readonly string _path;
        private readonly object _gate = new object();
        public string CurrentPath { get { return _path; } }
        public Logger(string dir) { _path = Path.Combine(dir, "probe.log"); File.WriteAllText(_path, ""); }
        private void Add(string s) { lock (_gate) File.AppendAllText(_path, DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine); }
        public void Info(string s) { Add("INFO " + s); }
        public void Warn(string s) { Add("WARN " + s); }
        public void Error(string s) { Add("ERROR " + s); }
        public void Detail(string s) { Add("DETAIL " + s); }
    }

    internal sealed class OwnedBrowser : IDisposable
    {
        public bool HasExited { get { return true; } }
        public static OwnedBrowser Start(string u, string d) { throw new InvalidOperationException("Edge is forbidden in the launcher regression probe"); }
        public bool Focus() { return false; }
        public void OnExit(Action a) { }
        public void WatchWindowClose(Action a) { }
        public void Dispose() { }
    }
}
