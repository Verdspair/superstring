using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    /// <summary>
    /// Orchestrates the desktop launch lifecycle on a dedicated worker thread:
    ///   1. verify required local resources and the pinned Bun version
    ///   2. serve (bun run src/server/index.ts) with the desktop token + 127.0.0.1 port
    ///   3. readiness probe (GET /__desktop/status w/ Bearer token, identity-verified)
    ///   4. open an isolated Edge application window and retain its process handle
    ///   5. end the owned process tree when the application window exits.
    ///
    /// Desktop close terminates this launch's job; ordinary service stop is a separate path.
    /// </summary>
    internal sealed class Launcher
    {
        private enum Phase { Idle, Preparing, Serving, Ready, Failed }

        private const int ReadyTimeoutMs = 90000;
        private const int AttemptTimeoutMs = 5000;
        private readonly ManualResetEvent _portReady = new ManualResetEvent(false);
        private readonly ManualResetEvent _serverExited = new ManualResetEvent(false);

        private readonly DesktopLayout _layout;
        private readonly string _root;
        private readonly Logger _log;
        private readonly string _bunExe;
        private readonly string _token;
        private readonly int _port;
        private volatile string _baseUrl;
        private volatile bool _portReported;
        private readonly MainForm _form;
        private readonly DesktopProcesses _processes;
        private int _exitStarted;

        private Process _server;
        private OwnedBrowser _browser;
        private Phase _phase = Phase.Idle;
        private readonly object _processLock = new object();

        public Launcher(string root, Logger log, string bunExe, string token, int port, MainForm form, DesktopLayout layout, DesktopProcesses processes)
        {
            _layout = layout;
            _root = root;
            _log = log;
            _bunExe = bunExe;
            _token = token;
            _port = port;
            _baseUrl = "http://127.0.0.1:" + port;
            _form = form;
            _processes = processes;
        }

        public void Attach()
        {
            _form.RetryRequested += (s, e) => Start();
            _form.DetailsToggled += (s, e) => _form.ToggleDetails();
            _form.FormClosingH += (s, e) => { e.Cancel = true; RequestExitOrCancel(); };
            _form.Shown += (s, e) => Start();
        }

        public void Start()
        {
            if (_phase != Phase.Idle && _phase != Phase.Failed) return;
            _phase = Phase.Preparing;
            Ui(() => { _form.SetBusy(true); _form.SetStatus("正在准备…"); });
            new Thread(Run).Start();
        }

        public void RequestExitOrCancel()
        {
            if (Interlocked.Exchange(ref _exitStarted, 1) != 0) return;
            _processes.Terminate(0);
        }

        /// <summary>Called by the NamedPipe server when a second instance starts.</summary>
        public ExistingInstanceResult OnSecondInstance()
        {
            if (_exitStarted != 0) return ExistingInstanceResult.Unavailable;
            bool shown = false;
            bool ready = _phase == Phase.Ready;
            Ui(() =>
            {
                if (_exitStarted != 0) return;
                if (ready && OpenBrowser()) { shown = true; return; }
                if (_phase == Phase.Ready)
                    _form.EnterFailed("本地服务未响应，未重新打开空白页面。请退出当前实例后重新启动。");
                if (!_form.Visible) { _form.Show(); }
                _form.BringToFront();
                shown = true;
            });
            if (_exitStarted != 0) return ExistingInstanceResult.Unavailable;
            return shown ? ExistingInstanceResult.Shown : ExistingInstanceResult.Unavailable;
        }

        private void Ui(Action a)
        {
            try
            {
                if (_form != null && _form.IsHandleCreated) _form.Invoke(a);
            }
            catch { }
        }

        private void Run()
        {
            try
            {
                SetPhase(Phase.Preparing, "正在准备…");
                if (!CheckBun()) return;
                if (!Prepare()) return;
                if (_exitStarted != 0) return;

                SetPhase(Phase.Serving, "正在启动服务…");
                if (!StartServer()) return;
                if (_exitStarted != 0) return;
                if (!WaitReady()) return;
                if (_exitStarted != 0) return;

                SetPhase(Phase.Ready, "已就绪，正在打开浏览器…");
                if (!OpenBrowser())
                {
                    Fail("暂时没能打开浏览器，请重试。");
                    return;
                }
                Ui(() => _form.HideAfterReady());

            }
            catch (Exception ex)
            {
                Fail("启动过程异常: " + ex.Message);
            }
        }

        private bool CheckBun()
        {
            if (_layout.Installed) return true;
            string ver;
            if (!BunResolver.VersionMatches(_bunExe, out ver))
            {
                Fail("Bun 版本必须为 " + BunResolver.RequiredVersion + "，当前为 " + (string.IsNullOrEmpty(ver) ? "未知" : ver)
                     + "。请勿使用全局或其他版本。");
                return false;
            }
            return true;
        }

        private bool Prepare()
        {
            if (_layout.Installed)
            {
                _layout.ValidateInstalledResources();
                return true;
            }

            string web = Path.Combine(_root, "dist", "web", "index.html");
            if (!File.Exists(web)) { Fail("找不到桌面前端文件: " + web); return false; }
            string entry = Path.Combine(_root, "src", "server", "index.ts");
            if (!File.Exists(entry)) { Fail("找不到服务入口: " + entry); return false; }
            return true;
        }

        private bool StartServer()
        {
            string entry = _layout.Installed ? _layout.ServerExecutable : Path.Combine(_root, "src", "server", "index.ts");

            var psi = new ProcessStartInfo
            {
                FileName = _layout.Installed ? entry : _bunExe,
                Arguments = _layout.Installed ? "" : "run \"" + entry + "\"",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            // The child inherits the launcher's environment (PATH, LM_STUDIO_*, etc.)
            // and we OVERRIDE only the desktop contract variables. The token is passed
            // via env (never the URL, never the log).
            _layout.ConfigureInstalledEnvironment(psi);
            psi.EnvironmentVariables["SUPERSTRING_SERVE_WEB"] = "1";
            psi.EnvironmentVariables["SUPERSTRING_DEV_PORT"] = _port.ToString();
            psi.EnvironmentVariables["SUPERSTRING_DESKTOP_AUTO_PORT"] = "1";
            psi.EnvironmentVariables["SUPERSTRING_DESKTOP_TOKEN"] = _token;
            psi.EnvironmentVariables["SUPERSTRING_DESKTOP_WINDOW_OWNED"] = "1";
            _portReported = false;
            _portReady.Reset();
            _serverExited.Reset();

            try { lock (_processLock) { if (_exitStarted != 0) return false; _server = Process.Start(psi); } }
            catch (Exception ex) { Fail("无法启动服务: " + ex.Message); return false; }

            _server.EnableRaisingEvents = true;
            _server.Exited += (s, e) =>
            {
                _serverExited.Set();
                if (_phase == Phase.Ready) RequestExitOrCancel();
            };
            WireOutput(_server, "server");
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            return true;
        }

        private void WireOutput(Process p, string tag)
        {
            p.OutputDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                int port;
                if (tag == "server" && !_portReported && Readiness.TryReadPort(e.Data, out port))
                {
                    // Only our child's stdout can announce the address; HTTP identity
                    // and the per-launch token are still checked before opening it.
                    _baseUrl = "http://127.0.0.1:" + port;
                    _portReported = true;
                    _portReady.Set();
                    _log.Info("本次服务地址: " + _baseUrl);
                }
                _log.Detail("[" + tag + "] " + e.Data);
            };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) _log.Detail("[" + tag + "] " + e.Data); };
        }

        private bool WaitReady()
        {
            int signal = WaitHandle.WaitAny(new WaitHandle[] { _portReady, _serverExited }, ReadyTimeoutMs);
            if (_exitStarted != 0) return false;
            if (signal == 1 || (_server != null && _server.HasExited))
            {
                Fail("服务在就绪前退出。点击“查看详情”查看服务输出。");
                return false;
            }
            if (signal == WaitHandle.WaitTimeout)
            {
                Fail("启动超时：服务未报告就绪。");
                return false;
            }
            if (Readiness.ProbeDesktopStatus(_baseUrl, _token, AttemptTimeoutMs) == Readiness.StatusOutcome.Ready) return true;
            Fail("未能确认桌面服务身份，已停止本次启动。请检查程序是否完整。");
            return false;
        }

        private bool OpenBrowser()
        {
            try
            {
#if VALIDATION
                Console.WriteLine("VALIDATION_BROWSER_READY " + _baseUrl + "/");
#else
                lock (_processLock)
                {
                    if (_exitStarted != 0) return false;
                    if (_browser != null && !_browser.HasExited)
                        return _browser.Focus();
                    _browser = OwnedBrowser.Start(_baseUrl + "/", _layout.StateDirectory);
                    _browser.OnExit(RequestExitOrCancel);
                }
                Ui(() => _browser.WatchWindowClose(RequestExitOrCancel));
#endif
                _log.Info("已打开独立应用窗口: " + _baseUrl + "/");
                return true;
            }
            catch (Exception ex)
            {
                _log.Warn("自动打开浏览器失败: " + ex.Message);
                return false;
            }
        }

        private void Fail(string detail)
        {
            _phase = Phase.Failed;
            _log.Error(detail);
            lock (_processLock)
            {
                if (_server != null && !_server.HasExited) { _server.Kill(); _server.WaitForExit(); }
                _processes.StopChildren();
                if (_server != null) { _server.Dispose(); _server = null; }
                if (_browser != null) { _browser.Dispose(); _browser = null; }
            }
            string recent = "";
            try
            {
                recent = File.ReadAllText(_log.CurrentPath);
                if (recent.Length > 12000) recent = recent.Substring(recent.Length - 12000);
            }
            catch { }
            Ui(() =>
            {
                _form.SetBusy(false);
                _form.EnterFailed(detail + "\n\n日志: " + _log.CurrentPath + "\n\n" + recent);
            });
        }

        private void SetPhase(Phase p, string status)
        {
            _phase = p;
            _log.Info(status);
            Ui(() => _form.SetStatus(status));
        }
    }
}
