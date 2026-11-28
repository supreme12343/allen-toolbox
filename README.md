<p align="center">
  <img src="icons/logo.svg" width="80" height="80" alt="ALLEN Toolbox logo">
</p>

# ALLEN Toolbox 2.4.1 Solus Vestro

Local study tools with signed, browser-only extension updates. Connect the original extension folder once; this browser profile remembers it for future updates. No store fee, Windows installer, EXE or PowerShell helper is needed.

**2.4.1 Solus Vestro** | **Manifest V3** | **Desktop Chrome / Edge / Brave**

[Download Solus Vestro](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.4.1) | [Browse releases](https://github.com/supreme12343/allen-toolbox/releases) | [Source code](https://github.com/supreme12343/allen-toolbox)

## Built-In Updates

1. Extract the official ZIP into a permanent folder and load its **`allen-toolbox`** folder using **Load unpacked** at `chrome://extensions`.
2. Open **Utilities > Built-in updater setup**. Confirm that the installation folder is used only by this browser/profile.
3. Click **Choose extension folder** and select the exact loaded folder containing `manifest.json`, not its parent or another copy. Approve Chrome's read/write access. Folder selection can grant access directly; a second permission popup is not always shown.
4. The page should show **Folder remembered** and **Permission: Granted**. Optionally enable **Automatic file installation**, which is off by default. Keep automatic release checks enabled, or check manually.
5. Updates reuse the saved connection after extension reloads and browser restarts. When Chrome withdraws permission, click **Restore write access** to reapprove the saved folder without selecting it again. Choose a folder again only if it was moved, forgotten, or its saved handle is missing.

The directory handle, ownership identity, baseline and automatic-install setting are stored in IndexedDB under the extension's browser profile. Normal refreshes and transient permission failures do not discard them. Chrome controls whether a grant persists; choose **Allow on every visit** if offered. The updater cannot force permanent access or recover a connection after browser storage is deleted or the extension is reinstalled under a different ID.

Keep the installation folder's original path and name, even if it still says an older BETA version. The header shows the running version; renaming or moving the folder can change the extension ID and break the remembered connection.

### Updating and Recovery

The official repository is fixed to [supreme12343/allen-toolbox](https://github.com/supreme12343/allen-toolbox). Release checks are hourly while Chrome is running. An automatic install postponed by active work retries from verified release metadata with bounded backoff, rather than repeatedly calling GitHub. Turning off automatic checks or file installation stops further automatic attempts; an already admitted transaction must finish or recover safely.

Deferred attempts retry after 1, 2, 4, 8 and 15 minutes. If that limit is reached, setup shows **Retry limit reached**; resolve the cause and press **Check for updates** to start a fresh attempt. Simply opening the popup cannot keep postponing a retry that is already due.

Updates verify the RSA signature before extraction or file writes, then verify the installation marker and tracked file hashes. Local edits, permission increases, unsafe ZIP contents and recovery-bootstrap changes require manual review instead of silent overwrite. Saved userscripts and settings stay in browser storage and are not replaced by packaged source updates.

Finish downloads and close script editors before installing. Original files are journaled before changes; dependencies precede entrypoints and the manifest is written last. Each file write is transactional, but the entire folder is not atomically replaced. Interrupted writes retain their recovery journal. Use **Update recovery** to restore verified originals; if the background page is broken, the standalone recovery page does not depend on it. Its earlier BETA label is preserved to keep the tested recovery bootstrap byte-identical for existing beta users.

**Do not share one installation folder between browser profiles.** Browser Web Locks cannot coordinate another profile or an external file editor. Keep backups of local changes. Removing the extension, clearing its storage or moving its installation folder can lose access to the saved handle and recovery data. There is no silent permission bypass or guarantee of perfectly failure-free updates.

### Existing Beta Users

The real **2.3.1 BETA to 2.3.2 BETA** file-update test succeeded: all installed runtime files matched the signed release. Connected beta users can check for 2.4.0 and install it through their existing updater. Keep the same folder/profile; the saved handle and automatic-install opt-in are preserved. The signing key, manifest permissions and frozen recovery bootstrap remain unchanged, and future release checks use the regular channel.

Users on 2.3.0 without this feature need one manual file replacement/reload to get the built-in updater. Do not remove/reinstall if you want to preserve settings and scripts. Report the extension/browser versions, steps and visible error if a problem occurs; omit private lesson URLs, cookies, authorization headers and personal script values.

## Features

The table covers the stable extension and the shipped **ALLEN Overseas Blocker Bundle v6.1**. Rows marked **Bundle** apply only to `https://digitalclass.allenoverseas.com/*`; they are separate from the core **Page fixes** controls.

| Feature | What is included | Availability / Notes |
|---|---|---|
| **File library** | PDF, video and audio discovery; title/URL search; file-type filters; rescan; clear detected list; toolbar file count. | **Library**; open a document or play media first. |
| **PDF tools** | Open, Save, Copy text, automatic or custom filenames, size/page information and validated current-viewer fallback. | **Library**; text extraction has no OCR. |
| **Direct recordings** | Download video/audio, copy links, choose filenames, view progress and cancel. Detected types include MP4/M4V/WebM/MOV/MKV and MP3/M4A/AAC/OGG/OGA/Opus/WAV/FLAC. | Supported HTTP(S) files; media MIME types can identify extensionless files; copied signed links may contain private tokens. |
| **MPEG-DASH discovery** | Detect playlist entries and copy their links. | Copy-link only; DASH downloading is unsupported. |
| **HLS video** | Playlist analysis, quality selection, supported byte ranges, TS recordings, fMP4 recordings with a fixed initialization map and identity AES-128 decryption. | Finished VOD only; outputs `.ts` or `.mp4`, without transcoding. |
| **HLS audio** | AAC/MP3 extraction from supported TS, packed audio, and identified audio-only/external fMP4 renditions. | Separate tracks are not merged; muxed fMP4 audio extraction is unsupported. |
| **Download reliability** | Bounded retries/timeouts, verified ranges and final sizes, configurable parallelism, cancellation and redacted diagnostics. | **Utilities**; 8 parallel requests by default; buffered media limit is 1 GiB per file. |
| **Interaction fixes** | Right-click, text selection, copy/cut/paste, drag/drop, keyboard shortcuts and zoom. | **Page fixes**; on by default, with editable-field safeguards. |
| **Reading and print fixes** | Unlock scrolling, rescue print styles and remove CSS blur while preserving other color filters. | **Page fixes**; on by default. |
| **PDF viewer fixes** | Detect viewer PDFs, read names on capture, remove disabling viewer URL hashes and reveal recognizable viewer buttons. | On by default; **Prefer printed title** is optional and off by default. |
| **Page-fix controls** | 20 switches, searchable keyboard-accessible controls, Balanced / All fixes / Turn off presets and per-site pause. | Presets/site pause do not turn off document/media discovery or the bundled userscript. |
| **Optional page fixes** | Skip leave-page warnings, silence alerts/confirmations, hide faint page-watermark overlays and normalize window size. | Off by default; confirmations return `false`; embedded PDF/video watermarks are unchanged. |
| **Console preservation** | Prevent pages from clearing console output with `console.clear()`. | Core **Keep console output** is on by default. |
| **Overlay cleanup** | Selective blocking-overlay removal with Undo. | **Utilities** or `Alt+O`; distinct from the bundle's permanent gate deletion. |
| **Focus reading** | Text-focused reading view, 14-32 px text size, estimated reading time and Escape/focus handling. | **Utilities**; 18 px default; not OCR. |
| **Links and text** | Copy a clean page link, deduplicated page links or page text; save the page as a text file. | **Utilities**; known tracking parameters are removed, not functional/signed parameters. |
| **Capture and page actions** | Save a visible PNG screenshot, print, request fullscreen and reload the page. | **Utilities**; screenshots need the active source tab and toolbar popup. |
| **Playback and downloads** | Adjust accessible players from 0.75x to 2x; open browser downloads; rescan media. | Playback/downloads in **Utilities**, rescan in **Library**; playback defaults to 1x. |
| **Dashboard and shortcuts** | Compact popup, full-tab dashboard/editor, running-version badge, keyboard navigation, visible focus and reduced-motion styling. | Four configurable extension shortcuts; see [Everyday use](#using-the-downloader). |
| **Site access and settings** | Allow this site, optionally allow all sites, remove optional access, customize shortcuts, reset settings and reload the extension. | Site access/shortcuts in **Utilities**, reload in **Scripts**, reset in the footer; reset preserves userscripts. |
| **Userscript manager** | Create, paste, upload or link-import scripts; enable/disable, edit, delete eligible entries and run registered menu commands. | **Scripts**; execution requires browser userscript access and matching site permissions. |
| **Script editor** | Highlighting, completion, bracket matching, folding, comments, find/replace, syntax-only checks, local drafts and concurrent-edit protection. | Full-tab editor; 6 MiB UTF-8 source limit. |
| **Userscript runtime** | Supported metadata, page/isolated injection, `GM_*` / `GM.*` APIs, persistent values, cross-tab listeners, HTTP requests, downloads, tabs, notifications and clipboard helpers. | Partial compatibility; see the [API support table](#what-is-supported). |
| **Script dependencies** | Install-time `@require` / `@resource` downloads, local caches and `@connect`-checked privileged requests. | Site permission and declared grants still apply; no automatic userscript updates. |
| **AO helpers** | Buttons, panels, toasts, detected items/downloads, CSS/hiding helpers, event controls and ready/mutation hooks. | Userscripts declaring `// @grant AO`. |
| **Portable scripts and exports** | Indexed folder imports/rescans, saved-state preservation, single `.user.js` export and full runtime ZIP export with saved scripts. | Folder imports cannot be deleted; source-embedded secrets are not sanitized. |
| **AI script assistance** | Copy an API-aware prompt or download it as Markdown, with version/site/script context. | **Scripts**; manual use with your chosen AI, not a built-in AI service. |
| **Official release checks** | Fixed GitHub source, hourly/startup checks, notifications, manual checking, release viewing and ZIP downloads. | Checks on by default; stable builds offer stable releases, not prereleases. |
| **Built-in folder updater** | Signed in-place file updates, remembered directory access, explicit permission restoration, opt-in automation and independent recovery. | **Utilities > Built-in updater setup**; one browser/profile per folder; no external installer. |
| **Advanced folder plugins** | Indexed JS/CSS plugins with targets, timing, frames and page/isolated-world selection. | Plugin index ships empty; userscripts are the recommended route. |
| **Bundle: Fullscreen and displays** | Reports fullscreen, fixed window/screen dimensions and a single display; hooks display-mode queries and orientation locking. | Reported state only; does not enter real fullscreen or lock screen orientation. |
| **Bundle: Visibility and focus** | Reports visible/focused state and suppresses page/window visibility and blur checks, while allowing input blur. | Enabled by default in v6.1; not a core Page fixes feature. |
| **Bundle: Activity payloads** | Attempts selected XHR/fetch/beacon payload rewriting and string WebSocket sanitization. | Rewriting on; dropping activity posts off; encoding/fetch limitations apply. |
| **Bundle: Fullscreen gates** | Deletes `#go-button` and `.enable_full_screen`; sweeps added nodes, SPA navigation, accessible frames and open shadow roots. | Permanent deletion; forces newly created page shadow roots open; not broad overlay cleanup. |
| **Bundle: Keyboard and selection** | Unlocks common browser shortcuts, right-click, copy/cut/paste, selection and drag-start by suppressing page handlers. | Browser defaults remain uncancelled; no direct clipboard-copy UI. |
| **Bundle: Leave-page hooks** | Attempts to suppress `beforeunload` handlers and warnings. | Enabled by default; useful unsaved-work warnings can be lost. |
| **Bundle: Synthetic camera/audio** | Supplies a 640x480 canvas video stream and optional low-gain synthetic audio through media hooks. | Not a real camera; the shipped native-camera fallback is broken. |
| **Bundle: Capture/device reports** | Reports default AV devices and granted camera/microphone state; denies display capture; wraps native `MediaRecorder`. | Does not grant browser permissions or universally prevent recording. |
| **Bundle: Peripheral reports** | Reports empty authorized USB/Bluetooth/serial/HID device lists. | Report spoofing, not device disconnection. |
| **Bundle: Detection shields** | Filters certain Worker URLs, blocks new service-worker registrations, caches tiny-canvas serialization and applies limited stack/styled-log filtering. | Can affect legitimate site behavior; not universal DevTools hiding. |
| **Bundle: Native-looking hooks** | Makes registered wrappers stringify as native and attempts event-trust getters. | Does not reliably turn synthetic events into browser-trusted events. |
| **Bundle: Debugger/reload filters** | Removes literal `debugger` text from eval strings/first constructor argument, blocks console clearing and attempts reload-type reporting changes. | Limited text/property hooks, not removal from all JavaScript or real navigation changes. |
| **Bundle: Startup watchdog** | Reapplies registered property getters and observes replacement document roots; periodic gate sweeps. | Does not reinstall every hook; reload the website after disabling the script. |
| **Bundle: Diagnostics** | `Alt+Shift+G` status/error panel plus `GC.status()`, `GC.report()` and `GC.sweep()` console helpers. | Snapshot diagnostics, not proof of success; no feature-toggle panel or GM menu commands. |

> **Separate controls:** the bundle is enabled on a fresh folder import, but existing script code and enabled states are preserved. Core presets, site pause and Undo overlay removal do not disable or undo its hooks. Use **Scripts** to disable it, then reload the website.

## Quick Navigation

[Install](#install) | [Built-in updates](#built-in-updates) | [Everyday use](#using-the-downloader) | [Bundle v6.1](#bundled-blocker-bundle-v61) | [Scripts](#scripts-tab) | [Releases](#github-releases-and-updates) | [Troubleshooting](#troubleshooting) | [Privacy](#privacy) | [Advanced](#advanced) | [License](#license)

---

## Install

1. Download the [official Solus Vestro release ZIP](https://github.com/supreme12343/allen-toolbox/releases/tag/v2.4.1) and extract it to a permanent folder.
2. Open `chrome://extensions` (**Edge:** `edge://extensions`; **Brave:** `brave://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and select the extracted **`allen-toolbox`** folder containing `manifest.json`.
4. Pin **ALLEN Toolbox** from the browser's extensions menu, then open a document or recording and click its toolbar icon.

> Chrome cannot install a `.zip` directly. Extract it first, then use **Load unpacked**. The standard ZIP includes no Windows executable installer or helper.

### One switch for scripts (needed once)

Use a current desktop Chrome/Chromium browser, preferably 138+; Solus requires 122 or newer.

1. Open the extension's **Details** page and turn on **Allow User Scripts**. Supported Chrome 122-137 uses **Developer mode** instead of that separate switch.
2. Reload the extension if needed and select **Scripts > Check again**.
3. Reload the website. If a script needs site access, approve only the required origins.

This enables both the shipped bundle and your own userscripts. PDF/video tools and core page fixes work without userscript access. Do not disable antivirus, add exclusions or restore quarantined legacy helpers to install the toolbox; see [Advanced safety notes](#advanced).

## Using the downloader

Open the toolbar icon. **Library** is for files, **Page fixes** is for page behavior, **Scripts** is for userscripts, and **Utilities** is for everyday actions and updates.

| You want to | Do this |
|---|---|
| Save or open a PDF | **Library** > optional filename > **Save** or **Open**; wait for completion or check browser downloads. |
| Copy PDF text | **Library** > **Copy text**; scanned pages need an external OCR tool. |
| Download a recording | Play it briefly, then **Library** > quality > **Download video** or **Audio only**; approve only the required servers. |
| Save YouTube video with audio | Play the video, then choose **Download with audio** on its video card when matching tracks are detected. Use **Rescan** if needed. |
| Save separate HLS tracks | If labeled **Video stream only**, download that and **Audio only** separately; they are not merged. |
| Change page fixes | **Page fixes** > preset or switch; pause fixes for this site with the site switch. Reload for early-page changes. |
| Enable fixes on another website | **Page fixes** > enable the site switch and grant that site's access. |
| Find missing resources | **Library > Rescan**; optional broader detection access is in **Utilities**. |
| Remove a blocking overlay | `Alt+O` or **Utilities > Remove overlays**; **Undo overlay removal** restores hidden elements. |
| Read, capture or copy | **Utilities** > focus reading, text/links, visible screenshot, printing or playback speed. |
| Open a larger interface | Use the header's open-in-tab button; the dashboard and editor adapt to narrow windows. |

### Keyboard shortcuts

Change extension shortcuts at `chrome://extensions/shortcuts` or **Utilities > Customise shortcuts**.

| Default shortcut | Action |
|---|---|
| `Alt+Shift+T` | Open ALLEN Toolbox. |
| `Alt+Shift+S` | Save the latest detected PDF. |
| `Alt+Shift+D` | Open the latest detected PDF. |
| `Alt+Shift+O` | Remove blocking overlays. |
| `Alt+O` | On-page overlay cleanup, outside editable controls. |
| `Alt+Shift+G` | Toggle the bundled v6.1 diagnostics panel on its matching site; separate from extension shortcut settings. |

## Bundled Blocker Bundle v6.1

The package includes [ALLEN Overseas Blocker Bundle v6.1](scripts/ALLEN%20Overseas%20%E2%80%94%20Blocker%20Bundle.user.js), indexed in [`scripts/scripts.json`](scripts/scripts.json). Its userscript version is **6.1**, separate from the extension's **2.4.1 Solus Vestro** version. The built-in manager runs it without a separate Tampermonkey installation or Windows helper.

* **Target:** `https://digitalclass.allenoverseas.com/*`, at document start in the page world and matching frames. It does not run on every ALLEN Overseas subdomain.
* **Fresh-import default:** enabled. Existing imported code, local edits, enabled states and values are preserved by updates/rescans, so an older installation may still contain a different script version.
* **Controls:** enable/disable the whole script in **Scripts**, then reload the website. Its options are internal source settings, not a feature-toggle panel; it registers no GM menu commands.
* **Defaults:** fullscreen/visibility reporting, payload rewriting, synthetic camera, gate removal, keyboard/selection unlocking, device/display reporting, leave-page suppression, detection/debugger filters and reload-report hooks are enabled. Activity-post dropping and debug logging are off.
* **Diagnostics:** `Alt+Shift+G` toggles a top-right status/error snapshot. Console helpers are `GC.status()`, `GC.report()` and `GC.sweep()`; their reports do not verify that every hook works.

> **Compatibility warning:** the bundle changes reported browser state and page/media APIs. It does not grant permissions, enter real fullscreen, supply a genuine camera or guarantee that a website accepts its reports. Gate deletion and installed hooks have no teardown/Undo; disable the script and reload the website to start without them.

The shipped native-camera fallback calls the already patched `getUserMedia` rather than a saved native method, so it is not a working real-camera fallback. Network rewriting is limited, especially for fetch requests with string bodies. Debugger filtering is literal text replacement, not syntax-aware removal from all JavaScript. New service-worker blocking, forced dimensions and open-shadow-root behavior can also affect legitimate page features.

The bundle does **not** provide PDF/lesson-recording discovery, HLS downloads, screenshot saving, CSS blur removal or DRM bypass. Those supported document/media/utility features belong to the extension core; the bundle's blur hooks concern focus events, and its media hooks concern capture APIs.

## Scripts tab

**Add a script**: open the full-tab editor, upload a `.user.js` file, paste code, or import an HTTP(S) link, then press **Save**. Importing into an existing script replaces its editor contents, so use **New Script** when creating another one. Settings show targets, grants and dependency origins. A browser permission prompt appears when additional site access is needed. A saved script can still need Allow User Scripts or additional access before it runs; that warning does not discard the saved code.

The editor includes find/replace, completion, folding, comments and **Check Syntax**, which compiles without executing code. Local autosaved drafts can be restored or discarded; saved revisions are protected against conflicting edits in another editor. **Save & Close** and **Reload Website** keep the edit/test workflow in one place.

Each script has an on/off switch and **Edit**. Folder-imported scripts are protected from deletion in the toolbox; disable them instead. Scripts created or uploaded through the editor still have **Delete**. Scripts that register menu commands (`GM_registerMenuCommand`) show them under *Commands on this page*.

Upload, Save, folder import and ZIP export share a **6 MiB UTF-8 source limit**, including non-English text. `await GM.setValue(...)` and `await GM.deleteValue(...)` wait for persisted storage; promise-form reads receive current values when the script connects, including on immediate reload.

### Ship custom scripts with the extension

Put your `.user.js` files in **`scripts/`**, then list them in **`scripts/scripts.json`**:

```json
[
  { "id": "my-helper", "file": "my-helper.user.js", "enabled": true }
]
```

`file` is relative to `scripts/` and must match the actual filename, including its `.user.js` extension. Each ID must be stable and unique. Use safe relative paths, not URLs or `../` paths. Each entry's `enabled` setting is retained when the script is imported; omitting it imports the script disabled. Files must be listed in the index; rescanning does not discover unlisted files.

Reload the extension and the website, or use **Scripts > Rescan folder scripts**. New IDs import once, and missing imports (including scripts deleted in older versions) are restored from the folder source. Existing edits, enabled states and script values are preserved. Changing a packaged file under an existing ID does not overwrite local edits. Folder imports cannot be deleted in the toolbox, but can still be edited or disabled. Restoring a previously deleted script cannot recover its deleted local edits or values. To deliberately distribute a new default separately, use a new ID.

**Scripts > Open ZIP exporter** opens the full-tab editor. Select **Code > Export Extension ZIP** to package the runtime extension and all **saved** script code and enabled states, including disabled scripts. Keep that tab open while exporting; the toolbar popup can close without interrupting this workflow. The ZIP contains `allen-toolbox/manifest.json`; recipients extract it and load that folder. An empty saved list exports an empty script index, not deleted defaults. Missing runtime resources abort the export instead of producing an incomplete extension.

Local values, drafts, cookies, request headers and private settings are excluded. **Hard-coded secrets inside script source are not removed: review your code before sharing.** Remote `@require` / `@resource` URLs remain in the source; their caches are not exported, so recipients may need internet access and permissions. Recipients must independently enable Allow User Scripts and grant their own site access.

The single-file **Export .user.js** button still exports the current editor contents, including unsaved edits. Extension ZIP export uses saved versions instead. Custom exports are sharing packages, not official signed update releases.

### What is supported

| Area | Support |
|---|---|
| Header | `@name @namespace @version @description @author @match @include (glob and /regex/) @exclude @exclude-match @grant @run-at @noframes @require @resource @connect @inject-into` |
| Page access | Default page injection runs like the site's own code; `@grant none` has `unsafeWindow === window` unless explicit content injection is selected. |
| Storage | `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, `GM_addValueChangeListener` and `GM_removeValueChangeListener`; values persist locally and listeners also work across tabs. |
| Requests and downloads | `GM_xmlhttpRequest` supports cross-origin requests, bodies, cookies/headers, JSON/document/blob/arraybuffer responses, timeout, abort and progress. `GM_download` is available with the option limits below. |
| UI and browser helpers | `GM_addStyle`, `GM_addElement`, `GM_openInTab`, `GM_notification`, `GM_setClipboard`, `GM_registerMenuCommand`, `GM_unregisterMenuCommand`, `GM_getResourceText`, `GM_getResourceURL`, `GM_log` and `GM_info`. |
| Aliases | Supported `GM.*` forms, including `GM.getValue`, `GM.setValue`, `GM.deleteValue` and `GM.xmlHttpRequest`; not every manager option/alias is implemented. |
| Libraries | `@require` and `@resource` are downloaded once, at install time |
| Sandbox | `@inject-into content` runs the script in an isolated userscript world, not the page world. |

**Compatibility limits:** no `GM_getTab/GM_saveTab`, `@sandbox`/`@unwrap`, automatic `@updateURL` replacement, `GM_cookie` or cloud sync. `document-body` currently maps to document-end. Dependencies are limited to 3 MiB each and binary XHR replies to 60 MiB. `GM_download` does not currently forward supplied headers or implement backend abort; do not assume complete compatibility with another manager's download options.

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

Buttons and panels live in a shadow root, stay on top of the page, and are re-attached if the page wipes its DOM. Other page-world scripts, including the bundled v6.1 script on its target site, can alter newly created shadow-root behavior.

### Make scripts with AI

Expand **Scripts > AI script assistance**, then use **Copy AI prompt** to copy a complete prompt (header format, every API, rules, recipes, worked examples, plus your extension version, the site you have open and your installed scripts). Paste it into ChatGPT, Claude, Gemini or any AI, describe what you want, and import the returned script through **+ New script**. **Download .md** saves the same prompt as a file; the template is `plugins/PLUGIN_PROMPT.md`.

### Security model

* Privileged userscript requests are checked against `@grant` in the background worker. Page-world discovery messages are treated as untrusted hints, not authorization to fetch or share private data.
* `GM_xmlhttpRequest` / `GM_download` honor `@connect` and the browser's site access. Connection-domain and `self` subdomains are included in consent summaries. Without `@connect`, requests may use any host the extension already has permission to access.
* The prompt tells AIs not to collect data, not to use remote or dynamic code, and to list every host they contact.
* Install only scripts you trust: a script that can read a page can read what you type there.

## GitHub releases and updates

Source and releases: [supreme12343/allen-toolbox](https://github.com/supreme12343/allen-toolbox). The extension is hard-locked to this official update source; no repository URL setup is required or available.

* **Automatic checks:** on by default, hourly and at browser startup. The browser must be running and allow notifications; checks are not instant push delivery. Stable builds offer stable releases, not prereleases.
* **Manual controls:** **Utilities > GitHub updates** offers **Check for updates**, **View release** and **Download update ZIP**, even when automatic checks are off. The official source is a link, not an editable field; legacy/tampered source settings are ignored and migrated back.
* **Built-in installation:** connect the original folder once using [Built-in updates](#built-in-updates). Signed file installation is a separate opt-in. The saved folder and preference survive reloads; **Restore write access** handles permission loss without another picker.
* **Manual ZIP fallback:** without a connected writable folder, close toolbox/editor tabs, extract the update, replace files in the **original permanent installation folder**, press **Reload** at the browser's extensions page, then reload the website. A ZIP download is queued, not installed or confirmed saved.
* **Saved scripts are separate:** runtime updates do not overwrite imported userscripts, edits, enabled states or values. To deliberately update one, import its new `.user.js` into the existing editor entry, review it and press **Save**. GitHub release checks do not automatically apply `@updateURL` updates.

Checks contact the public GitHub API without cookies, authentication tokens or captured LMS headers. Metadata is size-limited, versions are compared numerically, and foreign download links are refused. Offline/rate-limited checks leave installed tools usable. Signed asset fetching also omits credentials. No native Windows helper is included or invoked; publication details are in [Advanced](#advanced).

## Beta History

The **2.3.1 BETA** and **2.3.2 BETA** prereleases tested the new update method before its promotion to **2.4.0 Solus**. Connected beta installations can install this release without changing folders, signing keys, manifest permissions or the frozen recovery bootstrap. Automatic file installation remains opt-in; loading unpacked is not consent to filesystem writes.

Earlier beta pages remain available under [all releases](https://github.com/supreme12343/allen-toolbox/releases). Regular Solus installations use the stable update channel and do not silently switch to prereleases. If maintaining multiple versions for testing, keep separate permanent folders and avoid running duplicate page scripts on the same website.

## What it will not do

* **DRM-protected video** is unsupported and is not bypassed. Unsupported HLS protection, including SAMPLE-AES and non-identity key formats, is rejected; direct-file detection is not a universal DRM detector.
* **Live/unfinished streams**, **MPEG-DASH manifest downloads**, unsupported HLS discontinuities/changing initialization maps and muxed or unverified single-stream fMP4 audio extraction are refused. Separate HLS tracks are not merged. **Download with audio** joins compatible direct YouTube files into one MP4 or WebM without re-encoding; original track downloads remain available.
* Scanned PDFs can be saved, but text extraction does not perform OCR. Password protection and content access controls are not bypassed.
* Browser-internal pages cannot use injected utilities. Screenshots require returning to the source tab and using the toolbar popup. Fullscreen may require the webpage's fullscreen button or F11.
* Buffered media is limited to 1 GiB per file. Automatic PDF capture is limited to 100 MiB, preparation to 128 MiB, and the PDF cache to four files/256 MiB. Oversized or unsupported files produce an explicit error, not a promise of a successful save. Keep the browser open for running downloads.
* Core Page fixes do not spoof tab visibility/focus or strip `debugger` statements. The **separate shipped v6.1 bundle does**, with the limits described above; core presets and site pause do not disable it.

## Troubleshooting

| Problem | What to try |
|---|---|
| **Userscript access is disabled** | Enable **Allow User Scripts**, use **Scripts > Check again**, then reload the website. |
| **A script needs site access** | Use its access button and reload. Target/dependency/connection origins and the browser's userscript switch are separate gates. |
| **HTTP 403 / JSON instead of video** | Replay the recording or reopen the PDF to refresh authorized URLs. A complete, current viewer PDF may provide a fallback; review redacted diagnostics before sharing them. |
| **Nothing detected** | Open the document or play the video, then **Library > Rescan**. For persistent detection on another domain, grant site access in **Utilities**. |
| **A recording repeatedly fails** | Reduce parallelism in **Utilities**, replay to refresh signed links and retry. Authorization/format failures are not retried indefinitely. |
| **Saving is interrupted** | Use **Open browser downloads** to check disk, cancellation or network errors. Queued is not the same as saved. |
| **Bundle behavior persists after disabling** | Reload the website. Core Page fixes and Undo overlay removal do not undo already installed bundle hooks. |
| **Packaged script changes do not appear** | Reload the extension and website. Rescans preserve existing code/states/values; explicitly import the new source into an existing entry to update it. |
| **Folder permission is needed** | Use **Built-in updater setup > Restore write access**. The remembered folder is reused unless it moved or its saved handle was lost. |
| **An update is deferred** | Finish downloads and close script editors. Opted-in updates retry with bounded backoff; resolve permission/local-change/recovery errors before retrying. |
| **Retry limit reached** | Resolve the cause, then press **Check for updates**. Read-only popup refreshes cannot indefinitely postpone a due retry. |

<details>
<summary>How capped byte-range responses are validated</summary>

The downloader follows contiguous chunks until the whole file is assembled. If direct media omits a usable ETag/Last-Modified, it first tries a fresh complete request, then sequential ranges with overlapping-byte comparisons, a final leading-byte recheck and exact total-size checks. Wrong offsets, mismatched overlaps, changed metadata and incomplete bodies are refused. This compatibility path does not persist partial downloads and cannot prove an immutable file version without a server validator; the completed download includes that notice. HLS playlist byte-range validation remains strict.

</details>

## Privacy

* **No built-in core telemetry or analytics.** Network access is used for requested documents/media, userscript imports/dependencies/granted operations, and official release checks when enabled. Update checks omit credentials and can be disabled.
* **Local data:** script code, values, drafts and dependency caches stay in extension local storage. Captured download headers stay in browser session storage, with temporary request-scoped replay rules limited to extension-originated requests.
* **Folder updates:** the approved directory handle, installation marker, tracked hashes, automatic-install choice and recovery journal remain in this extension's IndexedDB/browser profile. They are not uploaded or exported with personal settings.
* **Permissions:** extra website access is explicit; all-site access is optional. Userscripts can themselves send data, so install only code you trust and review the bundle's network hooks before enabling it.
* **Sharing:** ZIP export excludes browser storage but cannot sanitize source-embedded secrets. Copied signed links may contain private tokens. Diagnostics are reduced/redacted; review them before sharing.

## Advanced

The sections below preserve legacy Windows safety notes and contributor documentation. They are not required for normal tools, manual ZIP installation or the built-in browser folder updater.

<details>
<summary>Legacy Windows updater safety (not Solus setup)</summary>

### Antivirus and Windows updater safety

Microsoft Defender flagged a temporary, unsigned native-host executable generated by the old updater tests. That does not establish that a downloaded video was malicious, and it does not prove the detection was a false positive. Do not restore quarantined files, disable protection, or add exclusions merely to run this project.

Solus does not compile executables, launch PowerShell, register native hosts, create Windows tasks or change antivirus settings. Legacy source is retained for historical testing; native protocol 2's publisher checks and locking are not used by the browser-only release. Windows tests use inert managed-code and mocked fixtures rather than launching freshly generated unsigned EXEs.

**No Windows certificate or installer is needed for Solus.** The ZIP excludes executable installers and helper scripts even if old signing configuration is present. The browser-only updater uses an RSA-signed package and the write permission you grant in Chrome.

Code signing, tests and antivirus scans reduce risk; none guarantees that every antivirus vendor will accept a build. A ZIP's RSA `.sig` authenticates archive bytes; it is not Windows Authenticode signing and is not proof that code is harmless.

### Historical signed-helper setup

The following notes describe a separate legacy design, not an installation step for Solus. Do not run a quarantined helper or lower security policy. The current packager never includes these tools.

**Downloading the ZIP, reading this README, or accepting the source license does not consent to installing software or background tasks.** If a future release includes a verified signed installer, run `Install-ALLEN-Toolbox.cmd`, read its publisher/setup details and approve explicitly; the default is No. Setup creates files under your user account, an hourly/logon task and per-user Native Messaging registrations for Chrome, Edge and Brave. It does not change browser profiles, trusted root certificates, global PowerShell policies or arbitrary system folders. Any already-valid leaf certificate added to your user-level TrustedPublisher store is separately disclosed in the consent text.

For that deliberately installed, verified code-signed managed build, **Load unpacked** uses **`%LOCALAPPDATA%\ALLENToolbox\extension`**. After approved setup and the initial Load unpacked step, the external updater can install compatible official signed releases automatically. Actual file replacement always waits until all supported browsers are closed, including for native requests; one idle profile cannot authorize replacing another profile's active files. Checks and notifications remain available while browsers are open. Interrupted recovery also waits for safe conditions. **Utilities > GitHub updates** displays actual availability/status; it never claims an absent or unsigned helper is ready. The check switch controls browser checks, not a separately installed background schedule.

For an existing unpacked installation, a verified signed installer supports `-Attach -ExtensionDirectory "C:\path\to\existing\allen-toolbox"` to keep its original folder/identity. Do not move/remove the extension if you want to retain its browser data. Protocol-1 unsigned helpers are not silently adopted or executed; an old background task should be disabled/removed explicitly before installing the new helper. Do not run a quarantined legacy executable.

The signed installer's `-Uninstall` flow asks again and removes only owned registrations, tasks and helper files. Browser data, extension files, unknown local files and recovery backups are preserved. Shared publisher trust is not removed casually. Never lower your system's security policy to force an unsigned uninstaller to run.

Chrome Web Store or supported managed distribution is another automatic-update route; this project does not publish signed CRXs to the store.

</details>

<details>
<summary>Release builds, signing and publication</summary>

Review userscripts for embedded secrets before every push; release packaging does not sanitize source code.

1. Push stable source to `main` or run **Build and release** manually. Actions runs syntax checks and regression tests before publishing `v<version>` with `ALLEN-Toolbox-<version>.zip`, a SHA-256 checksum and an RSA-SHA256 `.zip.sig`.
2. Increase **both** `manifest.json` and `package.json` to the same newer numeric version for subsequent versioned updates. Published versions/tags are not replaced; a push without a version increase does not deliver a newer version.
3. Packaging embeds the official repository and the updater independently pins it in code. A local release uses Node 24+ and `npm.cmd run release`; outputs are in `dist/`. Build/publication attempts targeting another update repository are rejected. Beta build instructions belong to the separate beta branch.

Solus builds always exclude native helper files. Only `UPDATER_SIGNING_KEY` is used to sign the official ZIP; it is not printed or included in source/artifacts. The browser updater verifies against the pinned `shared/update-public-key.json`. Historical Windows certificate tooling is not part of this release workflow.

Publication keeps the release in draft until the ZIP, checksum and signature are uploaded and their hashes verified. The private signing key is stored only in `UPDATER_SIGNING_KEY`; installation verification pins the public key. Unsigned, modified, oversized, foreign-source or unsafe-path archives are refused before automatic installation. A checksum from the same site is not a substitute for the signature.

Windows validation is required, not `continue-on-error`. GitHub's disposable Windows images disable Defender and preconfigure broad exclusions, so a runner-only preparation step enables protection, removes those exclusions and updates signatures before the scan. This step refuses to run on ordinary PCs or self-hosted runners. Defender protection and archive scanning must be enabled; a detection or unavailable validation blocks publication. Rerunning the original workflow restores its same-commit tested artifact; if it has expired, publish a newer version rather than overwrite mismatched draft assets.

If a tag push/upload succeeds but a later step fails, rerun **the same workflow run/commit** to resume missing draft uploads. Existing draft files with different hashes are refused, not overwritten. Published releases are never repaired in place; publish a newer version if an old release is incomplete. Local `npm.cmd run release` without the private key produces an unsigned development package, not a package the automatic updater trusts.

</details>

<details>
<summary>Folder plugins, project layout and validation</summary>

### Folder plugins (advanced)

The older mechanism still works: put a script in `plugins/`, list it in `plugins/plugins.json` (`id, name, file, css, world, matches, runAt, allFrames, enabled`) and reload the extension. Plugin `file` / `css` paths start with `plugins/`; referenced files are included in ZIP export. This index ships empty. Use `scripts/` for portable userscripts with the editor and GM runtime.

### Layout

```text
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
shared/folder-updater.js browser folder access, saved connections, backups/recovery
shared/builtin-updater.js guarded worker integration and installed status
popup/updater.html      setup and remembered-folder permission restoration
popup/updater-recovery.* frozen independent recovery bootstrap
updater/               verification key and legacy native sources (not installers)
scripts/               scripts.json and bundled .user.js files
plugins/               PLUGIN_PROMPT.md and (optional) folder plugins
icons/                 vector brand and generated PNG toolbar icons
lib/                   pdf.js (Apache-2.0), CodeMirror (MIT), Mediabunny (MPL-2.0)
tools/                 checks, icons, release packaging and resumable publication
.github/workflows/     tested, versioned GitHub release publication
tests/                 deterministic Node regression tests (source checkout)
```

### Validation

In the source checkout, use Node 24+ and run `npm.cmd run check`, `npm.cmd test`, and `npm.cmd run icons` on Windows. `npm run` also works in shells where npm's PowerShell wrapper is permitted. No dependency installation is needed for these checks. Optional `tools/browser-check.mjs` accepts `--playwright=<module index.mjs>`, `--browser=<Chromium executable>`, `--temp=<temporary directory>` and `--cdp-extension=1` for current branded Chrome (loads the fixture via DevTools instead of its disabled command-line switch). It launches an isolated profile and uses locally generated PDF/video/GitHub metadata fixtures, not real LMS accounts or GitHub releases. Runtime ZIP exports omit development tooling/tests.

</details>

## Credits

Credits to **Supreme** for ALLEN Toolbox.

pdf.js © Mozilla (Apache-2.0). The GM API follows the conventions established by Greasemonkey and documented by Violentmonkey (MIT) and Tampermonkey; no code was copied from them.

Local media joining uses the unmodified Mediabunny 1.66.5 browser bundle under [MPL-2.0](lib/mediabunny-LICENSE.txt). Its [corresponding source](https://registry.npmjs.org/mediabunny/-/mediabunny-1.66.5.tgz) is in the upstream npm archive (`package/src/`).

## License

Original project code is **Copyright (c) 2026 Shaan**, under the restricted source-available terms in [LICENSE](LICENSE). Personal use of official releases is permitted; reuse of protected original code to improve another system or build countermeasures requires Shaan's written permission. This is **not copyleft** or an open-source license.

Copyright cannot prohibit general inspiration, independently written implementations, or lawful security improvements that do not reuse protected expression. Public source can still be studied, so this license is not a technical guarantee against platform changes. Seek qualified legal review before relying on enforceability. pdf.js, CodeMirror, and other third-party material retain their own licenses and notices.

## Changelog

* **2.4.1 Solus Vestro**: add **Download with audio** for detected compatible YouTube tracks. Join them locally without re-encoding and keep separate downloads as a fallback. Extension permissions and the signed updater are unchanged.
* **2.4.0 Solus**: promote the tested browser-only updater, remember folder access across reloads, restore permission using the saved handle, preserve automatic-install preferences, retry deferred installs safely, and document one-time setup and recovery. No native executable installer is included.
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
