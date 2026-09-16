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
