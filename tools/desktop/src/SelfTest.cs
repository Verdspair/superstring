using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Superstring.Desktop
{
    /// <summary>
    /// Offline verification battery (--self-test). It proves the launcher's
    /// contracts without starting any project server:
    ///   * project root resolved from the EXE path (no hard-coded drive letter)
    ///   * Bun resolved and pinned to 1.4.2
    ///   * 64-hex desktop token generated
    ///   * readiness identity parsing + token never travels in the URL
    ///   * single-instance mutex name is deterministic and root-derived
    ///   * logger masks the token (and Bearer credentials)
    ///   * GUI form geometry and title are correct (no subtitle)
    /// </summary>
    internal static class SelfTest
    {
        private static int _failed;
        private static string _outputDirectory;

        public static int Run()
        {
            _failed = 0;
            string projectRoot = ProjectLocator.FindRoot(ProjectLocator.ExeDirectory);
            if (string.IsNullOrEmpty(projectRoot))
            {
                Console.WriteLine("Self-test requires an explicit development project; no files written.");
                return 1;
            }
            _outputDirectory = Path.Combine(projectRoot, "artifacts", "validation", "desktop-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_outputDirectory);
            Console.WriteLine("Evidence: " + _outputDirectory);
            Console.WriteLine("=== superstring desktop --self-test ===");

            // 1. project root
            string root = ProjectLocator.FindRoot(ProjectLocator.ExeDirectory);
            Check("project root located from EXE path", !string.IsNullOrEmpty(root));
            if (!string.IsNullOrEmpty(root))
            {
                var manifest = new System.Web.Script.Serialization.JavaScriptSerializer()
                    .Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "package.json")));
                object packageName;
                Check("root contains package.json(name=superstring)",
                    manifest != null && manifest.TryGetValue("name", out packageName) && object.Equals(packageName, "superstring"));
                RunProjectLocatorCheck(root);
            }

            // 2. bun
            if (!string.IsNullOrEmpty(root))
            {
                string err;
                string bun = BunResolver.Resolve(root, out err);
                Check("bun resolved (SUPERSTRING_BUN_EXE / node_modules / PATH)", bun != null, err);
                if (bun != null)
                {
                    string ver;
                    bool ok = BunResolver.VersionMatches(bun, out ver);
                    Check("bun version is exactly " + BunResolver.RequiredVersion + " (got " + (ver ?? "?") + ")", ok);
                }
            }

            // 3. token
            string token = Util.RandomHex(32);
            Check("desktop token is 64 hex chars", token.Length == 64 && Util.IsHex(token));

            // 4. readiness identity parsing
            Check("identity ready (valid body)", Readiness.IsIdentityReady("{\"app\":\"superstring\",\"desktop\":true,\"state\":\"ready\"}"));
            Check("identity rejected (wrong app)", !Readiness.IsIdentityReady("{\"app\":\"x\",\"desktop\":true,\"state\":\"ready\"}"));
            Check("identity rejected (desktop=false)", !Readiness.IsIdentityReady("{\"app\":\"superstring\",\"desktop\":false,\"state\":\"ready\"}"));
            Check("identity rejected (not ready)", !Readiness.IsIdentityReady("{\"app\":\"superstring\",\"desktop\":true,\"state\":\"starting\"}"));
            Check("identity rejected (garbage)", !Readiness.IsIdentityReady("not json"));

            int reportedPort;
            Check("actual port parses preferred", Readiness.TryReadPort("SUPERSTRING_DESKTOP_PORT 17861", out reportedPort) && reportedPort == 17861);
            Check("actual port parses OS-assigned", Readiness.TryReadPort("SUPERSTRING_DESKTOP_PORT 49152", out reportedPort) && reportedPort == 49152);
            foreach (string line in new string[] { null, "", "SUPERSTRING_DESKTOP_PORT ", "SUPERSTRING_DESKTOP_PORT 0", "SUPERSTRING_DESKTOP_PORT 65536", "SUPERSTRING_DESKTOP_PORT -1", "SUPERSTRING_DESKTOP_PORT +80", "SUPERSTRING_DESKTOP_PORT 80 trailing", "SUPERSTRING_DESKTOP_PORT  80", "[log] SUPERSTRING_DESKTOP_PORT 80" })
                Check("actual port rejects malformed: " + (line ?? "null"), !Readiness.TryReadPort(line, out reportedPort));

            // 5. token never in URL
            string baseUrl = "http://127.0.0.1:17861";
            Check("status URL shape", Readiness.StatusUrl(baseUrl) == baseUrl + "/__desktop/status");
            Check("health URL shape", Readiness.HealthUrl(baseUrl) == baseUrl + "/health");
            Check("stop URL shape", Readiness.StopUrl(baseUrl) == baseUrl + "/__desktop/stop");
            Check("token is NOT placed in the URL", Readiness.StatusUrl(baseUrl).IndexOf(token, StringComparison.Ordinal) < 0);

            // 6. single-instance hash determinism
            string h1 = SingleInstance.RootHash("C:\\foo\\bar");
            string h2 = SingleInstance.RootHash("c:/foo/bar");
            string h3 = SingleInstance.RootHash("C:\\foo\\baz");
            Check("root hash is normalisation-stable", h1 == h2);
            Check("root hash differs for different roots", h1 != h3);
            Check("root hash is 16 hex", h1.Length == 16 && Util.IsHex(h1));

            // 7. logger redaction
            string tmp = Path.Combine(_outputDirectory, "logger-fixture");
            Directory.CreateDirectory(tmp);
            try
            {
                var lg = new Logger(tmp, token);
                lg.Detail("token=" + token);
                lg.Detail("Authorization: Bearer " + token);
                lg.Detail("normal line without secret");
                // give the writer a moment
                string[] files = Directory.GetFiles(Path.Combine(tmp, "artifacts", "desktop"), "*.log");
                Check("logger produces at least one file", files.Length > 0);
                bool foundToken = false, foundRedacted = false;
                foreach (string f in files)
                {
                    string content = File.ReadAllText(f);
                    if (content.IndexOf(token, StringComparison.Ordinal) >= 0) foundToken = true;
                    if (content.IndexOf("REDACTED", StringComparison.Ordinal) >= 0) foundRedacted = true;
                }
                Check("logger never writes the raw token", !foundToken);
                Check("logger masks Bearer credential", foundRedacted);
            }
            finally
            {
                try { Directory.Delete(tmp, true); } catch { }
            }

            int duplicateCount;
            string[] normalized = ProcessEnvironment.Deduplicate(new string[] {
                "HTTP_PROXY=first", "http_proxy=second", "Path=C:\\fixture", "PATH=other",
                "EMPTY=", "TOKEN=a=b=c", "=C:=C:\\fixture", "=c:=C:\\other", "UNICODE=中文"
            }, out duplicateCount);
            Check("environment case duplicates counted", duplicateCount == 3);
            Check("environment keeps first proxy value", Array.IndexOf(normalized, "HTTP_PROXY=first") >= 0 && Array.IndexOf(normalized, "http_proxy=second") < 0);
            Check("environment preserves empty values", Array.IndexOf(normalized, "EMPTY=") >= 0);
            Check("environment preserves embedded equals", Array.IndexOf(normalized, "TOKEN=a=b=c") >= 0);
            Check("environment preserves hidden drive entries", Array.IndexOf(normalized, "=C:=C:\\fixture") >= 0);
            Check("environment preserves unicode", Array.IndexOf(normalized, "UNICODE=中文") >= 0);
            Check("environment normalization is idempotent", ProcessEnvironment.NormalizeCurrentProcess() == 0);

            var childInfo = new System.Diagnostics.ProcessStartInfo {
                FileName = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName,
                Arguments = "--help", UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            childInfo.EnvironmentVariables["SUPERSTRING_ENV_TEST"] = "fixture";
            using (var child = System.Diagnostics.Process.Start(childInfo))
            {
                bool exited = child.WaitForExit(10000);
                if (!exited) { child.Kill(); child.WaitForExit(); } // Help-only fixture, never a database process.
                Check("normalized environment starts a real child process", exited && child.ExitCode == 0 && child.StandardOutput.ReadToEnd().Contains("superstring desktop launcher"));
            }

            // Installed environment isolation is exercised on synthetic paths only.
            var layout = new DesktopLayout { Root = Path.Combine(_outputDirectory, "install-fixture"), Installed = true };
            bool lowSpaceRejected = false;
            try { DesktopLayout.CheckStartupSpace(DesktopLayout.StartupReserveBytes - 1); }
            catch (IOException) { lowSpaceRejected = true; }
            Check("startup rejects below reserve", lowSpaceRejected);
            DesktopLayout.CheckStartupSpace(DesktopLayout.StartupReserveBytes);
            Check("startup accepts exact reserve", true);
            layout.PrepareInstalledStorage();
            Check("storage preflight creates selected-root directories", Directory.Exists(Path.Combine(layout.Root, "userdata", "config")) && Directory.Exists(Path.Combine(layout.Root, "maintenance")));
            Check("storage preflight removes owned probes", Directory.GetFiles(layout.Root, "*", SearchOption.AllDirectories).Length == 0);
            Check("storage preflight creates no database", !File.Exists(Path.Combine(layout.Root, "userdata", "data", "superstring.sqlite")));
            string occupiedRoot = Path.Combine(_outputDirectory, "occupied-storage");
            Directory.CreateDirectory(occupiedRoot);
            File.WriteAllText(Path.Combine(occupiedRoot, "userdata"), "do not replace");
            bool occupiedRejected = false;
            try { new DesktopLayout { Root = occupiedRoot, Installed = true }.PrepareInstalledStorage(); }
            catch (IOException) { occupiedRejected = true; }
            Check("storage file collision is rejected", occupiedRejected);
            Check("storage file collision preserves contents", File.ReadAllText(Path.Combine(occupiedRoot, "userdata")) == "do not replace");
            var psi = new System.Diagnostics.ProcessStartInfo();
            foreach (string key in new string[] { "SUPERSTRING_DB_PATH", "SUPERSTRING_APP_ROOT", "SUPERSTRING_APP_MODE", "SUPERSTRING_BUN_EXE", "BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS", "NODE_PATH" })
                psi.EnvironmentVariables[key] = "fixture-override";
            layout.ConfigureInstalledEnvironment(psi);
            Check("installed environment fixes mode", psi.EnvironmentVariables["SUPERSTRING_APP_MODE"] == "installed");
            Check("installed environment fixes selected root", psi.EnvironmentVariables["SUPERSTRING_APP_ROOT"] == layout.Root);
            foreach (string key in new string[] { "SUPERSTRING_DB_PATH", "SUPERSTRING_BUN_EXE", "BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS", "NODE_PATH" })
                Check("installed clears " + key, !psi.EnvironmentVariables.ContainsKey(key));
            Check("installed state uses userdata", layout.StateDirectory == Path.Combine(layout.Root, "userdata", "state"));
            Check("installed logs use selected root", layout.LogDirectory == Path.Combine(layout.Root, "logs"));
            string blockedLog = Path.Combine(_outputDirectory, "blocked-log-file");
            File.WriteAllText(blockedLog, "synthetic fixture");
            bool rejectedLog = false;
            try { new Logger(layout.Root, token, blockedLog); }
            catch (IOException) { rejectedLog = true; }
            Check("unwritable log directory rejects instead of temp fallback", rejectedLog);

            RunAppearanceCheck();
            // 8. GUI geometry / title (no subtitle)
            RunGuiCheck();

            Console.WriteLine(_failed == 0 ? "=== SELF-TEST PASSED ===" : "=== SELF-TEST FAILED (" + _failed + ") ===");
            return _failed == 0 ? 0 : 1;
        }

        private static void RunProjectLocatorCheck(string projectRoot)
        {
            string fixture = Path.Combine(_outputDirectory, "project-locator-fixture");
            string arbitraryRoot = Path.Combine(fixture, "renamed-project");
            string nested = Path.Combine(arbitraryRoot, "dist", "desktop");
            Directory.CreateDirectory(nested);
            File.WriteAllText(Path.Combine(arbitraryRoot, "package.json"), "{\"name\":\"superstring\"}");
            Check("project root accepts arbitrary directory names",
                ProjectLocator.FindRoot(nested) == Path.GetFullPath(arbitraryRoot));

            string wrongRoot = Path.Combine(fixture, "superstring");
            Directory.CreateDirectory(wrongRoot);
            File.WriteAllText(Path.Combine(wrongRoot, "package.json"), "{\"name\":\"different-project\"}");
            // The fixture lives under the real project; a rejected package falls back to that ancestor.
            Check("project root rejects wrong package despite matching directory name",
                ProjectLocator.FindRoot(wrongRoot) == Path.GetFullPath(projectRoot));
            File.WriteAllText(Path.Combine(wrongRoot, "package.json"), "{}");
            Check("project root skips package without name",
                ProjectLocator.FindRoot(wrongRoot) == Path.GetFullPath(projectRoot));
        }

        private static void RunAppearanceCheck()
        {
            string dir = Path.Combine(_outputDirectory, "appearance-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "desktop-appearance.json"), theme, mode;
            DesktopAppearance.LoadSnapshot(dir, out theme, out mode);
            Check("missing snapshot defaults as a pair", theme == "slate" && mode == "system");
            for (int i = 0; i < DesktopPaletteData.Themes.GetLength(0); i++)
            {
                string id = DesktopPaletteData.Themes[i, 0];
                foreach (string selectedMode in DesktopPaletteData.Modes)
                {
                    File.WriteAllText(file, "{\"version\":1,\"theme\":\"" + id + "\",\"mode\":\"" + selectedMode + "\"}");
                    DesktopAppearance.LoadSnapshot(dir, out theme, out mode);
                    var p = DesktopAppearance.Resolve(theme, mode, () => true);
                    bool expectedDark = selectedMode != "light";
                    var expected = System.Drawing.ColorTranslator.FromHtml(DesktopPaletteData.Themes[i, expectedDark ? 2 : 1]);
                    Check("appearance " + id + "/" + selectedMode,
                        theme == id && mode == selectedMode && p.IsDark == expectedDark && p.Deep.ToArgb() == expected.ToArgb());
                }
            }
            string[] invalid = {
                "not json", "[]", "{\"theme\":\"blue\",\"mode\":\"dark\"}",
                "{\"version\":2,\"theme\":\"blue\",\"mode\":\"dark\"}",
                "{\"version\":1,\"theme\":\"blue\",\"mode\":\"dark\",\"extra\":1}",
                "{\"version\":1,\"theme\":\"blue\",\"mode\":\"bad\"}",
                "{\"version\":1,\"theme\":\"bad\",\"mode\":\"dark\"}",
                "{\"version\":\"1\",\"theme\":\"blue\",\"mode\":\"dark\"}", new string(' ', 4097)
            };
            for (int i = 0; i < invalid.Length; i++)
            {
                File.WriteAllText(file, invalid[i]);
                DesktopAppearance.LoadSnapshot(dir, out theme, out mode);
                Check("invalid snapshot defaults whole pair " + i, theme == "slate" && mode == "system");
            }
            File.WriteAllBytes(file, new byte[] { 0xff, 0xfe, 0xff });
            DesktopAppearance.LoadSnapshot(dir, out theme, out mode);
            Check("invalid UTF8 rejected", theme == "slate" && mode == "system");
            Check("system follows injected light", !DesktopAppearance.Resolve("slate", "system", () => false).IsDark);
            Check("fixed dark ignores system light", DesktopAppearance.Resolve("slate", "dark", () => false).IsDark);
            Check("slate keeps CSS distinct focus accent", DesktopAppearance.Resolve("slate", "light").Accent.ToArgb() == System.Drawing.ColorTranslator.FromHtml("#4266b0").ToArgb());
            Check("dark surface equals web CSS", DesktopAppearance.Resolve("blue", "dark").Surface.ToArgb() == System.Drawing.ColorTranslator.FromHtml("#232b36").ToArgb());
        }

        private static void RunGuiCheck()
        {
            bool ok = false;
            string title = null;
            System.Drawing.Size sz = System.Drawing.Size.Empty;
            string err = null;
            var t = new Thread(() =>
            {
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (var f = new MainForm())
                    {
                        title = f.Text;
                        sz = f.ClientSize;
                        f.ShowInTaskbar = false;
                        f.StartPosition = FormStartPosition.Manual;
                        f.Location = new System.Drawing.Point(-10000, -10000);
                        f.Show();
                        f.PerformLayout();
                        Application.DoEvents();
                        using (var image = new System.Drawing.Bitmap(f.Width, f.Height))
                        {
                            f.DrawToBitmap(image, new System.Drawing.Rectangle(0, 0, f.Width, f.Height));
                            image.Save(Path.Combine(_outputDirectory, "launcher-preview.png"));
                        }

                        // brand / title (English only, no subtitle, no CJK)
                        var brandName = f.Controls.Find("brandName", true)[0];
                        Check("brand is exactly English 'superstring'", brandName.Text == "superstring");
                        Check("brand has NO Chinese (超弦) characters", !ContainsCjk(brandName.Text));
                        Check("surface matches project CSS", f.BackColor == DesktopStyle.Surface);
                        Check("primary uses project deep color", DesktopStyle.Deep.ToArgb() == System.Drawing.ColorTranslator.FromHtml("#26364a").ToArgb());

                        // normal state: no operation buttons, no empty dashed frame
                        Check("normal state has NO visible action buttons", !AnyVisibleButton(f));
                        Check("normal state has NO empty dashed frame", !HasNamed(f, "content"));
                        Check("normal layout fits", Fits(f));
                        Check("normal status is centred and scaled once", StatusGeometry(f));
                        Capture(f, "launcher-normal.png");

                        // busy state: indicator animates, still no buttons
                        f.SetBusy(true);
                        f.SetStatus("正在准备…");
                        var spinner = (IndeterminateDot)f.Controls.Find("spinner", true)[0];
                        Check("busy shows animating indicator (no fake %)", spinner.IsAnimating && !AnyVisibleButton(f));
                        Capture(f, "launcher-busy.png");

                        // failure state: retry + details appear, indicator stops
                        f.EnterFailed("测试用日志：连接未完成。\r\n这是合成失败状态，不连接服务、不读取用户数据。\r\n检查后可以重试。");
                        Check("failed state exposes retry button", f.Controls.Find("retry", true)[0].Visible);
                        Check("failed state exposes details button", f.Controls.Find("details", true)[0].Visible);
                        Check("failed state stops animating indicator", !spinner.IsAnimating);
                        Check("failed layout fits", Fits(f));
                        Capture(f, "launcher-failed.png");

                        // details expand / collapse works
                        f.ToggleDetails();
                        Check("details expands on toggle", f.Controls.Find("detail", true)[0].Visible);
                        Check("details button label flips to hide", f.Controls.Find("details", true)[0].Text == "隐藏详情");
                        Check("expanded details layout fits", Fits(f));
                        Capture(f, "launcher-details.png");
                        f.ToggleDetails();
                        Check("details collapses on second toggle", !f.Controls.Find("detail", true)[0].Visible);
                        Check("details button label returns to view", f.Controls.Find("details", true)[0].Text == "查看详情");

                        // busy-after-failure resets the state
                        f.ToggleDetails(); // expand again (verifies reset clears it)
                        f.SetBusy(true);    // simulate a retry attempt
                        Check("busy resets failure UI (buttons hidden)", !AnyVisibleButton(f) && spinner.IsAnimating);
                        f.EnterFailed("第二次合成失败，验证状态重置。");
                        Check("re-failure shows retry + collapsed details",
                            f.Controls.Find("retry", true)[0].Visible
                            && f.Controls.Find("details", true)[0].Visible
                            && !f.Controls.Find("detail", true)[0].Visible
                            && f.Controls.Find("details", true)[0].Text == "查看详情");

                        // synthetic scaling geometry (NOT a real-DPI acceptance)
                        f.SetBusy(false);
                        f.PerformLayout();
                        f.Scale(new System.Drawing.SizeF(1.25f, 1.25f));
                        f.PerformLayout();
                        Check("125% synthetic scale fits", Fits(f));
                        Check("125% status centred and scaled once", StatusGeometry(f));
                        Capture(f, "launcher-scale125.png");
                        f.Scale(new System.Drawing.SizeF(1.2f, 1.2f));
                        f.PerformLayout();
                        Check("150% synthetic scale fits", Fits(f));
                        Check("150% status centred and scaled once", StatusGeometry(f));
                        Capture(f, "launcher-scale150.png");

                        // appearance applies to every visible label
                        var lightSurface = System.Drawing.ColorTranslator.FromHtml("#ffffff").ToArgb();
                        f.ApplyAppearance("blue", "dark");
                        Check("ApplyAppearance(dark) changes surface colour",
                            f.BackColor.ToArgb() != lightSurface);
                        Check("ApplyAppearance(dark) applies theme accent (blue.dark)",
                            DesktopStyle.Deep.ToArgb() == System.Drawing.ColorTranslator.FromHtml("#a6c8ff").ToArgb());
                        Check("brand label follows dark text", brandName.ForeColor.ToArgb() == DesktopStyle.Text.ToArgb());
                        Capture(f, "launcher-blue-dark.png");
                        f.ApplyAppearance("rose", "light");
                        Capture(f, "launcher-rose-light.png");
                        f.ApplyAppearance("slate", "light");
                        Check("ApplyAppearance(light) restores light surface",
                            f.BackColor.ToArgb() == lightSurface);
                        Check("ApplyAppearance(light) restores slate accent",
                            DesktopStyle.Deep.ToArgb() == System.Drawing.ColorTranslator.FromHtml("#26364a").ToArgb());
                    }
                    ok = true;
                }
                catch (Exception ex) { err = ex.Message + "\n" + ex.StackTrace; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join(15000);

            Check("form constructs without error", ok, err);
            if (ok)
            {
                Check("title is exactly 'superstring' (no subtitle)", title == "superstring");
                Check("logical client size is at least 680x460", sz.Width >= 680 && sz.Height >= 460, sz.ToString());
            }
        }

        private static bool AnyVisibleButton(Control c)
        {
            foreach (Control child in c.Controls)
            {
                if (child is Button && child.Visible) return true;
                if (AnyVisibleButton(child)) return true;
            }
            return false;
        }

        private static bool HasNamed(Control c, string name)
        {
            foreach (Control child in c.Controls)
            {
                if (child.Name == name) return true;
                if (HasNamed(child, name)) return true;
            }
            return false;
        }

        private static bool ContainsCjk(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            foreach (char ch in s)
                if (ch >= 0x4E00 && ch <= 0x9FFF) return true; // CJK Unified Ideographs
            return false;
        }

        private static bool StatusGeometry(Form form)
        {
            Control status = form.Controls.Find("status", true)[0];
            double scale = form.ClientSize.Width / 680.0;
            return Math.Abs(status.Left + status.Width / 2.0 - form.ClientSize.Width / 2.0) <= 2
                && Math.Abs(status.Width - 600 * scale) <= 2
                && Math.Abs(status.Height - 44 * scale) <= 2;
        }

        private static bool Fits(Control parent)
        {
            foreach (Control child in parent.Controls)
            {
                if (!child.Visible) continue;
                if (child.Left < 0 || child.Top < 0 || child.Right > parent.ClientSize.Width + 1 || child.Bottom > parent.ClientSize.Height + 1)
                {
                    Console.WriteLine("GEOMETRY " + child.Name + " bounds=" + child.Bounds + " parent=" + parent.ClientSize);
                    return false;
                }
                if (!Fits(child)) return false;
                if (child is Button)
                {
                    var size = TextRenderer.MeasureText(child.Text, child.Font);
                    if (size.Width > child.Width - 8 || size.Height > child.Height - 4) return false;
                }
            }
            return true;
        }

        private static void Capture(Form form, string filename)
        {
            form.Refresh();
            Application.DoEvents();
            using (var image = new System.Drawing.Bitmap(form.Width, form.Height))
            {
                form.DrawToBitmap(image, new System.Drawing.Rectangle(0, 0, form.Width, form.Height));
                image.Save(Path.Combine(_outputDirectory, filename));
            }
        }

        private static void Check(string name, bool pass, string detail)
        {
            if (pass)
            {
                Console.WriteLine("PASS  " + name);
            }
            else
            {
                _failed++;
                Console.WriteLine("FAIL  " + name + (string.IsNullOrEmpty(detail) ? "" : "  (" + detail + ")"));
            }
        }

        private static void Check(string name, bool pass)
        {
            Check(name, pass, null);
        }
    }
}
