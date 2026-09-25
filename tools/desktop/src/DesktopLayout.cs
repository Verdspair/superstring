using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

namespace Superstring.Desktop
{
    internal sealed class DesktopLayout
    {
#if INSTALLED
        public static readonly bool InstalledBuild = true;
#else
        public static readonly bool InstalledBuild = false;
#endif
        public string Root;
        public bool Installed;
        public string StateDirectory { get { return Installed ? Path.Combine(Root, "userdata", "state") : Path.Combine(Root, "artifacts", "state"); } }
        public string LogDirectory { get { return Installed ? Path.Combine(Root, "logs") : Path.Combine(Root, "local", "logs"); } }
        public string ServerExecutable { get { return Path.Combine(Root, "app", "superstring-server.exe"); } }

        public static DesktopLayout Resolve()
        {
            if (InstalledBuild) return ResolveInstalled(ProjectLocator.ExeDirectory);
            string root = ProjectLocator.FindRoot(ProjectLocator.ExeDirectory);
            if (string.IsNullOrEmpty(root)) throw new InvalidOperationException("无法定位开发项目，请检查启动器位置。");
            return new DesktopLayout { Root = root, Installed = false };
        }

        public static DesktopLayout ResolveInstalled(string root)
        {
            root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            if (root.Length <= 3) throw new InvalidOperationException("安装位置不能是磁盘根目录。");
            var result = new DesktopLayout { Root = root, Installed = true };
            result.ValidateInstalledResources();
            return result;
        }

        private static void RejectLinks(string filename)
        {
            string current = Path.GetFullPath(filename);
            while (!string.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("安装路径不允许包含目录链接。");
                var parent = Directory.GetParent(current);
                if (parent == null) break;
                current = parent.FullName;
            }
        }

        public void ValidateInstalledResources()
        {
            if (!Installed) return;
            RejectLinks(Root);
            RejectLinks(StateDirectory);
            RejectLinks(LogDirectory);
            RejectLinks(Path.Combine(Root, "userdata", "data"));
            RejectLinks(Path.Combine(Root, "userdata", "config"));
            RejectLinks(Path.Combine(Root, "backups"));
            RejectLinks(Path.Combine(Root, "maintenance"));
            string manifestPath = Path.Combine(Root, "build-manifest.json");
            RejectLinks(manifestPath);
            var info = new FileInfo(manifestPath);
            if (!info.Exists || info.Length > 1024 * 1024) throw new InvalidOperationException("安装资源清单缺失或过大，请重新安装。");
            var serializer = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
            var manifest = serializer.DeserializeObject(File.ReadAllText(manifestPath)) as Dictionary<string, object>;
            if (manifest == null || !manifest.ContainsKey("layoutVersion") || !(manifest["layoutVersion"] is int) || (int)manifest["layoutVersion"] != 1 || !manifest.ContainsKey("files"))
                throw new InvalidOperationException("不支持的安装资源清单。");
            RequireInteger(manifest, "manifestVersion", 1);
            RequireInteger(manifest, "businessSchemaVersion", 41);
            RequireString(manifest, "product", "superstring");
            RequireString(manifest, "version", PackageIdentity.Version);
            RequireString(manifest, "platform", "win32-x64");
            if (!Environment.Is64BitOperatingSystem) throw new InvalidOperationException("此程序包需要64位Windows。");
            var files = manifest["files"] as object[];
            if (files == null || files.Length == 0) throw new InvalidOperationException("安装资源清单为空。");
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object raw in files)
            {
                var item = raw as Dictionary<string, object>;
                if (item == null || !item.ContainsKey("path") || !item.ContainsKey("sha256")) throw new InvalidOperationException("资源记录无效。");
                string relative = item["path"] as string, expected = item["sha256"] as string;
                if (relative == null || expected == null || !relative.StartsWith("app/", StringComparison.Ordinal) || relative.Contains("..") || relative.Contains("\\") || relative.Contains(":") || !seen.Add(relative))
                    throw new InvalidOperationException("资源路径无效或重复。");
                foreach (string segment in relative.Split('/'))
                    if (string.IsNullOrEmpty(segment) || segment == "." || segment.TrimEnd(' ', '.') != segment || segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                        throw new InvalidOperationException("资源路径包含不支持的片段。");
                if (expected.Length != 64 || !Util.IsHex(expected)) throw new InvalidOperationException("资源哈希无效。");
                string filename = Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));
                RejectLinks(filename);
                using (var hash = SHA256.Create())
                using (var input = File.OpenRead(filename))
                {
                    string actual = BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                    if (!string.Equals(actual, expected, StringComparison.Ordinal)) throw new InvalidOperationException("安装文件校验失败: " + relative);
                }
            }
            // The R1 probe migration is deliberately NOT required: it is a development
            // surface and is absent from every release package.
            foreach (string required in new string[] { "app/superstring-server.exe", "app/resources/web/index.html", "app/resources/migrations/versions/0001_initial.sql", "app/resources/migrations/versions/0002_knowledge.sql", "app/resources/migrations/versions/0003_knowledge_read.sql", "app/resources/migrations/versions/0004_organization.sql", "app/resources/migrations/versions/0005_qq_transport.sql", "app/resources/migrations/versions/0006_qq_memory_sources.sql", "app/resources/migrations/versions/0007_qq_observation_text.sql", "app/resources/migrations/versions/0008_qq_memory_batch.sql", "app/resources/migrations/versions/0009_qq_transport_config.sql", "app/resources/migrations/versions/0010_qq_schemes.sql", "app/resources/migrations/versions/0011_qq_speech_log.sql", "app/resources/migrations/versions/0012_qq_media_notes.sql", "app/resources/migrations/versions/0013_qq_scheme_triggers.sql", "app/resources/migrations/versions/0014_qq_send_log.sql", "app/resources/migrations/versions/0015_qq_scheme_rhythm.sql", "app/resources/migrations/versions/0016_qq_context_budget.sql", "app/resources/migrations/versions/0017_qq_scheme_prompts.sql", "app/resources/migrations/versions/0018_qq_members.sql", "app/resources/migrations/versions/0019_qq_output_reserve.sql", "app/resources/migrations/versions/0020_qq_scheme_stickers.sql", "app/resources/migrations/versions/0021_qq_stickers.sql", "app/resources/migrations/versions/0022_qq_sticker_authorization.sql", "app/resources/migrations/versions/0023_qq_dispatch.sql", "app/resources/migrations/versions/0024_qq_media_purposes.sql", "app/resources/migrations/versions/0025_desktop_settings.sql", "app/resources/migrations/versions/0026_qq_media_supplement.sql", "app/resources/migrations/versions/0027_qq_event_addressed.sql", "app/resources/migrations/versions/0028_qq_immediate_lease.sql", "app/resources/migrations/versions/0029_qq_module_switches.sql", "app/resources/migrations/versions/0030_qq_sweep_verdicts.sql", "app/resources/migrations/versions/0031_qq_attention.sql", "app/resources/migrations/versions/0032_model_providers.sql", "app/resources/migrations/versions/0033_qq_idle_judgements.sql", "app/resources/migrations/versions/0034_qq_initiative_min_score.sql", "app/resources/migrations/versions/0035_qq_reply_split.sql", "app/resources/migrations/versions/0036_qq_judgement_reuse.sql", "app/resources/migrations/versions/0037_qq_judgement_per_speaker.sql", "app/resources/migrations/versions/0038_qq_judgement_model.sql", "app/resources/migrations/versions/0039_agent_runs.sql", "app/resources/migrations/versions/0040_conversation_wakes.sql", "app/resources/migrations/versions/0041_outbound_intents.sql" })
                if (!seen.Contains(required)) throw new InvalidOperationException("缺少必要资源: " + required);
        }

        private static void RequireInteger(Dictionary<string, object> manifest, string key, int expected)
        {
            object value;
            if (!manifest.TryGetValue(key, out value) || !(value is int) || (int)value != expected)
                throw new InvalidOperationException("不支持的程序包字段: " + key);
        }

        private static void RequireString(Dictionary<string, object> manifest, string key, string expected)
        {
            object value;
            if (!manifest.TryGetValue(key, out value) || !(value is string) || (string)value != expected)
                throw new InvalidOperationException("程序包身份不匹配: " + key);
        }

        // Startup headroom only, NOT the installer/upgrade backup-space budget.
        internal const long StartupReserveBytes = 64L * 1024 * 1024;
        internal static void CheckStartupSpace(long availableBytes)
        {
            if (availableBytes < StartupReserveBytes)
                throw new IOException("安装盘可用空间不足，启动至少需要64 MiB空闲空间。请释放空间后重试。");
        }

        public void PrepareInstalledStorage()
        {
            if (!Installed) return;
            CheckStartupSpace(new DriveInfo(Path.GetPathRoot(Root)).AvailableFreeSpace);
            string[] directories = new string[] { Root, Path.Combine(Root, "userdata", "data"), Path.Combine(Root, "userdata", "config"), StateDirectory, LogDirectory, Path.Combine(Root, "backups"), Path.Combine(Root, "maintenance") };
            // Precheck all components before creating anything; never touch existing file contents.
            foreach (string directory in directories)
            {
                RejectLinks(directory);
                string component = directory;
                while (!string.IsNullOrEmpty(component))
                {
                    if (File.Exists(component)) throw new IOException("所需目录被文件占用: " + component);
                    var parent = Directory.GetParent(component);
                    component = parent == null ? null : parent.FullName;
                }
            }
            foreach (string directory in directories)
            {
                Directory.CreateDirectory(directory);
                string probe = Path.Combine(directory, ".superstring-write-probe-" + Guid.NewGuid().ToString("N"));
                bool created = false;
                try
                {
                    using (var stream = new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    { created = true; stream.WriteByte(0); stream.Flush(true); }
                }
                finally { if (created) File.Delete(probe); }
            }
        }

        public void ConfigureInstalledEnvironment(ProcessStartInfo psi)
        {
            if (!Installed) return;
            // Do not inherit developer overrides or Bun CLI/config hooks.
            foreach (string key in new string[] { "SUPERSTRING_DB_PATH", "SUPERSTRING_APP_ROOT", "SUPERSTRING_APP_MODE", "SUPERSTRING_BUN_EXE", "BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS", "NODE_PATH" })
                psi.EnvironmentVariables.Remove(key);
            psi.EnvironmentVariables["SUPERSTRING_APP_MODE"] = "installed";
            psi.EnvironmentVariables["SUPERSTRING_APP_ROOT"] = Root;
        }
    }
}
