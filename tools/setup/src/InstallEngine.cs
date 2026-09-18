using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Superstring.Desktop;

namespace Superstring.Setup
{
    internal sealed class InstallRequest
    {
        internal string TargetRoot;
        internal bool CreateShortcuts = true;
        internal bool CreateDesktopShortcut = true;
        internal bool RunProductCheck = true;
        internal bool Uninstall;
        /// <summary>
        /// Test-only fault injection; gated behind SUPERSTRING_SETUP_TEST_HOOK.
        /// Phases: "swap" fails immediately after the program swap, "verify" fails after
        /// the swapped-in program was verified on disk. The "verify" phase raises the same
        /// VERIFY_* surface as a real post-install verification failure on purpose, so the
        /// rollback test also proves the public exit-code mapping (13) for that stage.
        /// </summary>
        internal string InjectFailureAfter;

        internal static bool TestHookEnabled
        {
            get { return Environment.GetEnvironmentVariable("SUPERSTRING_SETUP_TEST_HOOK") == "1"; }
        }

        /// <summary>
        /// Automation seam: redirects shortcut creation away from the real Desktop
        /// and Start Menu. Only honoured together with the test hook.
        /// </summary>
        internal static string ShortcutRootOverride
        {
            get { return TestHookEnabled ? Environment.GetEnvironmentVariable("SUPERSTRING_SETUP_SHORTCUT_ROOT") : null; }
        }
    }

    internal sealed class InstallResult
    {
        internal string Action;
        internal string Version;
        internal string PreviousVersion;
        internal string BackupDirectory;
        internal readonly List<string> Shortcuts = new List<string>();
        internal string TargetRoot;
        internal long RequiredBytes;
        internal long AvailableBytes;
    }

    /// <summary>
    /// Transactional full-package install/upgrade.
    ///
    /// Ordering contract:
    ///   1. exclusive maintenance lock (nothing of ours may be running)
    ///   2. recover any interrupted previous run
    ///   3. validate the target directory and the incoming package
    ///   4. identity + downgrade check against the installed manifest
    ///   5. conservative free-space check
    ///   6. extract to a staging directory inside the install root and hash-verify
    ///   7. consistent backup of the previous program and user data (upgrade only)
    ///   8. journaled swap of the program files (user data is never rewritten)
    ///   9. post-install verification via the real product entry point
    ///  10. on any failure after step 8: roll the program back to the backup
    /// </summary>
    internal sealed class InstallEngine
    {
        internal const string MaintenanceDirectoryName = "maintenance";
        internal const string BackupDirectoryName = "backups";

        private readonly Action<string, int> _progress;
        private readonly SetupLog _log;

        internal InstallEngine(SetupLog log, Action<string, int> progress)
        {
            _log = log;
            _progress = progress == null ? delegate(string message, int percent) { } : progress;
        }

        private static string Maintenance(string root) { return Path.Combine(root, MaintenanceDirectoryName); }
        private static string JournalPath(string root) { return Path.Combine(Maintenance(root), "journal.json"); }
        private static string PreviousApp(string root) { return Path.Combine(Maintenance(root), "previous-app"); }
        private static string PreviousLauncher(string root) { return Path.Combine(Maintenance(root), "previous-launcher.exe"); }
        private static string PreviousManifest(string root) { return Path.Combine(Maintenance(root), "previous-manifest.json"); }

        private static readonly string[] KnownTopLevel = new string[]
        {
            "app", "userdata", "logs", "backups", "maintenance", "superstring.exe", "build-manifest.json",
        };

        /// <summary>
        /// Read-only package integrity gate that runs before the target directory is
        /// touched. It only walks the archive index and the required-entry list, so it
        /// costs nothing, and it turns "bad download" into a failure that leaves the
        /// user's folder exactly as they chose it.
        /// </summary>
        private static void PreflightPackage()
        {
            using (Payload payload = Payload.OpenCurrent())
            {
                payload.ValidateEntries();
            }
        }

        internal InstallResult Run(InstallRequest request)
        {
            if (string.IsNullOrEmpty(request.TargetRoot)) throw new ArgumentException("缺少安装位置");
            string root = Path.GetFullPath(request.TargetRoot).TrimEnd(Path.DirectorySeparatorChar);
            if (root.Length <= 3) throw new InvalidDataException("TARGET_CANNOT_BE_DRIVE_ROOT");

            var result = new InstallResult { TargetRoot = root };
            MaintenanceLease lease = null;
            bool swapped = false;
            bool previousInstall = false;
            try
            {
                // The package must prove itself before anything exists under the user's
                // chosen directory: a truncated or tampered setup has to leave no root,
                // maintenance folder, lock or log behind. Uninstall is deliberately exempt
                // so that a damaged package can still remove the program it installed.
                if (!request.Uninstall)
                {
                    _progress("正在检查安装包…", 3);
                    PreflightPackage();
                }

                _progress("正在检查安装位置…", 5);
                RejectLinks(root);
                if (Directory.Exists(root)) RejectForeignContent(root);
                Directory.CreateDirectory(root);
                Directory.CreateDirectory(Maintenance(root));

                _progress("正在取得安装维护独占…", 10);
                try
                {
                    lease = MaintenanceLease.Acquire(root, true);
                }
                catch (IOException ex)
                {
                    throw new InstallBusyException(ex);
                }

                _log.AttachFile(Path.Combine(Maintenance(root), "setup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log"));
                _log.Info("安装开始: root=" + root);

                _progress("正在检查上次安装状态…", 15);
                RecoverInterrupted(root);
                RejectForeignContent(root);

                if (request.Uninstall)
                {
                    return Uninstall(root, result);
                }

                using (Payload payload = Payload.OpenCurrent())
                {
                    payload.ValidateEntries();
                    _progress("正在复核安装包…", 20);
                    var incoming = ReadManifestFromPayload(payload);
                    Manifest current = LoadCurrentManifest(root);
                    previousInstall = current != null;
                    if (current != null)
                    {
                        result.PreviousVersion = current.Version;
                        result.Action = SemVer.Classify(current.Version, incoming.Version);
                    }
                    else
                    {
                        result.Action = "fresh-install";
                    }
                    result.Version = incoming.Version;

                    long incomingBytes = payload.UncompressedSize();
                    long currentProgramBytes = previousInstall ? SpaceBudget.DirectoryBytes(Path.Combine(root, "app")) : 0;
                    long userDataBytes = SpaceBudget.DirectoryBytes(Path.Combine(root, "userdata"));
                    result.RequiredBytes = SpaceBudget.Required(incomingBytes, currentProgramBytes, userDataBytes);
                    string volume = Path.GetPathRoot(root);
                    result.AvailableBytes = new DriveInfo(volume).AvailableFreeSpace;
                    _progress("正在检查磁盘空间…", 25);
                    SpaceBudget.RequireAvailable(result.AvailableBytes, result.RequiredBytes, volume);

                    string staging = Path.Combine(Maintenance(root), "staging-" + Guid.NewGuid().ToString("N"));
                    try
                    {
                        _progress("正在解压程序文件…", 35);
                        Extract(payload, staging);
                        _progress("正在校验程序文件…", 50);
                        incoming.VerifyOnDisk(staging);

                        if (previousInstall)
                        {
                            _progress("正在备份现有程序与数据…", 60);
                            result.BackupDirectory = Backup(root, current);
                        }

                        _progress("正在安装程序文件…", 70);
                        WriteJournal(root, "swapping", result);
                        swapped = true;
                        Swap(root, staging);
                        if (request.InjectFailureAfter == "swap") throw new IOException("INJECTED_SWAP_FAILURE");

                        WriteJournal(root, "verifying", result);
                        Manifest installed = Manifest.Load(Path.Combine(root, "build-manifest.json"));
                        installed.VerifyOnDisk(root);
                        if (request.InjectFailureAfter == "verify") throw new IOException("VERIFY_INJECTED_FAILURE");
                        if (request.RunProductCheck) RunPackageCheck(root);
                    }
                    finally
                    {
                        DeleteDirectoryBestEffort(staging);
                    }
                }

                WriteJournal(root, "committed", result);
                CleanupAfterSuccess(root);

                if (request.CreateShortcuts)
                {
                    _progress("正在创建快捷方式…", 92);
                    if (request.CreateDesktopShortcut) TryCreateShortcut(root, result, true);
                    TryCreateShortcut(root, result, false);
                }

                _progress("安装完成", 100);
                _log.Info("安装完成: action=" + result.Action + " version=" + result.Version
                    + " previous=" + (result.PreviousVersion ?? "(none)") + " root=" + root);
                return result;
            }
            catch (Exception error)
            {
                if (swapped)
                {
                    _log.Error("安装失败，正在回滚: " + error.Message);
                    _progress("安装失败，正在回滚…", -1);
                    try
                    {
                        Rollback(root, previousInstall);
                        _log.Info("已回滚到安装前的程序文件；用户数据未被修改。");
                        WriteJournal(root, "rolled-back", null);
                    }
                    catch (Exception rollbackError)
                    {
                        _log.Error("回滚失败: " + rollbackError.Message);
                        throw new RollbackFailedException(error, rollbackError);
                    }
                }
                throw;
            }
            finally
            {
                if (lease != null) lease.Dispose();
            }
        }

        /// <summary>
        /// Removes only the program files and shortcuts this product owns. User
        /// data, logs and backups are deliberately preserved (product policy);
        /// the installation folder is never deleted recursively.
        /// </summary>
        private InstallResult Uninstall(string root, InstallResult result)
        {
            Manifest current = LoadCurrentManifest(root);
            if (current == null) throw new InvalidDataException("TARGET_NOT_OUR_INSTALLATION");
            _log.AttachFile(Path.Combine(Maintenance(root), "uninstall-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log"));
            _progress("正在移除程序文件…", 40);
            DeleteDirectory(Path.Combine(root, "app"));
            TryDeleteFile(Path.Combine(root, "superstring.exe"));
            TryDeleteFile(Path.Combine(root, "build-manifest.json"));
            _progress("正在移除快捷方式…", 80);
            TryDeleteFile(LinkPath(true));
            TryDeleteFile(LinkPath(false));
            result.Action = "uninstalled";
            result.Version = current.Version;
            _log.Info("已卸载程序文件；保留 userdata/logs/backups。root=" + root);
            _progress("卸载完成（用户数据已保留）", 100);
            return result;
        }

        private void TryCreateShortcut(string root, InstallResult result, bool desktop)
        {
            try
            {
                result.Shortcuts.Add(Shortcut.Create(LinkPath(desktop), Path.Combine(root, "superstring.exe"), root, result.BackupDirectory));
            }
            catch (Exception ex)
            {
                // One failed shortcut must not block the other or invalidate a good install.
                _log.Warn("快捷方式创建失败（不影响程序本体）: " + ex.Message);
            }
        }

        internal static string LinkPath(bool desktop)
        {
            string overrideRoot = InstallRequest.ShortcutRootOverride;
            if (!string.IsNullOrEmpty(overrideRoot))
                return Path.Combine(overrideRoot, desktop ? "Desktop" : Path.Combine("Programs", "superstring"), Shortcut.LinkName);
            return desktop ? Shortcut.DesktopLinkPath() : Shortcut.StartMenuLinkPath();
        }

        // target validation

        private static void RejectLinks(string path)
        {
            string current = Path.GetFullPath(path);
            while (!string.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || Directory.Exists(current))
                    && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("TARGET_REJECTS_LINKED_PATH");
                DirectoryInfo parent = Directory.GetParent(current);
                if (parent == null) break;
                current = parent.FullName;
            }
        }

        private static void RejectForeignContent(string root)
        {
            if (File.Exists(Path.Combine(root, "build-manifest.json"))) return;
            foreach (string entry in Directory.GetFileSystemEntries(root))
            {
                string name = Path.GetFileName(entry);
                bool known = false;
                foreach (string allowed in KnownTopLevel)
                    if (string.Equals(name, allowed, StringComparison.OrdinalIgnoreCase)) { known = true; break; }
                if (!known) throw new InvalidDataException("TARGET_NOT_EMPTY_AND_NOT_OURS: " + name);
            }
            // A valid journal is the only exception for a partially swapped fresh
            // installation. Recovery runs under the maintenance lease, then this
            // target check is repeated before installing anything new.
            if (Directory.Exists(Path.Combine(root, "app")) && !HasRecoverableJournal(root))
                throw new InvalidDataException("TARGET_APP_WITHOUT_MANIFEST");
        }

        private static bool HasRecoverableJournal(string root)
        {
            Dictionary<string, object> journal = ReadJournal(root);
            string phase = JournalField(journal, "phase");
            return journal != null && journal.ContainsKey("previous")
                && JournalField(journal, "product") == "superstring"
                && SemVer.IsValid(JournalField(journal, "version"))
                && (phase == "swapping" || phase == "verifying");
        }

        // journal and recovery

        private static void WriteJournal(string root, string phase, InstallResult result)
        {
            var map = new Dictionary<string, object>
            {
                { "phase", phase },
                { "product", "superstring" },
                { "at", DateTime.UtcNow.ToString("o") },
                { "version", result == null || result.Version == null ? "" : result.Version },
                { "previous", result == null || result.PreviousVersion == null ? "" : result.PreviousVersion },
            };
            WriteAtomic(JournalPath(root), new JavaScriptSerializer().Serialize(map));
        }

        private static Dictionary<string, object> ReadJournal(string root)
        {
            string path = JournalPath(root);
            if (!File.Exists(path)) return null;
            try
            {
                return new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path))
                    as Dictionary<string, object>;
            }
            catch (Exception) { }
            return null;
        }

        private static string JournalField(Dictionary<string, object> map, string key)
        {
            object value;
            if (map != null && map.TryGetValue(key, out value) && value is string) return (string)value;
            return null;
        }

        /// <summary>
        /// A crashed run must leave a deterministic state. Anything before the
        /// swap changed nothing, so it is only cleaned up; an interrupted swap is
        /// rolled back to the previous program.
        /// </summary>
        private void RecoverInterrupted(string root)
        {
            Dictionary<string, object> journal = ReadJournal(root);
            if (journal == null) { CleanupStaging(root); return; }
            string phase = JournalField(journal, "phase") ?? "unknown";
            if (phase == "swapping" || phase == "verifying")
            {
                _log.Warn("检测到上次安装被中断（" + phase + "），正在恢复安装前的程序文件。");
                // The journal records the version that was in place before the swap; an
                // empty value means this run was a FRESH install, which has no previous
                // program to restore. Such a run must be unwound instead (see Rollback),
                // otherwise a half-swapped app/ with no manifest is left behind and the
                // next attempt is refused as foreign content.
                bool hadPreviousInstall = !string.IsNullOrEmpty(JournalField(journal, "previous"));
                Rollback(root, hadPreviousInstall);
                _log.Info("中断恢复完成；用户数据未被修改。");
            }
            CleanupStaging(root);
            CleanupSwapArtifacts(root);
            try { File.Delete(JournalPath(root)); } catch (IOException) { }
        }

        private static void CleanupStaging(string root)
        {
            string maintenance = Maintenance(root);
            if (!Directory.Exists(maintenance)) return;
            foreach (string directory in Directory.GetDirectories(maintenance, "staging-*"))
                DeleteDirectoryBestEffort(directory);
        }

        private static void CleanupSwapArtifacts(string root)
        {
            DeleteDirectoryBestEffort(PreviousApp(root));
            TryDeleteFile(PreviousLauncher(root));
            TryDeleteFile(PreviousManifest(root));
        }

        // payload handling

        private static Manifest ReadManifestFromPayload(Payload payload)
        {
            ZipArchiveEntry entry = payload.Archive.GetEntry("build-manifest.json");
            if (entry == null) throw new InvalidDataException("SETUP_PAYLOAD_INCOMPLETE: build-manifest.json");
            using (var reader = new StreamReader(entry.Open(), Encoding.UTF8, true))
                return Manifest.Parse(reader.ReadToEnd());
        }

        private static Manifest LoadCurrentManifest(string root)
        {
            string path = Path.Combine(root, "build-manifest.json");
            if (!File.Exists(path)) return null;
            return Manifest.Load(path);
        }

        private static void Extract(Payload payload, string staging)
        {
            Directory.CreateDirectory(staging);
            foreach (ZipArchiveEntry entry in payload.Archive.Entries)
            {
                string relative = entry.FullName.Replace('\\', '/');
                string destination = Path.Combine(staging, relative.Replace('/', Path.DirectorySeparatorChar));
                if (relative.EndsWith("/", StringComparison.Ordinal)) { Directory.CreateDirectory(destination); continue; }
                string directory = Path.GetDirectoryName(destination);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                using (Stream input = entry.Open())
                using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                    input.CopyTo(output, 1 << 20);
            }
        }

        // backup

        private static string Backup(string root, Manifest current)
        {
            string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
            string directory = Path.Combine(root, BackupDirectoryName, stamp);
            int counter = 1;
            while (Directory.Exists(directory))
                directory = Path.Combine(root, BackupDirectoryName, stamp + "-" + (counter++));
            Directory.CreateDirectory(directory);
            var log = new List<string>();
            // 1. previous program (needed for rollback beyond this transaction)
            CopyTree(Path.Combine(root, "app"), Path.Combine(directory, "app"), log);
            CopyFileIfExists(Path.Combine(root, "superstring.exe"), Path.Combine(directory, "superstring.exe"), log);
            CopyFileIfExists(Path.Combine(root, "build-manifest.json"), Path.Combine(directory, "build-manifest.json"), log);
            // 2. user data, copied only while the exclusive lock guarantees the DB
            //    is closed. The WAL sidecars travel with the database so the trio is
            //    a consistent set (a copied .sqlite alone could miss recent commits).
            CopyTree(Path.Combine(root, "userdata"), Path.Combine(directory, "userdata"), log);
            var map = new Dictionary<string, object>
            {
                { "createdAt", DateTime.UtcNow.ToString("o") },
                { "version", current.Version },
                { "files", log.ToArray() },
            };
            WriteAtomic(Path.Combine(directory, "backup.json"), new JavaScriptSerializer().Serialize(map));
            return directory;
        }

        private static void CopyTree(string source, string destination, List<string> log)
        {
            if (!Directory.Exists(source)) return;
            Directory.CreateDirectory(destination);
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
                string target = Path.Combine(destination, relative);
                string directory = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.Copy(file, target, true);
                string sourceHash = Manifest.HashFile(file);
                if (sourceHash != Manifest.HashFile(target)) throw new IOException("备份校验失败: " + relative);
                log.Add(relative.Replace('\\', '/'));
            }
        }

        private static void CopyFileIfExists(string source, string destination, List<string> log)
        {
            if (!File.Exists(source)) return;
            File.Copy(source, destination, true);
            if (Manifest.HashFile(source) != Manifest.HashFile(destination)) throw new IOException("备份校验失败: " + Path.GetFileName(source));
            log.Add(Path.GetFileName(source));
        }

        // swap and rollback

        private static void Swap(string root, string staging)
        {
            string currentApp = Path.Combine(root, "app");
            if (Directory.Exists(currentApp)) MoveDirectory(currentApp, PreviousApp(root));
            CopyFileIfExists(Path.Combine(root, "superstring.exe"), PreviousLauncher(root), new List<string>());
            CopyFileIfExists(Path.Combine(root, "build-manifest.json"), PreviousManifest(root), new List<string>());
            MoveDirectory(Path.Combine(staging, "app"), currentApp);
            TryDeleteFile(Path.Combine(root, "superstring.exe"));
            MoveFile(Path.Combine(staging, "superstring.exe"), Path.Combine(root, "superstring.exe"));
            TryDeleteFile(Path.Combine(root, "build-manifest.json"));
            MoveFile(Path.Combine(staging, "build-manifest.json"), Path.Combine(root, "build-manifest.json"));
        }

        /// <summary>
        /// Undo a swap. When a previous program exists it is moved back. When this was
        /// a FRESH install there is nothing to restore, so the partially swapped-in
        /// program files are removed instead: leaving an app/ directory (or a manifest)
        /// with no complete program behind would be rejected as foreign content on the
        /// next run and would force the user to clean the folder by hand.
        /// </summary>
        private static void Rollback(string root, bool hadPreviousInstall)
        {
            string currentApp = Path.Combine(root, "app");
            if (Directory.Exists(PreviousApp(root)))
            {
                if (Directory.Exists(currentApp)) DeleteDirectory(currentApp);
                MoveDirectory(PreviousApp(root), currentApp);
            }
            else if (!hadPreviousInstall)
            {
                DeleteDirectoryBestEffort(currentApp);
            }
            if (File.Exists(PreviousLauncher(root)))
            {
                TryDeleteFile(Path.Combine(root, "superstring.exe"));
                MoveFile(PreviousLauncher(root), Path.Combine(root, "superstring.exe"));
            }
            else if (!hadPreviousInstall)
            {
                TryDeleteFile(Path.Combine(root, "superstring.exe"));
            }
            if (File.Exists(PreviousManifest(root)))
            {
                TryDeleteFile(Path.Combine(root, "build-manifest.json"));
                MoveFile(PreviousManifest(root), Path.Combine(root, "build-manifest.json"));
            }
            else if (!hadPreviousInstall)
            {
                TryDeleteFile(Path.Combine(root, "build-manifest.json"));
            }
        }

        private static void CleanupAfterSuccess(string root)
        {
            CleanupSwapArtifacts(root);
            try { File.Delete(JournalPath(root)); } catch (IOException) { }
        }

        private void RunPackageCheck(string root)
        {
            string executable = Path.Combine(root, "superstring.exe");
            if (!File.Exists(executable)) throw new IOException("VERIFY_LAUNCHER_MISSING");
            var info = new ProcessStartInfo(executable, "--check-package")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using (Process process = Process.Start(info))
            {
                string stdout = process.StandardOutput.ReadToEnd();
                string stderr = process.StandardError.ReadToEnd();
                if (!process.WaitForExit(60000))
                {
                    try { process.Kill(); } catch { }
                    throw new IOException("安装后校验超时");
                }
                if (process.ExitCode != 0 || stdout.IndexOf("PACKAGE_OK", StringComparison.Ordinal) < 0)
                    throw new IOException("安装后校验失败(" + process.ExitCode + "): " + stdout + stderr);
                _log.Info("安装后校验通过: " + stdout.Trim());
            }
        }

        // file helpers

        private static void WriteAtomic(string filename, string content)
        {
            string directory = Path.GetDirectoryName(filename);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            string temporary = filename + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, content, new UTF8Encoding(false));
            if (File.Exists(filename)) File.Delete(filename);
            File.Move(temporary, filename);
        }

        private static void MoveDirectory(string source, string destination)
        {
            Retry(delegate { Directory.Move(source, destination); });
        }

        private static void MoveFile(string source, string destination)
        {
            Retry(delegate { File.Move(source, destination); });
        }

        private static void TryDeleteFile(string filename)
        {
            try { if (File.Exists(filename)) File.Delete(filename); }
            catch (IOException) { }
        }

        private static void DeleteDirectory(string directory)
        {
            if (!Directory.Exists(directory)) return;
            Retry(delegate { Directory.Delete(directory, true); });
        }

        private static void DeleteDirectoryBestEffort(string directory)
        {
            try { DeleteDirectory(directory); }
            catch (Exception) { }
        }

        /// <summary>Short retry window for transient antivirus/indexer handles.</summary>
        private static void Retry(Action action)
        {
            IOException last = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try { action(); return; }
                catch (IOException ex)
                {
                    last = ex;
                    Thread.Sleep(200 * (attempt + 1));
                }
                catch (UnauthorizedAccessException ex)
                {
                    last = new IOException(ex.Message, ex);
                    Thread.Sleep(200 * (attempt + 1));
                }
            }
            throw last;
        }
    }

    internal sealed class InstallBusyException : Exception
    {
        internal InstallBusyException(Exception inner)
            : base("安装目录正在使用中：请先关闭正在运行的 superstring（包括后台服务），然后重试。", inner)
        {
        }
    }

    internal sealed class RollbackFailedException : Exception
    {
        internal RollbackFailedException(Exception original, Exception rollback)
            : base("安装失败且自动回滚未完成。请先不要启动程序，并保留此目录下的 backups 与 maintenance 以便人工恢复。原始错误: "
                   + original.Message + " / 回滚错误: " + rollback.Message, rollback)
        {
        }
    }
}
