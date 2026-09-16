using System;
using System.IO;

namespace Superstring.Setup
{
    /// <summary>
    /// Read-only, seekable window over a byte range of another stream. The setup
    /// payload is a ZIP appended to this EXE, so ZipArchive must not see the
    /// trailing trailer or the executable header.
    /// </summary>
    internal sealed class BoundedStream : Stream
    {
        private readonly Stream _inner;
        private readonly long _start;
        private readonly long _length;
        private long _position;

        internal BoundedStream(Stream inner, long start, long length)
        {
            if (inner == null) throw new ArgumentNullException("inner");
            if (start < 0 || length < 0) throw new ArgumentOutOfRangeException("start");
            _inner = inner;
            _start = start;
            _length = length;
        }

        internal static BoundedStream OpenFile(string filename, long start, long length)
        {
            // FileShare.Read lets the running executable be read while it is executing.
            var file = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            try
            {
                if (start + length > file.Length) throw new InvalidDataException("Payload range exceeds the file length.");
                return new BoundedStream(file, start, length);
            }
            catch
            {
                file.Dispose();
                throw;
            }
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return _length; } }

        public override long Position
        {
            get { return _position; }
            set
            {
                if (value < 0) throw new ArgumentOutOfRangeException("value");
                _position = value;
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remaining = _length - _position;
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            _inner.Position = _start + _position;
            int read = _inner.Read(buffer, offset, count);
            _position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            if (origin == SeekOrigin.Begin) target = offset;
            else if (origin == SeekOrigin.Current) target = _position + offset;
            else target = _length + offset;
            if (target < 0) throw new IOException("Cannot seek before the payload start.");
            _position = target;
            return _position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
