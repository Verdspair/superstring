using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace Superstring.Desktop
{
    /// <summary>
    /// Build-time helper (not part of the launcher EXE). Packs icon frames into one .ico that
    /// csc embeds into superstring.exe via /win32icon.
    /// With only an output path it draws the glyph through GlyphRenderer at the nine legacy
    /// sizes, so the retiring C# shell keeps working unchanged. With --png-dir it packs
    /// already rendered PNG frames instead: the size ladder then belongs to the renderer
    /// (build/brand-assets.mjs) and every ICO entry size is read from its PNG.
    /// </summary>
    internal static class IconBuilder
    {
        // Legacy GlyphRenderer ladder; must keep matching the embedded brand resources.
        private static readonly int[] Sizes = new int[] { 16, 20, 24, 32, 40, 48, 64, 128, 256 };

        private const string PngDirectoryOption = "--png-dir";
        private const string PngDirectoryPrefix = "--png-dir=";
        private const string Usage =
            "usage: IconBuilder.exe <out.ico> [--png-dir <directory of PNG frames>]";

        /// <summary>One ICO frame: DIB bytes for csc, PNG bytes only for the build preview.</summary>
        private sealed class Frame
        {
            public readonly int Size;
            public readonly byte[] Dib;
            public readonly byte[] Png;

            public Frame(int size, byte[] dib, byte[] png)
            {
                Size = size;
                Dib = dib;
                Png = png;
            }
        }

        private static int Main(string[] args)
        {
            string outPath;
            string pngDirectory;
            string error;
            if (!TryParseArguments(args, out outPath, out pngDirectory, out error))
            {
                Console.Error.WriteLine(error);
                return 1;
            }
            try
            {
                List<Frame> frames = pngDirectory == null ? GlyphFrames() : ReadPngFrames(pngDirectory);
                if (frames.Count == 0) throw new InvalidOperationException("no icon frames to pack");
                Frame preview = frames[0];
                foreach (Frame frame in frames)
                    if (frame.Size > preview.Size) preview = frame;
                // Written before the .ico so a failed pack still leaves the visual reference.
                File.WriteAllBytes(PreviewPath(outPath), preview.Png);
                WriteIco(outPath, frames);
                Console.WriteLine("icon written: " + outPath + " (" + frames.Count + " frames)");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("icon build failed: " + ex.Message);
                return 1;
            }
        }

        private static bool TryParseArguments(
            string[] args, out string outPath, out string pngDirectory, out string error)
        {
            outPath = "superstring.ico";
            pngDirectory = null;
            error = null;
            var positional = new List<string>();
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                string directory;
                if (arg == PngDirectoryOption)
                {
                    if (i + 1 >= args.Length)
                    {
                        error = Usage;
                        return false;
                    }
                    directory = args[++i];
                }
                else if (arg.StartsWith(PngDirectoryPrefix, StringComparison.Ordinal))
                {
                    directory = arg.Substring(PngDirectoryPrefix.Length);
                }
                else if (arg.StartsWith("-", StringComparison.Ordinal))
                {
                    error = "unknown option " + arg + Environment.NewLine + Usage;
                    return false;
                }
                else
                {
                    positional.Add(arg);
                    continue;
                }
                if (directory.Length == 0 || pngDirectory != null)
                {
                    error = Usage;
                    return false;
                }
                pngDirectory = directory;
            }
            if (positional.Count > 1)
            {
                error = Usage;
                return false;
            }
            if (positional.Count == 1) outPath = positional[0];
            return true;
        }

        private static List<Frame> GlyphFrames()
        {
            var frames = new List<Frame>();
            foreach (int s in Sizes)
            {
                using (var bmp = new Bitmap(s, s, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.Clear(Color.Transparent);
                        GlyphRenderer.Draw(g, new Rectangle(0, 0, s, s), GlyphRenderer.DefaultColor);
                    }
                    bool preview = s == Sizes[Sizes.Length - 1];
                    frames.Add(new Frame(s, ToDibBytes(bmp), preview ? ToPngBytes(bmp) : null));
                }
            }
            return frames;
        }

        private static List<Frame> ReadPngFrames(string directory)
        {
            if (!Directory.Exists(directory))
                throw new DirectoryNotFoundException("PNG frame directory not found: " + directory);
            var frames = new List<Frame>();
            var sizes = new List<int>();
            foreach (string file in Directory.GetFiles(directory, "*.png"))
            {
                byte[] png = File.ReadAllBytes(file);
                using (var stream = new MemoryStream(png, false))
                using (var image = new Bitmap(stream))
                {
                    int size = image.Width;
                    if (size != image.Height)
                        throw new InvalidOperationException("icon frame is not square: " + file);
                    if (size > 256)
                        throw new InvalidOperationException(
                            "icon frame exceeds the 256 px ICO limit: " + file);
                    if (sizes.Contains(size))
                        throw new InvalidOperationException(
                            "duplicate icon frame size " + size + ": " + file);
                    sizes.Add(size);
                    frames.Add(new Frame(size, ToDibBytes(image), png));
                }
            }
            // ICO expects ascending sizes; Directory.GetFiles order is filesystem-defined.
            frames.Sort(delegate(Frame a, Frame b) { return a.Size.CompareTo(b.Size); });
            return frames;
        }

        private static string PreviewPath(string outPath)
        {
            return Path.Combine(
                Path.GetDirectoryName(Path.GetFullPath(outPath)), "superstring-preview.png");
        }

        private static byte[] ToPngBytes(Bitmap bmp)
        {
            using (var stream = new MemoryStream())
            {
                bmp.Save(stream, ImageFormat.Png);
                return stream.ToArray();
            }
        }

        private static byte[] ToDibBytes(Bitmap bmp)
        {
            // Legacy csc Win32 resource compiler requires DIB frames, not PNG.
            using (var ms = new MemoryStream())
            using (var w = new BinaryWriter(ms))
            {
                int maskStride = ((bmp.Width + 31) / 32) * 4;
                w.Write(40); w.Write(bmp.Width); w.Write(bmp.Height * 2);
                w.Write((ushort)1); w.Write((ushort)32); w.Write(0);
                w.Write(bmp.Width * bmp.Height * 4); w.Write(0); w.Write(0); w.Write(0); w.Write(0);
                for (int y = bmp.Height - 1; y >= 0; y--)
                    for (int x = 0; x < bmp.Width; x++)
                    {
                        Color c = bmp.GetPixel(x, y);
                        w.Write(c.B); w.Write(c.G); w.Write(c.R); w.Write(c.A);
                    }
                for (int y = bmp.Height - 1; y >= 0; y--)
                {
                    byte[] mask = new byte[maskStride];
                    for (int x = 0; x < bmp.Width; x++)
                        if (bmp.GetPixel(x, y).A == 0) mask[x / 8] |= (byte)(128 >> (x % 8));
                    w.Write(mask);
                }
                return ms.ToArray();
            }
        }

        private static void WriteIco(string path, List<Frame> frames)
        {
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
            using (var w = new BinaryWriter(fs))
            {
                // ICONDIR
                w.Write((ushort)0);            // reserved
                w.Write((ushort)1);            // type = icon
                w.Write((ushort)frames.Count); // count

                // Pre-compute offsets: header(6) + entries(16*count)
                int offset = 6 + 16 * frames.Count;
                for (int i = 0; i < frames.Count; i++)
                {
                    byte[] data = frames[i].Dib;
                    int size = frames[i].Size;
                    w.Write((byte)(size >= 256 ? 0 : size)); // bWidth
                    w.Write((byte)(size >= 256 ? 0 : size)); // bHeight
                    w.Write((byte)0);   // bColorCount
                    w.Write((byte)0);   // bReserved
                    w.Write((ushort)1); // wPlanes
                    w.Write((ushort)32);// wBitCount
                    w.Write((uint)data.Length); // dwBytesInRes
                    w.Write((uint)offset);      // dwImageOffset
                    offset += data.Length;
                }
                for (int i = 0; i < frames.Count; i++)
                {
                    w.Write(frames[i].Dib);
                }
            }
        }
    }
}
