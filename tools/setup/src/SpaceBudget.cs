using System;
using System.IO;

namespace Superstring.Setup
{
    /// <summary>
    /// Conservative additional-space requirement for a full-package install or
    /// upgrade. Mirrors tools/installer/upgrade-policy.mjs so the offline policy
    /// tests and the shipped installer cannot drift apart.
    ///
    /// Required = 2 x incoming program bytes  (staging copy + final program)
    ///          + current program bytes       (previous program retained for rollback)
    ///          + 2 x user data bytes         (quiescent backup + restored copy)
    ///          + reserve                     (database growth, logs, transient files)
    /// </summary>
    internal static class SpaceBudget
    {
        internal const long ReserveBytes = 256L * 1024 * 1024;

        internal static long Plus(long left, long right)
        {
            if (left < 0 || right < 0) throw new ArgumentOutOfRangeException("bytes");
            // Saturate instead of overflowing into a meaningless small number.
            if (left > long.MaxValue - right) return long.MaxValue;
            return left + right;
        }

        internal static long Multiply(long value, long factor)
        {
            if (value < 0 || factor < 0) throw new ArgumentOutOfRangeException("bytes");
            if (value == 0 || factor == 0) return 0;
            if (value > long.MaxValue / factor) return long.MaxValue;
            return value * factor;
        }

        internal static long Required(long incomingProgramBytes, long currentProgramBytes, long userDataBytes, long reserveBytes)
        {
            return Plus(
                Plus(Multiply(incomingProgramBytes, 2), currentProgramBytes),
                Plus(Multiply(userDataBytes, 2), reserveBytes));
        }

        internal static long Required(long incomingProgramBytes, long currentProgramBytes, long userDataBytes)
        {
            return Required(incomingProgramBytes, currentProgramBytes, userDataBytes, ReserveBytes);
        }

        internal static void RequireAvailable(long availableBytes, long requiredBytes, string volumeRoot)
        {
            if (availableBytes < requiredBytes)
                throw new IOException(
                    "磁盘空间不足：安装位置所在驱动器 " + volumeRoot + " 需要约 "
                    + (requiredBytes / (1024 * 1024)) + " MiB，当前可用 " + (availableBytes / (1024 * 1024))
                    + " MiB。请释放空间或改选其他安装位置。");
        }

        internal static long DirectoryBytes(string directory)
        {
            if (!Directory.Exists(directory)) return 0;
            long total = 0;
            foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
            {
                try { total = Plus(total, new FileInfo(file).Length); }
                catch (IOException) { }
            }
            return total;
        }
    }
}
