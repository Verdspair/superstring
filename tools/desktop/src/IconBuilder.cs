using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace Superstring.Desktop
{
    /// <summary>
    /// Build-time helper (not part of the launcher EXE). Renders the brand glyph at
    /// nine sizes and packs them into a single .ico. Run by build/build.ps1; the
    /// resulting .ico is embedded into superstring.exe via /win32icon.
    /// </summary>
    internal static class IconBuilder
    {
        private static readonly int[] Sizes = new int[] { 16, 20, 24, 32, 40, 48, 64, 128, 256 };

        private static int Main(string[] args)
        {
            string outPath = args.Length > 0 ? args[0] : "superstring.ico";
            try
            {
                var frames = new List<byte[]>();
                foreach (int s in Sizes)
                {
                    using (var bmp = new Bitmap(s, s, PixelFormat.Format32bppArgb))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            g.Clear(Color.Transparent);
                            GlyphRenderer.Draw(g, new Rectangle(0, 0, s, s), GlyphRenderer.DefaultColor);
                        }
                        frames.Add(ToDibBytes(bmp));
                        if (s == 256) bmp.Save(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(outPath)), "superstring-preview.png"), ImageFormat.Png);
                    }
                }
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

        private static void WriteIco(string path, List<byte[]> frames)
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
                    byte[] data = frames[i];
                    int size = Sizes[i];
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
                    w.Write(frames[i]);
                }
            }
        }
    }
}
