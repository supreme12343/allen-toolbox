using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
using System.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32.SafeHandles;

namespace AllenToolbox
{
    // Build-time verification only. This library is not shipped to extension users.
    public static class WindowsReleaseSecurity
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation
        {
            public uint Attributes;
            public FILETIME Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct TrustFile
        {
            public uint Size;
            public IntPtr Path, Handle, Subject;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct TrustData
        {
            public uint Size;
            public IntPtr Policy, Sip;
            public uint Ui, Revocation, Choice;
            public IntPtr File;
            public uint State;
            public IntPtr StateData, Url;
            public uint Flags, Context;
            public IntPtr Settings;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ProviderSigner
        {
            public uint Size;
            public FILETIME VerifiedAt;
            public uint CertificateCount;
            public IntPtr Certificates;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern SafeFileHandle CreateFile(string path, uint access, uint sharing, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
        [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int WinVerifyTrust(IntPtr window, [In] ref Guid action, [In, Out] ref TrustData data);
        [DllImport("wintrust.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
        [DllImport("wintrust.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint signer, bool counterSigner, uint counterIndex);

        public sealed class DirectoryLocks : IDisposable
        {
            private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
            private readonly HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            public void Add(string directory)
            {
                for (string path = Path.GetFullPath(directory); !String.IsNullOrEmpty(path); path = Path.GetDirectoryName(path))
                {
                    if (File.Exists(path)) throw new IOException("A build directory ancestor is a file.");
                    if (!Directory.Exists(path) || paths.Contains(path)) continue;
                    // Open the directory itself, not a link target; omit delete sharing.
                    // FILE_LIST_DIRECTORY makes no-delete sharing enforce rename checks.
                    SafeFileHandle file = CreateFile(path, 0x81, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    if (file.IsInvalid) { file.Dispose(); throw new IOException("Cannot pin the build directory."); }
                    FileInformation information;
                    if (!GetFileInformationByHandle(file, out information) || (information.Attributes & 0x400) != 0 || (information.Attributes & 0x10) == 0)
                    { file.Dispose(); throw new IOException("Build directories cannot be reparse points."); }
                    handles.Add(file); paths.Add(path);
                }
            }

            public void Dispose()
            {
                foreach (SafeFileHandle handle in handles) handle.Dispose();
                handles.Clear(); paths.Clear();
            }
        }

        public static DirectoryLocks PinDirectories(string directory)
        {
            DirectoryLocks result = new DirectoryLocks();
            try { result.Add(directory); return result; }
            catch { result.Dispose(); throw; }
        }

        public static string VerifySigner(FileStream stream, string path)
        {
            Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            IntPtr name = Marshal.StringToCoTaskMemUni(path);
            IntPtr file = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile)));
            TrustData data = new TrustData();
            try
            {
                TrustFile item = new TrustFile { Size = (uint)Marshal.SizeOf(typeof(TrustFile)), Path = name, Handle = stream.SafeFileHandle.DangerousGetHandle() };
                Marshal.StructureToPtr(item, file, false);
                data.Size = (uint)Marshal.SizeOf(typeof(TrustData));
                data.Ui = 2; data.Revocation = 1; data.Choice = 1; data.File = file; data.State = 1; data.Flags = 0x80;
                stream.Position = 0;
                if (WinVerifyTrust(IntPtr.Zero, ref action, ref data) != 0) throw new SecurityException("Windows did not trust the staged file signature.");
                IntPtr provider = WTHelperProvDataFromStateData(data.StateData);
                IntPtr pointer = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
                if (pointer == IntPtr.Zero) throw new SecurityException("Windows returned no authenticated signer.");
                ProviderSigner signer = (ProviderSigner)Marshal.PtrToStructure(pointer, typeof(ProviderSigner));
                if (signer.CertificateCount == 0 || signer.Certificates == IntPtr.Zero) throw new SecurityException("Windows returned no signer certificate.");
                // CRYPT_PROVIDER_CERT begins with cbStruct, then aligned PCCERT_CONTEXT.
                IntPtr certificateContext = Marshal.ReadIntPtr(signer.Certificates, IntPtr.Size == 8 ? 8 : 4);
                if (certificateContext == IntPtr.Zero) throw new SecurityException("Windows returned an invalid signer certificate.");
                using (X509Certificate2 certificate = new X509Certificate2(certificateContext))
                {
                    bool codeSigning = false;
                    foreach (X509Extension extension in certificate.Extensions)
                    {
                        X509EnhancedKeyUsageExtension usage = extension as X509EnhancedKeyUsageExtension;
                        if (usage != null) foreach (Oid oid in usage.EnhancedKeyUsages) if (oid.Value == "1.3.6.1.5.5.7.3.3") codeSigning = true;
                    }
                    if (!codeSigning) throw new SecurityException("Signer certificate is not a code-signing certificate.");
                    return certificate.Thumbprint.ToUpperInvariant();
                }
            }
            finally
            {
                if (data.StateData != IntPtr.Zero) { data.State = 2; WinVerifyTrust(IntPtr.Zero, ref action, ref data); }
                Marshal.FreeHGlobal(file); Marshal.FreeCoTaskMem(name);
            }
        }
    }
}
