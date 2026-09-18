using System;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Superstring.Desktop
{
    /// <summary>Current appearance snapshot, mutated by the file watcher and read by
    /// the OS theme-change handler.</summary>
    internal sealed class AppearanceState
    {
        public string Theme;
        public string Mode;
    }

    internal static class Program
    {
#if VALIDATION
        private static int DefaultPort = 17861;
#else
        private const int DefaultPort = 17861;
#endif

        [STAThread]
        private static int Main(string[] args)
        {
            // Must run before Framework materializes any child environment or threads.
            int normalizedEnvironmentKeys;
            try { normalizedEnvironmentKeys = ProcessEnvironment.NormalizeCurrentProcess(); }
            catch
            {
                MessageBox.Show("无法准备启动环境，已停止本次启动。", "superstring", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            Native.SetPerMonitorDpi();

            // argument handling
            bool selfTest = false;
            bool help = false;
            bool checkPackage = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--check-package") checkPackage = true;
                else if (args[i] == "--self-test") selfTest = true;
                else if (args[i] == "--help" || args[i] == "-h") help = true;
            }

            if (help)
            {
                Console.WriteLine("superstring desktop launcher");
                Console.WriteLine("  (no args)   launch the panel, prepare, serve, open browser");
                Console.WriteLine("  --self-test run offline checks and exit (no GUI, no server)");
                Console.WriteLine("  --help       show this help");
                Console.WriteLine("  --check-package validate installed resources without launching");
                Console.WriteLine(DesktopLayout.InstalledBuild
                    ? "Installed mode: the EXE directory is the only application root."
                    : "Development mode: project root is discovered from the EXE path.");
                return 0;
            }

            if (checkPackage)
            {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
                try
                {
                    if (!DesktopLayout.InstalledBuild) throw new InvalidOperationException("Package check requires installed build.");
                    var checkedLayout = DesktopLayout.Resolve();
                    Console.WriteLine("PACKAGE_OK root=" + checkedLayout.Root + " state=" + checkedLayout.StateDirectory + " logs=" + checkedLayout.LogDirectory);
                    return 0;
                }
                catch (Exception ex) { Console.WriteLine("PACKAGE_REJECTED: " + ex.Message); return 1; }
            }
            if (selfTest)
            {
                if (DesktopLayout.InstalledBuild)
                {
                    Console.WriteLine("Installed build supports --check-package; development self-test is disabled.");
                    return 1;
                }
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
                Console.WriteLine("ENVIRONMENT_NORMALIZED=" + normalizedEnvironmentKeys);
                return SelfTest.Run();
            }

#if VALIDATION
            if (!int.TryParse(Environment.GetEnvironmentVariable("SUPERSTRING_VALIDATION_PORT"), out DefaultPort) || DefaultPort < 1024 || DefaultPort > 65535)
                return 2;
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
#endif
            // project root
            DesktopLayout layout;
            try { layout = DesktopLayout.Resolve(); }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "superstring", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            string root = layout.Root;

            MaintenanceLease runtimeLease = null;
            try
            {
                if (layout.Installed)
                {
                    runtimeLease = MaintenanceLease.Acquire(root, false);
                    // Revalidate under the lease: maintenance may have run during Resolve.
                    layout.ValidateInstalledResources();
                }
            }
            catch (Exception ex)
            {
                if (runtimeLease != null) runtimeLease.Dispose();
                MessageBox.Show(ex.Message, "superstring", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            try
            {
            // single instance (normalised root hash)
            var single = new SingleInstance();
            if (!single.TryAcquire(root))
            {
                single.NotifyExisting();
                return 0; // another instance owns the session; just reveal it
            }

            // No database/log is opened before the installed storage preflight.
            try { layout.PrepareInstalledStorage(); }
            catch (Exception ex)
            {
                single.Release();
                MessageBox.Show("启动前检查失败: " + ex.Message, "superstring", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            // runtime config
            string token = Util.RandomHex(32); // 64 hex
            Logger log;
            try { log = new Logger(root, token, layout.LogDirectory); }
            catch (Exception ex)
            {
                single.Release();
                MessageBox.Show("无法写入应用日志目录: " + ex.Message, "superstring", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            log.Info("superstring 桌面启动器启动；项目根=" + root + " 端口=" + DefaultPort);

            // resolve bun early so failures are reported through the panel
            string bunError = null;
            string bunExe = layout.Installed ? null : BunResolver.Resolve(root, out bunError);
            if (!layout.Installed && bunExe == null)
            {
                log.Error("Bun 解析失败: " + bunError);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new MainForm();
            var launcher = new Launcher(root, log, bunExe, token, DefaultPort, form, single, layout);
            launcher.Attach();

            // appearance: restore the persisted snapshot, then keep it in sync
            // The browser pushes {theme,mode} over the same-origin desktop WS; the
            // server persists it to artifacts/state/desktop-appearance.json. We read
            // it before launch, watch it for changes, and also follow the Windows
            // app-mode preference while mode is "system".
            string stateDir = layout.StateDirectory;
            string snapTheme, snapMode;
            DesktopAppearance.LoadSnapshot(stateDir, out snapTheme, out snapMode);
            var current = new AppearanceState { Theme = snapTheme, Mode = snapMode };
            try { form.ApplyAppearance(current.Theme, current.Mode); }
            catch (Exception ex) { log.Warn("外观初始化失败，回退默认: " + ex.Message); }

            // Allocate the native handle on the UI thread before callbacks queue work.
            IntPtr appearanceHandle = form.Handle;
            IDisposable watcher = null;
            try
            {
                watcher = DesktopAppearance.Watch(stateDir, (theme, mode) =>
                {
                    try
                    {
                        if (form.IsDisposed || form.Disposing) return;
                        form.BeginInvoke((Action)(() =>
                        {
                            if (form.IsDisposed || form.Disposing) return;
                            current.Theme = theme; current.Mode = mode;
                            form.ApplyAppearance(theme, mode);
                        }));
                    }
                    catch { }
                });
            }
            catch (Exception ex) { log.Warn("外观文件监听未启用: " + ex.Message); }

            // Re-apply when Windows light/dark flips, but only while mode == "system".
            UserPreferenceChangedEventHandler sysHandler = (s, e) =>
            {
                try
                {
                    if (form.IsDisposed || form.Disposing) return;
                    form.BeginInvoke((Action)(() =>
                    {
                        if (!form.IsDisposed && !form.Disposing && current.Mode == "system")
                            form.ApplyAppearance(current.Theme, current.Mode);
                    }));
                }
                catch { }
            };
            SystemEvents.UserPreferenceChanged += sysHandler;

            single.StartPipeServer(() => launcher.OnSecondInstance());

            try
            {
                Application.Run(form);
            }
            finally
            {
                SystemEvents.UserPreferenceChanged -= sysHandler;
                if (watcher != null) { try { watcher.Dispose(); } catch { } }
                single.Release();
            }
            return 0;
            }
            finally { if (runtimeLease != null) runtimeLease.Dispose(); }
        }
    }
}
