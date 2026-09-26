using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

namespace Superstring.Setup
{
    /// <summary>
    /// Build manifest of an installation. Validation mirrors the launcher
    /// (tools/desktop/src/DesktopLayout.cs) so the setup and the running product
    /// agree on what a valid installation is.
    /// </summary>
    internal sealed class Manifest
    {
        internal const int SupportedManifestVersion = 1;
        internal const int SupportedLayoutVersion = 1;
        internal const int SupportedSchemaVersion = 44;
        internal const string Product = "superstring";
        internal const string Platform = "win32-x64";

        internal string Version { get; private set; }
        internal int SchemaVersion { get; private set; }
        internal string RawJson { get; private set; }
        internal readonly List<FileRecord> Files = new List<FileRecord>();
        internal FileRecord Launcher { get; private set; }

        internal sealed class FileRecord
        {
            internal string Path;
            internal string Sha256;
        }

        internal static Manifest Load(string filename, bool allowPreviousSchema = false)
        {
            if (!File.Exists(filename)) throw new FileNotFoundException("缺少安装清单", filename);
            return Parse(File.ReadAllText(filename), allowPreviousSchema);
        }

        internal static Manifest Parse(string json, bool allowPreviousSchema = false)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
            var root = serializer.DeserializeObject(json) as Dictionary<string, object>;
            if (root == null) throw new InvalidDataException("MANIFEST_NOT_AN_OBJECT");
            var manifest = new Manifest();
            manifest.RawJson = json;
            RequireInteger(root, "manifestVersion", SupportedManifestVersion);
            RequireInteger(root, "layoutVersion", SupportedLayoutVersion);
            object schemaValue;
            if (!root.TryGetValue("businessSchemaVersion", out schemaValue) || !(schemaValue is int)
                || ((int)schemaValue != SupportedSchemaVersion && !(allowPreviousSchema && ((int)schemaValue >= 1 && (int)schemaValue < SupportedSchemaVersion))))
                throw new InvalidDataException("MANIFEST_UNSUPPORTED_FIELD: businessSchemaVersion");
            manifest.SchemaVersion = (int)schemaValue;
            RequireString(root, "product", Product);
            RequireString(root, "platform", Platform);
            manifest.Version = RequireAnyString(root, "version");
            if (!SemVer.IsValid(manifest.Version)) throw new InvalidDataException("MANIFEST_INVALID_VERSION");
            var files = root.ContainsKey("files") ? root["files"] as object[] : null;
            if (files == null || files.Length == 0) throw new InvalidDataException("MANIFEST_EMPTY_FILE_LIST");
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object raw in files)
            {
                var item = raw as Dictionary<string, object>;
                if (item == null) throw new InvalidDataException("MANIFEST_INVALID_FILE_RECORD");
                string relative = RequireAnyString(item, "path");
                string hash = RequireAnyString(item, "sha256");
                if (!relative.StartsWith("app/", StringComparison.Ordinal)
                    || relative.Contains("..") || relative.Contains("\\") || relative.Contains(":"))
                    throw new InvalidDataException("MANIFEST_UNSAFE_PATH: " + relative);
                foreach (string segment in relative.Split('/'))
                {
                    if (segment.Length == 0 || segment == "." || segment.TrimEnd(' ', '.') != segment)
                        throw new InvalidDataException("MANIFEST_UNSAFE_PATH: " + relative);
                    if (segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                        throw new InvalidDataException("MANIFEST_UNSAFE_PATH: " + relative);
                }
                if (hash.Length != 64 || !IsHex(hash)) throw new InvalidDataException("MANIFEST_INVALID_HASH: " + relative);
                if (!seen.Add(relative)) throw new InvalidDataException("MANIFEST_DUPLICATE_PATH: " + relative);
                manifest.Files.Add(new FileRecord { Path = relative, Sha256 = hash });
            }
            foreach (string required in RequiredFiles)
                if (!seen.Contains(required)) throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: " + required);
            if (manifest.SchemaVersion >= 2 && !seen.Contains("app/resources/migrations/versions/0002_knowledge.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0002_knowledge.sql");
            if (manifest.SchemaVersion >= 3 && !seen.Contains("app/resources/migrations/versions/0003_knowledge_read.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0003_knowledge_read.sql");
            if (manifest.SchemaVersion >= 4 && !seen.Contains("app/resources/migrations/versions/0004_organization.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0004_organization.sql");
            if (manifest.SchemaVersion >= 5 && !seen.Contains("app/resources/migrations/versions/0005_qq_transport.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0005_qq_transport.sql");
            if (manifest.SchemaVersion >= 6 && !seen.Contains("app/resources/migrations/versions/0006_qq_memory_sources.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0006_qq_memory_sources.sql");
            if (manifest.SchemaVersion >= 7 && !seen.Contains("app/resources/migrations/versions/0007_qq_observation_text.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0007_qq_observation_text.sql");
            if (manifest.SchemaVersion >= 8 && !seen.Contains("app/resources/migrations/versions/0008_qq_memory_batch.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0008_qq_memory_batch.sql");
            if (manifest.SchemaVersion >= 9 && !seen.Contains("app/resources/migrations/versions/0009_qq_transport_config.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0009_qq_transport_config.sql");
            if (manifest.SchemaVersion >= 10 && !seen.Contains("app/resources/migrations/versions/0010_qq_schemes.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0010_qq_schemes.sql");
            if (manifest.SchemaVersion >= 11 && !seen.Contains("app/resources/migrations/versions/0011_qq_speech_log.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0011_qq_speech_log.sql");
            if (manifest.SchemaVersion >= 12 && !seen.Contains("app/resources/migrations/versions/0012_qq_media_notes.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0012_qq_media_notes.sql");
            if (manifest.SchemaVersion >= 13 && !seen.Contains("app/resources/migrations/versions/0013_qq_scheme_triggers.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0013_qq_scheme_triggers.sql");
            if (manifest.SchemaVersion >= 14 && !seen.Contains("app/resources/migrations/versions/0014_qq_send_log.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0014_qq_send_log.sql");
            if (manifest.SchemaVersion >= 15 && !seen.Contains("app/resources/migrations/versions/0015_qq_scheme_rhythm.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0015_qq_scheme_rhythm.sql");
            if (manifest.SchemaVersion >= 16 && !seen.Contains("app/resources/migrations/versions/0016_qq_context_budget.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0016_qq_context_budget.sql");
            if (manifest.SchemaVersion >= 17 && !seen.Contains("app/resources/migrations/versions/0017_qq_scheme_prompts.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0017_qq_scheme_prompts.sql");
            if (manifest.SchemaVersion >= 18 && !seen.Contains("app/resources/migrations/versions/0018_qq_members.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0018_qq_members.sql");
            if (manifest.SchemaVersion >= 19 && !seen.Contains("app/resources/migrations/versions/0019_qq_output_reserve.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0019_qq_output_reserve.sql");
            if (manifest.SchemaVersion >= 20 && !seen.Contains("app/resources/migrations/versions/0020_qq_scheme_stickers.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0020_qq_scheme_stickers.sql");
            if (manifest.SchemaVersion >= 21 && !seen.Contains("app/resources/migrations/versions/0021_qq_stickers.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0021_qq_stickers.sql");
            if (manifest.SchemaVersion >= 22 && !seen.Contains("app/resources/migrations/versions/0022_qq_sticker_authorization.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0022_qq_sticker_authorization.sql");
            if (manifest.SchemaVersion >= 23 && !seen.Contains("app/resources/migrations/versions/0023_qq_dispatch.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0023_qq_dispatch.sql");
            if (manifest.SchemaVersion >= 24 && !seen.Contains("app/resources/migrations/versions/0024_qq_media_purposes.sql"))
                throw new InvalidOperationException("缺少必要资源: app/resources/migrations/versions/0024_qq_media_purposes.sql");
            if (manifest.SchemaVersion >= 25 && !seen.Contains("app/resources/migrations/versions/0025_desktop_settings.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0025_desktop_settings.sql");
            if (manifest.SchemaVersion >= 26 && !seen.Contains("app/resources/migrations/versions/0026_qq_media_supplement.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0026_qq_media_supplement.sql");
            if (manifest.SchemaVersion >= 27 && !seen.Contains("app/resources/migrations/versions/0027_qq_event_addressed.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0027_qq_event_addressed.sql");
            if (manifest.SchemaVersion >= 28 && !seen.Contains("app/resources/migrations/versions/0028_qq_immediate_lease.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0028_qq_immediate_lease.sql");
            if (manifest.SchemaVersion >= 29 && !seen.Contains("app/resources/migrations/versions/0029_qq_module_switches.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0029_qq_module_switches.sql");
            if (manifest.SchemaVersion >= 30 && !seen.Contains("app/resources/migrations/versions/0030_qq_sweep_verdicts.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0030_qq_sweep_verdicts.sql");
            if (manifest.SchemaVersion >= 31 && !seen.Contains("app/resources/migrations/versions/0031_qq_attention.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0031_qq_attention.sql");
            if (manifest.SchemaVersion >= 32 && !seen.Contains("app/resources/migrations/versions/0032_model_providers.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0032_model_providers.sql");
            if (manifest.SchemaVersion >= 33 && !seen.Contains("app/resources/migrations/versions/0033_qq_idle_judgements.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0033_qq_idle_judgements.sql");
            if (manifest.SchemaVersion >= 34 && !seen.Contains("app/resources/migrations/versions/0034_qq_initiative_min_score.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0034_qq_initiative_min_score.sql");
            if (manifest.SchemaVersion >= 35 && !seen.Contains("app/resources/migrations/versions/0035_qq_reply_split.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0035_qq_reply_split.sql");
            if (manifest.SchemaVersion >= 36 && !seen.Contains("app/resources/migrations/versions/0036_qq_judgement_reuse.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0036_qq_judgement_reuse.sql");
            if (manifest.SchemaVersion >= 37 && !seen.Contains("app/resources/migrations/versions/0037_qq_judgement_per_speaker.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0037_qq_judgement_per_speaker.sql");
            if (manifest.SchemaVersion >= 38 && !seen.Contains("app/resources/migrations/versions/0038_qq_judgement_model.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0038_qq_judgement_model.sql");
            if (manifest.SchemaVersion >= 39 && !seen.Contains("app/resources/migrations/versions/0039_agent_runs.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0039_agent_runs.sql");
            if (manifest.SchemaVersion >= 40 && !seen.Contains("app/resources/migrations/versions/0040_conversation_wakes.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0040_conversation_wakes.sql");
            if (manifest.SchemaVersion >= 42 && !seen.Contains("app/resources/migrations/versions/0042_runtime_observability.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0042_runtime_observability.sql");
            if (manifest.SchemaVersion >= 43 && !seen.Contains("app/resources/migrations/versions/0043_protected_model_results.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0043_protected_model_results.sql");
            if (manifest.SchemaVersion >= 44 && !seen.Contains("app/resources/migrations/versions/0044_conversation_avatars.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0044_conversation_avatars.sql");
            if (manifest.SchemaVersion >= 41 && !seen.Contains("app/resources/migrations/versions/0041_outbound_intents.sql"))
                throw new InvalidDataException("MANIFEST_MISSING_REQUIRED: app/resources/migrations/versions/0041_outbound_intents.sql");
            var launcher = root.ContainsKey("launcher") ? root["launcher"] as Dictionary<string, object> : null;
            if (launcher == null) throw new InvalidDataException("MANIFEST_MISSING_LAUNCHER");
            manifest.Launcher = new FileRecord
            {
                Path = RequireAnyString(launcher, "path"),
                Sha256 = RequireAnyString(launcher, "sha256"),
            };
            if (manifest.Launcher.Path != "superstring.exe" || manifest.Launcher.Sha256.Length != 64
                || !IsHex(manifest.Launcher.Sha256))
                throw new InvalidDataException("MANIFEST_INVALID_LAUNCHER");
            return manifest;
        }

        internal static readonly string[] RequiredFiles = new string[]
        {
            "app/superstring-server.exe",
            "app/resources/web/index.html",
            "app/resources/migrations/versions/0001_initial.sql",
        };

        internal static bool IsHex(string value)
        {
            foreach (char c in value)
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
            return true;
        }

        internal static string HashFile(string filename)
        {
            using (var hash = SHA256.Create())
            using (var stream = File.OpenRead(filename))
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        /// <summary>Verify every recorded file (program resources and launcher) on disk.</summary>
        internal void VerifyOnDisk(string root)
        {
            foreach (FileRecord record in Files)
            {
                string filename = Path.Combine(root, record.Path.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(filename)) throw new InvalidDataException("VERIFY_MISSING: " + record.Path);
                if (HashFile(filename) != record.Sha256) throw new InvalidDataException("VERIFY_MISMATCH: " + record.Path);
            }
            string launcher = Path.Combine(root, Launcher.Path);
            if (!File.Exists(launcher)) throw new InvalidDataException("VERIFY_MISSING: " + Launcher.Path);
            if (HashFile(launcher) != Launcher.Sha256) throw new InvalidDataException("VERIFY_MISMATCH: " + Launcher.Path);
        }

        private static void RequireInteger(Dictionary<string, object> map, string key, int expected)
        {
            object value;
            if (!map.TryGetValue(key, out value) || !(value is int) || (int)value != expected)
                throw new InvalidDataException("MANIFEST_UNSUPPORTED_FIELD: " + key);
        }

        private static void RequireString(Dictionary<string, object> map, string key, string expected)
        {
            object value;
            if (!map.TryGetValue(key, out value) || !(value is string) || (string)value != expected)
                throw new InvalidDataException("MANIFEST_IDENTITY_MISMATCH: " + key);
        }

        private static string RequireAnyString(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value) || !(value is string) || ((string)value).Length == 0)
                throw new InvalidDataException("MANIFEST_MISSING_FIELD: " + key);
            return (string)value;
        }
    }
}
