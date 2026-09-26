using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Superstring.Desktop
{
    // Native read-only consumer. Tables are generated from the web sources.
    internal static class DesktopAppearance
    {
        private const string FileName = "desktop-appearance.json";
        internal sealed class ResolvedPalette
        {
            public Color Surface, Text, Muted, Deep, Line, Soft, Accent;
            public bool IsDark;
        }
        public static bool IsThemeId(string id)
        {
            for (int i = 0; i < DesktopPaletteData.Themes.GetLength(0); i++)
                if (DesktopPaletteData.Themes[i, 0] == id) return true;
            return false;
        }
        public static bool IsModeId(string id)
        {
            foreach (string mode in DesktopPaletteData.Modes) if (mode == id) return true;
            return false;
        }
        public static void LoadSnapshot(string stateDir, out string theme, out string mode)
        {
            theme = "slate"; mode = "system";
            try
            {
                using (var stream = new FileStream(Path.Combine(stateDir, FileName), FileMode.Open,
                    FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Length > 4096) return;
                    var bytes = new byte[4097];
                    int count = 0, read;
                    while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) > 0) count += read;
                    if (count > 4096) return;
                    string json = new UTF8Encoding(false, true).GetString(bytes, 0, count);
                    var parser = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
                    var data = parser.DeserializeObject(json) as Dictionary<string, object>;
                    if (data == null || data.Count != 3 || !data.ContainsKey("version") ||
                        !data.ContainsKey("theme") || !data.ContainsKey("mode")) return;
                    if (!(data["version"] is int) || (int)data["version"] != 1) return;
                    string t = data["theme"] as string, m = data["mode"] as string;
                    if (!IsThemeId(t) || !IsModeId(m)) return;
                    theme = t; mode = m;
                }
            }
            catch { /* Recover the whole pair, never a half-valid snapshot. */ }
        }
        public static ResolvedPalette Resolve(string themeId, string mode)
        {
            return Resolve(themeId, mode, IsWindowsDark);
        }
        internal static ResolvedPalette Resolve(string themeId, string mode, Func<bool> systemDark)
        {
            bool dark = mode == "dark" || (mode != "light" && systemDark());
            var p = DesktopPaletteData.Base(dark);
            int index = 0;
            for (int i = 0; i < DesktopPaletteData.Themes.GetLength(0); i++)
                if (DesktopPaletteData.Themes[i, 0] == themeId) { index = i; break; }
            // The web applies shared theme colors to primary/ring for every
            // theme, including slate. Borders and muted surfaces stay neutral.
            Color tone = ColorTranslator.FromHtml(DesktopPaletteData.Themes[index, dark ? 2 : 1]);
            p.Deep = tone; p.Accent = tone;
            return p;
        }
        public static bool IsWindowsDark()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object value = key == null ? null : key.GetValue("AppsUseLightTheme");
                    return value is int && (int)value == 0;
                }
            }
            catch { return false; }
        }
        public static IDisposable Watch(string stateDir, Action<string, string> onChange)
        {
            return new AppearanceWatcher(stateDir, onChange);
        }
        private sealed class AppearanceWatcher : IDisposable
        {
            private readonly FileSystemWatcher _watcher;
            private readonly Timer _timer;
            private readonly object _gate = new object();
            private readonly string _stateDir;
            private readonly Action<string, string> _onChange;
            private bool _disposed;
            internal AppearanceWatcher(string stateDir, Action<string, string> onChange)
            {
                _stateDir = Path.GetFullPath(stateDir); _onChange = onChange;
                string existing = _stateDir;
                while (!Directory.Exists(existing))
                {
                    existing = Path.GetDirectoryName(existing);
                    if (string.IsNullOrEmpty(existing)) throw new DirectoryNotFoundException(stateDir);
                }
                _timer = new Timer(ReadLatest, null, Timeout.Infinite, Timeout.Infinite);
                _watcher = new FileSystemWatcher(existing, "*");
                _watcher.IncludeSubdirectories = true;
                _watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName;
                _watcher.Changed += Changed;
                _watcher.Created += Changed;
                _watcher.Deleted += Changed;
                _watcher.Renamed += Renamed;
                _watcher.Error += (s, e) => Schedule();
                _watcher.EnableRaisingEvents = true;
                Schedule();
            }
            private bool Relevant(string file)
            {
                return string.Equals(file, Path.Combine(_stateDir, FileName), StringComparison.OrdinalIgnoreCase)
                    || string.Equals(file, _stateDir, StringComparison.OrdinalIgnoreCase);
            }
            private void Changed(object sender, FileSystemEventArgs e) { if (Relevant(e.FullPath)) Schedule(); }
            private void Renamed(object sender, RenamedEventArgs e) { if (Relevant(e.FullPath) || Relevant(e.OldFullPath)) Schedule(); }
            private void Schedule()
            {
                lock (_gate) { if (!_disposed) _timer.Change(120, Timeout.Infinite); }
            }
            private void ReadLatest(object state)
            {
                lock (_gate)
                {
                    if (_disposed) return;
                    string theme, mode;
                    LoadSnapshot(_stateDir, out theme, out mode);
                    try { _onChange(theme, mode); } catch { }
                }
            }
            public void Dispose()
            {
                lock (_gate)
                {
                    if (_disposed) return;
                    _disposed = true;
                    _watcher.Dispose();
                    _timer.Dispose();
                }
            }
        }
    }
}
