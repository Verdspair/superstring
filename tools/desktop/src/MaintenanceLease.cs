using System;
using System.IO;

namespace Superstring.Desktop
{
    // Stable file handle, not a deletable sentinel or a timeout-based stale lock.
    // This protects native launcher lifetime only until the service participates too.
    internal sealed class MaintenanceLease : IDisposable
    {
        private FileStream _handle;
        private MaintenanceLease(FileStream handle) { _handle = handle; }

        internal static MaintenanceLease Acquire(string root, bool maintenance)
        {
            string directory = Path.Combine(Path.GetFullPath(root), "maintenance");
            string filename = Path.Combine(directory, "operation.lock");
            for (string current = filename; !string.IsNullOrEmpty(current); )
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("维护锁路径不能包含链接。");
                var parent = Directory.GetParent(current);
                current = parent == null ? null : parent.FullName;
            }
            Directory.CreateDirectory(directory);
            // Create only if absent. Never truncate/delete/recreate a live lock file.
            if (!File.Exists(filename))
            {
                try { using (var initial = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite)) { } }
                catch (IOException) { if (!File.Exists(filename)) throw; }
            }
            try
            {
                return new MaintenanceLease(new FileStream(filename, FileMode.Open,
                    maintenance ? FileAccess.ReadWrite : FileAccess.Read,
                    maintenance ? FileShare.None : FileShare.Read));
            }
            catch (IOException ex)
            {
                throw new IOException("程序运行或安装维护正在占用此目录，请关闭程序或等待维护结束。", ex);
            }
        }

        public void Dispose()
        {
            if (_handle != null) { _handle.Dispose(); _handle = null; }
        }
    }
}
