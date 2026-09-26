using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace Superstring.Setup
{
    /// <summary>
    /// Locates and opens the ZIP payload appended to this executable. The trailer
    /// is written by tools/installer/build-package.mjs; nothing is read from the
    /// working directory, so the setup EXE stays self-contained.
    /// </summary>
    internal sealed class Payload : IDisposable
    {
        internal const string Magic = "SSSETUP1";
        internal const int TrailerBytes = 24;

        private readonly BoundedStream _stream;
        private readonly ZipArchive _archive;

        internal long PayloadOffset { get; private set; }
        internal long PayloadLength { get; private set; }

        private Payload(BoundedStream stream, long offset, long length)
        {
            _stream = stream;
            PayloadOffset = offset;
            PayloadLength = length;
            _archive = new ZipArchive(stream, ZipArchiveMode.Read, true);
        }

        internal ZipArchive Archive { get { return _archive; } }

        internal static Payload OpenCurrent()
        {
            return Open(Process.GetCurrentProcess().MainModule.FileName);
        }

        internal static Payload Open(string executable)
        {
            long offset, length;
            using (var file = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (file.Length < TrailerBytes + 1) throw new InvalidDataException("SETUP_PAYLOAD_MISSING");
                var trailer = new byte[TrailerBytes];
                file.Position = file.Length - TrailerBytes;
                ReadExactly(file, trailer, 0, TrailerBytes);
                if (Encoding.ASCII.GetString(trailer, 0, 8) != Magic) throw new InvalidDataException("SETUP_PAYLOAD_MISSING");
                length = BitConverter.ToInt64(trailer, 8);
                offset = BitConverter.ToInt64(trailer, 16);
                if (length <= 0 || offset <= 0 || offset + length + TrailerBytes != file.Length)
                    throw new InvalidDataException("SETUP_PAYLOAD_TRUNCATED");
            }
            return new Payload(BoundedStream.OpenFile(executable, offset, length), offset, length);
        }

        private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
        {
            int read = 0;
            while (read < count)
            {
                int step = stream.Read(buffer, offset + read, count - read);
                if (step <= 0) throw new EndOfStreamException();
                read += step;
            }
        }

        /// <summary>
        /// Entries the payload cannot be installed without. The R1 probe migration is
        /// deliberately absent: it is a development surface and must never be required
        /// from (or present in) a release package.
        /// </summary>
        internal static readonly string[] RequiredEntries = new string[]
        {
            "superstring.exe",
            "build-manifest.json",
            "app/superstring-server.exe",
            "app/resources/web/index.html",
            "app/resources/migrations/versions/0001_initial.sql",
            "app/resources/migrations/versions/0002_knowledge.sql",
            "app/resources/migrations/versions/0003_knowledge_read.sql",
            "app/resources/migrations/versions/0004_organization.sql",
            "app/resources/migrations/versions/0005_qq_transport.sql",
            "app/resources/migrations/versions/0006_qq_memory_sources.sql",
            "app/resources/migrations/versions/0007_qq_observation_text.sql",
            "app/resources/migrations/versions/0008_qq_memory_batch.sql",
            "app/resources/migrations/versions/0009_qq_transport_config.sql",
            "app/resources/migrations/versions/0010_qq_schemes.sql", "app/resources/migrations/versions/0011_qq_speech_log.sql", "app/resources/migrations/versions/0012_qq_media_notes.sql", "app/resources/migrations/versions/0013_qq_scheme_triggers.sql", "app/resources/migrations/versions/0014_qq_send_log.sql", "app/resources/migrations/versions/0015_qq_scheme_rhythm.sql", "app/resources/migrations/versions/0016_qq_context_budget.sql", "app/resources/migrations/versions/0017_qq_scheme_prompts.sql", "app/resources/migrations/versions/0018_qq_members.sql", "app/resources/migrations/versions/0019_qq_output_reserve.sql",
        "app/resources/migrations/versions/0020_qq_scheme_stickers.sql",
        "app/resources/migrations/versions/0021_qq_stickers.sql",
        "app/resources/migrations/versions/0022_qq_sticker_authorization.sql",
        "app/resources/migrations/versions/0023_qq_dispatch.sql",
        "app/resources/migrations/versions/0024_qq_media_purposes.sql",
        "app/resources/migrations/versions/0025_desktop_settings.sql",
        "app/resources/migrations/versions/0026_qq_media_supplement.sql",
        "app/resources/migrations/versions/0027_qq_event_addressed.sql",
        "app/resources/migrations/versions/0028_qq_immediate_lease.sql",
        "app/resources/migrations/versions/0029_qq_module_switches.sql",
        "app/resources/migrations/versions/0030_qq_sweep_verdicts.sql",
        "app/resources/migrations/versions/0031_qq_attention.sql",
        "app/resources/migrations/versions/0032_model_providers.sql",
        "app/resources/migrations/versions/0033_qq_idle_judgements.sql",
        "app/resources/migrations/versions/0034_qq_initiative_min_score.sql",
        "app/resources/migrations/versions/0035_qq_reply_split.sql",
        "app/resources/migrations/versions/0036_qq_judgement_reuse.sql",
        "app/resources/migrations/versions/0037_qq_judgement_per_speaker.sql",
        "app/resources/migrations/versions/0038_qq_judgement_model.sql",
        "app/resources/migrations/versions/0039_agent_runs.sql", "app/resources/migrations/versions/0040_conversation_wakes.sql", "app/resources/migrations/versions/0041_outbound_intents.sql", "app/resources/migrations/versions/0042_runtime_observability.sql",
        };

        /// <summary>Total uncompressed size, used for the conservative space budget.</summary>
        internal long UncompressedSize()
        {
            long total = 0;
            foreach (ZipArchiveEntry entry in _archive.Entries)
            {
                if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;
                total += entry.Length;
            }
            return total;
        }

        /// <summary>Reject absolute paths, traversal, odd segments and duplicate names.</summary>
        internal void ValidateEntries()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (ZipArchiveEntry entry in _archive.Entries)
            {
                string name = entry.FullName.Replace('\\', '/');
                // Directory entries are tolerated (some zip writers emit them) but are
                // never counted as content.
                if (name.EndsWith("/", StringComparison.Ordinal))
                {
                    if (!seen.Add(name)) throw new InvalidDataException("SETUP_PAYLOAD_DUPLICATE: " + name);
                    continue;
                }
                if (name.StartsWith("/", StringComparison.Ordinal) || name.Contains(":") || name.Contains(".."))
                    throw new InvalidDataException("SETUP_PAYLOAD_UNSAFE_PATH: " + name);
                foreach (string segment in name.Split('/'))
                {
                    if (segment.Length == 0 || segment == "." || segment.TrimEnd(' ', '.') != segment)
                        throw new InvalidDataException("SETUP_PAYLOAD_UNSAFE_PATH: " + name);
                    if (segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                        throw new InvalidDataException("SETUP_PAYLOAD_UNSAFE_PATH: " + name);
                }
                if (!seen.Add(name)) throw new InvalidDataException("SETUP_PAYLOAD_DUPLICATE: " + name);
            }
            foreach (string required in RequiredEntries)
            {
                ZipArchiveEntry entry = _archive.GetEntry(required);
                if (entry == null || entry.Length == 0) throw new InvalidDataException("SETUP_PAYLOAD_INCOMPLETE: " + required);
            }
        }

        public void Dispose()
        {
            _archive.Dispose();
            _stream.Dispose();
        }
    }
}
