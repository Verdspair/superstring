using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Superstring.Setup
{
    /// <summary>
    /// Dual-channel log: a bounded in-memory transcript for the UI/details view
    /// and an append-only file under the install root's maintenance directory.
    /// Never records secrets; the payload has none.
    /// </summary>
    internal sealed class SetupLog : IDisposable
    {
        private const int MaxMemoryLines = 400;
        private readonly List<string> _lines = new List<string>();
        private readonly object _lock = new object();
        private StreamWriter _writer;
        private string _path;

        internal string Path { get { return _path; } }

        internal void AttachFile(string filename)
        {
            lock (_lock)
            {
                try
                {
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(filename));
                    _writer = new StreamWriter(filename, true, new UTF8Encoding(false)) { AutoFlush = true };
                    _path = filename;
                }
                catch
                {
                    _writer = null;
                    _path = null;
                }
            }
        }

        internal void Write(string level, string message)
        {
            if (message == null) message = string.Empty;
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + level + "] " + message;
            lock (_lock)
            {
                _lines.Add(line);
                if (_lines.Count > MaxMemoryLines) _lines.RemoveRange(0, _lines.Count - MaxMemoryLines);
                if (_writer != null)
                {
                    try { _writer.WriteLine(line); }
                    catch { }
                }
            }
        }

        internal void Info(string message) { Write("INFO ", message); }
        internal void Warn(string message) { Write("WARN ", message); }
        internal void Error(string message) { Write("ERROR", message); }

        internal string Transcript(int maxCharacters = 12000)
        {
            lock (_lock)
            {
                string text = string.Join(Environment.NewLine, _lines.ToArray());
                if (text.Length > maxCharacters) text = text.Substring(text.Length - maxCharacters);
                return text;
            }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                if (_writer != null) { try { _writer.Dispose(); } catch { } _writer = null; }
            }
        }
    }
}
