# ALLEN Toolbox 2.3.2 BETA

**Experimental prerelease for beta testers. This is not the Latest stable version.** Normal users should stay on [2.3.0 stable](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.3.0).

## 2.3.1 to 2.3.2 Update Test

This is a small version-bump release for testing the existing built-in updater. No updater engine, folder permission, signing key or recovery-bootstrap changes are included.

If you already connected **2.3.1 BETA**, keep that installation folder unchanged. Open **Utilities > Built-in updater BETA setup**, click **Check for beta update**, then **Install checked beta update**. Do not manually extract the new ZIP over the folder before this test. Successful installation and reload should show **2.3.2 BETA** in the header. Existing automatic-install opt-in may apply it when idle.

## Built-In Updater Beta

This beta tests a new browser-only update method using Chrome's File System Access API. There is no Windows installer, EXE, PowerShell helper or store registration. Loading unpacked does **not** grant filesystem access; setup asks you to choose the original extension folder and approve read/write access explicitly.

1. Extract the BETA ZIP and load its `allen-toolbox` folder with Developer mode at `chrome://extensions`. A separate permanent beta folder lets you keep the stable installation intact; disable the stable copy while testing on the same website to avoid duplicate page scripts.
2. Open **Utilities > Built-in updater BETA setup**. Read and acknowledge the single-browser/profile testing warning.
3. Select the original folder containing `manifest.json`. Setup verifies that the selected folder belongs to the running extension before connecting it.
4. Review the beta release before installing. Automatic file installation is **off by default**, and turning it on is an additional opt-in.

The updater checks the fixed official GitHub repository, verifies the RSA signature before extracting/writing a release, protects local edits and saves recovery data before changing files. It pauses for active downloads and script editors. Stable releases remain separate from beta releases; v2.3.0 stays GitHub's Latest.

**Testing limits:** use the installation folder only in one browser/profile. Permissions can expire or be revoked, and Chrome must be running for browser-based checks. File writes are atomic individually, not as a whole folder. Interrupted updates may require **BETA update recovery** or manual re-extraction; the independent recovery page does not depend on the background worker. Changes to permissions or the frozen recovery bootstrap require manual review/installation. Saved userscripts/settings remain in browser storage, but moving/reinstalling an unpacked extension can change its ID and does not transfer that storage automatically.

Report the beta/browser versions, steps, expected/actual result and visible error. Do not share private lesson URLs, cookies, authorization headers or personal script values.

A Chrome / Edge / Brave extension (Manifest V3) that bundles:

* **Page fixes**: searchable, keyboard-accessible controls for right-click, selection, clipboard, shortcuts, zoom, printing and scrolling. Choose Balanced, All fixes or Off; pause fixes for one site. Blur removal preserves color filters. Unsaved-work warnings and window-size spoofing are off by default.
* **PDFs**: validated viewer captures, automatic names, Open / Save / Copy text, and a current-document fallback when a previously loaded stream expires. Save distinguishes queued, completed and interrupted browser downloads.
* **Recordings**: direct files and supported HLS VOD, transient-request retries, bounded timeouts, verified ranges and final sizes. Separate HLS audio is downloadable and is clearly distinguished from a combined recording.
* **Scripts**: a local userscript editor and manager, a real `scripts/` folder, and **Export extension ZIP** to ship saved scripts with the entire runtime extension.
* **Utilities**: reversible overlay cleanup, focus reading, clean-link and page-link copying, text export, visible screenshots, playback speed, media rescan, and browser downloads access.
* **GitHub updates**: this BETA checks a separate prerelease channel and offers an explicitly approved folder updater. Stable builds keep normal stable-release checks. No repository URL setup is required or available, and this beta contains no native executable installer.

## Install

1. Download the official ZIP and extract it to a permanent folder. The standard build does not include or enable an unsigned executable helper.
2. Open `chrome://extensions` and switch on **Developer mode** (top-right). A downloaded file or Windows installer cannot silently register an unpacked extension in Chrome.
3. Click **Load unpacked** and select the extracted **`allen-toolbox`** folder containing `manifest.json`. If you deliberately installed a verified code-signed managed build instead, select **`%LOCALAPPDATA%\ALLENToolbox\extension`**.
4. Pin the extension (puzzle-piece icon → pin).

### One switch for scripts (needed once)

Use a current desktop Chrome/Chromium browser, preferably 138+. Chrome only runs add-on scripts after you allow it: `chrome://extensions` → **ALLEN Toolbox → Details → turn on "Allow User Scripts"**. Chrome 120–137 uses **Developer mode** instead of that separate switch. After enabling access, reload the extension if needed, press **Scripts > Check again**, then reload the website. Everything else works without script access.

> Chrome cannot install a `.zip` directly — unzip it and use **Load unpacked**.

### Antivirus and Windows updater safety

Microsoft Defender flagged a temporary, unsigned native-host executable generated by the old updater tests. That does not establish that a downloaded video was malicious, and it does not prove the detection was a false positive. Do not restore quarantined files, disable protection, or add exclusions merely to run this project.

The hardened design does not compile executables on recipients' computers, does not launch PowerShell with `ExecutionPolicy Bypass`, and does not reuse the old unsigned native-host registration. Native protocol 2 uses a separate host name, signed-publisher checks, per-client activity tracking and fail-closed installation. Windows tests use inert managed-code and mocked fixtures rather than launching freshly generated unsigned EXEs.

**No trusted Windows code-signing certificate is configured in this checkout.** Its standard ZIP therefore omits executable installers and helper scripts, and its native-installation controls are disabled. Video/PDF downloads, userscripts, the visible running version, GitHub release checks and manual ZIP updates remain usable without the helper.

Code signing, tests and antivirus scans reduce risk; none guarantees that every antivirus vendor will accept a build. A ZIP's RSA `.sig` authenticates archive bytes; it is not Windows Authenticode signing and is not proof that code is harmless.

### Signed Windows setup and uninstall

**Downloading the ZIP, reading this README, or accepting the source license does not consent to installing software or background tasks.** If a future release includes a verified signed installer, run `Install-ALLEN-Toolbox.cmd`, read its publisher/setup details and approve explicitly; the default is No. Setup creates files under your user account, an hourly/logon task and per-user Native Messaging registrations for Chrome, Edge and Brave. It does not change browser profiles, trusted root certificates, global PowerShell policies or arbitrary system folders. Any already-valid leaf certificate added to your user-level TrustedPublisher store is separately disclosed in the consent text.

After approved signed setup and the initial Load unpacked step, the external updater can install compatible official signed releases automatically. Actual file replacement always waits until all supported browsers are closed, including for native requests; one idle profile cannot authorize replacing another profile's active files. Checks and notifications remain available while browsers are open. Interrupted recovery also waits for safe conditions. **Utilities > GitHub updates** displays actual availability/status; it never claims an absent or unsigned helper is ready. The check switch controls browser checks, not a separately installed background schedule.

For an existing unpacked installation, a verified signed installer supports `-Attach -ExtensionDirectory "C:\path\to\existing\allen-toolbox"` to keep its original folder/identity. Do not move/remove the extension if you want to retain its browser data. Protocol-1 unsigned helpers are not silently adopted or executed; an old background task should be disabled/removed explicitly before installing the new helper. Do not run a quarantined legacy executable.

The signed installer's `-Uninstall` flow asks again and removes only owned registrations, tasks and helper files. Browser data, extension files, unknown local files and recovery backups are preserved. Shared publisher trust is not removed casually. Never lower your system's security policy to force an unsigned uninstaller to run.

## GitHub releases and updates

Source and releases: [supreme12343/allen-toolbox](https://github.com/supreme12343/allen-toolbox). The extension is hard-locked to this official update source. Users never enter a repository URL and cannot change it through settings or saved configuration. Review userscripts for embedded secrets before every push; release packaging does not sanitize source code.

1. Push the source to the repository's `main` branch, or run its **Build and release** GitHub Actions workflow manually. Actions runs syntax checks and regression tests before publishing `v<version>` with `ALLEN-Toolbox-<version>.zip`, its SHA-256 checksum and its RSA-SHA256 `.zip.sig` signature.
2. For each subsequent update, increase **both** `manifest.json` and `package.json` to the same newer numeric version, then push to `main`. A published version/tag is not replaced. A push without a version increase does not deliver a new update.
3. Release packaging embeds the official repository and the updater independently pins the same source in code. People installing the ZIP get hourly checks automatically and a notification when a newer release appears. The browser must be running and allow notifications; checks are not instant push delivery.
4. **Utilities > GitHub updates** shows the official source as a link, not an editable field. Automatic checks can be switched off; **Check for updates**, **View release** and **Download update ZIP** remain available manually. Legacy or tampered repository settings are ignored and migrated back to the official source.

A local release can also be built with Node 24+: `npm.cmd run release`. Outputs are in `dist/` and always use `https://github.com/supreme12343/allen-toolbox`. Build or publication attempts targeting another update repository are rejected.

Windows helper packaging additionally requires `WINDOWS_SIGNING_PFX` (base64 of a CA-trusted code-signing PFX), `WINDOWS_SIGNING_PASSWORD`, and `WINDOWS_SIGNING_THUMBPRINT` as protected repository secrets. They are not configured by inventing a self-signed certificate or installing a new trusted root. `tools/build-windows-updater.ps1` prebuilds/signs the helper in CI; `tools/verify-windows-updater.ps1` verifies publisher trust and exact file hashes. A missing certificate produces a manual-only package; an incomplete, invalid or mismatched signing configuration blocks packaging. Certificate rotation requires explicit reattachment rather than silently trusting a different publisher.

Publication keeps the release in draft until the ZIP, checksum and signature are uploaded and their hashes verified. The private signing key is stored only in the repository's `UPDATER_SIGNING_KEY` Actions secret; the helper pins the public verification key. Unsigned, modified, oversized, foreign-source or unsafe-path archives are refused before installation. A checksum downloaded from the same site is not used as a substitute for the signature.

Windows validation is required, not `continue-on-error`. GitHub's disposable Windows images disable Defender and preconfigure broad exclusions, so a runner-only preparation step enables protection, removes those exclusions and updates signatures before the scan. This step refuses to run on ordinary PCs or self-hosted runners. Defender protection and archive scanning must be enabled; a detection or unavailable validation blocks publication. Rerunning the original workflow restores its same-commit artifact before rebuilding or signing, preserving timestamped native bytes. If that artifact has expired, publish a newer version rather than overwrite mismatched draft assets.

If a tag push or upload succeeds but a later step fails, rerun **the same workflow run/commit** to resume missing draft uploads. Existing draft files with a different hash are refused, not overwritten. Published releases are never repaired in place; publish a newer version if an old release is incomplete. Local `npm.cmd run release` without the private signing key produces an unsigned development package, not a package the native updater will automatically trust.

**Without the external updater:** a Load unpacked extension cannot replace its own installed files. Close toolbox/editor tabs, extract the update, replace files in the **original permanent installation folder**, and press **Reload** at `chrome://extensions`; then reload the website. ZIP downloads are reported as queued, not installed or saved. With the explicitly installed Windows helper, signed file replacement happens outside Chrome and the extension reloads after confirmed installation. Chrome Web Store or supported managed distribution is another automatic-update route; this project does not publish signed CRXs to the store.

**Saved scripts are separate:** runtime updates do not overwrite already imported userscripts, local edits, enabled states or values. To update an existing script deliberately, import the new `.user.js` into its existing editor entry, review it and press Save. Automatic `@updateURL` userscript replacement is not enabled by the GitHub release checker.

Update checks contact only the public GitHub API using no cookies, authentication tokens or captured LMS headers. The extension needs `alarms` and `https://api.github.com/*` access for those checks; it does not request all-site access merely for updates. Metadata is size-limited, stable versions are compared numerically, and foreign download links are refused. Offline/rate-limited checks keep the installed extension usable.

## Scripts tab

**Add a script**: open the full-tab editor, upload a `.user.js` file, paste code, or import an HTTP(S) link, then press **Save**. Importing into an existing script replaces its editor contents, so use **New Script** when creating another one. Settings show targets, grants and dependency origins. Syntax checking compiles code without executing it. A browser permission prompt appears when additional site access is needed. A saved script can still need Allow User Scripts or additional access before it runs; that warning does not discard the saved code.

Each script has an on/off switch and **Edit**. Folder-imported scripts are protected from deletion in the toolbox; disable them instead. Scripts created or uploaded through the editor still have **Delete**. Scripts that register menu commands (`GM_registerMenuCommand`) show them under *Commands on this page*.

Upload, Save, folder import and ZIP export share a **6 MiB UTF-8 source limit**, including non-English text. `await GM.setValue(...)` and `await GM.deleteValue(...)` wait for persisted storage; promise-form reads receive current values when the script connects, including on immediate reload.

### Ship custom scripts with the extension

Put your `.user.js` files in **`scripts/`**, then list them in **`scripts/scripts.json`**:

```json
[
  { "id": "my-helper", "file": "my-helper.user.js", "enabled": true }
]
```

`file` is relative to `scripts/` and must match the actual filename, including its `.user.js` extension. Each ID must be stable and unique. Use safe relative paths, not URLs or `../` paths. Each entry's `enabled` setting is retained when the script is imported. Files must be listed in the index; rescanning does not discover unlisted files.

Reload the extension and the website, or use **Scripts > Rescan folder scripts**. New IDs import once, and missing imports (including scripts deleted in older versions) are restored from the folder source. Existing edits, enabled states and script values are preserved. Changing a packaged file under an existing ID does not overwrite local edits. Folder imports cannot be deleted in the toolbox, but can still be edited or disabled. Restoring a previously deleted script cannot recover its deleted local edits or values. To deliberately distribute a new default separately, use a new ID.

**Scripts > Open ZIP exporter** opens the full-tab editor. Select **Code > Export Extension ZIP** to package the runtime extension and all **saved** script code and enabled states, including disabled scripts. Keep that tab open while exporting; the toolbar popup can close without interrupting this workflow. The ZIP contains `allen-toolbox/manifest.json`; recipients extract it and load that folder. An empty saved list exports an empty script index, not deleted defaults. Missing runtime resources abort the export instead of producing an incomplete extension.

Local values, drafts, cookies, request headers and private settings are excluded. **Hard-coded secrets inside script source are not removed: review your code before sharing.** Remote `@require` / `@resource` URLs remain in the source; their caches are not exported, so recipients may need internet access and permissions. Recipients must independently enable Allow User Scripts and grant their own site access.

The single-file **Export .user.js** button still exports the current editor contents, including unsaved edits. Extension ZIP export uses saved versions instead.

### What is supported

| Area | Support |
|---|---|
| Header | `@name @namespace @version @description @author @match @include (glob and /regex/) @exclude @exclude-match @grant @run-at @noframes @require @resource @connect @inject-into` |
| Page access | `@grant none` runs in the page like the site's own code (`unsafeWindow === window`) |
| GM API | `GM_getValue / setValue / deleteValue / listValues`, `GM_addValueChangeListener` (also across tabs), `GM_addStyle`, `GM_addElement`, `GM_xmlhttpRequest` (cross-origin, cookies, headers, JSON/blob/arraybuffer, timeout, abort, progress), `GM_download`, `GM_openInTab`, `GM_notification`, `GM_setClipboard`, `GM_registerMenuCommand`, `GM_getResourceText/URL`, `GM_log`, `GM_info`, and the promise forms `GM.getValue`, `GM.xmlHttpRequest`, … |
| Libraries | `@require` and `@resource` are downloaded once, at install time |
| Sandbox | `@inject-into content` runs the script in the extension's isolated world |

**Not supported:** `GM_getTab/GM_saveTab`, `@sandbox`/`@unwrap`, auto-update from `@updateURL`, `GM_cookie`. Scripts written for other managers that depend on those will need a small edit.

### Toolbox extras (`// @grant AO`)

Adds an `AO` object:

```js
AO.ui.button({ label: 'Save PDF', primary: true, position: 'bottom-right', onClick: async (e, h) => { ... } });
AO.ui.panel({ title: 'My panel', content: 'hello', open: true });
AO.ui.toast('Done');
AO.items();                 // PDFs / videos the extension has detected on this page
AO.saveItem(id, { name });  // saves one with the extension's downloader
AO.hide('.banner');  AO.removeWhen('.upsell');  AO.addCss(id, css);
AO.allowEvents(['contextmenu']);  AO.blockEvents(['copy']);
AO.onReady(fn);  AO.onMutation(fn);
```

Buttons and panels live in a closed shadow root, stay on top of the page, and are re-attached if the page wipes its DOM.

### Make scripts with AI

Expand **Scripts > AI script assistance**, then use **Copy AI prompt** to copy a complete prompt (header format, every API, rules, recipes, worked examples, plus your extension version, the site you have open and your installed scripts). Paste it into ChatGPT, Claude, Gemini or any AI, describe what you want, and import the returned script through **+ New script**. **Download .md** saves the same prompt as a file; the template is `plugins/PLUGIN_PROMPT.md`.

### Security model

* Privileged userscript requests are checked against `@grant` in the background worker. Page-world discovery messages are treated as untrusted hints, not authorization to fetch or share private data.
* `GM_xmlhttpRequest` / `GM_download` honor `@connect` and the browser's site access. Connection-domain and `self` subdomains are included in consent summaries. Without `@connect`, requests may use any host the extension already has permission to access.
* The prompt tells AIs not to collect data, not to use remote or dynamic code, and to list every host they contact.
* Install only scripts you trust: a script that can read a page can read what you type there.

## Using the downloader

| You want to | Do this |
|---|---|
| Save a PDF | Toolbar icon > **Library** > optional name > **Save**; wait for completion or check browser downloads |
| Download a recording | Play it briefly, then **Library** > quality > **Download video** or **Audio only**; approve only the required servers |
| Save separate HLS tracks | If labeled **Video stream only**, download that and **Audio only** as separate files; they are not merged |
| Change page fixes | **Page fixes** > preset or switch; the site switch pauses fixes only here. Reload for all early-page changes |
| Enable fixes on another website | **Page fixes** > enable the site switch and grant that site's access |
| Find missing resources | **Library > Rescan**; optional broader detection access is in **Utilities** |
| Remove a blocking overlay | `Alt+O`, or **Utilities > Remove overlays**; **Undo overlay removal** restores hidden elements |
| Read, capture or copy | **Utilities** > focus reading, text export, clean links, visible screenshot or playback speed |
| Open a larger interface | Header's open-in-tab button; the dashboard and editor adapt to narrow windows |

Shortcuts (change at `chrome://extensions/shortcuts`): `Alt+Shift+T` open panel · `Alt+Shift+S` save PDF · `Alt+Shift+D` open PDF · `Alt+Shift+O` remove overlays.

## What it will not do

* **DRM-protected video** (Widevine, FairPlay, PlayReady, SAMPLE-AES) is detected and refused with a message.
* **Live streams**, **MPEG-DASH**, unsupported HLS discontinuities / changing initialization maps, and muxed fMP4 audio extraction are refused rather than exported as corrupt files. Standalone audio fMP4 and external audio renditions are supported; separate tracks are not automatically merged.
* Scanned PDFs can be saved, but text extraction does not perform OCR. Password protection and content access controls are not bypassed.
* Browser-internal pages cannot use injected utilities. Screenshots require returning to the source tab and using the toolbar popup. Fullscreen may require the webpage's fullscreen button or F11.
* Buffered media is limited to 1 GiB to avoid unbounded memory use. Automatic PDF capture uploads are limited to 100 MB; PDF preparation and cache also have bounded budgets. Oversized or unsupported files produce an explicit error, not a promise of a successful save.
* There is deliberately no tab-visibility/focus spoofing or `debugger`-stripping — those mainly defeat exam tab-switch checks.

## Troubleshooting

* *Scripts tab says "Userscript access is disabled"* – turn on **Allow User Scripts** (see Install).
* *A script shows "needs site access"*: tap its access button and reload the website. Complete target/dependency/connection origins are requested; Allow User Scripts is a separate browser gate.
* *Download refused (HTTP 403)*: replay the recording or reopen the PDF so current authorized URLs are captured. A complete, current viewer PDF can be used when its stream expires. Diagnostics omit sensitive header values and raw response bodies; review any copied report before sharing it.
* *"The server answered with application/json instead of a video"* – the signed link expired; reload the lecture.
* *Nothing detected*: open the document or play the video and press **Rescan**. For persistent detection on other domains, grant site access in **Utilities**.
* *A recording fails repeatedly*: reduce parallelism in **Utilities**, replay it to refresh signed links, and retry. Transient requests retry automatically; authorization and format errors are not retried indefinitely.
* *A server caps each byte-range response*: the downloader follows contiguous chunks until the whole file is assembled. If a direct media response omits a usable ETag/Last-Modified, it first tries a fresh complete request, then uses sequential ranges with overlapping-byte comparisons, a final leading-byte recheck and exact total-size checks. Wrong offsets, mismatched overlaps, changed metadata and incomplete bodies are refused. This compatibility path does not persist partial downloads and cannot prove an immutable file version without a server validator; the completed download includes that notice. HLS playlist byte-range validation remains strict.
* *Saving is interrupted*: inspect **Open browser downloads** for disk, cancellation or network errors. A queued download is not the same as a saved file.
* After editing packaged files, press **Reload** on the extension card and reload the website. Folder rescans restore missing imports without overwriting installed scripts or their saved edits, enabled states and values.

## Privacy

There is no built-in telemetry or analytics. Network access is used for the documents/media you request, userscript imports/dependencies/explicitly granted operations, and public GitHub release checks when configured. Update checks omit credentials and can be disabled. Captured download headers remain in browser session storage; replay rules are temporary, request-scoped and limited to extension-originated requests. Script code, values and dependency caches stay in extension local storage. Custom scripts can themselves send data, so install only code you trust. ZIP export excludes browser storage but cannot sanitize secrets embedded in source. Diagnostics are reduced and redacted; review them before sharing.

## Folder plugins (advanced)

The older mechanism still works: put a script in `plugins/`, list it in `plugins/plugins.json` (`id, name, file, css, world, matches, runAt, allFrames, enabled`) and reload the extension. Plugin `file` / `css` paths start with `plugins/`; referenced files are included in ZIP export. This index ships empty. Use `scripts/` for portable userscripts with the editor and GM runtime.

## Layout

```
manifest.json          permissions, content scripts, shortcuts
background.js          detection registry, routing, downloads, folder plugins
gm/gm-bg.js            userscript manager: storage, registration, GM_* backend
gm/gm-runtime.js       GM_* / GM.* / AO runtime embedded into each script
gm/gm-relay.js         bridge between a page script and the extension
offscreen.js           long-running worker: pdf.js, HLS + file downloader
content/               page-world unblockers and the bridge to the extension
popup/                 the UI          sandbox/  syntax checker (eval-capable page)
shared/                HLS / PDF / HTTP validation, names, TS demuxer, ZIP packaging
shared/updates.js      GitHub release metadata checks and update notices
shared/native-updater.js constrained Native Messaging bridge and installed status
updater/               optional Windows installer, signed updater and native host
scripts/               scripts.json and bundled .user.js files
plugins/               PLUGIN_PROMPT.md and (optional) folder plugins
icons/                 vector brand and generated PNG toolbar icons
lib/                   pdf.js (Apache-2.0), CodeMirror (MIT)
tools/                 checks, icons, release packaging and resumable publication
.github/workflows/     tested, versioned GitHub release publication
tests/                 deterministic Node regression tests (source checkout)
```

## Validation

In the source checkout, use Node 24+ and run `npm.cmd run check`, `npm.cmd test`, and `npm.cmd run icons` on Windows. `npm run` also works in shells where npm's PowerShell wrapper is permitted. No dependency installation is needed for these checks. Optional `tools/browser-check.mjs` accepts `--playwright=<module index.mjs>`, `--browser=<Chromium executable>`, `--temp=<temporary directory>` and `--cdp-extension=1` for current branded Chrome (loads the fixture via DevTools instead of its disabled command-line switch). It launches an isolated profile and uses locally generated PDF/video/GitHub metadata fixtures, not real LMS accounts or GitHub releases. Runtime ZIP exports omit development tooling/tests.

## Credits

Credits to **Supreme** for ALLEN Toolbox.

pdf.js © Mozilla (Apache-2.0). The GM API follows the conventions established by Greasemonkey and documented by Violentmonkey (MIT) and Tampermonkey; no code was copied from them.

## License

Original project code is **Copyright (c) 2026 Shaan**, under the restricted source-available terms in [LICENSE](LICENSE). Personal use of official releases is permitted; reuse of protected original code to improve another system or build countermeasures requires Shaan's written permission. This is **not copyleft** or an open-source license.

Copyright cannot prohibit general inspiration, independently written implementations, or lawful security improvements that do not reuse protected expression. Public source can still be studied, so this license is not a technical guarantee against platform changes. Seek qualified legal review before relying on enforceability. pdf.js, CodeMirror, and other third-party material retain their own licenses and notices.

## Changelog

* **2.3.2 BETA**: version-bump update-test release. Use the connected 2.3.1 BETA folder to exercise signed in-place installation and reload. Updater code, permissions, signing key and recovery bootstrap remain unchanged.
* **2.3.1 BETA**: experimental built-in folder updater with explicit permission, signed package checks, local-edit protection, backups and standalone recovery. Separate beta branch/channel and prerelease publishing; stable 2.3.0 remains Latest. Automatic installation is opt-in, not enabled by download or Load unpacked alone.
* **2.3.0**: remove client-side executable compilation and policy bypasses, require trusted same-publisher Windows signatures, isolate native protocol 2 with multi-client activity and cross-session locks, harden recovery and folder boundaries, and restore mandatory Windows/antivirus release validation. Standard builds remain manual-only until a trusted Windows signing certificate is configured. Include the running-version badge and validatorless capped-media compatibility fix.
* **2.2.0**: bundle an explicitly approved Windows installer/updater, constrained Native Messaging, signed automatic installation with rollback and fixed official source, and Shaan's restricted-source copyright notice. Downloading alone is not consent; Chrome's initial Load unpacked step remains required.
* **2.1.3**: hard-lock updates to the official repository; remove manual URL entry and source switching; migrate legacy source settings safely; keep automatic checks enabled by default without setup.
* **2.1.2**: deterministic ZIP ordering regardless of concurrent asset reads; authenticated draft-release discovery and verified resumable publication. The unpublished 2.1.1 tag is preserved rather than moved to different source.
* **2.1.1**: resume server-capped byte ranges without losing or duplicating bytes; retain strict file identity/length checks and HLS validation; add configurable hourly GitHub release checks, update notifications, release ZIP downloads and tested GitHub Actions packaging. Unpacked installations still require replacing files and reloading; stored userscript edits are not overwritten.
* **2.1.0**: graphite-and-blue interface, compact native popup, updated vector/toolbar logo and responsive dashboard; accessible searchable page fixes and file filters; per-site pause and presets; reversible overlay cleanup and daily utilities; seed-once custom scripts folder with saved-script extension ZIP export; exact request-scoped header leases; stronger PDF fallback, bounded retries/timeouts/range validation, HLS protection/audio checks, and truthful native download completion; regression and isolated-browser checks.
* **2.0.0** – Userscript manager (Violentmonkey/Tampermonkey-compatible): upload / paste / link install, GM_* and GM.* APIs, `@require`/`@resource`/`@connect`, menu commands, cross-tab values, sandbox mode; `AO` helpers with always-on-top buttons and panels that can use the downloader; new AI prompt for userscripts; early-page-message buffering; UI fixes.
* **1.4.0** – AI prompt for folder plugins. **1.3.0** – ranged parallel downloads + size check. **1.2.0** – replay the player's complete request; Copy diagnostics. **1.1.0** – streamed direct downloads. **1.0.0** – first release.
