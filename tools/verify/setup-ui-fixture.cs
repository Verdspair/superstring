using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Loads the actual setup assembly and renders offscreen; never invokes the install engine.
internal static class SetupUiFixture
{
    private const BindingFlags Instance = BindingFlags.Instance | BindingFlags.NonPublic;
    private const BindingFlags Static = BindingFlags.Static | BindingFlags.NonPublic;
    private static readonly List<object> Checks = new List<object>();
    private static int failures;
    private static Type formType;
    private static Assembly assembly;

    private static void Check(string name, bool pass)
    {
        Checks.Add(new { name = name, pass = pass });
        if (!pass) failures++;
    }

    private static object Field(object target, string name)
    {
        return target.GetType().GetField(name, Instance).GetValue(target);
    }

    private static object Call(object target, string name, params object[] arguments)
    {
        return target.GetType().GetMethod(name, Instance).Invoke(target, arguments);
    }

    private static void Set(object target, string name, object value)
    {
        target.GetType().GetField(name, Instance).SetValue(target, value);
    }

    private static void CheckBounds(Control parent, string state)
    {
        foreach (Control control in parent.Controls)
        {
            Check(state + ": bounds " + control.GetType().Name + "/" + control.Text.Substring(0, Math.Min(14, control.Text.Length)),
                control.Left >= 0 && control.Top >= 0 && control.Right <= parent.ClientSize.Width && control.Bottom <= parent.ClientSize.Height);
            var label = control as Label;
            if (label != null)
            {
                using (Graphics graphics = control.CreateGraphics())
                {
                    Size measured = TextRenderer.MeasureText(graphics, label.Text, label.Font,
                        new Size(label.ClientSize.Width, int.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
                    Check(state + ": label text fits " + label.Text.Substring(0, Math.Min(14, label.Text.Length)), measured.Height <= label.ClientSize.Height);
                }
            }
            var button = control as Button;
            if (button != null)
            {
                using (Graphics graphics = button.CreateGraphics())
                {
                    Size measured = TextRenderer.MeasureText(graphics, button.Text, button.Font, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.SingleLine);
                    Check(state + ": button text fits " + button.Text, measured.Width + 6 <= button.ClientSize.Width && measured.Height + 4 <= button.ClientSize.Height);
                }
            }
            CheckBounds(control, state);
        }
    }

    private static void Snapshot(Form form, string path)
    {
        form.Refresh();
        Application.DoEvents();
        using (var image = new Bitmap(form.Width, form.Height))
        {
            form.DrawToBitmap(image, new Rectangle(Point.Empty, image.Size));
            image.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    private static string Message(string action, bool desktop, bool startMenu)
    {
        object result = Activator.CreateInstance(assembly.GetType("Superstring.Setup.InstallResult"), true);
        Set(result, "Action", action);
        Set(result, "Version", "0.2.0-alpha");
        Set(result, "PreviousVersion", "0.0.1");
        var links = (List<string>)Field(result, "Shortcuts");
        MethodInfo linkPath = assembly.GetType("Superstring.Setup.InstallEngine").GetMethod("LinkPath", Static);
        if (desktop) links.Add((string)linkPath.Invoke(null, new object[] { true }));
        if (startMenu) links.Add((string)linkPath.Invoke(null, new object[] { false }));
        return (string)formType.GetMethod("CompletionMessage", Static).Invoke(null, new object[] { result });
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        assembly = Assembly.LoadFile(Path.GetFullPath(args[0]));
        formType = assembly.GetType("Superstring.Setup.SetupForm", true);
        var sizes = new List<object>();
        foreach (float scale in new float[] { 1f, 1.25f, 1.5f, 2f })
        {
            object log = Activator.CreateInstance(assembly.GetType("Superstring.Setup.SetupLog"), true);
            using (var form = (Form)formType.GetConstructors(Instance)[0].Invoke(new object[] { log }))
            {
                form.ShowInTaskbar = false;
                form.StartPosition = FormStartPosition.Manual;
                form.Location = new Point(-16000, -16000);
                form.Show();
                Application.DoEvents();
                form.PerformAutoScale();
                float dpi = form.CurrentAutoScaleDimensions.Width;
                Check("native logical client size is 720x500", Math.Abs(form.ClientSize.Width * 96f / dpi - 720f) <= 2f && Math.Abs(form.ClientSize.Height * 96f / dpi - 500f) <= 2f);
                if (scale != 1f) form.Scale(new SizeF(scale, scale));
                form.PerformLayout();
                string tag = "scale-" + (scale * 100).ToString("0");
                sizes.Add(new { scale = scale, dpi = dpi, width = form.ClientSize.Width, height = form.ClientSize.Height });
                var checkbox = (CheckBox)Field(form, "_desktopShortcut");
                var path = (TextBox)Field(form, "_path");
                var status = (Label)Field(form, "_status");
                var progress = (ProgressBar)Field(form, "_progress");
                var details = (TextBox)Field(form, "_details");
                var install = (Button)Field(form, "_install");
                Check(tag + ": desktop is checked by default", checkbox.Checked);
                Check(tag + ": default request creates desktop", (bool)Field(Call(form, "BuildRequest"), "CreateDesktopShortcut"));
                Check(tag + ": installation path remains editable", !path.ReadOnly);
                string suggested = (string)formType.GetMethod("DefaultTargetRoot", Static).Invoke(null, null);
                Check(tag + ": path uses suggested default", path.Text == suggested);
                path.Text = @"E:\custom folder\superstring";
                Check(tag + ": typed path reaches request", (string)Field(Call(form, "BuildRequest"), "TargetRoot") == path.Text);
                path.Text = suggested;
                CheckBounds(form, tag + " ready");
                Check(tag + ": form remains offscreen without taskbar entry", !form.ShowInTaskbar && form.Right < 0 && form.Bottom < 0);
                Check(tag + ": choice and status do not overlap", checkbox.Bottom < status.Top);
                Check(tag + ": status and progress do not overlap", status.Bottom < progress.Top);
                Check(tag + ": details and footer do not overlap", details.Bottom < install.Top);
                Snapshot(form, Path.Combine(args[1], tag + "-ready.png"));

                checkbox.Checked = false;
                object request = Call(form, "BuildRequest");
                Check(tag + ": unchecked choice reaches request", !(bool)Field(request, "CreateDesktopShortcut"));
                Check(tag + ": unchecked still allows start menu", (bool)Field(request, "CreateShortcuts"));
                Call(form, "SetBusy", true);
                Check(tag + ": choice locked during installation", !checkbox.Enabled && !path.Enabled && !install.Enabled);
                Call(form, "SetBusy", false);
                Check(tag + ": choice restored after failure", checkbox.Enabled && !checkbox.Checked);
                string menuOnly = Message("fresh-install", false, true);
                Check(tag + ": opt-out completion never claims desktop", menuOnly.Contains("开始菜单") && !menuOnly.Contains("桌面"));
                status.Text = menuOnly;
                CheckBounds(form, tag + " opt-out completion");
                Snapshot(form, Path.Combine(args[1], tag + "-unchecked.png"));
                checkbox.Checked = true;
                status.Text = Message("upgrade", true, true);
                Set(form, "_finished", true);
                Call(form, "SetBusy", false);
                install.Text = "完成";
                progress.Value = 100;
                CheckBounds(form, tag + " upgrade completion");
                Snapshot(form, Path.Combine(args[1], tag + "-complete.png"));
                Set(form, "_finished", false);
                Call(form, "SetBusy", false);
                install.Text = "安装";
                progress.Value = 0;
                Check(tag + ": failed shortcuts do not report success", Message("fresh-install", false, false).Contains("未创建快捷方式"));
                status.Text = "安装失败：安装位置不可写，请选择其他目录后重试。";
                details.Visible = true;
                details.Text = "示例错误详情：安装位置不可写。\r\n请选择其他目录后重试。";
                var toggle = (Button)Field(form, "_detailsToggle");
                toggle.Visible = true;
                toggle.Text = "收起详情";
                CheckBounds(form, tag + " error");
                Snapshot(form, Path.Combine(args[1], tag + "-error.png"));
                Set(form, "_finished", true);
                Call(form, "SetBusy", false);
                Check(tag + ": completed form locks options but permits close", !checkbox.Enabled && !path.Enabled && install.Enabled);
            }
            ((IDisposable)log).Dispose();
        }
        var report = new { passed = failures == 0, failed = failures, checks = Checks, sizes = sizes,
            note = "Actual compiled WinForms controls, native DPI and synthetic additional scaling; offscreen DrawToBitmap only. No real install, desktop writes, monitor switch or clean-machine acceptance." };
        File.WriteAllText(Path.Combine(args[1], "report.json"), new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { passed = Checks.Count - failures, failed = failures, sizes = sizes }));
        return failures == 0 ? 0 : 1;
    }
}
