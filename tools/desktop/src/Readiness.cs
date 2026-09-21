using System;
using System.IO;
using System.Net;
using System.Text;

namespace Superstring.Desktop
{
    /// <summary>
    /// Loopback readiness and graceful-stop client. Proxy is disabled so local
    /// probes never leave the machine. The token is sent only in the Bearer
    /// header and never logged; readiness requires app/desktop/state identity,
    /// not just HTTP 200.
    /// </summary>
    internal static class Readiness
    {
        public enum StatusOutcome
        {
            NotReady,         // server not listening yet, or body failed identity
            Ready,            // 200 + verified identity
            EndpointMissing,  // /__desktop/status not implemented (404/405) -> caller may fall back to /health
        }

        public const string RequiredApp = "superstring";
        public const string RequiredState = "ready";

        public static bool TryReadPort(string line, out int port)
        {
            port = 0;
            const string prefix = "SUPERSTRING_DESKTOP_PORT ";
            if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)) return false;
            string value = line.Substring(prefix.Length);
            for (int i = 0; i < value.Length; i++) if (value[i] < '0' || value[i] > '9') return false;
            return int.TryParse(value, out port) && port >= 1 && port <= 65535;
        }

        public static string StatusUrl(string baseUrl)
        {
            return Normalize(baseUrl) + "/__desktop/status";
        }

        public static string HealthUrl(string baseUrl)
        {
            return Normalize(baseUrl) + "/health";
        }

        public static string StopUrl(string baseUrl)
        {
            return Normalize(baseUrl) + "/__desktop/stop";
        }

        private static string Normalize(string baseUrl)
        {
            if (string.IsNullOrEmpty(baseUrl)) return "http://127.0.0.1:17861";
            string u = baseUrl.TrimEnd('/');
            return u;
        }

        /// <summary>Pure identity check, also used by the self-test.</summary>
        public static bool IsIdentityReady(string json)
        {
            try
            {
                var fields = new System.Web.Script.Serialization.JavaScriptSerializer()
                    .Deserialize<System.Collections.Generic.Dictionary<string, object>>(json);
                return fields != null && fields.ContainsKey("app") && fields.ContainsKey("state")
                    && fields.ContainsKey("desktop") && fields["app"] is string
                    && (string)fields["app"] == RequiredApp && fields["state"] is string
                    && (string)fields["state"] == RequiredState && fields["desktop"] is bool
                    && (bool)fields["desktop"];
            }
            catch { return false; }
        }

        public static StatusOutcome ProbeDesktopStatus(string baseUrl, string token, int attemptTimeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(StatusUrl(baseUrl));
            req.Method = "GET";
            req.AllowAutoRedirect = false;
            req.Proxy = null; // never proxy loopback
            req.Timeout = attemptTimeoutMs;
            req.ReadWriteTimeout = attemptTimeoutMs;
            req.Headers["Authorization"] = "Bearer " + token;
            req.Accept = "application/json";
            using (var deadline = new System.Threading.Timer(_ => req.Abort(), null, attemptTimeoutMs, System.Threading.Timeout.Infinite))
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode != HttpStatusCode.OK) return StatusOutcome.NotReady;
                    string body = ReadAll(resp);
                    return IsIdentityReady(body) ? StatusOutcome.Ready : StatusOutcome.NotReady;
                }
            }
            catch (WebException wex)
            {
                var hr = wex.Response as HttpWebResponse;
                if (hr != null && (hr.StatusCode == HttpStatusCode.NotFound || hr.StatusCode == HttpStatusCode.MethodNotAllowed))
                {
                    return StatusOutcome.EndpointMissing;
                }
                return StatusOutcome.NotReady;
            }
            catch
            {
                return StatusOutcome.NotReady;
            }
        }

        public static bool ProbeHealth(string baseUrl, int attemptTimeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(HealthUrl(baseUrl));
            req.Method = "GET";
            req.AllowAutoRedirect = false;
            req.Proxy = null;
            req.Timeout = attemptTimeoutMs;
            req.ReadWriteTimeout = attemptTimeoutMs;
            try
            {
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Ask the server to stop via its safe-stop endpoint (token-authenticated).
        /// Best-effort; the caller still waits for the process to actually exit.
        /// </summary>
        public static void PostStop(string baseUrl, string token, int attemptTimeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(StopUrl(baseUrl));
            req.Method = "POST";
            req.AllowAutoRedirect = false;
            req.Proxy = null;
            req.Timeout = attemptTimeoutMs;
            req.ReadWriteTimeout = attemptTimeoutMs;
            req.ContentType = "application/json";
            req.Headers["Authorization"] = "Bearer " + token;
            try
            {
                using (var ms = new MemoryStream(Encoding.UTF8.GetBytes("{}")))
                {
                    using (var reqStream = req.GetRequestStream()) ms.CopyTo(reqStream);
                }
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    // Ignore body; any outcome is fine.
                    var _ = resp.StatusCode;
                }
            }
            catch
            {
                // If the endpoint is gone or the process is already dying, that is OK.
            }
        }

        // minimal JSON field extraction (no external dependency)

        public static string ExtractString(string json, string key)
        {
            int i = IndexOfKey(json, key);
            if (i < 0) return null;
            int v = AdvancePastValueStart(json, i);
            if (v < 0 || v >= json.Length || json[v] != '"') return null;
            int end = json.IndexOf('"', v + 1);
            if (end < 0) return null;
            return Unescape(json.Substring(v + 1, end - v - 1));
        }

        public static bool? ExtractBool(string json, string key)
        {
            int i = IndexOfKey(json, key);
            if (i < 0) return null;
            int v = AdvancePastValueStart(json, i);
            if (v < 0 || v >= json.Length) return null;
            if (json.Substring(v).StartsWith("true", StringComparison.Ordinal)) return true;
            if (json.Substring(v).StartsWith("false", StringComparison.Ordinal)) return false;
            return null;
        }

        private static int IndexOfKey(string json, string key)
        {
            string token = "\"" + key + "\"";
            int i = json.IndexOf(token, StringComparison.Ordinal);
            return i;
        }

        private static int AdvancePastValueStart(string json, int keyIndex)
        {
            int colon = json.IndexOf(':', keyIndex);
            if (colon < 0) return -1;
            return colon + 1;
        }

        private static string Unescape(string s)
        {
            if (s == null) return null;
            return s.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", "\n").Replace("\\t", "\t");
        }

        private static string ReadAll(HttpWebResponse resp)
        {
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                char[] buffer = new char[4097];
                int total = 0;
                while (total < buffer.Length)
                {
                    int n = sr.Read(buffer, total, buffer.Length - total);
                    if (n == 0) return new string(buffer, 0, total);
                    total += n;
                }
                throw new InvalidDataException("Desktop status body exceeds 4 KiB.");
            }
        }
    }
}
