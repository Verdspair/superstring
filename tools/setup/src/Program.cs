using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Superstring.Desktop;

namespace Superstring.Setup
{
    internal static class Program
    {
        internal const int ExitOk = 0;
        internal const int ExitGeneric = 1;
        internal const int ExitArguments = 2;
        internal const int ExitTargetRejected = 3;
        internal const int ExitPayloadInvalid = 4;
        internal const int ExitBusy = 10;
        internal const int ExitVersionRefused = 11;
        internal const int ExitNoSpace = 12;
        internal const int ExitVerificationFailed = 13;
        internal const int ExitRollbackFailed = 14;

        [STAThread]
        private static int Main(string[] args)
        {
            // Normalize before the Framework builds any child environment.
            try { ProcessEnvironment.NormalizeCurrentProcess(); }
            catch { }

            var options = ParseArguments(args);
            if (options == null)
            {
                Console.Error.WriteLine("superstring setup");
                Console.Error.WriteLine("  (no args)                run the graphical installer");
                Console.Error.WriteLine("  /dir=<path> /silent      unattended install into <path>");
                Console.Error.WriteLine("  /noshortcut              unattended: do not create shortcuts");
                Console.Error.WriteLine("  /nodesktopshortcut       unattended: create only the Start Menu shortcut");
                Console.Error.WriteLine("  /nocheck                 unattended: skip the post-install product check");
                return ExitArguments;
            }

            using (var log = new SetupLog())
            {
                try
                {
                    if (!options.Silent)
                    {
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        Application.Run(new SetupForm(log));
                        return ExitOk;
                    }
                    PinUtf8StandardStreams();
                    var engine = new InstallEngine(log, delegate(string message, int percent) { Console.WriteLine("setup: " + message); });
                    InstallResult result = engine.Run(new InstallRequest
                    {
                        TargetRoot = options.TargetRoot,
                        CreateShortcuts = !options.NoShortcut,
                        CreateDesktopShortcut = !options.NoDesktopShortcut,
                        RunProductCheck = !options.NoCheck,
                        Uninstall = options.Uninstall,
                        InjectFailureAfter = options.FailAfter,
                    });
                    Console.WriteLine(ResultJson(result));
                    return ExitOk;
                }
                catch (Exception error)
                {
                    int code = MapExitCode(error);
                    log.Error(error.Message);
                    Console.WriteLine(ErrorJson(error));
                    if (options.DebugDetails) TryWriteError(log.Transcript());
                    return code;
                }
            }
        }

        /// <summary>
        /// Unattended stdout is a machine-readable channel: the progress lines and the
        /// final JSON result are parsed as UTF-8 by the launcher and by validation
        /// tooling. The Framework default writer encodes with the console OEM codepage,
        /// which silently mangles non-ASCII install paths on a zh-CN machine (a mojibake
        /// path never matches on disk), so pin UTF-8 the same way the desktop launcher does.
        /// </summary>
        private static void PinUtf8StandardStreams()
        {
            var encoding = new UTF8Encoding(false);
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), encoding) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), encoding) { AutoFlush = true });
        }

        /// <summary>Diagnostics must never turn a good install into a failed one.</summary>
        private static void TryWriteError(string text)
        {
            try { Console.Error.WriteLine(text); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
        }

        private static int MapExitCode(Exception error)
        {
            if (error is InstallBusyException) return ExitBusy;
            if (error is RollbackFailedException) return ExitRollbackFailed;
            string message = error.Message ?? string.Empty;
            if (message.StartsWith("TARGET_", StringComparison.Ordinal)) return ExitTargetRejected;
            if (message.StartsWith("MANIFEST_", StringComparison.Ordinal)) return ExitVersionRefused;
            if (message.StartsWith("DOWNGRADE_REJECTED", StringComparison.Ordinal)) return ExitVersionRefused;
            if (message.StartsWith("SETUP_PAYLOAD", StringComparison.Ordinal)) return ExitPayloadInvalid;
            if (message.StartsWith("磁盘空间不足", StringComparison.Ordinal)) return ExitNoSpace;
            if (message.StartsWith("VERIFY_", StringComparison.Ordinal)) return ExitVerificationFailed;
            if (message.StartsWith("安装后校验", StringComparison.Ordinal)) return ExitVerificationFailed;
            if (error is InvalidDataException) return ExitVersionRefused;
            return ExitGeneric;
        }

        private sealed class Options
        {
            internal bool Silent;
            internal string TargetRoot;
            internal bool NoShortcut;
            internal bool NoDesktopShortcut;
            internal bool NoCheck;
            internal string FailAfter;
            internal bool DebugDetails;
            internal bool Uninstall;
        }

        private static Options ParseArguments(string[] args)
        {
            var options = new Options { TargetRoot = SetupForm.DefaultTargetRoot() };
            foreach (string argument in args)
            {
                if (argument == "/?" || argument == "/help" || argument == "--help") return null;
                if (argument == "/silent" || argument == "--silent") { options.Silent = true; continue; }
                if (argument == "/noshortcut") { options.NoShortcut = true; continue; }
                if (argument == "/nodesktopshortcut") { options.NoDesktopShortcut = true; continue; }
                if (argument == "/nocheck") { options.NoCheck = true; continue; }
                if (argument == "/verbose") { options.DebugDetails = true; continue; }
                if (argument == "/uninstall") { options.Uninstall = true; options.Silent = true; continue; }
                if (StartsWith(argument, "/dir=") || StartsWith(argument, "--dir="))
                {
                    options.TargetRoot = argument.Substring(argument.IndexOf('=') + 1).Trim('"');
                    continue;
                }
                if (StartsWith(argument, "/fail-after="))
                {
                    // Fault injection for rollback verification; ignored unless the
                    // test hook environment variable is explicitly set.
                    if (InstallRequest.TestHookEnabled) options.FailAfter = argument.Substring(argument.IndexOf('=') + 1);
                    continue;
                }
                return null;
            }
            if (string.IsNullOrEmpty(options.TargetRoot)) return null;
            return options;
        }

        private static bool StartsWith(string value, string prefix)
        {
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static string ResultJson(InstallResult result)
        {
            var map = new Dictionary<string, object>
            {
                { "ok", true },
                { "action", result.Action },
                { "version", result.Version },
                { "previousVersion", result.PreviousVersion ?? "" },
                { "backupDirectory", result.BackupDirectory ?? "" },
                { "targetRoot", result.TargetRoot },
                { "requiredBytes", result.RequiredBytes },
                { "availableBytes", result.AvailableBytes },
                { "shortcuts", result.Shortcuts.ToArray() },
            };
            return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(map);
        }

        private static string ErrorJson(Exception error)
        {
            var map = new Dictionary<string, object>
            {
                { "ok", false },
                { "error", error.GetType().Name },
                { "message", error.Message },
            };
            return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(map);
        }
    }
}
