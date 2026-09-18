using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    // Mirrors src/web/styles.css default light tokens. The launcher resolves the
    // real palette via DesktopAppearance.Resolve (theme + mode, system->Windows)
    // and pushes it here with Apply(); controls repaint from these fields, so a
    // theme/mode change takes effect on the next Invalidate.
    internal static class DesktopStyle
    {
        public static Color Surface = ColorTranslator.FromHtml("#ffffff");
        public static Color Text = ColorTranslator.FromHtml("#242b36");
        public static Color Muted = ColorTranslator.FromHtml("#616b79");
        public static Color Deep = ColorTranslator.FromHtml("#26364a");
        public static Color Line = ColorTranslator.FromHtml("#dce2e9");
        public static Color Soft = ColorTranslator.FromHtml("#f7f8fa");
        public static Color Accent = ColorTranslator.FromHtml("#4266b0");

        public static void Apply(DesktopAppearance.ResolvedPalette p)
        {
            Surface = p.Surface;
            Text = p.Text;
            Muted = p.Muted;
            Deep = p.Deep;
            Line = p.Line;
            Soft = p.Soft;
            Accent = p.Accent;
        }

        public static GraphicsPath Rounded(RectangleF rect, float radius)
        {
            float d = radius * 2;
            var p = new GraphicsPath();
            p.AddArc(rect.X, rect.Y, d, d, 180, 90);
            p.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            p.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            p.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    /// <summary>Three fading dots indicate activity without a percentage.</summary>
    internal sealed class IndeterminateDot : Control
    {
        private readonly Timer _timer = new Timer { Interval = 140 };
        private int _frame;
        private bool _animating;

        public bool IsAnimating { get { return _animating; } }

        public IndeterminateDot()
        {
            SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
            BackColor = Color.Transparent;
            DoubleBuffered = true;
            _timer.Tick += (s, e) => { _frame = (_frame + 1) % 3; Invalidate(); };
        }

        public void Start()
        {
            _animating = true;
            _frame = 0;
            if (!_timer.Enabled) _timer.Start();
            Invalidate();
        }

        public void Stop()
        {
            _animating = false;
            _timer.Stop();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int cy = Height / 2;
            int spacing = 14;
            int startX = Width / 2 - spacing;
            for (int i = 0; i < 3; i++)
            {
                int phase = (_frame - i + 300) % 3;
                double a = phase == 0 ? 1.0 : (phase == 1 ? 0.45 : 0.18);
                using (var b = new SolidBrush(Color.FromArgb((int)(a * 255), DesktopStyle.Deep)))
                    g.FillEllipse(b, startX + i * spacing - 4, cy - 4, 8, 8);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _timer.Dispose();
            base.Dispose(disposing);
        }
    }

    internal sealed class OutlineButton : Button
    {
        public bool Primary;
        private bool _hover;
        private bool _pressed;
        public OutlineButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            UseVisualStyleBackColor = false;
            BackColor = DesktopStyle.Surface;
            Cursor = Cursors.Hand;
        }
        protected override void OnMouseEnter(EventArgs e) { _hover = true; base.OnMouseEnter(e); Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { _hover = false; _pressed = false; base.OnMouseLeave(e); Invalidate(); }
        protected override void OnMouseDown(MouseEventArgs e) { _pressed = true; base.OnMouseDown(e); Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { _pressed = false; base.OnMouseUp(e); Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            float s = e.Graphics.DpiX / 96f;
            e.Graphics.Clear(Parent == null ? DesktopStyle.Surface : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = Primary ? DesktopStyle.Deep : (_hover || _pressed ? DesktopStyle.Soft : DesktopStyle.Surface);
            Color ink = Primary ? DesktopStyle.Surface : DesktopStyle.Text;
            Color border = Primary ? DesktopStyle.Deep : (_hover ? DesktopStyle.Muted : DesktopStyle.Line);
            if (!Enabled) { fill = Mix(fill, DesktopStyle.Surface); ink = Mix(ink, DesktopStyle.Surface); border = Mix(border, DesktopStyle.Surface); }
            using (var p = DesktopStyle.Rounded(new RectangleF(2 * s, 2 * s, Width - 4 * s, Height - 4 * s), 8 * s))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(border, s)) { e.Graphics.FillPath(brush, p); e.Graphics.DrawPath(pen, p); }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            if (Focused && ShowFocusCues)
                using (var p = DesktopStyle.Rounded(new RectangleF(s, s, Width - 2 * s, Height - 2 * s), 8 * s))
                using (var pen = new Pen(DesktopStyle.Accent, 2 * s)) e.Graphics.DrawPath(pen, p);
        }
        private static Color Mix(Color a, Color b) { return Color.FromArgb((a.R + b.R) / 2, (a.G + b.G) / 2, (a.B + b.B) / 2); }
    }

    /// <summary>English brand only (no subtitle), project light palette, 680x460 logical
    /// layout. Centered brand + status with a lightweight, percentage-free indicator.
    /// No operation buttons are shown in the normal state; retry and an expandable
    /// details box appear only on failure. The native title bar (X) still cancels
    /// safely via FormClosingH. Auto-start on Shown and hide-on-ready are unchanged.</summary>
    internal sealed class MainForm : Form
    {
        private Label _status;
        private TextBox _detail;
        private IndeterminateDot _spinner;
        private OutlineButton _retry;
        private OutlineButton _details;
        private bool _detailsShown;

        // Current appearance selection. ApplyAppearance resolves the concrete
        // palette via DesktopAppearance (16-colour source, mode + Windows system
        // detection) and recolours the form — no cached/duplicated colour source.
        private string _themeId = "slate";
        private string _themeMode = "system";

        public event EventHandler RetryRequested;
        public event EventHandler DetailsToggled;
        public event FormClosingEventHandler FormClosingH;

        public MainForm()
        {
            SuspendLayout();
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            Font = new Font("Segoe UI", 10.5F, FontStyle.Regular, GraphicsUnit.Point);
            ClientSize = new Size(680, 460);
            Text = "superstring";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = DesktopStyle.Surface;
            DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // Centered brand glyph.
            var brand = new PictureBox { Name = "brand", Location = new Point(312, 92), Size = new Size(56, 56), BackColor = Color.Transparent, SizeMode = PictureBoxSizeMode.CenterImage };
            brand.Paint += (s, e) => GlyphRenderer.Draw(e.Graphics, brand.ClientRectangle, DesktopStyle.Deep);
            Controls.Add(brand);

            // Centered brand name (English only, no subtitle).
            var brandName = new Label { Name = "brandName", Text = "superstring", Location = new Point(0, 156), Size = new Size(680, 40), Font = new Font("Segoe UI Semibold", 18F, FontStyle.Regular, GraphicsUnit.Point), ForeColor = DesktopStyle.Text, TextAlign = ContentAlignment.MiddleCenter };
            Controls.Add(brandName);

            // Lightweight, percentage-free activity indicator.
            _spinner = new IndeterminateDot { Name = "spinner", Location = new Point(313, 212), Size = new Size(54, 18), Visible = false };
            Controls.Add(_spinner);

            // Centered status line.
            // Assign the font before design bounds: inheriting it on Controls.Add can
            // rescale Label.Size at high DPI before the form's own DPI pass.
            _status = new Label { Font = Font, Name = "status", Location = new Point(40, 252), Size = new Size(600, 44), BackColor = DesktopStyle.Surface, ForeColor = DesktopStyle.Text, TextAlign = ContentAlignment.MiddleCenter, Text = "正在准备…" };
            Controls.Add(_status);

            // Expandable failure details (hidden until toggled).
            _detail = new TextBox { Name = "detail", Location = new Point(40, 300), Size = new Size(600, 84), Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BorderStyle = BorderStyle.None, Visible = false, BackColor = DesktopStyle.Soft, ForeColor = DesktopStyle.Muted, Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point) };
            Controls.Add(_detail);

            // Failure-only actions: retry + details toggle (hidden in normal state).
            _retry = MakeButton("retry", "重试", 212, 392, true);
            _details = MakeButton("details", "查看详情", 348, 392, false);
            _retry.Visible = false;
            _details.Visible = false;
            _retry.TabIndex = 0; _details.TabIndex = 1;
            _retry.Click += (s, e) => Raise(RetryRequested);
            _details.Click += (s, e) => Raise(DetailsToggled);
            Controls.AddRange(new Control[] { _retry, _details });

            FormClosing += (s, e) => { if (FormClosingH != null) FormClosingH(s, e); };
            ResumeLayout(false);
        }

        /// <summary>Apply a resolved appearance (theme + mode). Resolves the concrete
        /// palette via DesktopAppearance (light/dark from mode or Windows when
        /// "system"), pushes it to DesktopStyle, and recolours the form + controls.
        /// Called at startup with the persisted snapshot, on file-change (watcher),
        /// and when the OS theme flips (system mode).</summary>
        public void ApplyAppearance(string themeId, string mode)
        {
            _themeId = DesktopAppearance.IsThemeId(themeId) ? themeId : "slate";
            _themeMode = DesktopAppearance.IsModeId(mode) ? mode : "system";

            var palette = DesktopAppearance.Resolve(_themeId, _themeMode);
            DesktopStyle.Apply(palette);

            BackColor = DesktopStyle.Surface;
            if (_status != null) { _status.BackColor = DesktopStyle.Surface; _status.ForeColor = DesktopStyle.Text; }
            if (_detail != null) { _detail.BackColor = DesktopStyle.Soft; _detail.ForeColor = DesktopStyle.Muted; }
            foreach (Control child in Controls)
            {
                if (child == _detail) continue;
                child.BackColor = DesktopStyle.Surface;
                child.ForeColor = DesktopStyle.Text;
            }
            Invalidate(true);
        }

        public string CurrentThemeId { get { return _themeId; } }
        public string CurrentThemeMode { get { return _themeMode; } }

        private OutlineButton MakeButton(string name, string text, int x, int y, bool primary)
        {
            return new OutlineButton { Font = Font, Name = name, Text = text, AccessibleName = text, Location = new Point(x, y), Size = new Size(120, 40), Primary = primary, Anchor = AnchorStyles.Bottom };
        }
        private void Raise(EventHandler h) { if (h != null) h(this, EventArgs.Empty); }
        public void SetStatus(string text) { _status.Text = text; }
        public void SetBusy(bool busy)
        {
            if (busy)
            {
                _spinner.Visible = true;
                _spinner.Start();
                _retry.Visible = false;
                _details.Visible = false;
                _detail.Visible = false;
                _detailsShown = false;
                _details.Text = "查看详情";
            }
            else
            {
                _spinner.Stop();
                _spinner.Visible = false;
            }
        }
        public void EnterFailed(string detail)
        {
            _spinner.Stop();
            _spinner.Visible = false;
            _retry.Visible = true;
            _details.Visible = true;
            SetStatus("暂时没能打开，请重试。");
            _detail.Text = detail;
            _detail.Visible = false;
            _details.Text = "查看详情";
            _detailsShown = false;
            if (!Visible) { Show(); BringToFront(); }
        }
        public void ToggleDetails()
        {
            _detailsShown = !_detailsShown;
            _detail.Visible = _detailsShown;
            _details.Text = _detailsShown ? "隐藏详情" : "查看详情";
        }
        public void HideAfterReady()
        {
            _spinner.Stop();
            _spinner.Visible = false;
            _detail.Visible = false;
            _detailsShown = false;
            Hide();
        }
    }
}
