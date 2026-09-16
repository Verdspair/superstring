using System;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace Superstring.Desktop
{
    /// <summary>
    /// Single-instance ownership for the desktop launcher.
    ///
    /// Identity is derived from a NORMALISED hash of the project root, never from a
    /// port probe. A named Mutex claims ownership; a NamedPipe lets a second launch
    /// ask the already-running instance to reveal its panel / open the browser
    /// instead of starting a competing service (which would wrongly assume a
    /// stranger on the port belongs to us).
    /// </summary>
    internal sealed class SingleInstance
    {
        private Mutex _mutex;
        public bool IsFirst { get; private set; }
        public string MutexName { get; private set; }
        public string PipeName { get; private set; }

        public bool TryAcquire(string projectRoot)
        {
            string hash = RootHash(projectRoot);
            MutexName = "Local\\superstring-desktop-" + hash;
            PipeName = "superstring-desktop-pipe-" + hash;

            bool created;
            _mutex = new Mutex(true, MutexName, out created);
            IsFirst = created;
            // If not created, another instance already owns the kernel object.
            if (!created)
            {
                try { _mutex.Close(); } catch { }
                _mutex = null;
            }
            return IsFirst;
        }

        public void Release()
        {
            try { if (_mutex != null) { _mutex.ReleaseMutex(); _mutex.Close(); } } catch { }
        }

        public void NotifyExisting()
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    client.Connect(2000);
                    byte[] msg = Encoding.UTF8.GetBytes("show");
                    client.Write(msg, 0, msg.Length);
                    client.Flush();
                }
            }
            catch
            {
                // If the pipe isn't reachable we simply don't surface a second window.
            }
        }

        public void StartPipeServer(Action onShow)
        {
            Thread t = new Thread(() => PipeLoop(onShow));
            t.IsBackground = true;
            t.Start();
        }

        private void PipeLoop(Action onShow)
        {
            while (true)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(PipeName, PipeDirection.In))
                    {
                        server.WaitForConnection();
                        var buf = new byte[64];
                        while (server.Read(buf, 0, buf.Length) > 0) { }
                        if (onShow != null) onShow();
                    }
                }
                catch
                {
                    Thread.Sleep(500);
                }
            }
        }

        public static string RootHash(string root)
        {
            string norm = root.ToLowerInvariant().Replace('\\', '/').TrimEnd('/');
            using (var sha = SHA256.Create())
            {
                byte[] b = sha.ComputeHash(Encoding.UTF8.GetBytes(norm));
                var sb = new StringBuilder();
                for (int i = 0; i < 8; i++) sb.Append(b[i].ToString("x2"));
                return sb.ToString();
            }
        }
    }
}
