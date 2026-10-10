using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Superstring.Desktop
{
    // Synthetic "server" side of the regression probe. Roles are selected by env/args,
    // never by process name scanning; the grandchild marker is the first argument and
    // the parent child is launched from the real absolute probe exe path.
    internal static class FakeServer
    {
        internal static int RunGrandchild(string dir, string ready, string release)
        {
            IntPtr stdout = GetStdHandle(-11); IntPtr stderr = GetStdHandle(-12);
            File.WriteAllText(ready, "pid=" + Process.GetCurrentProcess().Id
                + ";stdoutHandle=" + stdout.ToInt64() + ";stdoutType=" + GetFileType(stdout)
                + ";stderrHandle=" + stderr.ToInt64() + ";stderrType=" + GetFileType(stderr)
                + ";time=" + DateTime.UtcNow.ToString("o"));
            Console.WriteLine("SYNTHETIC_GRANDCHILD_STDOUT_PIPE_HELD"); Console.Out.Flush();
            Console.Error.WriteLine("SYNTHETIC_GRANDCHILD_STDERR_PIPE_HELD"); Console.Error.Flush();
            while (!File.Exists(release)) Thread.Sleep(20);
            Console.WriteLine("SYNTHETIC_GRANDCHILD_RELEASED"); Console.Out.Flush();
            return 0;
        }

        internal static int RunParent(string dir, string mode, string ready, string release)
        {
            if (mode == "3-early-exit") return 0;
            if (mode == "2-no-port")
            {
                File.WriteAllText(Path.Combine(dir, "parent.alive"), "pid=" + Process.GetCurrentProcess().Id);
                while (true) Thread.Sleep(1000);
            }
            if (mode == "1-fail")
            {
                string exe = Process.GetCurrentProcess().MainModule.FileName;
                STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags = STARTF_USESTDHANDLES;
                si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
                PROCESS_INFORMATION pi;
                StringBuilder cmd = new StringBuilder("\"" + exe + "\" --fake-grandchild");
                if (!CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, dir, ref si, out pi))
                {
                    File.WriteAllText(Path.Combine(dir, "parent.error"), "CreateProcess error=" + Marshal.GetLastWin32Error());
                    return 31;
                }
                File.WriteAllText(Path.Combine(dir, "parent-child.json"),
                    "{\"parentPid\":" + Process.GetCurrentProcess().Id + ",\"childPid\":" + pi.dwProcessId
                    + ",\"stdoutType\":" + GetFileType(si.hStdOutput) + ",\"stderrType\":" + GetFileType(si.hStdError) + "}");
                CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                File.WriteAllText(Path.Combine(dir, "parent.alive"), "pid=" + Process.GetCurrentProcess().Id);
                while (true) Thread.Sleep(1000);
            }
            return 3;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int n);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetFileType(IntPtr h);
        private const int STARTF_USESTDHANDLES = 0x100;
        private const uint CREATE_NO_WINDOW = 0x08000000;
    }
}
