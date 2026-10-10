using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    // Permanent regression harness for the native desktop launcher lifecycle.
    // One exe, three roles, selected only by args/env (never by process name):
    //   --run               probe process: real Launcher/MainForm/Readiness/ProcessTree
    //                       compiled from the product sources are observed here
    //   env PROBE_ROLE=...  launched by Launcher.StartServer as the "server" child
    //                       (fake parent role, see FakeServer.RunParent)
    //   --fake-grandchild   launched by the fake parent; inherits the redirected
    //                       stdout/stderr handles and holds them until released
    //
    // Cases (env PROBE_CASE):
    //   1-fail       live parent + redirected grandchild, real Launcher.Fail must
    //                kill the owned job and clear the busy UI without any rescue
    //   2-no-port    silent server, WaitReady must take the timeout branch
    //   3-early-exit server exits before readiness, WaitReady early-exit branch
    internal static class Program
    {
        private static string Dir { get { return Environment.GetEnvironmentVariable("PROBE_DIR"); } }
        private static string Case { get { return Environment.GetEnvironmentVariable("PROBE_CASE"); } }
        private static string Ready { get { return Path.Combine(Dir, "grandchild.ready"); } }
        private static string Release { get { return Path.Combine(Dir, "release-grandchild"); } }
        private static string Result { get { return Path.Combine(Dir, "RESULT.json"); } }

        private static MainForm _form;
        private static Launcher _launcher;
        private static DesktopProcesses _processes;
        private static Thread _worker;
        private static System.Windows.Forms.Timer _timer;
        private static Stopwatch _clock;
        private static int _stage;
        private static bool _workerDone;
        private static long _workerDoneMs = -1;
        private static bool _rescued;
        private static string _blockedSnapshot = "";
        private static int _childPid;
        private static int _serverPid;
        private static bool _waitReadyResult;
        private static long _waitReadyMs = -1;
        private static bool _waitReadyDone;
        private static string _finalUi = "";
        private static string _error = "";

        private static void Write(string s)
        {
            File.AppendAllText(Path.Combine(Dir, "native-probe.log"), DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            if (args.Length > 0 && args[0] == "--fake-grandchild") return FakeServer.RunGrandchild(Dir, Ready, Release);
            if (Environment.GetEnvironmentVariable("PROBE_ROLE") == "fake-parent") return FakeServer.RunParent(Dir, Case, Ready, Release);
            if (args.Length == 0 || args[0] != "--run") { Console.Error.WriteLine("expected --run"); return 2; }
            Directory.CreateDirectory(Dir);
            try
            {
                RunProbe();
                return _error == "" ? 0 : 1;
            }
            catch (Exception ex)
            {
                _error = ex.ToString();
                Write("HARNESS_ERROR " + ex);
                try { SaveResult(); } catch { }
                return 1;
            }
        }

        private static void RunProbe()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            _processes = new DesktopProcesses();
            _form = new MainForm();
            _form.SetBusy(true);
            _form.Shown += delegate { BeginScenario(); };
            Application.Run(_form);
            _processes.StopChildren();
            SaveResult();
            _processes.Dispose(); // job close (kill-on-close) reaps anything left
        }

        private static void BeginScenario()
        {
            try
            {
                _launcher = new Launcher(Dir, new Logger(Dir), Assembly.GetExecutingAssembly().Location,
                    "c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4", 17861, _form,
                    new DesktopLayout(), _processes);
                bool started = (bool)CallLauncher("StartServer", null);
                if (!started) throw new Exception("StartServer returned false");
                _serverPid = ((Process)LauncherField("_server")).Id;
                _clock = Stopwatch.StartNew();
                if (Case == "1-fail") { _stage = 0; }
                else { StartWaitReadyWorker(); _stage = 2; }
                _timer = new System.Windows.Forms.Timer { Interval = 50 };
                _timer.Tick += Tick;
                _timer.Start();
                Write("SCENARIO_BEGIN case=" + Case + " serverPid=" + _serverPid + " ownPid=" + Process.GetCurrentProcess().Id);
            }
            catch (Exception ex)
            {
                _error = ex.ToString(); Write("SCENARIO_ERROR " + ex); StopTimer(); _form.Close();
            }
        }

        // Watchdog: an independent UI timer. It only ends this probe's own job; it
        // never kills by process name and never touches anything outside the probe job.
        private static void Tick(object sender, EventArgs e)
        {
            try
            {
                if (_stage == 0)
                {
                    if (File.Exists(Path.Combine(Dir, "parent.error")))
                        throw new Exception(File.ReadAllText(Path.Combine(Dir, "parent.error")));
                    if (File.Exists(Ready))
                    {
                        _childPid = ParsePid(File.ReadAllText(Ready));
                        Write("GRANDCHILD_READY pid=" + _childPid);
                        StartFailWorker();
                        _stage = 1;
                        _clock.Restart();
                    }
                    else if (_clock.ElapsedMilliseconds > 10000)
                        throw new Exception("grandchild fixture never became ready");
                    return;
                }
                if (_stage == 1)
                {
                    if (_workerDone)
                    {
                        _finalUi = UiSnapshot();
                        Write("FAIL_WORKER_COMPLETED elapsedMs=" + _workerDoneMs + " " + _finalUi);
                        StopTimer(); _form.Close();
                    }
                    else if (!_rescued && _clock.ElapsedMilliseconds >= 1500)
                    {
                        // Bug-signature probe: a Fail that is still blocked here means the
                        // owned grandchild kept the redirected pipes open. Free it so the
                        // blocked Fail can finish and the snapshot documents the defect.
                        _blockedSnapshot = "workerAlive=" + _worker.IsAlive
                            + " grandchildAlive=" + IsAlive(_childPid) + " " + UiSnapshot();
                        _rescued = true;
                        File.WriteAllText(Release, "release");
                        Write("WATCHDOG_RESCUE " + _blockedSnapshot);
                    }
                    else if (_rescued && _clock.ElapsedMilliseconds > 8000)
                    {
                        _error = "Fail worker still blocked after rescue";
                        StopTimer(); _form.Close();
                    }
                    return;
                }
                if (_stage == 2)
                {
                    if (_waitReadyDone)
                    {
                        _finalUi = UiSnapshot();
                        Write("WAITREADY_DONE result=" + _waitReadyResult + " elapsedMs=" + _waitReadyMs + " " + _finalUi);
                        StopTimer(); _form.Close();
                    }
                    else if (_clock.ElapsedMilliseconds > 15000)
                    {
                        _error = "WaitReady worker did not complete";
                        StopTimer(); _form.Close();
                    }
                }
            }
            catch (Exception ex)
            {
                _error = ex.ToString(); Write("TICK_ERROR " + ex); StopTimer();
                try { _finalUi = UiSnapshot(); } catch { }
                try { File.WriteAllText(Release, "release"); } catch { }
                _form.Close();
            }
        }

        private static void StartFailWorker()
        {
            _worker = new Thread(delegate()
            {
                try
                {
                    CallLauncher("Fail", new object[] { "synthetic Fail with live parent and redirected stdout descendant" });
                }
                catch (Exception ex) { _error = ex.ToString(); Write("FAIL_EXCEPTION " + ex); }
                finally { _workerDoneMs = _clock.ElapsedMilliseconds; _workerDone = true; }
            });
            _worker.IsBackground = true;
            _worker.Start();
        }

        private static void StartWaitReadyWorker()
        {
            _worker = new Thread(delegate()
            {
                Stopwatch sw = Stopwatch.StartNew();
                try { _waitReadyResult = (bool)CallLauncher("WaitReady", null); }
                catch (Exception ex) { _error = ex.ToString(); Write("WAITREADY_EXCEPTION " + ex); }
                finally { _waitReadyMs = sw.ElapsedMilliseconds; _waitReadyDone = true; }
            });
            _worker.IsBackground = true;
            _worker.Start();
        }

        private static void SaveResult()
        {
            string ui = _finalUi;
            string j = "{" +
                "\"status\":\"" + (_error == "" ? "complete" : "harness-error") + "\"," +
                "\"case\":\"" + Escape(Case) + "\"," +
                "\"probePid\":" + Process.GetCurrentProcess().Id + "," +
                "\"serverPid\":" + _serverPid + "," +
                "\"grandchildPid\":" + _childPid + "," +
                "\"failWorkerCompleted\":" + (_workerDone ? "true" : "false") + "," +
                "\"failDoneMs\":" + _workerDoneMs + "," +
                "\"rescueRequired\":" + (_rescued ? "true" : "false") + "," +
                "\"blockedSnapshot\":\"" + Escape(_blockedSnapshot) + "\"," +
                "\"waitReadyResult\":" + (_waitReadyDone ? _waitReadyResult.ToString().ToLowerInvariant() : "null") + "," +
                "\"waitReadyMs\":" + _waitReadyMs + "," +
                "\"launcherPhase\":\"" + Escape(PhaseName()) + "\"," +
                "\"uiSnapshot\":\"" + Escape(ui) + "\"," +
                "\"jobLeftovers\":\"" + Escape(OwnedChildren()) + "\"," +
                "\"grandchildAliveAtExit\":" + ((_childPid > 0 && IsAlive(_childPid)) ? "true" : "false") + "," +
                "\"derivedWaitTimeoutMs\":1000," +
                "\"productWaitTimeoutMs\":90000," +
                "\"edgeStarted\":false," +
                "\"runtimeStarted\":false," +
                "\"error\":\"" + Escape(_error) + "\"}\n";
            File.WriteAllText(Result, j);
            Console.WriteLine(j);
        }

        private static object CallLauncher(string name, object[] args)
        {
            return _launcher.GetType().GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(_launcher, args);
        }

        private static object LauncherField(string name)
        {
            return _launcher.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(_launcher);
        }

        private static string UiSnapshot()
        {
            // Must be called on the UI thread before the form closes; reading after
            // Application.Run returns yields disposed/empty controls.
            object label = _form.GetType().GetField("_status", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(_form);
            object spinner = _form.GetType().GetField("_spinner", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(_form);
            object retry = _form.GetType().GetField("_retry", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(_form);
            object details = _form.GetType().GetField("_details", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(_form);
            bool visible = (bool)spinner.GetType().GetProperty("Visible").GetValue(spinner, null);
            bool animating = (bool)spinner.GetType().GetProperty("IsAnimating").GetValue(spinner, null);
            string text = (string)label.GetType().GetProperty("Text").GetValue(label, null);
            return "label=\"" + text + "\" spinnerVisible=" + visible + " spinnerAnimating=" + animating
                + " retryVisible=" + retry.GetType().GetProperty("Visible").GetValue(retry, null)
                + " detailsVisible=" + details.GetType().GetProperty("Visible").GetValue(details, null);
        }

        private static string PhaseName()
        {
            object p = _launcher == null ? null : LauncherField("_phase");
            return p == null ? "none" : p.ToString();
        }

        private static string OwnedChildren()
        {
            string file = Path.Combine(Dir, "parent-child.json");
            if (!File.Exists(file)) return "";
            try
            {
                string j = File.ReadAllText(file);
                int i = j.IndexOf("\"childPid\":") + 11;
                int e = j.IndexOf(',', i);
                int pid = int.Parse(j.Substring(i, e - i));
                return IsAlive(pid) ? pid.ToString() : "";
            }
            catch { return ""; }
        }

        private static bool IsAlive(int pid)
        {
            try { return !Process.GetProcessById(pid).HasExited; }
            catch { return false; }
        }

        private static int ParsePid(string ready)
        {
            int i = ready.IndexOf("pid=") + 4;
            int e = ready.IndexOf(';', i);
            return int.Parse(ready.Substring(i, e - i));
        }

        private static void StopTimer() { if (_timer != null) _timer.Stop(); }

        private static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }
    }
}
