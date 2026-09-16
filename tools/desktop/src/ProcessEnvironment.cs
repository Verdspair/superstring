using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Superstring.Desktop
{
    // .NET Framework builds a case-insensitive child environment using Add(),
    // which throws if an inherited native block contains differently-cased keys.
    // Normalize once before threads start. Only this process's block is changed;
    // no registry/user/machine environment settings are written.
    internal static class ProcessEnvironment
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr GetEnvironmentStringsW();
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeEnvironmentStringsW(IntPtr block);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetEnvironmentStringsW(IntPtr block);

        internal static string[] Deduplicate(string[] entries, out int duplicates)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var result = new List<string>();
            duplicates = 0;
            foreach (string entry in entries)
            {
                // Preserve Windows hidden drive-current-directory entries (=C:=...).
                int separator = entry.IndexOf('=', entry.StartsWith("=", StringComparison.Ordinal) ? 1 : 0);
                if (separator <= 0) throw new InvalidOperationException("Invalid inherited environment entry.");
                string key = entry.Substring(0, separator);
                // First entry wins, matching lookup order in the inherited block.
                // Never log values: environment entries can contain credentials.
                if (seen.Add(key)) result.Add(entry);
                else duplicates++;
            }
            return result.ToArray();
        }

        internal static int NormalizeCurrentProcess()
        {
            var entries = new List<string>();
            IntPtr block = GetEnvironmentStringsW();
            if (block == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                IntPtr cursor = block;
                while (Marshal.ReadInt16(cursor) != 0)
                {
                    string entry = Marshal.PtrToStringUni(cursor);
                    entries.Add(entry);
                    cursor = IntPtr.Add(cursor, checked((entry.Length + 1) * 2));
                }
            }
            finally { FreeEnvironmentStringsW(block); }
            int duplicates;
            string[] normalized = Deduplicate(entries.ToArray(), out duplicates);
            if (duplicates == 0) return 0;
            IntPtr replacement = Marshal.StringToHGlobalUni(string.Join("\0", normalized) + "\0\0");
            try
            {
                if (!SetEnvironmentStringsW(replacement)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(replacement); }
            return duplicates;
        }
    }
}
