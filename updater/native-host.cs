using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace AllenToolbox
{
    // ABI 1: installed EXEs stay in place while signed helper scripts are updated.
    public static class NativeHost
    {
        private const string Repository = "https://github.com/supreme12343/allen-toolbox";
        private const int InputLimit = 64 * 1024;
        private const int OutputLimit = 1024 * 1024;
        private const int ProcessTimeoutMilliseconds = 180000;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = OutputLimit, RecursionLimit = 16 };
        private static readonly HashSet<string> States = new HashSet<string>(new[] { "up-to-date", "available", "updated", "deferred", "error" }, StringComparer.Ordinal);
        private static readonly HashSet<string> Errors = new HashSet<string>(new[] {
            "", "installation-invalid", "package-invalid", "release-invalid", "release-not-found",
            "network-error", "network-timeout", "download-too-large", "signature-invalid",
            "archive-invalid", "transaction-failed", "transaction-recovery-required",
            "active-downloads", "browser-running", "update-in-progress", "internal-error",
            "native-input-invalid", "native-output-invalid", "native-timeout", "caller-not-allowed"
        }, StringComparer.Ordinal);
        private static string helperDirectory;
        private static string extensionDirectory;
        private static string extensionId;

        public static int Main(string[] args)
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            bool configured = false;
            bool callerAllowed = false;
            try
            {
                helperDirectory = CanonicalPath(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
                LoadConfiguration();
                configured = true;
                callerAllowed = IsCallerAllowed(args);
            }
            catch { extensionDirectory = null; extensionId = null; }

            while (true)
            {
                byte[] frame;
                try { frame = ReadFrame(input); }
                catch { WriteFrame(output, ErrorReply("native-input-invalid")); return 1; }
                if (frame == null) return 0;
                Dictionary<string, object> reply;
                try
                {
                    string text = Utf8.GetString(frame);
                    Dictionary<string, object> request = Json.DeserializeObject(text) as Dictionary<string, object>;
                    if (!ValidRequest(request, text)) reply = ErrorReply("native-input-invalid");
                    else if (!configured) reply = ErrorReply("installation-invalid");
                    else if (!callerAllowed) reply = ErrorReply("caller-not-allowed");
                    else reply = RunUpdater((string)request["command"], (bool)request["busy"]);
                }
                catch { reply = ErrorReply("native-input-invalid"); }
                try { WriteFrame(output, reply); }
                catch { return 1; }
            }
        }

        private static string CanonicalPath(string path)
        {
            string full = Path.GetFullPath(path).TrimEnd('\\');
            if (!Regex.IsMatch(full, @"^[a-zA-Z]:\\") || Regex.IsMatch(full.Substring(2), "[<>:\"|?*\\x00-\\x1f]")) throw new InvalidDataException();
            foreach (string segment in full.Substring(3).Split('\\')) if (segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal)) throw new InvalidDataException();
            return Char.ToUpperInvariant(full[0]) + full.Substring(1);
        }

        private static void NoReparse(string path)
        {
            for (string cursor = path; !String.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor))
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(cursor); }
                catch (FileNotFoundException) { continue; }
                catch (DirectoryNotFoundException) { continue; }
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
            }
        }

        private static void UserDirectory(string path)
        {
            string profile = CanonicalPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            if (!path.StartsWith(profile + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            foreach (string relative in new[] {
                @"AppData\Local\Google\Chrome\User Data", @"AppData\Local\Microsoft\Edge\User Data",
                @"AppData\Local\BraveSoftware\Brave-Browser\User Data", @"AppData\Roaming\Mozilla",
                @"AppData\Local\Mozilla", @"AppData\Local\Chromium\User Data"
            })
            {
                string blocked = profile + "\\" + relative;
                if (path.Equals(blocked, StringComparison.OrdinalIgnoreCase) || path.StartsWith(blocked + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            }
            NoReparse(path);
        }

        private static Dictionary<string, object> ReadJson(string path, int limit)
        {
            NoReparse(path);
            if (new FileInfo(path).Length > limit) throw new InvalidDataException();
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Length > limit) throw new InvalidDataException();
            Dictionary<string, object> value = Json.DeserializeObject(Utf8.GetString(bytes).TrimStart('\uFEFF')) as Dictionary<string, object>;
            if (value == null) throw new InvalidDataException();
            return value;
        }

        private static bool IsProtocolOne(object value) { return value is int && (int)value == 1; }
        private static bool IsInteger(object value) { return value is int || value is long; }
        private static string StringField(Dictionary<string, object> value, string field)
        {
            object result;
            if (!value.TryGetValue(field, out result) || !(result is string)) throw new InvalidDataException();
            return (string)result;
        }

        private static string ComputeExtensionId(string path)
        {
            byte[] digest;
            using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(Encoding.Unicode.GetBytes(CanonicalPath(path)));
            StringBuilder result = new StringBuilder(32);
            for (int i = 0; i < 16; i++) { result.Append((char)('a' + (digest[i] >> 4))); result.Append((char)('a' + (digest[i] & 15))); }
            return result.ToString();
        }

        private static void LoadConfiguration()
        {
            UserDirectory(helperDirectory);
            Dictionary<string, object> config = ReadJson(Path.Combine(helperDirectory, "installation.json"), 16 * 1024);
            object protocol;
            if (!config.TryGetValue("protocol", out protocol) || !IsProtocolOne(protocol) || StringField(config, "owner") != "ALLEN Toolbox" || StringField(config, "repository") != Repository || StringField(config, "helperDirectory") != helperDirectory) throw new InvalidDataException();
            object disabled;
            if (!config.TryGetValue("disabled", out disabled) || !(disabled is bool) || (bool)disabled) throw new InvalidDataException();
            extensionDirectory = CanonicalPath(StringField(config, "extensionDirectory"));
            if (extensionDirectory != StringField(config, "extensionDirectory")) throw new InvalidDataException();
            UserDirectory(extensionDirectory);
            if (extensionDirectory.Equals(helperDirectory, StringComparison.OrdinalIgnoreCase) || extensionDirectory.StartsWith(helperDirectory + "\\", StringComparison.OrdinalIgnoreCase) || helperDirectory.StartsWith(extensionDirectory + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            extensionId = StringField(config, "extensionId");
            if (extensionId != ComputeExtensionId(extensionDirectory)) throw new InvalidDataException();
            NoReparse(Path.Combine(helperDirectory, "updater.ps1"));
            if (!File.Exists(Path.Combine(helperDirectory, "updater.ps1"))) throw new InvalidDataException();
        }

        private static bool IsCallerAllowed(string[] args)
        {
            string expected = "chrome-extension://" + extensionId + "/";
            bool found = false;
            foreach (string argument in args)
            {
                if (argument.StartsWith("--parent-window=", StringComparison.Ordinal))
                {
                    long window;
                    if (!Int64.TryParse(argument.Substring(16), out window) || window < 0) return false;
                    continue;
                }
                if (found || argument != expected) return false;
                found = true;
            }
            // Chromium supplies the origin; direct stdio launches may not supply one.
            return true;
        }

        private static bool ValidRequest(Dictionary<string, object> request, string text)
        {
            if (request == null || request.Count != 3 || !request.ContainsKey("protocol") || !request.ContainsKey("command") || !request.ContainsKey("busy")) return false;
            if (!IsProtocolOne(request["protocol"]) || !(request["busy"] is bool) || !(request["command"] is string)) return false;
            string command = (string)request["command"];
            if (command != "status" && command != "check" && command != "update") return false;
            // Only the three literal JSON fields are accepted, not duplicate aliases or
            // JavaScriptSerializer's legacy extensions to JSON syntax.
            string field = @"(?:""protocol""\s*:\s*1|""command""\s*:\s*""(?:status|check|update)""|""busy""\s*:\s*(?:true|false))";
            return Regex.IsMatch(text, @"^\s*\{\s*" + field + @"\s*,\s*" + field + @"\s*,\s*" + field + @"\s*\}\s*$", RegexOptions.CultureInvariant);
        }

        private static bool ValidVersion(object value)
        {
            string version = value as string;
            if (version == null || !Regex.IsMatch(version, @"^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$")) return false;
            bool nonzero = false;
            foreach (string part in version.Split('.')) { int number = Int32.Parse(part); if (number > 65535) return false; nonzero |= number != 0; }
            return nonzero;
        }

        private static string InstalledVersion()
        {
            try
            {
                Dictionary<string, object> manifest = ReadJson(Path.Combine(extensionDirectory, "manifest.json"), 256 * 1024);
                object version, manifestVersion;
                if (!manifest.TryGetValue("manifest_version", out manifestVersion) || !(manifestVersion is int) || (int)manifestVersion != 3 || StringField(manifest, "name") != "ALLEN Toolbox" || StringField(manifest, "homepage_url") != Repository || !manifest.TryGetValue("version", out version) || !ValidVersion(version)) return null;
                return (string)version;
            }
            catch { return null; }
        }

        private static Dictionary<string, object> ErrorReply(string error)
        {
            return new Dictionary<string, object> {
                { "protocol", 1 }, { "installed", true }, { "installedVersion", InstalledVersion() },
                { "availableVersion", null }, { "state", "error" }, { "lastCheckedAt", 0L },
                { "lastUpdatedAt", 0L }, { "error", error }, { "extensionId", extensionId ?? "" }
            };
        }

        private static async Task<byte[]> ReadBoundedAsync(Stream stream, int limit)
        {
            using (MemoryStream result = new MemoryStream())
            {
                byte[] bytes = new byte[4096];
                int count;
                while ((count = await stream.ReadAsync(bytes, 0, bytes.Length).ConfigureAwait(false)) != 0)
                {
                    if (result.Length + count > limit) throw new InvalidDataException();
                    result.Write(bytes, 0, count);
                }
                return result.ToArray();
            }
        }

        private static Dictionary<string, object> RunUpdater(string command, bool busy)
        {
            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string script = Path.Combine(helperDirectory, "updater.ps1");
            NoReparse(script);
            ProcessStartInfo start = new ProcessStartInfo {
                FileName = powershell,
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Command " + command + " -Native" + (busy ? " -Busy" : ""),
                WorkingDirectory = helperDirectory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (Process process = new Process { StartInfo = start, EnableRaisingEvents = true })
            {
                TaskCompletionSource<bool> exited = new TaskCompletionSource<bool>();
                TaskCompletionSource<bool> failed = new TaskCompletionSource<bool>();
                process.Exited += delegate { exited.TrySetResult(true); };
                if (!process.Start()) return ErrorReply("native-output-invalid");
                process.StandardInput.Close();
                Task<byte[]> stdout = ReadBoundedAsync(process.StandardOutput.BaseStream, OutputLimit);
                Task<byte[]> stderr = ReadBoundedAsync(process.StandardError.BaseStream, 8192);
                stdout.ContinueWith(delegate(Task<byte[]> task) { if (task.IsFaulted) failed.TrySetResult(true); }, TaskScheduler.Default);
                stderr.ContinueWith(delegate(Task<byte[]> task) { if (task.IsFaulted) failed.TrySetResult(true); }, TaskScheduler.Default);
                Task deadline = Task.Delay(ProcessTimeoutMilliseconds);
                Task winner = Task.WhenAny(exited.Task, failed.Task, deadline).GetAwaiter().GetResult();
                if (winner != exited.Task)
                {
                    try { process.Kill(); process.WaitForExit(1500); } catch { }
                    return ErrorReply(winner == deadline ? "native-timeout" : "native-output-invalid");
                }
                try
                {
                    if (!Task.WaitAll(new Task[] { stdout, stderr }, 2000) || process.ExitCode != 0) return ErrorReply("native-output-invalid");
                    Dictionary<string, object> raw = Json.DeserializeObject(Utf8.GetString(stdout.Result).Trim()) as Dictionary<string, object>;
                    return ValidateReply(raw);
                }
                catch { return ErrorReply("native-output-invalid"); }
            }
        }

        private static Dictionary<string, object> ValidateReply(Dictionary<string, object> raw)
        {
            if (raw == null || !IsProtocolOne(raw["protocol"]) || !(raw["installed"] is bool) || !(bool)raw["installed"] || StringField(raw, "extensionId") != extensionId) throw new InvalidDataException();
            string state = StringField(raw, "state"), error = StringField(raw, "error");
            if (!States.Contains(state) || !Errors.Contains(error)) throw new InvalidDataException();
            string actual = InstalledVersion();
            if (!Object.Equals(raw["installedVersion"], actual) || (actual == null && state != "error")) throw new InvalidDataException();
            if (raw["availableVersion"] != null && !ValidVersion(raw["availableVersion"])) throw new InvalidDataException();
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            foreach (string field in new[] { "lastCheckedAt", "lastUpdatedAt" })
                if (!IsInteger(raw[field]) || Convert.ToInt64(raw[field]) < 0 || Convert.ToInt64(raw[field]) > now + 60000) throw new InvalidDataException();
            return new Dictionary<string, object> {
                { "protocol", 1 }, { "installed", true }, { "installedVersion", actual },
                { "availableVersion", raw["availableVersion"] }, { "state", state },
                { "lastCheckedAt", Convert.ToInt64(raw["lastCheckedAt"]) }, { "lastUpdatedAt", Convert.ToInt64(raw["lastUpdatedAt"]) },
                { "error", error }, { "extensionId", extensionId }
            };
        }

        private static byte[] ReadFrame(Stream input)
        {
            byte[] header = new byte[4];
            int first = input.Read(header, 0, 4);
            if (first == 0) return null;
            for (int offset = first; offset < 4; ) { int count = input.Read(header, offset, 4 - offset); if (count == 0) throw new InvalidDataException(); offset += count; }
            uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
            if (length == 0 || length > InputLimit) throw new InvalidDataException();
            byte[] bytes = new byte[(int)length];
            for (int offset = 0; offset < bytes.Length; ) { int count = input.Read(bytes, offset, bytes.Length - offset); if (count == 0) throw new InvalidDataException(); offset += count; }
            return bytes;
        }

        private static void WriteFrame(Stream output, Dictionary<string, object> reply)
        {
            byte[] bytes = Utf8.GetBytes(Json.Serialize(reply));
            if (bytes.Length > OutputLimit) throw new InvalidDataException();
            int length = bytes.Length;
            byte[] header = { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
            output.Write(header, 0, header.Length); output.Write(bytes, 0, bytes.Length); output.Flush();
        }
    }
}
