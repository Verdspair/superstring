using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;

namespace Superstring.Desktop
{
    /// <summary>
    /// Draws embedded PNG frames generated from src/shared/brand/superstring.svg.
    /// Geometry and SVG interpretation belong to the shared source and build-time resvg.
    /// The native view only selects resolution and tints the monochrome alpha mask.
    /// </summary>
    internal static class GlyphRenderer
    {
        public static readonly Color DefaultColor = Color.FromArgb(0x23, 0x27, 0x2E);
        private static readonly int[] Sizes = new int[] { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        private static readonly Dictionary<int, Bitmap> Frames = LoadFrames();

        private static Dictionary<int, Bitmap> LoadFrames()
        {
            var frames = new Dictionary<int, Bitmap>();
            Assembly assembly = typeof(GlyphRenderer).Assembly;
            foreach (int size in Sizes)
            {
                string name = "Superstring.Desktop.Brand." + size + ".png";
                using (Stream stream = assembly.GetManifestResourceStream(name))
                {
                    if (stream == null) throw new InvalidOperationException("Missing embedded brand resource: " + name);
                    using (Image image = Image.FromStream(stream))
                    {
                        // Clone so the process-lifetime bitmap does not depend on an open resource stream.
                        frames.Add(size, new Bitmap(image));
                    }
                }
            }
            return frames;
        }

        public static void Draw(Graphics g, Rectangle bounds, Color color)
        {
            int side = Math.Min(bounds.Width, bounds.Height);
            if (side <= 0) return;
            int frameSize = Sizes[Sizes.Length - 1];
            foreach (int candidate in Sizes)
            {
                if (candidate >= side) { frameSize = candidate; break; }
            }
            Bitmap frame = Frames[frameSize];
            var target = new Rectangle(bounds.X + (bounds.Width - side) / 2, bounds.Y + (bounds.Height - side) / 2, side, side);
            var state = g.Save();
            try
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                using (var attributes = new ImageAttributes())
                {
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    attributes.SetColorMatrix(new ColorMatrix(new float[][]
                    {
                        new float[] { 0, 0, 0, 0, 0 },
                        new float[] { 0, 0, 0, 0, 0 },
                        new float[] { 0, 0, 0, 0, 0 },
                        new float[] { 0, 0, 0, color.A / 255f, 0 },
                        new float[] { color.R / 255f, color.G / 255f, color.B / 255f, 0, 1 },
                    }));
                    g.DrawImage(frame, target, 0, 0, frame.Width, frame.Height, GraphicsUnit.Pixel, attributes);
                }
            }
            finally { g.Restore(state); }
        }
    }
}
