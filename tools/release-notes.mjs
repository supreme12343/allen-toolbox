export function releaseNotes({ version, versionName = version, prerelease = false }) {
  if (prerelease) return `## ${version} BETA - Built-In Updater Test

**This is an experimental prerelease for beta testers, not the Latest stable version.**
For normal use, stay on [ALLEN Toolbox 2.3.0](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.3.0).

${version === '2.3.2' ? `### Update Test: 2.3.1 BETA to 2.3.2 BETA

This small version-bump release tests the existing updater without changing its engine, permissions, signing key or recovery bootstrap.

**Already connected 2.3.1 BETA? Do not manually replace your folder first.** Open **Utilities > Built-in updater BETA setup**, click **Check for beta update**, then **Install checked beta update**. After a successful verified install and reload, the header should read **2.3.2 BETA**. If automatic file installation was opted in, it may apply the release when idle.

` : ''}
### What We Are Testing

- A browser-only updater using Chrome's folder-access permission, without a Windows installer, EXE or PowerShell helper.
- Signed GitHub update verification before any extension files are changed.
- Installation-folder checks, local-edit protection, backups and interrupted-update recovery.
- Separate beta update checks while stable users remain on the stable release channel.

### Beta Setup

1. Extract the **BETA ZIP** to a permanent folder and load its \`allen-toolbox\` folder at \`chrome://extensions\`.
2. Open **Utilities > Built-in updater BETA** and read the testing warnings.
3. Confirm that this installation folder is used only by this browser/profile, choose the original folder, and explicitly grant read/write access.
4. Automatic file installation is an additional opt-in. Without folder permission, normal tools and manual updates remain available.

### Important Limits

- Automated tests cover updater logic and real Chrome OPFS/IndexedDB/WebCrypto integration. Actual external-folder picker grants and in-place permission persistence still need beta-tester feedback.
- Requires a supporting Chrome/Chromium browser. Permission can expire or be revoked; the updater must pause rather than bypass consent.
- Do not share the same installation folder between browser profiles while testing.
- File replacement is not an atomic whole-folder operation. An interrupted update may require the independent recovery page or manual re-extraction.
- Saved userscripts/settings stay in browser storage. Local edits to packaged files block automatic replacement instead of being overwritten silently.
- This beta is for testing a new update method, not a promise of production reliability or zero antivirus false positives.

### Feedback

Report the BETA version, browser version, steps, expected/actual result, and the visible error. Do not share private lesson URLs, cookies, authorization headers or personal script values.

**Stable remains Latest:** [v2.3.0](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.3.0).
`;
  if (version !== '2.3.0') return `## ALLEN Toolbox ${versionName}

The browser-only updater moves out of beta, with remembered folder access and safer retry/recovery handling. No store account, Windows installer, EXE or PowerShell helper is needed.

### New in 2.4.0

- Connect the original unpacked extension folder once. The directory handle, installation identity and automatic-update preference are saved in this browser profile and reused after extension reloads and browser restarts.
- If Chrome withdraws write permission, **Restore write access** reapproves the saved folder without opening another folder picker. A moved, forgotten or missing folder still requires an explicit selection.
- Deferred automatic installations retry from validated release metadata when work is idle, instead of silently waiting for another hourly GitHub check. Permission loss, local edits and recovery errors pause installation rather than being bypassed.
- Signed releases are verified before extraction and file replacement. Packaged local edits, changed permissions, corrupt archives and recovery-bootstrap changes block automatic replacement.
- Existing downloads, PDF/video tools, saved userscripts, settings and the running-version badge remain available. Completed download Blobs are retained through update-admission waits.

### Enable Built-In Updates

1. Extract the official ZIP into a permanent folder and load its \`allen-toolbox\` folder with **Load unpacked** at \`chrome://extensions\`.
2. Open **Utilities > Built-in updater setup** and confirm that only this browser/profile uses the installation folder.
3. Click **Choose extension folder**, select that exact loaded folder containing \`manifest.json\`, and approve Chrome's read/write access. The folder picker can grant access itself; a second dialog is not always shown.
4. Enable **Automatic file installation** if desired. It is off by default. Keep automatic release checks enabled, or use **Check for updates** manually.
5. Future checks reuse the saved folder. If permission is lost, click **Restore write access**; do not remove/reinstall the extension or repeatedly choose a new folder.

### Existing Beta Testers

The real 2.3.1 BETA to 2.3.2 BETA in-place test succeeded: installed runtime files matched the signed release. Connected beta users can check for this release and install it through their existing updater. The signing key, extension permissions and independent recovery bootstrap are preserved. The folder connection and opt-in remain in the same browser profile, and future checks use the regular release channel.

Users on 2.3.0 without the built-in updater need one manual file replacement/reload to obtain this feature. Keep the original folder and browser extension ID to preserve local settings and scripts.

### Safety and Limits

Chrome controls filesystem permissions. The updater cannot make them permanent, bypass a denial, preserve data after browser storage is cleared, or share a connection between profiles. When offered, Chrome's **Allow on every visit** option can retain access.

Use one browser/profile per installation folder. Backups and a durable recovery journal protect per-file updates, but whole-folder replacement is not atomic. Close script editors and finish active downloads before applying an update. Use **Update recovery** if a transaction is interrupted; the recovery page retains its earlier BETA wording because its tested bootstrap is intentionally unchanged.

Windows checks, updater/media regressions, real Chrome storage tests and a protected Defender scan run before publication. No antivirus exclusions are added to users' machines, and no promise of zero false positives is made.

The ZIP, checksum and RSA signature are included below. Original project code remains Copyright (c) 2026 Shaan; third-party notices are preserved.
`;
  return `## ALLEN Toolbox ${version} - Stable Release

Local study tools for ALLEN pages, with reliable media downloads and a clearer update experience.

### Highlights

- Improved direct-video downloading for servers that return capped byte ranges or omit ETag/Last-Modified validators.
- A visible running-version badge in the popup and dashboard.
- GitHub update checks locked to the official repository; no manual repository entry.
- Updater hardening, signature verification, recovery safeguards and mandatory Windows regression checks.
- No unsigned Windows executable installer in this package. Ordinary downloads, scripts and manual ZIP updates work without a native helper.

### Install or Update

Download \`ALLEN-Toolbox-${version}.zip\`, extract it, and load the \`allen-toolbox\` folder with **Load unpacked** at \`chrome://extensions\`.
For an existing installation, keep the original folder, replace its files and reload the extension. Do not remove/reinstall if you want to retain browser-stored settings and scripts.

The \`.sha256\` and RSA \`.sig\` assets provide checksum/signature verification. They are not Windows Authenticode signatures.

### Validation

The release pipeline requires Windows tests and an enabled Microsoft Defender scan before publication. This does not guarantee every antivirus vendor will accept every future build.

Original project code is Copyright (c) 2026 Shaan; see the included restricted-source LICENSE and preserved third-party notices.
`;
}
