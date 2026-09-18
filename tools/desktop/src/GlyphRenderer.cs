using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace Superstring.Desktop
{
    /// <summary>
    /// Renders the approved 24x24 brand glyph with System.Drawing.
    /// Shared by the embedded icon and form header; circular corners use exact arcs.
    /// </summary>
    internal static class GlyphRenderer
    {
        // 24x24 viewBox, matching the SVG.
        public const float ViewBox = 24f;

        public static readonly Color DefaultColor = Color.FromArgb(0x23, 0x27, 0x2E);

        private static readonly string[] StrokedPaths = new string[]
        {
            "M7.6 10h8.8a1.6 1.6 0 0 1 1.6 1.6V17a1.6 1.6 0 0 1-1.6 1.6h-6.9l-1.9 1.9v-1.9A1.6 1.6 0 0 1 6 17v-5.4A1.6 1.6 0 0 1 7.6 10Z",
            "M1.85 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57",
            "M3.7025 2.55c-.38 .57-.6175 1.1875-.7125 1.8525c.38-.0475 .7125-.266 .931-.57",
            "M20.2975 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57",
            "M22.15 4.4025c.38-.57 .6175-1.1875 .7125-1.8525c-.38 .0475-.7125 .266-.931 .57",
            "M7.95 14.85C8.6 14.85 8.775 13.1 10.065 13.1C10.71 13.1 11.355 13.5 12 14.3C12.645 15.1 13.29 15.5 13.935 15.5C15.225 15.5 15.4 13.75 16.05 13.75",
        };

        private static readonly float[] StrokeWidths = new float[]
        {
            1.7f, 1.3f, 1.3f, 1.3f, 1.3f, 1.4f,
        };

        public static void Draw(Graphics g, Rectangle bounds, Color color)
        {
            float scale = Math.Min(bounds.Width, bounds.Height) / ViewBox;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            float offX = bounds.X + (bounds.Width - ViewBox * scale) / 2f;
            float offY = bounds.Y + (bounds.Height - ViewBox * scale) / 2f;
            g.TranslateTransform(offX, offY);
            g.ScaleTransform(scale, scale);

            using (var brush = new SolidBrush(color))
            {
                FillCircle(g, brush, 10.065f, 13.1f, 1.6f);
                FillCircle(g, brush, 13.935f, 15.5f, 1.6f);

                for (int i = 0; i < StrokedPaths.Length; i++)
                {
                    float w = StrokeWidths[i]; // Graphics already applies the viewBox scale.
                    using (var pen = new Pen(color, w))
                    {
                        pen.LineJoin = LineJoin.Round;
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        using (var path = BuildPath(StrokedPaths[i]))
                        {
                            g.DrawPath(pen, path);
                        }
                    }
                }
            }
            g.ResetTransform();
        }

        private static void FillCircle(Graphics g, Brush b, float cx, float cy, float r)
        {
            g.FillEllipse(b, cx - r, cy - r, r * 2f, r * 2f);
        }

        private static GraphicsPath BuildPath(string d)
        {
            var path = new GraphicsPath();
            if (d == StrokedPaths[0])
            {
                // Exact circular SVG corners (r=1.6), not straight-line approximations.
                path.AddLine(7.6f, 10f, 16.4f, 10f);
                path.AddArc(14.8f, 10f, 3.2f, 3.2f, 270f, 90f);
                path.AddLine(18f, 11.6f, 18f, 17f);
                path.AddArc(14.8f, 15.4f, 3.2f, 3.2f, 0f, 90f);
                path.AddLine(16.4f, 18.6f, 9.5f, 18.6f);
                path.AddLine(9.5f, 18.6f, 7.6f, 20.5f);
                path.AddLine(7.6f, 20.5f, 7.6f, 18.6f);
                path.AddArc(6f, 15.4f, 3.2f, 3.2f, 90f, 90f);
                path.AddLine(6f, 17f, 6f, 11.6f);
                path.AddArc(6f, 10f, 3.2f, 3.2f, 180f, 90f);
                path.CloseFigure();
                return path;
            }
            var tokens = Tokenize(d);
            int n = 0;
            float x = 0f, y = 0f;     // current point
            float px = 0f, py = 0f;   // previous point (segment start)
            char cmd = ' ';
            while (n < tokens.Count)
            {
                string t = tokens[n];
                if (t.Length == 1 && IsCommand(t[0]))
                {
                    cmd = t[0];
                    n++;
                    if (cmd == 'Z' || cmd == 'z')
                    {
                        path.CloseFigure();
                        continue;
                    }
                }

                bool rel = char.IsLower(cmd);
                char C = char.ToUpper(cmd);

                if (C == 'M')
                {
                    float nx = Next(tokens, ref n);
                    float ny = Next(tokens, ref n);
                    if (rel) { nx += x; ny += y; }
                    x = nx; y = ny;
                    px = x; py = y;
                    path.StartFigure();
                }
                else if (C == 'L')
                {
                    float nx = Next(tokens, ref n);
                    float ny = Next(tokens, ref n);
                    if (rel) { nx += x; ny += y; }
                    path.AddLine(px, py, nx, ny);
                    x = nx; y = ny; px = x; py = y;
                }
                else if (C == 'H')
                {
                    float nx = Next(tokens, ref n);
                    if (rel) nx += x;
                    path.AddLine(px, py, nx, y);
                    x = nx; px = x; py = y;
                }
                else if (C == 'V')
                {
                    float ny = Next(tokens, ref n);
                    if (rel) ny += y;
                    path.AddLine(px, py, x, ny);
                    y = ny; px = x; py = y;
                }
                else if (C == 'C')
                {
                    float x1 = Next(tokens, ref n), y1 = Next(tokens, ref n);
                    float x2 = Next(tokens, ref n), y2 = Next(tokens, ref n);
                    float nx = Next(tokens, ref n), ny = Next(tokens, ref n);
                    if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
                    path.AddBezier(new PointF(px, py), new PointF(x1, y1), new PointF(x2, y2), new PointF(nx, ny));
                    x = nx; y = ny; px = x; py = y;
                }
                else if (C == 'A')
                {
                    throw new NotSupportedException("Arcs must use the exact explicit bubble geometry.");
                }
                else
                {
                    n++; // unknown token, skip defensively
                }
            }
            return path;
        }

        private static float Next(List<string> tokens, ref int n)
        {
            float v = 0f;
            if (n < tokens.Count)
            {
                float.TryParse(tokens[n], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v);
                n++;
            }
            return v;
        }

        private static bool IsCommand(char c)
        {
            return "MmLlHhVvCcAaZz".IndexOf(c) >= 0;
        }

        private static List<string> Tokenize(string d)
        {
            var outp = new List<string>();
            int i = 0;
            while (i < d.Length)
            {
                char c = d[i];
                if (char.IsWhiteSpace(c) || c == ',' || c == '+')
                {
                    i++;
                    continue;
                }
                if (c == '-' || (char.IsDigit(c) || c == '.') || (c == 'e' || c == 'E'))
                {
                    // Signed/unsigned number (also catches exponent continuation).
                    int j = i;
                    if (d[j] == '+' || d[j] == '-') j++;
                    while (j < d.Length && (char.IsDigit(d[j]) || d[j] == '.' || d[j] == 'e' || d[j] == 'E'
                        || ((d[j] == '+' || d[j] == '-') && (d[j - 1] == 'e' || d[j - 1] == 'E'))))
                        j++;
                    outp.Add(d.Substring(i, j - i));
                    i = j;
                    continue;
                }
                if (IsCommand(c))
                {
                    outp.Add(c.ToString());
                    i++;
                    continue;
                }
                i++;
            }
            return outp;
        }
    }
}
