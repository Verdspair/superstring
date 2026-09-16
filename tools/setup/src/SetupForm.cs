using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Superstring.Setup
{
    /// <summary>
    /// Minimal setup UI in the product's light token set (same values as the
    /// launcher's default theme). Brand text stays English "superstring"; the
    /// body copy is Chinese like the rest of the user-facing product.
    /// </summary>
    internal sealed class SetupForm : Form
    {
        private static readonly Color SurfaceColor = ColorTranslator.FromHtml("#ffffff");
        private static readonly Color InkColor = ColorTranslator.FromHtml("#242b36");
        private static readonly Color MutedColor = ColorTranslator.FromHtml("#616b79");
        private static readonly Color PrimaryColor = ColorTranslator.FromHtml("#26364a");
        private static readonly Color LineColor = ColorTranslator.FromHtml("#dce2e9");
        private static readonly Color PanelColor = ColorTranslator.FromHtml("#f7f8fa");

        private readonly SetupLog _log;
        private readonly TextBox _path;
        private readonly Label _status;
        private readonly ProgressBar _progress;
        private readonly TextBox _details;
        private readonly Button _install;
        private readonly Button _browse;
        private readonly Button _detailsToggle;
        private readonly CheckBox _desktopShortcut;
        private bool _busy;
        private bool _finished;

        internal string TargetRoot { get { return _path.Text.Trim(); } }

        internal SetupForm(SetupLog log)
        {
            SuspendLayout();
            _log = log;
            Text = "superstring setup";
            AutoScaleDimensions = new SizeF(96f, 96f);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(720, 500);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = SurfaceColor;
            Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            ForeColor = InkColor;

            var brand = new Label
            {
                Text = "superstring",
                Font = new Font("Microsoft YaHei UI", 17f, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = InkColor,
                AutoSize = true,
                Location = new Point(28, 24),
            };
            Controls.Add(brand);

            var panel = new RoundedPanel
            {
                Font = Font,
                Location = new Point(28, 74),
                Size = new Size(664, 120),
                BackColor = PanelColor,
                Radius = 12,
            };
            Controls.Add(panel);

            var pathLabel = new Label
            {
                Font = Font,
                Text = "安装位置",
                ForeColor = MutedColor,
                AutoSize = true,
                Location = new Point(16, 14),
            };
            panel.Controls.Add(pathLabel);

            _path = new TextBox
            {
                Font = Font,
                Location = new Point(16, 38),
                Size = new Size(528, 28),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = SurfaceColor,
                ForeColor = InkColor,
                Text = DefaultTargetRoot(),
            };
            panel.Controls.Add(_path);

            _browse = new Button
            {
                Font = Font,
                Text = "浏览…",
                Location = new Point(556, 36),
                Size = new Size(92, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = SurfaceColor,
                ForeColor = PrimaryColor,
            };
            _browse.FlatAppearance.BorderColor = LineColor;
            _browse.Click += OnBrowse;
            panel.Controls.Add(_browse);

            var hint = new Label
            {
                Font = Font,
                Text = "程序与聊天数据都会保存在这个目录下；可以改到其他磁盘。",
                ForeColor = MutedColor,
                AutoSize = true,
                MaximumSize = new Size(632, 0),
                Location = new Point(16, 78),
            };
            panel.Controls.Add(hint);

            _desktopShortcut = new CheckBox
            {
                Font = Font,
                Text = "在桌面创建快捷方式",
                Checked = true,
                AutoSize = true,
                Location = new Point(28, 210),
                ForeColor = InkColor,
                UseVisualStyleBackColor = true,
            };
            Controls.Add(_desktopShortcut);

            // Set the font before bounds: inherited font changes can otherwise scale
            // Label/TextBox sizes once here and a second time in the form DPI pass.
            _status = new Label
            {
                Font = Font,
                Text = "准备就绪，点击“安装”开始。",
                ForeColor = MutedColor,
                AutoEllipsis = true,
                Location = new Point(28, 250),
                Size = new Size(664, 48),
            };
            Controls.Add(_status);

            _progress = new ProgressBar
            {
                Location = new Point(28, 308),
                Size = new Size(664, 6),
                Style = ProgressBarStyle.Continuous,
                Maximum = 100,
            };
            Controls.Add(_progress);

            _details = new TextBox
            {
                Font = Font,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Location = new Point(28, 332),
                Size = new Size(664, 96),
                Visible = false,
                BackColor = PanelColor,
                ForeColor = InkColor,
                BorderStyle = BorderStyle.FixedSingle,
                WordWrap = false,
            };
            Controls.Add(_details);

            _detailsToggle = new Button
            {
                Font = Font,
                Text = "查看详情",
                Location = new Point(28, 444),
                Size = new Size(104, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = SurfaceColor,
                ForeColor = PrimaryColor,
                Visible = false,
            };
            _detailsToggle.FlatAppearance.BorderColor = LineColor;
            _detailsToggle.Click += OnToggleDetails;
            Controls.Add(_detailsToggle);

            _install = new Button
            {
                Font = Font,
                Text = "安装",
                Location = new Point(588, 444),
                Size = new Size(104, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = PrimaryColor,
                ForeColor = Color.White,
            };
            _install.FlatAppearance.BorderSize = 0;
            _install.Click += OnInstall;
            Controls.Add(_install);

            AcceptButton = _install;
            ResumeLayout(true);
        }

        /// <summary>
        /// Suggested install root. The field stays editable — this only pre-fills it.
        ///
        /// The product must never silently land on the system drive (product policy: chat
        /// data follows the chosen root, no silent C: fallback), so D: is preferred and
        /// the fallback walks other FIXED drives only. When no non-system fixed drive is
        /// ready the field is left empty on purpose: the install button already rejects
        /// an empty or relative path, which forces an explicit user choice instead of a
        /// hidden C: install.
        /// </summary>
        internal static string DefaultTargetRoot()
        {
            if (IsReadyFixedDrive("D")) return @"D:\superstring";
            string systemDrive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                if (string.Equals(drive.Name, systemDrive, StringComparison.OrdinalIgnoreCase)) continue;
                return Path.Combine(drive.Name, "superstring");
            }
            return string.Empty;
        }

        private static bool IsReadyFixedDrive(string letter)
        {
            try
            {
                var drive = new DriveInfo(letter);
                return drive.DriveType == DriveType.Fixed && drive.IsReady;
            }
            catch (ArgumentException) { return false; }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 superstring 的安装位置";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(_path.Text.Trim())) dialog.SelectedPath = _path.Text.Trim();
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    // Install into a dedicated subfolder instead of the chosen folder itself.
                    _path.Text = Path.Combine(dialog.SelectedPath, "superstring");
                }
            }
        }

        private void OnToggleDetails(object sender, EventArgs e)
        {
            _details.Visible = !_details.Visible;
            _detailsToggle.Text = _details.Visible ? "收起详情" : "查看详情";
            if (_details.Visible) _details.Text = _log.Transcript();
        }

        private void OnInstall(object sender, EventArgs e)
        {
            if (_busy || _finished) return;
            string target = _path.Text.Trim();
            if (target.Length == 0)
            {
                MessageBox.Show(this, "请先选择安装位置。", "superstring setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!Path.IsPathRooted(target))
            {
                MessageBox.Show(this, "请填写完整路径（例如 D:\\apps\\superstring）。", "superstring setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            InstallRequest request = BuildRequest();
            var worker = new Thread(delegate() { RunInstall(request); });
            worker.IsBackground = true;
            SetBusy(true);
            SetStatus("正在准备…");
            worker.Start();
        }

        private InstallRequest BuildRequest()
        {
            return new InstallRequest
            {
                TargetRoot = TargetRoot,
                CreateShortcuts = true,
                CreateDesktopShortcut = _desktopShortcut.Checked,
                RunProductCheck = true,
            };
        }

        private static string CompletionMessage(InstallResult result)
        {
            string message = string.Equals(result.Action, "fresh-install", StringComparison.Ordinal)
                ? "安装完成。"
                : "已更新到 " + result.Version + "（原 " + result.PreviousVersion + "）。聊天数据未改动。";
            bool desktop = result.Shortcuts.Contains(InstallEngine.LinkPath(true));
            bool startMenu = result.Shortcuts.Contains(InstallEngine.LinkPath(false));
            if (desktop && startMenu) return message + "桌面与开始菜单已创建 superstring 快捷方式。";
            if (desktop) return message + "已创建桌面快捷方式。";
            if (startMenu) return message + "已创建开始菜单快捷方式。";
            return message + "未创建快捷方式，可从安装目录打开 superstring.exe。";
        }

        private void RunInstall(InstallRequest request)
        {
            var engine = new InstallEngine(_log, delegate(string message, int percent) { Report(message, percent); });
            try
            {
                InstallResult result = engine.Run(request);
                Report("安装完成", 100);
                Ui(delegate
                {
                    _path.Text = result.TargetRoot;
                    _finished = true;
                    SetBusy(false);
                    _install.Text = "完成";
                    _install.Click -= OnInstall;
                    _install.Click += delegate(object s, EventArgs e) { Close(); };
                    SetStatus(CompletionMessage(result));
                });
            }
            catch (Exception error)
            {
                _log.Error(error.Message);
                Report("安装失败", -1);
                Ui(delegate
                {
                    SetBusy(false);
                    SetStatus("安装失败：" + error.Message);
                    _details.Text = _log.Transcript();
                    _details.Visible = true;
                    _detailsToggle.Visible = true;
                    _detailsToggle.Text = "收起详情";
                });
            }
        }

        private void Report(string message, int percent)
        {
            Ui(delegate
            {
                SetStatus(message);
                if (percent < 0) { _progress.Style = ProgressBarStyle.Marquee; }
                else
                {
                    _progress.Style = ProgressBarStyle.Continuous;
                    _progress.Value = Math.Max(0, Math.Min(100, percent));
                }
            });
        }

        private void SetStatus(string message) { _status.Text = message; }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _install.Enabled = !busy;
            _browse.Enabled = !busy && !_finished;
            _path.Enabled = !busy && !_finished;
            _desktopShortcut.Enabled = !busy && !_finished;
        }

        private void Ui(Action action)
        {
            try
            {
                if (IsDisposed || Disposing) return;
                if (InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch (InvalidOperationException) { }
        }
    }

    /// <summary>Panel with a 1px border and a 12px corner radius, matching the product shell.</summary>
    internal sealed class RoundedPanel : Panel
    {
        internal int Radius = 12;

        internal RoundedPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var path = Round(bounds, Radius))
            using (var fill = new SolidBrush(BackColor))
            using (var border = new Pen(ColorTranslator.FromHtml("#dce2e9"), 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
            base.OnPaint(e);
        }

        private static GraphicsPath Round(Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
