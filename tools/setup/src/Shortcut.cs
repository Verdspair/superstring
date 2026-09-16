using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Superstring.Setup
{
    /// <summary>
    /// Creates the program shortcut through the Windows shell COM interfaces
    /// (no PowerShell/WSH dependency at install time). An existing shortcut is
    /// backed up before being replaced, and the target is verified afterwards.
    /// </summary>
    internal static class Shortcut
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLinkObject { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
            void GetIDList(out IntPtr ppidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
            void GetHotkey(out short pwHotkey);
            void SetHotkey(short wHotkey);
            void GetShowCmd(out int piShowCmd);
            void SetShowCmd(int iShowCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
            void Resolve(IntPtr hwnd, int fFlags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }

        [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPersistFile
        {
            void GetClassID(out Guid pClassID);
            void IsDirty();
            void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
            void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
            void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
            void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
        }

        internal const string LinkName = "superstring.lnk";

        /// <summary>Writes a shortcut; returns the path or null when skipped.</summary>
        internal static string Create(string linkPath, string target, string workingDirectory, string backupDirectory)
        {
            target = Path.GetFullPath(target);
            if (!File.Exists(target)) throw new FileNotFoundException("快捷方式目标不存在", target);
            string directory = Path.GetDirectoryName(linkPath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            if (File.Exists(linkPath))
            {
                if (!string.IsNullOrEmpty(backupDirectory))
                {
                    Directory.CreateDirectory(backupDirectory);
                    string backup = Path.Combine(backupDirectory, Path.GetFileName(linkPath) + ".bak");
                    File.Copy(linkPath, backup, true);
                    if (Manifest.HashFile(linkPath) != Manifest.HashFile(backup))
                        throw new IOException("快捷方式备份校验失败");
                }
            }
            object instance = new ShellLinkObject();
            try
            {
                var link = (IShellLinkW)instance;
                link.SetPath(target);
                link.SetWorkingDirectory(Path.GetFullPath(workingDirectory));
                link.SetIconLocation(target, 0);
                link.SetDescription("superstring");
                link.SetArguments("");
                ((IPersistFile)instance).Save(linkPath, false);
            }
            finally
            {
                Marshal.ReleaseComObject(instance);
            }
            if (!File.Exists(linkPath)) throw new IOException("快捷方式未生成: " + linkPath);
            return linkPath;
        }

        internal static string DesktopLinkPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), LinkName);
        }

        internal static string StartMenuLinkPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "superstring", LinkName);
        }
    }
}
