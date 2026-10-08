using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Superstring.Desktop
{
    /// <summary>The launcher and its descendants share one Windows process lifetime.</summary>
    internal sealed class DesktopProcesses : IDisposable
    {
        private IntPtr _job;

        public DesktopProcesses()
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) throw new Win32Exception();
            try
            {
                var limits = new ExtendedLimits();
                limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int size = Marshal.SizeOf(typeof(ExtendedLimits));
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(limits, buffer, false);
                    if (!SetInformationJobObject(_job, 9, buffer, (uint)size)) throw new Win32Exception();
                }
                finally { Marshal.FreeHGlobal(buffer); }
                using (var current = Process.GetCurrentProcess())
                    if (!AssignProcessToJobObject(_job, current.Handle)) throw new Win32Exception();
            }
            catch { CloseHandle(_job); _job = IntPtr.Zero; throw; }
        }

        public void Terminate(int exitCode)
        {
            if (!TerminateJobObject(_job, unchecked((uint)exitCode))) throw new Win32Exception();
        }

        /// <summary>Leave the error panel alive, but never reuse a failed service on retry.</summary>
        public void StopChildren()
        {
            int capacity = 16;
            IntPtr buffer;
            while (true)
            {
                buffer = Marshal.AllocHGlobal(8 + capacity * IntPtr.Size);
                uint returned;
                if (QueryInformationJobObject(_job, 3, buffer, (uint)(8 + capacity * IntPtr.Size), out returned)) break;
                int error = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(buffer);
                if (error != 234) throw new Win32Exception(error);
                capacity *= 2;
            }
            try
            {
                int count = Marshal.ReadInt32(buffer, 4);
                int currentId = Process.GetCurrentProcess().Id;
                var children = new System.Collections.Generic.List<Process>();
                try
                {
                    for (int i = 0; i < count; i++)
                    {
                        int id = unchecked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                        if (id == currentId) continue;
                        try
                        {
                            var child = Process.GetProcessById(id);
                            bool owned;
                            if (!IsProcessInJob(child.Handle, _job, out owned)) { child.Dispose(); throw new Win32Exception(); }
                            if (owned) children.Add(child); else child.Dispose();
                        }
                        catch (ArgumentException) { }
                        catch (InvalidOperationException) { }
                    }
                    foreach (var child in children)
                    {
                        try { if (!child.HasExited) child.Kill(); }
                        catch (InvalidOperationException) { }
                    }
                    foreach (var child in children) child.WaitForExit();
                }
                finally { foreach (var child in children) child.Dispose(); }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public void Dispose()
        {
            if (_job == IntPtr.Zero) return;
            CloseHandle(_job);
            _job = IntPtr.Zero;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long ProcessUserTime, JobUserTime;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
