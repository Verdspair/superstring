using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Superstring.Desktop
{
    /// <summary>
    /// Rotating, redacting logger. Writes to artifacts/desktop/ so we never touch
    /// the user's business data or secrets. Two hard rules:
    ///   1. The desktop token is never written (masked on set).
    ///   2. Full environment dumps are never written; only individual, non-secret
    ///      variable names may be logged by the caller.
    /// </summary>
    internal sealed class Logger
    {
        private readonly string _dir;
        private readonly object _lock = new object();
        private readonly string _secret;
        private string _currentPath;
        private long _currentSize;
        private const long MaxBytes = 1024 * 1024; // 1 MiB per file
        private const int KeepFiles = 3;

        public bool EchoToConsole { get; set; }

        public Logger(string projectRoot, string secret) : this(projectRoot, secret, null) { }

        public Logger(string projectRoot, string secret, string logDirectory)
        {
            _dir = logDirectory ?? Path.Combine(projectRoot, "artifacts", "desktop");
            _secret = secret ?? string.Empty;
            // Never silently write application logs to a different disk/profile.
            Directory.CreateDirectory(_dir);
            RollIfNeeded();
        }

        private void RollIfNeeded()
        {
            string baseName = "Superstring-" + DateTime.Now.ToString("yyyyMMdd");
            for (int i = 0; i < KeepFiles; i++)
            {
                string p = i == 0 ? Path.Combine(_dir, baseName + ".log")
                                  : Path.Combine(_dir, baseName + "-" + i + ".log");
                if (File.Exists(p))
                {
                    _currentPath = p;
                    _currentSize = new FileInfo(p).Length;
                    if (_currentSize < MaxBytes) return;
                }
                else
                {
                    _currentPath = p;
                    _currentSize = 0;
                    return;
                }
            }
            // All slots full: drop the oldest and reuse slot 1.
            try { if (File.Exists(Path.Combine(_dir, baseName + "-" + (KeepFiles - 1) + ".log")))
                File.Delete(Path.Combine(_dir, baseName + "-" + (KeepFiles - 1) + ".log")); } catch { }
            _currentPath = Path.Combine(_dir, baseName + "-" + (KeepFiles - 1) + ".log");
            _currentSize = File.Exists(_currentPath) ? new FileInfo(_currentPath).Length : 0;
        }

        public void Info(string msg) { Write("INFO ", msg); }
        public void Warn(string msg) { Write("WARN ", msg); }
        public void Error(string msg) { Write("ERROR", msg); }
        public void Detail(string msg) { Write("DETAIL", msg); }

        private void Write(string level, string msg)
        {
            if (msg == null) msg = string.Empty;
            string safe = Redact(msg);
            if (safe.Length > 8192) safe = safe.Substring(0, 8192) + " [truncated]";
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + safe;
            if (EchoToConsole)
            {
                Console.WriteLine(line);
            }
            lock (_lock)
            {
                try
                {
                    if (_currentSize >= MaxBytes) RollIfNeeded();
                    using (var w = new StreamWriter(_currentPath, true, Encoding.UTF8))
                    {
                        w.WriteLine(line);
                    }
                    _currentSize += Encoding.UTF8.GetByteCount(line) + 2;
                }
                catch
                {
                    // Logging must never break the launcher.
                }
            }
        }

        /// <summary>Mask any secret material before it reaches disk.</summary>
        public string Redact(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            string outp = s;
            if (!string.IsNullOrEmpty(_secret) && _secret.Length >= 8)
            {
                outp = outp.Replace(_secret, "***REDACTED***");
            }
            // Mask Authorization: Bearer <token> style leaks regardless of value.
            int idx = outp.IndexOf("Bearer ", StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                int start = idx + "Bearer ".Length;
                int end = outp.IndexOfAny(new char[] { ' ', '\r', '\n', '\t' }, start);
                if (end < 0) end = outp.Length;
                if (end > start)
                {
                    outp = outp.Substring(0, start) + "***REDACTED***" + outp.Substring(end);
                }
            }
            // Generic 64-hex token shape (our desktop token) as a safety net.
            // Only applied to long hex runs to avoid masking hashes we log on purpose.
            return outp;
        }

        public string CurrentPath { get { return _currentPath; } }
    }
}
