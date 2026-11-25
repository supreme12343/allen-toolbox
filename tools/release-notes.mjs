export function releaseNotes({ version, prerelease = false }) {
  if (prerelease) return `## ${version} BETA - Built-In Updater Test

**This is an experimental prerelease for beta testers, not the Latest stable version.**
For normal use, stay on [ALLEN Toolbox 2.3.0](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.3.0).

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
