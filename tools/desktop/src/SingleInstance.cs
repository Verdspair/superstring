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
    internal enum ExistingInstanceResult { Shown, Unavailable }

    internal sealed class SingleInstance
    {
        private Mutex _mutex;
        private volatile bool _released;
        private readonly object _pipeLock = new object();
        private NamedPipeServerStream _activePipe;
        public bool IsFirst { get; private set; }
        public string MutexName { get; private set; }
        public string PipeName { get; private set; }

        public bool TryAcquire(string projectRoot)
        {
            string hash = RootHash(projectRoot);
            MutexName = "Local\\superstring-desktop-" + hash;
            PipeName = "superstring-desktop-pipe-" + hash;
            if (_mutex == null)
            {
                bool created;
                _mutex = new Mutex(true, MutexName, out created);
                if (created) { IsFirst = true; return true; }
            }
            return AcquireCurrentThread();
        }

        private bool AcquireCurrentThread()
        {
            try { IsFirst = _mutex.WaitOne(0); }
            catch (AbandonedMutexException) { IsFirst = true; }
            return IsFirst;
        }

        public void Release()
        {
            _released = true;
            lock (_pipeLock)
            {
                if (_activePipe != null) { try { _activePipe.Dispose(); } catch { } _activePipe = null; }
            }
            try { if (IsFirst && _mutex != null) _mutex.ReleaseMutex(); } catch { }
            IsFirst = false;
            try { if (_mutex != null) _mutex.Close(); } catch { }
            _mutex = null;
        }

        public ExistingInstanceResult NotifyExisting()
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut))
                {
                    client.Connect(2000);
                    client.WriteByte(1);
                    client.Flush();
                    byte[] response = new byte[1];
                    var read = client.BeginRead(response, 0, 1, null, null);
                    using (WaitHandle completion = read.AsyncWaitHandle)
                    {
                        if (!completion.WaitOne(6000)) return ExistingInstanceResult.Unavailable;
                    }
                    int count = client.EndRead(read);
                    int responseByte = count == 1 ? response[0] : -1;
                    if (responseByte == 1) return ExistingInstanceResult.Shown;
                }
            }
            catch { }
            return ExistingInstanceResult.Unavailable;
        }

        public void StartPipeServer(Func<ExistingInstanceResult> onShow)
        {
            _released = false;
            Thread t = new Thread(() => PipeLoop(onShow));
            t.IsBackground = true;
            t.Start();
        }

        private void PipeLoop(Func<ExistingInstanceResult> onShow)
        {
            while (!_released)
            {
                NamedPipeServerStream server = null;
                try
                {
                    server = new NamedPipeServerStream(PipeName, PipeDirection.InOut);
                    lock (_pipeLock)
                    {
                        if (_released) { server.Dispose(); return; }
                        _activePipe = server;
                    }
                    server.WaitForConnection();
                    if (server.ReadByte() != 1) continue;
                    ExistingInstanceResult result = onShow == null ? ExistingInstanceResult.Unavailable : onShow();
                    server.WriteByte(result == ExistingInstanceResult.Shown ? (byte)1 : (byte)0);
                    server.Flush();
                }
                catch (IOException)
                {
                    if (_released) return;
                }
                catch (ObjectDisposedException)
                {
                    if (_released) return;
                    break;
                }
                catch
                {
                    break;
                }
                finally
                {
                    lock (_pipeLock) { if (object.ReferenceEquals(_activePipe, server)) _activePipe = null; }
                    if (server != null) server.Dispose();
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
