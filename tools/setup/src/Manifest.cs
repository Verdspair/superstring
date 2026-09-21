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
        internal const int SupportedSchemaVersion = 4;
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
