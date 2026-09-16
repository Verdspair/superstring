using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    /// <summary>
    /// Orchestrates the desktop launch lifecycle on a dedicated worker thread:
    ///   1. preflight (reuse tools/ops/start.ts --no-build: check prebuilt frontend)
    ///   2. serve (bun run src/server/index.ts) with the desktop token + 127.0.0.1 port
    ///   3. readiness probe (GET /__desktop/status w/ Bearer token, identity-verified)
    ///   4. open the browser (Process.Start, UseShellExecute=true)
    ///   5. hide the panel and monitor: when the server (our own process) exits, exit too.
    ///
    /// Stop semantics: we only ever stop processes we spawned, via the token
    /// authenticated /__desktop/stop endpoint (graceful). No global taskkill,
    /// no port-based killing and no timed hard kill of the database process.
    /// </summary>
    internal sealed class Launcher
    {
        private enum Phase { Idle, Preparing, Serving, Ready, Failed }

        private const int PrepareTimeoutMs = 240000;
        private const int ReadyTimeoutMs = 90000;
        private const int AttemptTimeoutMs = 5000;
        private const int PollIntervalMs = 400;

        private readonly DesktopLayout _layout;
        private readonly string _root;
        private readonly Logger _log;
        private readonly string _bunExe;
        private readonly string _token;
        private readonly int _port;
        private readonly string _baseUrl;
        private readonly MainForm _form;
        private readonly SingleInstance _single;

        private Process _preflight;
        private Process _server;
        private volatile bool _cancel;
        private volatile bool _exiting;
        private Phase _phase = Phase.Idle;
        private volatile bool _stopRequested;
        private readonly object _processLock = new object();

        public Launcher(string root, Logger log, string bunExe, string token, int port, MainForm form, SingleInstance single, DesktopLayout layout)
        {
            _layout = layout;
            _root = root;
            _log = log;
            _bunExe = bunExe;
            _token = token;
            _port = port;
            _baseUrl = "http://127.0.0.1:" + port;
            _form = form;
            _single = single;
        }

        public void Attach()
        {
            _form.RetryRequested += (s, e) => Start();
            _form.DetailsToggled += (s, e) => _form.ToggleDetails();
            _form.FormClosingH += (s, e) => { if (!_exiting) { e.Cancel = true; RequestExitOrCancel(); } };
            _form.Shown += (s, e) => Start();
        }

        public void Start()
        {
            if (_phase != Phase.Idle && _phase != Phase.Failed) return;
            _cancel = false;
            _stopRequested = false;
            _phase = Phase.Preparing;
            Ui(() => { _form.SetBusy(true); _form.SetStatus("正在准备…"); });
            new Thread(Run).Start();
        }

        public void RequestExitOrCancel()
        {
            if (_exiting || _stopRequested) return;
            _stopRequested = true;
            _cancel = true;
            Ui(() => _form.SetStatus("正在退出…"));
            new Thread(() =>
            {
                StopOwnedProcesses();
                _exiting = true;
                Ui(() => Application.Exit());
            }).Start();
        }

        /// <summary>Called by the NamedPipe server when a second instance starts.</summary>
        public void OnSecondInstance()
        {
            Ui(() =>
            {
                if (_phase == Phase.Ready && OpenBrowser()) return;
                if (!_form.Visible) { _form.Show(); }
                _form.BringToFront();
            });
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
                if (_cancel) { CleanupPreflight(); return; }
                if (!Prepare()) return;
                if (_cancel) { CleanupPreflight(); return; }

                SetPhase(Phase.Serving, "正在启动服务…");
                if (!StartServer()) return;
                if (_cancel) { StopOwnedProcesses(); return; }
                if (!WaitReady()) return;
                if (_cancel) { StopOwnedProcesses(); return; }

                SetPhase(Phase.Ready, "已就绪，正在打开浏览器…");
                if (!OpenBrowser())
                {
                    Fail("暂时没能打开浏览器，请重试。");
                    return;
                }
                Ui(() => _form.HideAfterReady());
                Monitor();
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
            string helper = Path.Combine(_root, "tools", "ops", "start.ts");
            if (!File.Exists(helper)) { Fail("找不到启动预检脚本: " + helper); return false; }

            var psi = new ProcessStartInfo
            {
                FileName = _bunExe,
                Arguments = "\"" + helper + "\" --no-build",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.EnvironmentVariables["SUPERSTRING_DEV_PORT"] = _port.ToString();

            try { lock (_processLock) { if (_cancel) return false; _preflight = Process.Start(psi); } }
            catch (Exception ex) { Fail("无法启动 Bun 预检: " + ex.Message); return false; }

            WireOutput(_preflight, "preflight");
            _preflight.BeginOutputReadLine();
            _preflight.BeginErrorReadLine();

            int waited = 0;
            while (!_preflight.HasExited && waited < PrepareTimeoutMs)
            {
                if (_cancel) { CleanupPreflight(); return false; }
                _preflight.WaitForExit(300);
                waited += 300;
            }
            if (_cancel) { CleanupPreflight(); return false; }
            if (!_preflight.HasExited) { CleanupPreflight(); Fail("预检未能及时完成，请查看详情后重试。"); return false; }
            if (_preflight.ExitCode != 0) { Fail("预检失败（缺少前端文件时请先构建项目）（退出码 " + _preflight.ExitCode + "）。点击“查看详情”查看 Bun 输出。"); return false; }
            return true;
        }

        private bool StartServer()
        {
            string entry = _layout.Installed ? _layout.ServerExecutable : Path.Combine(_root, "src", "server", "index.ts");
            if (!File.Exists(entry)) { Fail("找不到服务入口: " + entry); return false; }

            var psi = new ProcessStartInfo
            {
                FileName = _layout.Installed ? entry : _bunExe,
                Arguments = _layout.Installed ? "" : "run \"" + entry + "\"",
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            // The child inherits the launcher's environment (PATH, LM_STUDIO_*, etc.)
            // and we OVERRIDE only the desktop contract variables. The token is passed
            // via env (never the URL, never the log).
            _layout.ConfigureInstalledEnvironment(psi);
            psi.EnvironmentVariables["SUPERSTRING_SERVE_WEB"] = "1";
            psi.EnvironmentVariables["SUPERSTRING_DEV_PORT"] = _port.ToString();
            psi.EnvironmentVariables["SUPERSTRING_DESKTOP_TOKEN"] = _token;

            try { lock (_processLock) { if (_cancel) return false; _server = Process.Start(psi); } }
            catch (Exception ex) { Fail("无法启动服务: " + ex.Message); return false; }

            WireOutput(_server, "server");
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();
            return true;
        }

        private void WireOutput(Process p, string tag)
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null) _log.Detail("[" + tag + "] " + e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) _log.Detail("[" + tag + "] " + e.Data); };
        }

        private bool WaitReady()
        {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < ReadyTimeoutMs)
            {
                if (_cancel) { StopOwnedProcesses(); return false; }
                if (_server != null && _server.HasExited)
                {
                    Fail("服务在就绪前退出（退出码 " + _server.ExitCode + "）。点击“查看详情”查看服务输出。");
                    return false;
                }

                int remaining = (int)(ReadyTimeoutMs - clock.ElapsedMilliseconds);
                if (remaining <= 0) break;
                var outcome = Readiness.ProbeDesktopStatus(_baseUrl, _token, Math.Min(AttemptTimeoutMs, remaining));
                if (outcome == Readiness.StatusOutcome.Ready) return true;

                if (outcome == Readiness.StatusOutcome.EndpointMissing)
                {
                    Fail("未能确认桌面服务身份，已停止本次启动。请检查程序是否完整。");
                    return false;
                }

                int pause = (int)Math.Min(PollIntervalMs, ReadyTimeoutMs - clock.ElapsedMilliseconds);
                if (pause > 0) Thread.Sleep(pause);
            }
            Fail("启动超时：服务在预算内未报告就绪（" + (ReadyTimeoutMs / 1000) + " 秒）。");
            return false;
        }

        private bool OpenBrowser()
        {
            try
            {
#if VALIDATION
                Console.WriteLine("VALIDATION_BROWSER_READY " + _baseUrl + "/");
#else
                var psi = new ProcessStartInfo(_baseUrl + "/") { UseShellExecute = true };
                Process.Start(psi);
#endif
                _log.Info("已派发打开浏览器: " + _baseUrl + "/");
                return true;
            }
            catch (Exception ex)
            {
                // Opening the browser is best-effort; the page is still reachable manually.
                _log.Warn("自动打开浏览器失败: " + ex.Message);
                return false;
            }
        }

        private void Monitor()
        {
            _phase = Phase.Ready;
            while (!_cancel && (_server == null || !_server.HasExited))
            {
                if (_server != null) _server.WaitForExit(PollIntervalMs);
            }
            if (_cancel) StopOwnedProcesses();
            _log.Info("服务已退出，桌面宿主随之退出。");
            _exiting = true;
            Ui(() => Application.Exit());
        }

        private void CleanupPreflight()
        {
            if (_preflight != null && !_preflight.HasExited)
            {
                _log.Warn("取消预检：终止本次无构建预检进程。");
                _preflight.Kill();
                _preflight.WaitForExit(); // --no-build preflight never creates a Vite child.
            }
        }

        private void StopOwnedProcesses()
        {
            lock (_processLock)
            {
                if (_server != null && !_server.HasExited)
                {
                    _log.Info("正在按令牌安全停止自有服务…");
                    ProcessTree.StopOwnedServer(_server, _baseUrl, _token, _log);
                }
                CleanupPreflight();
            }
        }

        private void Fail(string detail)
        {
            _phase = Phase.Failed;
            _log.Error(detail);
            StopOwnedProcesses();
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
