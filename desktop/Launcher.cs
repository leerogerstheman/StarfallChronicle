// ===========================================================================
//  Starfall Chronicle - native window launcher
// ===========================================================================
//
//  What this is
//  ------------
//  A tiny WinForms host whose only job is to give the game its own real
//  window: no browser, no tab, no address bar, its own taskbar entry and
//  title. It embeds a WebView2 control pointed at the local Node server.
//
//  Why WebView2 and not a full native rewrite
//  ------------------------------------------
//  The battle HUD is ~40KB of hand-written CSS with custom properties, grid
//  layouts, float animations and a reduced-motion path. Rewriting that in
//  WinForms would look worse, take far longer, and throw away the entire
//  browser test suite. WebView2 keeps one renderer, one stylesheet, one set
//  of tests.
//
//  Lifecycle
//  ---------
//    resolve project root -> find node -> start src/server.js (hidden)
//      -> poll TCP port until ready -> open window -> navigate
//    window closed -> kill node -> exit
//
//  Readiness is detected by polling the port, never by parsing child stdout.
//  stdout from a grandchild process is unreliable to observe, and it is not a
//  contract the server promised; the listening socket is.
//
//  If the WebView2 runtime or SDK assemblies are missing, this falls back to
//  the user's default browser instead of failing. The game stays playable.
//
//  Build with:  build-desktop.bat   (uses the OS's own csc.exe, no SDK needed)
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StarfallChronicle
{
    internal static class Program
    {
        private const string AppTitle = "星陨纪年 · Starfall Chronicle";
        private const int DefaultPort = 8787;
        private const int HealthTimeoutMs = 30000;
        private const int HealthPollMs = 250;

        private static Process _server;
        private static Form _window;
        private static WebView2 _view;
        private static CoreWebView2Environment _env;
        private static int _port = DefaultPort;
        private static string _root;
        private static string _baseUrl;

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _port = ResolvePort(args);

            _root = ResolveRoot();
            if (_root == null)
            {
                Fail("找不到项目文件 src\\server.js。\n\n"
                   + "请把 StarfallChronicle.exe 放在项目目录下的 desktop\\bin\\ 中，\n"
                   + "或从项目根目录运行 build-desktop.bat 重新构建。");
                return 2;
            }

            _baseUrl = "http://127.0.0.1:" + _port;

            string node = FindNode();
            if (node == null)
            {
                Fail("找不到 Node.js（需要 22 或更新版本）。\n\n"
                   + "请从 https://nodejs.org/ 安装后重试。");
                return 3;
            }

            // If something already answers on this port, assume it is a server
            // we can talk to (for example one started by start.bat) and just
            // attach to it. We must not kill a process we did not start.
            bool attached = HealthOk(_port, 400);

            if (!attached)
            {
                _server = StartServer(node);
                if (_server == null)
                {
                    Fail("无法启动本地服务（" + _baseUrl + "）。");
                    return 4;
                }
                if (!WaitForHealth())
                {
                    ShutdownServer();
                    Fail("本地服务在 " + (HealthTimeoutMs / 1000) + " 秒内没有就绪。\n\n"
                       + "请确认端口 " + _port + " 未被占用，或设置环境变量 PORT 换一个端口。");
                    return 5;
                }
            }

            // Plumbing check: everything up to the window works, then stop.
            // Used by test\desktop.js so the launcher's process handling can be
            // tested on machines with no WebView2 runtime, and on CI.
            if (HasFlag(args, "--selfcheck"))
            {
                bool healthy = HttpProbe(_baseUrl + "/api/health", 4000);
                ShutdownServer();
                Console.Out.WriteLine(healthy
                    ? "selfcheck ok  root=" + _root + "  port=" + _port
                    : "selfcheck FAILED  root=" + _root + "  port=" + _port);
                Console.Out.Flush();
                return healthy ? 0 : 6;
            }

            int code = RunWindow();

            ShutdownServer();
            return code;
        }

        // -- command line ---------------------------------------------------

        private static bool HasFlag(string[] args, string flag)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (String.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// Fetch /api/health. Used only by --selfcheck; the window path trusts a
        /// successful TCP connect, because the server binds the port only after
        /// its self-check passes.
        /// </summary>
        private static bool HttpProbe(string url, int timeoutMs)
        {
            try
            {
                System.Net.HttpWebRequest req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Method = "GET";
                using (System.Net.HttpWebResponse res = (System.Net.HttpWebResponse)req.GetResponse())
                using (StreamReader r = new StreamReader(res.GetResponseStream()))
                {
                    string body = r.ReadToEnd();
                    return res.StatusCode == System.Net.HttpStatusCode.OK
                        && body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static int ResolvePort(string[] args)
        {
            string fromEnv = Environment.GetEnvironmentVariable("PORT");
            int port;
            if (!String.IsNullOrEmpty(fromEnv) && Int32.TryParse(fromEnv, out port)
                && port > 0 && port < 65536)
            {
                return port;
            }
            for (int i = 0; i < args.Length; i++)
            {
                if ((args[i] == "--port" || args[i] == "-p") && i + 1 < args.Length)
                {
                    if (Int32.TryParse(args[i + 1], out port) && port > 0 && port < 65536)
                    {
                        return port;
                    }
                }
            }
            return DefaultPort;
        }

        // -- project root ---------------------------------------------------

        /// <summary>
        /// Look for src/server.js starting beside the executable, then in the
        /// working directory, then walking up to five parent directories.
        /// </summary>
        private static string ResolveRoot()
        {
            List<string> seeds = new List<string>();
            try
            {
                seeds.Add(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
            }
            catch (Exception) { }
            try
            {
                seeds.Add(Environment.CurrentDirectory);
            }
            catch (Exception) { }
            try
            {
                seeds.Add(AppDomain.CurrentDomain.BaseDirectory);
            }
            catch (Exception) { }

            for (int s = 0; s < seeds.Count; s++)
            {
                string dir = seeds[s];
                if (String.IsNullOrEmpty(dir)) continue;

                for (int up = 0; up <= 5 && !String.IsNullOrEmpty(dir); up++)
                {
                    if (File.Exists(Path.Combine(dir, "src", "server.js")))
                    {
                        return dir;
                    }
                    DirectoryInfo parent = Directory.GetParent(dir);
                    dir = parent == null ? null : parent.FullName;
                }
            }
            return null;
        }

        // -- node -----------------------------------------------------------

        private static string FindNode()
        {
            List<string> candidates = new List<string>();

            string onPath = WhichNode();
            if (onPath != null) candidates.Add(onPath);

            string pf = Environment.GetEnvironmentVariable("ProgramFiles");
            string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");
            string appData = Environment.GetEnvironmentVariable("APPDATA");

            if (pf != null) candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            if (pf86 != null) candidates.Add(Path.Combine(pf86, "nodejs", "node.exe"));
            if (local != null) candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));
            if (appData != null) candidates.Add(Path.Combine(appData, "npm", "node.exe"));

            // Runtimes shipped by other tooling on this machine. These are
            // ordinary Node builds; the game needs nothing beyond core modules.
            if (profile != null)
            {
                candidates.Add(Path.Combine(profile, ".dsh", "dsh-runtimes",
                    "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe"));
                candidates.Add(Path.Combine(profile, "scoop", "apps", "nodejs", "current", "node.exe"));
            }
            if (local != null)
            {
                candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));
                candidates.Add(Path.Combine(local, "Microsoft", "WinGet", "Links", "node.exe"));
            }

            for (int i = 0; i < candidates.Count; i++)
            {
                if (IsUsableNode(candidates[i])) return candidates[i];
            }
            return null;
        }

        private static string WhichNode()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("node", "--version");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string v = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(4000)) { try { p.Kill(); } catch (Exception) { } return null; }
                    return p.ExitCode == 0 && v.Trim().Length > 0 ? "node" : null;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool IsUsableNode(string path)
        {
            if (String.IsNullOrEmpty(path) || !File.Exists(path)) return false;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(path, "--version");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string v = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(5000)) { try { p.Kill(); } catch (Exception) { } return false; }
                    return p.ExitCode == 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        // -- server process -------------------------------------------------

        private static Process StartServer(string nodeExe)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = "\"" + Path.Combine(_root, "src", "server.js") + "\"";
                psi.WorkingDirectory = _root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;

                SetEnv(psi, "PORT", _port.ToString());
                SetEnv(psi, "STARFALL_NO_OPEN", "1");

                Process p = new Process();
                p.StartInfo = psi;
                p.EnableRaisingEvents = true;

                // Drain both pipes. A full pipe buffer would block the child
                // forever, and the server does print a startup banner.
                StringBuilder noise = new StringBuilder();
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) { lock (noise) { noise.AppendLine(e.Data); } }
                };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) { lock (noise) { noise.AppendLine(e.Data); } }
                };

                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                return p;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void SetEnv(ProcessStartInfo psi, string key, string value)
        {
            try
            {
                psi.EnvironmentVariables[key] = value;
            }
            catch (ArgumentException)
            {
                // EnvironmentVariables on .NET Framework is case-insensitive
                // on Windows; a duplicate key under different casing throws.
                // Harmless: the variable is already set.
            }
        }

        private static bool WaitForHealth()
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < HealthTimeoutMs)
            {
                if (_server != null && _server.HasExited) return false;
                if (HealthOk(_port, 500)) return true;
                Thread.Sleep(HealthPollMs);
            }
            return false;
        }

        /// <summary>
        /// A successful TCP connect is the signal: the server binds the port
        /// only after its self-check passes, so listening means playable.
        /// </summary>
        private static bool HealthOk(int port, int timeoutMs)
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                    c.EndConnect(ar);
                    return c.Connected;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void ShutdownServer()
        {
            if (_server == null) return;
            try
            {
                if (!_server.HasExited)
                {
                    _server.Kill();
                    if (!_server.WaitForExit(4000))
                    {
                        try { _server.Kill(); } catch (Exception) { }
                    }
                }
            }
            catch (Exception) { }
            finally
            {
                try { _server.Dispose(); } catch (Exception) { }
                _server = null;
            }
        }

        // -- window ---------------------------------------------------------

        private static int RunWindow()
        {
            string sdkDir = SdkDir();
            string runtimeDir = FindWebViewRuntime();

            if (sdkDir == null || runtimeDir == null)
            {
                return RunBrowserFallback(sdkDir == null
                    ? "缺少 WebView2 组件（desktop\\bin 下的 DLL）。"
                    : "本机未安装 WebView2 运行时。");
            }

            try
            {
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions();
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "StarfallChronicle", "WebView2");
                try { Directory.CreateDirectory(userData); } catch (Exception) { }

                var task = CoreWebView2Environment.CreateAsync(runtimeDir, userData, options);
                if (!task.Wait(20000) || task.Result == null)
                {
                    throw new TimeoutException("CreateAsync 超时");
                }
                _env = task.Result;

                _window = new Form();
                _window.Text = AppTitle;
                _window.StartPosition = FormStartPosition.CenterScreen;
                _window.Size = new Size(1440, 900);
                _window.MinimumSize = new Size(960, 600);
                _window.BackColor = Color.FromArgb(12, 14, 22);
                _window.KeyPreview = true;

                try
                {
                    Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                    if (icon != null) _window.Icon = icon;
                }
                catch (Exception) { }

                _view = new WebView2();
                _view.Dock = DockStyle.Fill;
                _view.DefaultBackgroundColor = Color.FromArgb(12, 14, 22);
                _window.Controls.Add(_view);

                _view.CoreWebView2InitializationCompleted += OnViewReady;

                _window.FormClosed += delegate(object s, FormClosedEventArgs e)
                {
                    try { if (_view != null) _view.Dispose(); } catch (Exception) { }
                    ShutdownServer();
                    Environment.Exit(0);
                };

                _view.EnsureCoreWebView2Async(_env);

                Application.Run(_window);
                return 0;
            }
            catch (Exception ex)
            {
                return RunBrowserFallback("创建窗口失败：" + ex.Message);
            }
        }

        private static void OnViewReady(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                RunBrowserFallback("WebView2 初始化失败：" + (e.InitializationException == null
                    ? "未知错误" : e.InitializationException.Message));
                return;
            }
            try
            {
                CoreWebView2Settings settings = _view.CoreWebView2.Settings;
                settings.AreDefaultContextMenusEnabled = false;
                settings.IsStatusBarEnabled = false;
                settings.AreBrowserAcceleratorKeysEnabled = true;
                settings.IsZoomControlEnabled = true;
                settings.IsPasswordAutosaveEnabled = false;
                settings.IsGeneralAutofillEnabled = false;
            }
            catch (Exception) { }

            _view.CoreWebView2.Navigate(_baseUrl);
        }

        private static string SdkDir()
        {
            string dir = null;
            try { dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
            catch (Exception) { }
            if (String.IsNullOrEmpty(dir)) return null;

            bool core = File.Exists(Path.Combine(dir, "Microsoft.Web.WebView2.Core.dll"));
            bool winforms = File.Exists(Path.Combine(dir, "Microsoft.Web.WebView2.WinForms.dll"));
            bool loader = File.Exists(Path.Combine(dir, "WebView2Loader.dll"));
            return core && winforms && loader ? dir : null;
        }

        /// <summary>
        /// The Evergreen runtime ships with Edge; WebView2 usually lives in a
        /// versioned folder under Program Files (x86). Pick the newest one that
        /// actually contains the host executable.
        /// </summary>
        private static string FindWebViewRuntime()
        {
            List<string> roots = new List<string>();
            string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
            string pf = Environment.GetEnvironmentVariable("ProgramFiles");

            if (pf86 != null) roots.Add(Path.Combine(pf86, "Microsoft", "EdgeWebView", "Application"));
            if (pf != null) roots.Add(Path.Combine(pf, "Microsoft", "EdgeWebView", "Application"));

            for (int i = 0; i < roots.Count; i++)
            {
                string best = NewestVersionDir(roots[i]);
                if (best != null) return best;
            }

            // Last resort: Edge's own installation carries a compatible loader.
            if (pf86 != null)
            {
                string edge = Path.Combine(pf86, "Microsoft", "Edge", "Application");
                string best = NewestVersionDir(edge);
                if (best != null) return best;
            }
            if (pf != null)
            {
                string edge = Path.Combine(pf, "Microsoft", "Edge", "Application");
                string best = NewestVersionDir(edge);
                if (best != null) return best;
            }
            return null;
        }

        private static string NewestVersionDir(string root)
        {
            try
            {
                if (!Directory.Exists(root)) return null;
                string[] dirs = Directory.GetDirectories(root);
                string best = null;
                Version bestVersion = null;
                for (int i = 0; i < dirs.Length; i++)
                {
                    if (!File.Exists(Path.Combine(dirs[i], "msedgewebview2.exe"))) continue;
                    Version v;
                    if (!Version.TryParse(Path.GetFileName(dirs[i]), out v)) continue;
                    if (bestVersion == null || v > bestVersion)
                    {
                        bestVersion = v;
                        best = dirs[i];
                    }
                }
                return best;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // -- fallbacks ------------------------------------------------------

        private static int RunBrowserFallback(string reason)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(_baseUrl);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception) { }

            MessageBox.Show(
                reason + "\n\n"
                + "已改用系统默认浏览器打开：\n" + _baseUrl + "\n\n"
                + "游戏可以正常游玩。点击「确定」结束服务。",
                AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);

            ShutdownServer();
            return 0;
        }

        private static void Fail(string message)
        {
            try
            {
                MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch (Exception)
            {
                try { Console.Error.WriteLine(message); } catch (Exception) { }
            }
        }
    }
}
