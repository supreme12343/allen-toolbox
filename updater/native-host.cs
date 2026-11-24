using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace AllenToolbox
{
    // Protocol 2 is deliberately isolated from the old unsigned native host.
    public static class NativeHost
    {
        private const string Repository = "https://github.com/supreme12343/allen-toolbox";
        private const int InputLimit = 64 * 1024;
        private const int OutputLimit = 1024 * 1024;
        private const int ProcessTimeoutMilliseconds = 180000;
        private const int PendingReplyLimit = 32;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = OutputLimit, RecursionLimit = 16 };
        private static readonly HashSet<string> States = new HashSet<string>(new[] { "up-to-date", "available", "updated", "deferred", "error" }, StringComparer.Ordinal);
        private static readonly HashSet<string> Errors = new HashSet<string>(new[] {
            "", "installation-invalid", "package-invalid", "release-invalid", "release-not-found",
            "network-error", "network-timeout", "download-too-large", "signature-invalid",
            "archive-invalid", "transaction-failed", "transaction-recovery-required",
            "active-downloads", "browser-running", "update-in-progress", "recovery-deferred",
            "publisher-not-trusted", "reattach-required", "internal-error",
            "native-input-invalid", "native-output-invalid", "native-timeout", "caller-not-allowed"
        }, StringComparer.Ordinal);
        private static string helperDirectory;
        private static string extensionDirectory;
        private static string extensionId;
        private static string publisherThumbprint;
        private static volatile bool configurationTrusted;

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

            return ProcessFrames(input, output, delegate(Dictionary<string, object> request) {
                if (!configured) return Task.FromResult(ErrorReply("installation-invalid"));
                if (!callerAllowed) return Task.FromResult(ErrorReply("caller-not-allowed"));
                try {
                    LoadConfiguration();
                    // Record validated heartbeats on the reader thread, before any child/lock wait.
                    WriteActivity((string)request["clientId"], (bool)request["busy"]);
                }
                catch { return Task.FromResult(ErrorReply("installation-invalid")); }
                return Task.Run(delegate { return RunUpdater((string)request["command"], (bool)request["busy"], (string)request["clientId"]); });
            }, ErrorReply);
        }

        private static int ProcessFrames(Stream input, Stream output,
            Func<Dictionary<string, object>, Task<Dictionary<string, object>>> dispatch,
            Func<string, Dictionary<string, object>> errorReply)
        {
            // Only the writer waits for children. Replies stay ordered and the queue is bounded.
            using (BlockingCollection<Task<Dictionary<string, object>>> replies = new BlockingCollection<Task<Dictionary<string, object>>>(PendingReplyLimit))
            {
                Task writer = Task.Run(async delegate {
                    foreach (Task<Dictionary<string, object>> pending in replies.GetConsumingEnumerable())
                    {
                        Dictionary<string, object> reply;
                        try { reply = await pending.ConfigureAwait(false); }
                        catch { reply = errorReply("native-output-invalid"); }
                        WriteFrame(output, reply);
                    }
                });
                int result = 0;
                try {
                    while (!writer.IsFaulted)
                    {
                        byte[] frame;
                        try { frame = ReadFrame(input); }
                        catch {
                            if (!replies.TryAdd(Task.FromResult(errorReply("native-input-invalid")))) result = 1;
                            result = 1; break;
                        }
                        if (frame == null) break;
                        if (replies.Count >= PendingReplyLimit) { result = 1; break; }
                        Task<Dictionary<string, object>> pending;
                        try {
                            string text = Utf8.GetString(frame);
                            Dictionary<string, object> request;
                            lock (Json) { request = Json.DeserializeObject(text) as Dictionary<string, object>; }
                            pending = ValidRequest(request, text) ? dispatch(request) : Task.FromResult(errorReply("native-input-invalid"));
                        }
                        catch { pending = Task.FromResult(errorReply("native-input-invalid")); }
                        if (pending == null || !replies.TryAdd(pending)) { result = 1; break; }
                    }
                }
                finally { replies.CompleteAdding(); }
                try { writer.GetAwaiter().GetResult(); } catch { return 1; }
                return result;
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
                @"AppData\Local\Google\Chrome", @"AppData\Local\Google\Chrome Beta",
                @"AppData\Local\Google\Chrome Dev", @"AppData\Local\Google\Chrome SxS",
                @"AppData\Local\Microsoft\Edge", @"AppData\Local\Microsoft\Edge Beta",
                @"AppData\Local\Microsoft\Edge Dev", @"AppData\Local\Microsoft\Edge SxS",
                @"AppData\Local\BraveSoftware\Brave-Browser", @"AppData\Local\BraveSoftware\Brave-Browser-Beta",
                @"AppData\Local\BraveSoftware\Brave-Browser-Nightly", @"AppData\Roaming\Mozilla",
                @"AppData\Local\Mozilla", @"AppData\Local\Chromium", @"AppData\Local\Vivaldi",
                @"AppData\Local\Opera Software", @"AppData\Roaming\Opera Software"
            })
            {
                string blocked = profile + "\\" + relative;
                if (path.Equals(blocked, StringComparison.OrdinalIgnoreCase) || path.StartsWith(blocked + "\\", StringComparison.OrdinalIgnoreCase) || blocked.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            }
            NoReparse(path);
        }

        private static Dictionary<string, object> ReadJson(string path, int limit)
        {
            NoReparse(path);
            if (new FileInfo(path).Length > limit) throw new InvalidDataException();
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Length > limit) throw new InvalidDataException();
            Dictionary<string, object> value;
            lock (Json) { value = Json.DeserializeObject(Utf8.GetString(bytes).TrimStart('\uFEFF')) as Dictionary<string, object>; }
            if (value == null) throw new InvalidDataException();
            return value;
        }

        private static bool IsProtocolTwo(object value) { return value is int && (int)value == 2; }
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
            configurationTrusted = false;
            UserDirectory(helperDirectory);
            string root = ControlledRoot();
            if (helperDirectory != Path.Combine(root, "updater")) throw new InvalidDataException();
            OwnedPath(root, true); OwnedPath(helperDirectory, true);
            Dictionary<string, object> config = ReadJson(Path.Combine(helperDirectory, "installation.json"), 16 * 1024);
            object protocol;
            if (!config.TryGetValue("protocol", out protocol) || !IsProtocolTwo(protocol) || StringField(config, "owner") != "ALLEN Toolbox" || StringField(config, "repository") != Repository || StringField(config, "helperDirectory") != helperDirectory || StringField(config, "installationState") != "installed") throw new InvalidDataException();
            object disabled;
            if (!config.TryGetValue("disabled", out disabled) || !(disabled is bool) || (bool)disabled) throw new InvalidDataException();
            string configuredExtension = CanonicalPath(StringField(config, "extensionDirectory"));
            if (extensionDirectory != null && configuredExtension != extensionDirectory) throw new InvalidDataException();
            extensionDirectory = configuredExtension;
            if (extensionDirectory != StringField(config, "extensionDirectory")) throw new InvalidDataException();
            UserDirectory(extensionDirectory);
            if (extensionDirectory.Equals(helperDirectory, StringComparison.OrdinalIgnoreCase) || extensionDirectory.StartsWith(helperDirectory + "\\", StringComparison.OrdinalIgnoreCase) || helperDirectory.StartsWith(extensionDirectory + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
            extensionId = StringField(config, "extensionId");
            if (extensionId != ComputeExtensionId(extensionDirectory)) throw new InvalidDataException();
            string configuredPublisher = StringField(config, "publisherThumbprint");
            if (!Regex.IsMatch(configuredPublisher, "^[A-F0-9]{40}$", RegexOptions.CultureInvariant) || (publisherThumbprint != null && publisherThumbprint != configuredPublisher)) throw new InvalidDataException();
            Dictionary<string, object> owner = ReadJson(Path.Combine(helperDirectory, "ownership.json"), 8192);
            string installationId = StringField(config, "installationId");
            if (!CanonicalUuid(installationId) || !IsProtocolTwo(owner["protocol"]) || StringField(owner, "owner") != "ALLEN Toolbox" || StringField(owner, "userSid") != WindowsIdentity.GetCurrent().User.Value || StringField(owner, "helperDirectory") != helperDirectory || StringField(owner, "installationId") != installationId || StringField(owner, "publisherThumbprint") != configuredPublisher) throw new InvalidDataException();
            VerifyPublisher(Assembly.GetExecutingAssembly().Location, configuredPublisher);
            VerifyPublisher(Path.Combine(helperDirectory, "updater.ps1"), configuredPublisher);
            VerifyPublisher(Path.Combine(helperDirectory, "install.ps1"), configuredPublisher);
            publisherThumbprint = configuredPublisher;
            configurationTrusted = true;
        }

        private static string ControlledRoot()
        {
            string root = CanonicalPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ALLENToolbox"));
            UserDirectory(root);
            return root;
        }

        private static void OwnedPath(string path, bool directory)
        {
            NoReparse(path);
            FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
            string sid = WindowsIdentity.GetCurrent().User.Value;
            if (((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))).Value != sid) throw new InvalidDataException();
            FileSystemRights write = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                string identity = ((SecurityIdentifier)rule.IdentityReference).Value;
                if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & write) != 0 && identity != sid && identity != "S-1-5-18" && identity != "S-1-5-32-544") throw new InvalidDataException();
            }
        }

        private static void WriteActivity(string clientId, bool busy)
        {
            if (!CanonicalUuid(clientId)) throw new InvalidDataException();
            string root = ControlledRoot(), locks = Path.Combine(root, "locks"), activity = Path.Combine(root, "activity");
            OwnedPath(root, true); OwnedPath(locks, true); OwnedPath(activity, true);
            string lockPath = Path.Combine(locks, "activity-" + clientId + ".lock");
            NoReparse(lockPath);
            if (File.Exists(lockPath)) OwnedPath(lockPath, false);
            Stopwatch clock = Stopwatch.StartNew();
            FileStream held = null;
            while (held == null)
            {
                try { held = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException) { if (clock.ElapsedMilliseconds >= 1000) throw new InvalidDataException(); Thread.Sleep(25); }
            }
            using (held)
            {
                OwnedPath(lockPath, false);
                string path = Path.Combine(activity, clientId + ".json"), temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
                NoReparse(path);
                long at = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                byte[] bytes;
                lock (Json) { bytes = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object> { { "protocol", 2 }, { "clientId", clientId }, { "busy", busy }, { "at", at } })); }
                try {
                    File.WriteAllBytes(temporary, bytes);
                    if (File.Exists(path)) File.Replace(temporary, path, null);
                    else File.Move(temporary, path);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustFileInfo
        {
            internal uint Size;
            [MarshalAs(UnmanagedType.LPWStr)] internal string Path;
            internal IntPtr File;
            internal IntPtr KnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustData
        {
            internal uint Size;
            internal IntPtr PolicyCallback;
            internal IntPtr SipClient;
            internal uint UiChoice;
            internal uint RevocationChecks;
            internal uint UnionChoice;
            internal IntPtr FileInfo;
            internal uint StateAction;
            internal IntPtr StateData;
            internal IntPtr UrlReference;
            internal uint ProviderFlags;
            internal uint UiContext;
            internal IntPtr SignatureSettings;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProviderSigner
        {
            internal uint Size;
            internal uint VerifyTimeLow;
            internal uint VerifyTimeHigh;
            internal uint CertificateCount;
            internal IntPtr Certificates;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int WinVerifyTrust(IntPtr window, [In] ref Guid action, [In, Out] ref WinTrustData data);
        [DllImport("wintrust.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr WTHelperProvDataFromStateData(IntPtr stateData);
        [DllImport("wintrust.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint index, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counterSignerIndex);

        private static void VerifyPublisher(string path, string expected)
        {
            NoReparse(path);
            using (FileStream held = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
            {
                WinTrustFileInfo file = new WinTrustFileInfo { Size = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo)), Path = path, File = held.SafeFileHandle.DangerousGetHandle() };
                IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                Marshal.StructureToPtr(file, filePointer, false);
                WinTrustData data = new WinTrustData {
                    Size = (uint)Marshal.SizeOf(typeof(WinTrustData)), UiChoice = 2, RevocationChecks = 1,
                    UnionChoice = 1, FileInfo = filePointer, StateAction = 1,
                    // Chain revocation excluding the root; cached retrieval only, no network/UI.
                    ProviderFlags = 0x80 | 0x1000 | 0x2000
                };
                Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
                try {
                    if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0) throw new InvalidDataException();
                    IntPtr provider = WTHelperProvDataFromStateData(data.StateData);
                    if (provider == IntPtr.Zero) throw new InvalidDataException();
                    IntPtr signerPointer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
                    if (signerPointer == IntPtr.Zero) throw new InvalidDataException();
                    ProviderSigner signer = (ProviderSigner)Marshal.PtrToStructure(signerPointer, typeof(ProviderSigner));
                    if (signer.CertificateCount == 0 || signer.Certificates == IntPtr.Zero) throw new InvalidDataException();
                    // CRYPT_PROVIDER_CERT starts with DWORD cbStruct, then aligned PCCERT_CONTEXT.
                    IntPtr certificateContext = Marshal.ReadIntPtr(signer.Certificates, IntPtr.Size == 8 ? 8 : 4);
                    if (certificateContext == IntPtr.Zero) throw new InvalidDataException();
                    using (X509Certificate2 certificate = new X509Certificate2(certificateContext))
                    {
                        bool codeSigning = false;
                        foreach (X509Extension extension in certificate.Extensions)
                        {
                            X509EnhancedKeyUsageExtension usages = extension as X509EnhancedKeyUsageExtension;
                            if (usages != null) foreach (Oid usage in usages.EnhancedKeyUsages) if (usage.Value == "1.3.6.1.5.5.7.3.3") codeSigning = true;
                        }
                        if (!codeSigning || certificate.Thumbprint != expected || certificate.NotBefore.ToUniversalTime() > DateTime.UtcNow || certificate.NotAfter.ToUniversalTime() < DateTime.UtcNow) throw new InvalidDataException();
                    }
                }
                finally {
                    data.StateAction = 2;
                    WinVerifyTrust(new IntPtr(-1), ref action, ref data);
                    Marshal.DestroyStructure(filePointer, typeof(WinTrustFileInfo));
                    Marshal.FreeHGlobal(filePointer);
                }
            }
        }

        private static bool IsCallerAllowed(string[] args)
        {
            string expected = "chrome-extension://" + extensionId + "/";
            bool found = false;
            bool parentFound = false;
            if (args == null) return false;
            foreach (string argument in args)
            {
                if (argument == null) return false;
                if (argument.StartsWith("--parent-window=", StringComparison.Ordinal))
                {
                    long window;
                    if (parentFound || !Regex.IsMatch(argument.Substring(16), "^(0|[1-9][0-9]*)$", RegexOptions.CultureInvariant) || !Int64.TryParse(argument.Substring(16), out window) || window < 0) return false;
                    parentFound = true;
                    continue;
                }
                if (found || argument != expected) return false;
                found = true;
            }
            return found;
        }

        private static bool ValidRequest(Dictionary<string, object> request, string text)
        {
            if (request == null || request.Count != 4 || !request.ContainsKey("protocol") || !request.ContainsKey("command") || !request.ContainsKey("busy") || !request.ContainsKey("clientId")) return false;
            if (!IsProtocolTwo(request["protocol"]) || !(request["busy"] is bool) || !(request["command"] is string) || !CanonicalUuid(request["clientId"] as string)) return false;
            string command = (string)request["command"];
            if (command != "status" && command != "check" && command != "update") return false;
            // Only the four literal JSON fields are accepted, not duplicate aliases or
            // JavaScriptSerializer's legacy extensions to JSON syntax.
            string field = @"(?:""protocol""\s*:\s*2|""command""\s*:\s*""(?:status|check|update)""|""busy""\s*:\s*(?:true|false)|""clientId""\s*:\s*""[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"")";
            return Regex.IsMatch(text, @"^\s*\{\s*" + field + @"\s*,\s*" + field + @"\s*,\s*" + field + @"\s*,\s*" + field + @"\s*\}\s*$", RegexOptions.CultureInvariant);
        }

        private static bool CanonicalUuid(string value)
        {
            Guid id;
            return value != null && Guid.TryParseExact(value, "D", out id) && id.ToString("D") == value;
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
                if (!manifest.TryGetValue("manifest_version", out manifestVersion) || !(manifestVersion is int) || (int)manifestVersion != 3 || StringField(manifest, "name") != "ALLEN Toolbox" || StringField(manifest, "homepage_url") != Repository || manifest.ContainsKey("key") || !manifest.TryGetValue("version", out version) || !ValidVersion(version)) return null;
                return (string)version;
            }
            catch { return null; }
        }

        private static Dictionary<string, object> ErrorReply(string error)
        {
            return new Dictionary<string, object> {
                { "protocol", 2 }, { "installed", true }, { "installedVersion", InstalledVersion() },
                { "availableVersion", null }, { "state", "error" }, { "lastCheckedAt", 0L },
                { "lastUpdatedAt", 0L }, { "error", error }, { "extensionId", extensionId ?? "" },
                { "security", SecurityReply() }
            };
        }

        private static Dictionary<string, object> SecurityReply()
        {
            return new Dictionary<string, object> { { "authenticode", configurationTrusted }, { "publisherThumbprint", publisherThumbprint ?? "" } };
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

        private static Dictionary<string, object> RunUpdater(string command, bool busy, string clientId)
        {
            try { LoadConfiguration(); } catch { return ErrorReply("installation-invalid"); }
            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string script = Path.Combine(helperDirectory, "updater.ps1");
            NoReparse(script);
            ProcessStartInfo start = new ProcessStartInfo {
                FileName = powershell,
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy AllSigned -File \"" + script + "\" -Command " + command + " -Native -ActivityRecorded -ClientId " + clientId + (busy ? " -Busy" : ""),
                WorkingDirectory = helperDirectory, UseShellExecute = false,
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
                    Dictionary<string, object> raw;
                    lock (Json) { raw = Json.DeserializeObject(Utf8.GetString(stdout.Result).Trim()) as Dictionary<string, object>; }
                    return ValidateReply(raw);
                }
                catch { return ErrorReply("native-output-invalid"); }
            }
        }

        private static Dictionary<string, object> ValidateReply(Dictionary<string, object> raw)
        {
            if (raw == null || !IsProtocolTwo(raw["protocol"]) || !(raw["installed"] is bool) || !(bool)raw["installed"] || StringField(raw, "extensionId") != extensionId) throw new InvalidDataException();
            Dictionary<string, object> security = raw["security"] as Dictionary<string, object>;
            if (security == null || security.Count != 2 || !(security["authenticode"] is bool) || !(bool)security["authenticode"] || StringField(security, "publisherThumbprint") != publisherThumbprint) throw new InvalidDataException();
            string state = StringField(raw, "state"), error = StringField(raw, "error");
            if (!States.Contains(state) || !Errors.Contains(error)) throw new InvalidDataException();
            string actual = InstalledVersion();
            if (actual == null && state == "deferred" && (error == "update-in-progress" || error == "recovery-deferred"))
            {
                Dictionary<string, object> config = ReadJson(Path.Combine(helperDirectory, "installation.json"), 16 * 1024);
                object fallback = config["installedVersion"];
                if (!ValidVersion(fallback)) throw new InvalidDataException();
                actual = (string)fallback;
            }
            if (!Object.Equals(raw["installedVersion"], actual) || (actual == null && state != "error")) throw new InvalidDataException();
            if (raw["availableVersion"] != null && !ValidVersion(raw["availableVersion"])) throw new InvalidDataException();
            if ((state == "up-to-date" || state == "available" || state == "updated") && error != "") throw new InvalidDataException();
            if (state == "updated" && (!IsInteger(raw["lastUpdatedAt"]) || Convert.ToInt64(raw["lastUpdatedAt"]) <= 0)) throw new InvalidDataException();
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            foreach (string field in new[] { "lastCheckedAt", "lastUpdatedAt" })
                if (!IsInteger(raw[field]) || Convert.ToInt64(raw[field]) < 0 || Convert.ToInt64(raw[field]) > now + 60000) throw new InvalidDataException();
            return new Dictionary<string, object> {
                { "protocol", 2 }, { "installed", true }, { "installedVersion", actual },
                { "availableVersion", raw["availableVersion"] }, { "state", state },
                { "lastCheckedAt", Convert.ToInt64(raw["lastCheckedAt"]) }, { "lastUpdatedAt", Convert.ToInt64(raw["lastUpdatedAt"]) },
                { "error", error }, { "extensionId", extensionId }, { "security", SecurityReply() }
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
            byte[] bytes;
            lock (Json) { bytes = Utf8.GetBytes(Json.Serialize(reply)); }
            if (bytes.Length > OutputLimit) throw new InvalidDataException();
            int length = bytes.Length;
            byte[] header = { (byte)length, (byte)(length >> 8), (byte)(length >> 16), (byte)(length >> 24) };
            output.Write(header, 0, header.Length); output.Write(bytes, 0, bytes.Length); output.Flush();
        }
    }
}
