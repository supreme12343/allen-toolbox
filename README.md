# ALLEN Toolbox 2.1.2

A Chrome / Edge / Brave extension (Manifest V3) that bundles:

* **Page fixes**: searchable, keyboard-accessible controls for right-click, selection, clipboard, shortcuts, zoom, printing and scrolling. Choose Balanced, All fixes or Off; pause fixes for one site. Blur removal preserves color filters. Unsaved-work warnings and window-size spoofing are off by default.
* **PDFs**: validated viewer captures, automatic names, Open / Save / Copy text, and a current-document fallback when a previously loaded stream expires. Save distinguishes queued, completed and interrupted browser downloads.
* **Recordings**: direct files and supported HLS VOD, transient-request retries, bounded timeouts, verified ranges and final sizes. Separate HLS audio is downloadable and is clearly distinguished from a combined recording.
* **Scripts**: a local userscript editor and manager, a real `scripts/` folder, and **Export extension ZIP** to ship saved scripts with the entire runtime extension.
* **Utilities**: reversible overlay cleanup, focus reading, clean-link and page-link copying, text export, visible screenshots, playback speed, media rescan, and browser downloads access.
* **GitHub updates**: hourly public-release checks, newer-version notifications, a manual check and release ZIP download. GitHub Actions builds and publishes a new version after a push to `main`.

## Install

1. Unzip the extension ZIP somewhere permanent (Chrome loads the extension from that folder).
2. Open `chrome://extensions` and switch on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`allen-toolbox`** folder, the one containing `manifest.json`.
4. Pin the extension (puzzle-piece icon → pin).

### One switch for scripts (needed once)

Use a current desktop Chrome/Chromium browser, preferably 138+. Chrome only runs add-on scripts after you allow it: `chrome://extensions` → **ALLEN Toolbox → Details → turn on "Allow User Scripts"**. Chrome 120–137 uses **Developer mode** instead of that separate switch. After enabling access, reload the extension if needed, press **Scripts > Check again**, then reload the website. Everything else works without script access.

> Chrome cannot install a `.zip` directly — unzip it and use **Load unpacked**.

## GitHub releases and updates

Source and releases: [supreme12343/allen-toolbox](https://github.com/supreme12343/allen-toolbox). The extension defaults to this public repository for update checks. Review userscripts for embedded secrets before every push; release packaging does not sanitize source code.

1. Push the source to the repository's `main` branch, or run its **Build and release** GitHub Actions workflow manually. Actions runs syntax checks and regression tests before publishing `v<version>` with `ALLEN-Toolbox-<version>.zip` and its SHA-256 checksum.
2. For each subsequent update, increase **both** `manifest.json` and `package.json` to the same newer numeric version, then push to `main`. A published version/tag is not replaced. A push without a version increase does not deliver a new update.
3. Release packaging automatically embeds the actual GitHub repository as the ZIP's `manifest.homepage_url`. People installing that ZIP get hourly checks for that repository and a notification when a newer release appears. The browser must be running and allow notifications; checks are not instant push delivery.
4. For an existing local installation with saved update settings, open **Utilities > GitHub updates**, enter `https://github.com/supreme12343/allen-toolbox`, and press **Save repository**. New installations use this repository automatically. Automatic checks can be switched off; **Check for updates**, **View release** and **Download update ZIP** remain available manually.

A local release can also be built with Node 24+: `npm.cmd run release`. Outputs are in `dist/` and use the repository in `manifest.homepage_url`. For a fork, override it with `npm.cmd run release -- --repository=https://github.com/OWNER/REPO`. A source tree without either setting builds an unlinked ZIP, without inventing a repository. GitHub Actions supplies its own repository automatically.

Publication keeps the release in draft until both the ZIP and checksum are uploaded and their hashes verified. If a tag push or upload succeeds but a later step fails, rerun **the same workflow run/commit** to resume missing draft uploads. Existing draft files with a different hash are refused, not overwritten. Published releases are never repaired in place; publish a newer version if an old release is incomplete.

**Chrome limitation:** a Load unpacked extension cannot replace its own installed files. After downloading the update ZIP, close toolbox/editor tabs, extract it, replace files in the **original permanent installation folder**, and press **Reload** at `chrome://extensions`; then reload the website. Do not remove/reinstall or move the extension if you want to retain its local script values/settings. ZIP downloads are reported as queued, not installed or saved. Fully automatic whole-extension updates require Chrome Web Store distribution (or a supported managed deployment); this workflow produces ZIPs, not signed CRXs, and does not publish to the store.

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
* *A server caps each byte-range response*: the downloader follows validated contiguous chunks until the whole file is assembled. Wrong offsets, changed file versions and incomplete bodies are still refused. If the endpoint provides neither a stable ETag/Last-Modified nor a complete response, replay the recording to refresh its URL; unsafe partial files are not saved.
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

## Changelog

* **2.1.2**: deterministic ZIP ordering regardless of concurrent asset reads; authenticated draft-release discovery and verified resumable publication. The unpublished 2.1.1 tag is preserved rather than moved to different source.
* **2.1.1**: resume server-capped byte ranges without losing or duplicating bytes; retain strict file identity/length checks and HLS validation; add configurable hourly GitHub release checks, update notifications, release ZIP downloads and tested GitHub Actions packaging. Unpacked installations still require replacing files and reloading; stored userscript edits are not overwritten.
* **2.1.0**: graphite-and-blue interface, compact native popup, updated vector/toolbar logo and responsive dashboard; accessible searchable page fixes and file filters; per-site pause and presets; reversible overlay cleanup and daily utilities; seed-once custom scripts folder with saved-script extension ZIP export; exact request-scoped header leases; stronger PDF fallback, bounded retries/timeouts/range validation, HLS protection/audio checks, and truthful native download completion; regression and isolated-browser checks.
* **2.0.0** – Userscript manager (Violentmonkey/Tampermonkey-compatible): upload / paste / link install, GM_* and GM.* APIs, `@require`/`@resource`/`@connect`, menu commands, cross-tab values, sandbox mode; `AO` helpers with always-on-top buttons and panels that can use the downloader; new AI prompt for userscripts; early-page-message buffering; UI fixes.
* **1.4.0** – AI prompt for folder plugins. **1.3.0** – ranged parallel downloads + size check. **1.2.0** – replay the player's complete request; Copy diagnostics. **1.1.0** – streamed direct downloads. **1.0.0** – first release.
