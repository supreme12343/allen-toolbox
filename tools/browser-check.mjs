import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { crc32, validateZipPath } from '../shared/zip.js';
import { EXTENSION_ASSETS } from '../shared/package.js';
import { OFFICIAL_REPOSITORY } from '../shared/updates.js';
import { isBetaManifest } from '../shared/update-meta.js';

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const index = argument.indexOf('='); return [argument.slice(0, index), argument.slice(index + 1)];
}));
const { chromium } = options['--playwright'] ? await import(pathToFileURL(options['--playwright']).href) : await import('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureRepository = OFFICIAL_REPOSITORY;
const sourceManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), fixtureBeta = isBetaManifest(sourceManifest);
const currentVersion = sourceManifest.version.split('.').map(Number);
currentVersion[currentVersion.length - 1]++;
const fixtureVersion = currentVersion.join('.');
const fixtureRelease = { tag_name: 'v' + fixtureVersion, html_url: fixtureRepository + '/releases/tag/v' + fixtureVersion,
  draft: false, prerelease: false, assets: [{ name: 'ALLEN-Toolbox-' + fixtureVersion + '.zip', state: 'uploaded', size: 12345,
    browser_download_url: fixtureRepository + '/releases/download/v' + fixtureVersion + '/ALLEN-Toolbox-' + fixtureVersion + '.zip' }] };
const output = await mkdtemp(join(options['--temp'] || join(tmpdir(), 'kilo'), 'allen-toolbox-verify-'));
const downloads = join(output, 'downloads'); await mkdir(downloads);
const host = 'toolbox-fixture.allenoverseas.com', origin = 'http://' + host;
const requests = [];
let video = Buffer.alloc(0), failPdf = false, failVideoOnce = false, partialVideo = false, wrongVideoStartOnce = false, noValidatorVideo = false;
const hlsMedia = Buffer.alloc(376); hlsMedia[0] = hlsMedia[188] = 0x47;

function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const text = 'BT /F1 18 Tf 25 150 Td (Local Study Fixture) Tj ET';
  objects.push('<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream');
  let source = '%PDF-1.4\n', offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += (index + 1) + ' 0 obj\n' + body + '\nendobj\n'; }
  const xref = Buffer.byteLength(source);
  source += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(source + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}
const pdf = makePdf();
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,user-scalable=no,maximum-scale=1"><title>Local Study Fixture</title><style>html,body{overflow-y:hidden}body{min-height:1300px;font:16px system-ui}#blur{filter:blur(2px) brightness(.5)}.overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.1)}</style></head><body>
<article><h1>Local Study Fixture</h1><p id="blocked" oncontextmenu="return false" oncopy="return false">Normal browser controls should work.</p><p id="blur">Blur should disappear without removing brightness.</p><p>${'A local paragraph for reading and text export. '.repeat(30)}</p><a href="${origin}/viewer/stream?token=fixture-only&amp;doc=guide">Study document</a><a href="${origin}/chapter?utm_source=test&amp;chapter=2">Chapter two</a></article>
<video id="video" controls preload="metadata" src="${origin}/fixture.webm" width="240" height="135"></video><div id="overlay" class="overlay"></div>
<script>fetch('/viewer/stream?token=fixture-only&doc=guide',{headers:{Authorization:'Bearer local-fixture-only'}}).then(r=>r.arrayBuffer());fetch('/fixture.webm',{headers:{'X-Toolbox-Fixture':'local-only'}}).then(r=>r.arrayBuffer());</script></body></html>`;

const server = createServer(async (request, response) => {
  requests.push({ url: request.url, headers: request.headers });
  if (request.url === '/fixture.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); return; }
  if (request.url === '/gm-echo') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const data = Buffer.from(JSON.stringify({ cookie: request.headers.cookie || '', method: request.method, body: Buffer.concat(chunks).toString() }));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length }); response.end(data); return;
  }
  if (request.url.startsWith('/viewer/stream')) {
    if (failPdf) { response.writeHead(403, { 'Content-Type': 'text/plain' }); response.end('expired fixture token - not a real credential'); return; }
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': 'inline; filename="Local Study Fixture.pdf"' }); response.end(pdf); return;
  }
  if (request.url === '/fixture.webm') {
    if (failVideoOnce) { failVideoOnce = false; response.writeHead(503, { 'Content-Type': 'text/plain' }); response.end('retry this local fixture'); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', ...(noValidatorVideo ? {} : { ETag: '"toolbox-fixture-v1"' }) };
    if (range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : video.length - 1, video.length - 1, partialVideo ? start + 128 * 1024 - 1 : video.length - 1);
      if (start >= video.length || end < start) { response.writeHead(416, { 'Content-Range': 'bytes */' + video.length }); response.end(); return; }
      response.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + video.length, 'Content-Length': end - start + 1 }); response.end(video.subarray(start, end + 1)); return;
    }
    if (partialVideo) {
      const start = wrongVideoStartOnce ? 128 * 1024 : 0, end = Math.min(start + 128 * 1024 - 1, video.length - 1);
      wrongVideoStartOnce = false;
      response.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + video.length, 'Content-Length': end - start + 1 }); response.end(video.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': video.length }); response.end(video); return;
  }
  if (['/ranges.m3u8', '/segments.m3u8'].includes(request.url)) {
    const segments = request.url === '/ranges.m3u8' ? '#EXTINF:1,\n#EXT-X-BYTERANGE:188@0\nhls-media.ts\n#EXTINF:1,\n#EXT-X-BYTERANGE:188\nhls-media.ts' :
      '#EXTINF:1,\nhls-one.ts\n#EXTINF:1,\nhls-two.ts';
    const playlist = Buffer.from('#EXTM3U\n' + segments + '\n#EXT-X-ENDLIST\n');
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': playlist.length }); response.end(playlist); return;
  }
  if (['/hls-media.ts', '/hls-one.ts', '/hls-two.ts'].includes(request.url)) {
    const data = request.url === '/hls-media.ts' ? hlsMedia : hlsMedia.subarray(0, 188);
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = range ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : data.length - 1, start + 63);
    if (start >= data.length || end < start) { response.writeHead(416); response.end(); return; }
    response.writeHead(206, { 'Content-Type': 'video/mp2t', ETag: '"hls-stable"',
      'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
    response.end(data.subarray(start, end + 1)); return;
  }
  if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  response.writeHead(404); response.end('Local fixture not found');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
async function fixtureExtension() {
  const directory = join(output, 'test-extension');
  // Keep user-uploaded scripts/plugins untouched and never execute them in UI verification.
  for (const path of EXTENSION_ASSETS) {
    if (path === 'scripts/scripts.json' || path === 'plugins/plugins.json') continue;
    const target = join(directory, path);
    let data = await readFile(join(root, path));
    if (path === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      manifest.homepage_url = 'https://github.com/other/toolbox';
      data = Buffer.from(JSON.stringify(manifest));
    }
    if (path === 'background.js') {
      // Metadata is a local fixture too: never contact a real GitHub repository during tests.
      const api = 'https://api.github.com/repos/' + OFFICIAL_REPOSITORY.slice('https://github.com/'.length) + (fixtureBeta ? '/releases?per_page=30' : '/releases/latest');
      data = Buffer.from(`globalThis.fixtureNativeCalls = 0;
chrome.runtime.sendNativeMessage = () => { globalThis.fixtureNativeCalls++; return Promise.reject(new Error('Native execution is prohibited in this browser fixture')); };
const fixtureFetch = globalThis.fetch;
globalThis.fetch = (input, options) => String(input) === ${JSON.stringify(api)} ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(fixtureBeta ? [fixtureRelease] : fixtureRelease))}, { headers: { 'content-type': 'application/json' } })) : fixtureFetch(input, options);
` + data.toString('utf8') + '\nglobalThis.fixtureUpdateDebug = async () => ({ ...(await updates.status()), capabilities: await offscreen("updater-capabilities") });\n');
    }
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, data);
  }
  const fixtures = {
    'plugins/plugins.json': '[]',
    'scripts/scripts.json': JSON.stringify([{ id: 'browser-fixture', file: 'fixture.user.js', enabled: false }]),
    'scripts/fixture.user.js': '// ==UserScript==\n// @name Browser fixture\n// @match https://example.org/*\n// @grant none\n// ==/UserScript==\nvoid 0;\n',
  };
  for (const [path, text] of Object.entries(fixtures)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, text);
  }
  return directory;
}

async function launch(extensionDirectory, profile) {
  const viaCDP = options['--cdp-extension'] === '1';
  const browserContext = await chromium.launchPersistentContext(join(output, profile), {
    executablePath: options['--browser'], headless: true, acceptDownloads: true, downloadsPath: downloads,
    ignoreDefaultArgs: viaCDP ? ['--disable-extensions'] : [],
    args: [...(viaCDP ? ['--enable-unsafe-extension-debugging'] : ['--disable-extensions-except=' + extensionDirectory, '--load-extension=' + extensionDirectory]), '--no-proxy-server',
      '--host-resolver-rules=MAP ' + host + ' 127.0.0.1:' + server.address().port],
  });
  if (viaCDP) {
    const session = await browserContext.browser().newBrowserCDPSession();
    try { await session.send('Extensions.loadUnpacked', { path: extensionDirectory }); }
    catch (error) { await browserContext.close(); throw error; }
    finally { await session.detach().catch(() => {}); }
  }
  return browserContext;
}

async function allowScripts(browserContext, extensionId) {
  const settings = await browserContext.newPage();
  await settings.goto('chrome://extensions/?id=' + extensionId);
  const toggle = settings.locator('extensions-detail-view #allow-user-scripts cr-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  await settings.locator('extensions-detail-view #allow-user-scripts cr-toggle[aria-checked="true"]').waitFor();
  await settings.close();
}

async function assertActionPopup(worker, inspector, source) {
  // A tab's emulated viewport can also resize the host browser window; restore a real desktop host first.
  await source.setViewportSize({ width: 1280, height: 720 });
  await source.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  try {
    // Action popups are not Playwright tabs: inspect the real native view without forcing its viewport.
    await inspector.waitForFunction(() => chrome.extension.getViews({ type: 'popup' }).some((view) => Number(view.document.querySelector('#count')?.dataset.count) >= 2));
    await inspector.waitForFunction(() => chrome.extension.getViews({ type: 'popup' }).some((view) => view.innerWidth >= 440 && Math.abs(view.document.body.getBoundingClientRect().width - view.innerWidth) < 1));
    const actual = await inspector.evaluate(() => {
      const view = chrome.extension.getViews({ type: 'popup' })[0], doc = view.document;
      const lines = (node) => { const range = doc.createRange(); range.selectNodeContents(node); return range.getClientRects().length; };
      const main = doc.querySelector('main'), credit = doc.querySelector('.footer-credit').getBoundingClientRect();
      return { width: view.innerWidth, height: view.innerHeight, bodyWidth: doc.body.getBoundingClientRect().width,
        titleLines: lines(doc.querySelector('.head-text b')), tabLines: [...doc.querySelectorAll('#tabs button')].map(lines),
        fileWidth: doc.querySelector('.card:has(.ico.pdf) .name').getBoundingClientRect().width,
        mainHeight: main.clientHeight, overflowing: main.scrollWidth > main.clientWidth,
        footerBottom: doc.querySelector('footer').getBoundingClientRect().bottom, creditBottom: credit.bottom };
    });
    // Windows DPI/native borders can subtract a few CSS pixels from the requested width.
    assert.ok(actual.width >= 440 && actual.width <= 800, 'Native action popup must not collapse to min-content width: ' + JSON.stringify(actual));
    assert.equal(actual.bodyWidth, actual.width);
    assert.equal(actual.titleLines, 1); assert.ok(actual.tabLines.every((count) => count === 1));
    assert.ok(actual.fileWidth >= 260); assert.ok(actual.mainHeight >= 200); assert.equal(actual.overflowing, false);
    assert.ok(actual.footerBottom <= actual.height && actual.creditBottom <= actual.height);
    const cdp = await context.newCDPSession(inspector);
    const origin = 'chrome-extension://' + new URL(worker.url()).hostname;
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const target = targets.find((entry) => entry.url === origin + '/popup/popup.html');
    assert.ok(target, 'The actual toolbar popup must expose a screenshot target');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const pending = new Map(); let sequence = 0;
    const receive = (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    };
    cdp.on('Target.receivedMessageFromTarget', receive);
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native popup screenshot timed out')); }, 10000);
      pending.set(id, { resolve, reject, timer });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch((error) => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
    try {
      await command('Runtime.evaluate', { expression: 'document.getAnimations().forEach((animation) => { if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish(); })' });
      const { data } = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(output, 'native-popup.png'), Buffer.from(data, 'base64'));
    } finally {
      cdp.off('Target.receivedMessageFromTarget', receive);
      await cdp.send('Target.detachFromTarget', { sessionId }); await cdp.detach();
    }
  } catch (error) {
    const views = await inspector.evaluate(() => chrome.extension.getViews({ type: 'popup' }).map((view) => ({
      width: view.innerWidth, height: view.innerHeight, bodyWidth: view.document.body?.getBoundingClientRect().width,
      count: view.document.querySelector('#count')?.dataset.count, status: view.document.querySelector('#global-status')?.textContent,
    }))).catch(() => []);
    throw new Error(error.message + '\nNative popup diagnostics: ' + JSON.stringify(views), { cause: error });
  } finally {
    await inspector.evaluate(() => chrome.extension.getViews({ type: 'popup' }).forEach((view) => view.close()));
  }
}

async function assertCreditsVisible(page) {
  const credit = page.locator('footer .footer-credit');
  assert.equal((await credit.textContent()).trim(), 'Credits to Supreme');
  assert.equal(await credit.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
  }), true, 'Credits must remain visible and unclipped');
}

async function assertTabIndicator(page) {
  await page.waitForFunction(() => {
    const nav = document.getElementById('tabs'), active = nav.querySelector('[aria-selected="true"]');
    const parent = nav.getBoundingClientRect(), button = active.getBoundingClientRect();
    const style = getComputedStyle(nav, '::after'), matrix = new DOMMatrix(style.transform);
    return Math.abs(matrix.m41 - (button.left - parent.left)) < 1 && Math.abs(parseFloat(style.width) - button.width) < 1;
  });
}

async function extractRelease(filename, destination) {
  const zip = await readFile(filename), entries = new Map();
  let offset = 0;
  // Test only: the exporter writes STORE/ZIP32, so verify each entry before extraction.
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    assert.equal(zip.readUInt16LE(offset + 6) & 8, 0);
    const size = zip.readUInt32LE(offset + 18), length = zip.readUInt16LE(offset + 26);
    assert.equal(size, zip.readUInt32LE(offset + 22));
    const path = validateZipPath(zip.toString('utf8', offset + 30, offset + 30 + length));
    assert.ok(path.startsWith('allen-toolbox/')); assert.equal(entries.has(path), false);
    const start = offset + 30 + length + zip.readUInt16LE(offset + 28), end = start + size;
    assert.ok(end <= zip.length);
    const data = zip.subarray(start, end);
    assert.equal(crc32(data), zip.readUInt32LE(offset + 14));
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, data);
    entries.set(path, data); offset = end;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.ok(entries.has('allen-toolbox/manifest.json'));
  return entries;
}

let context, recipientContext;
try {
  context = await launch(await fixtureExtension(), 'profile');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionOrigin = 'chrome-extension://' + new URL(worker.url()).hostname;
  const source = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(source);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const recorded = await source.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const painter = canvas.getContext('2d'), stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
    return new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = reject;
      recorder.onstop = async () => { stream.getTracks().forEach((track) => track.stop()); resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); };
      recorder.start(); let frame = 0;
      const timer = setInterval(() => {
        painter.fillStyle = frame % 2 ? '#55d6b0' : '#15212b'; painter.fillRect(0, 0, canvas.width, canvas.height);
        painter.fillStyle = '#fff'; painter.fillRect(20 + frame * 15, 30, 80, 80);
        if (++frame === 6) { clearInterval(timer); recorder.stop(); }
      }, 70);
    });
  });
  // An EBML Void keeps the generated WebM valid while exercising parallel ranges.
  const padding = 300000;
  video = Buffer.concat([Buffer.from(recorded), Buffer.from([0xec, 0x10 | (padding >>> 24), (padding >>> 16) & 255, (padding >>> 8) & 255, padding & 255]), Buffer.alloc(padding)]);
  await source.goto(origin + '/fixture.html');
  await source.waitForFunction(() => window.AOToolbox && window.AOToolbox.cfg.contextmenu === true);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, origin + '/*');
  const popup = await context.newPage(), errors = [];
  popup.on('pageerror', (error) => errors.push(error.message));
  await popup.emulateMedia({ reducedMotion: 'no-preference' });
  await popup.setViewportSize({ width: 448, height: 600 });
  await popup.goto(extensionOrigin + '/popup/popup.html?tab=' + tabId);
  const runningVersion = await worker.evaluate(() => chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version);
  assert.equal(await popup.locator('#extension-version').textContent(), 'v' + runningVersion);
  assert.equal(await popup.locator('#extension-version').getAttribute('aria-label'), 'Running extension version ' + runningVersion);
  await popup.locator('.card:has(.ico.pdf)').first().waitFor();
  await popup.locator('.card:has(.ico.media)').first().waitFor();
  await assertActionPopup(worker, popup, source);
  await assertCreditsVisible(popup);
  assert.deepEqual(await popup.evaluate(() => [getComputedStyle(document.body).backgroundColor,
    getComputedStyle(document.querySelector('.card')).backgroundColor,
    getComputedStyle(document.querySelector('.card .primary')).backgroundColor]), ['rgb(18, 21, 27)', 'rgb(29, 34, 43)', 'rgb(45, 102, 180)']);
  assert.match((await popup.locator('#count').textContent()).trim(), /^\d+ files? detected$/);
  assert.equal(await popup.locator('.card .name').first().evaluate((input) => input.labels[0].querySelector('.field-label').textContent), 'File name');
  await source.waitForFunction(() => getComputedStyle(document.getElementById('blur')).filter.includes('brightness') && !getComputedStyle(document.getElementById('blur')).filter.includes('blur'));
  assert.equal(await source.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'auto');
  assert.equal(await source.evaluate(() => document.getElementById('blocked').getAttribute('oncontextmenu')), null);
  await popup.getByRole('tab', { name: 'Library', exact: true }).focus();
  await popup.getByRole('tab', { name: 'Library', exact: true }).press('ArrowRight');
  assert.equal(await popup.getByRole('tab', { name: 'Page fixes', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await popup.locator('.panel.active').evaluate((panel) => getComputedStyle(panel).animationName), 'toolbox-panel-enter');
  assert.equal(await popup.locator('#tabs').evaluate((nav) => getComputedStyle(nav, '::after').transitionDuration), '0.22s');
  await assertTabIndicator(popup);
  await popup.locator('body').screenshot({ path: join(output, 'popup-page-fixes.png'), animations: 'disabled' });
  await popup.getByRole('switch', { name: 'Copy / cut / paste', exact: true }).press('Space');
  await source.waitForFunction(() => window.AOToolbox.cfg.clipboard === false);
  assert.equal(await source.evaluate(() => document.getElementById('blocked').getAttribute('oncopy')), 'return false');
  assert.equal(await source.evaluate(() => document.getElementById('blocked').getAttribute('oncontextmenu')), null);
  await popup.getByRole('switch', { name: 'Remove blur', exact: true }).click();
  await source.waitForFunction(() => getComputedStyle(document.getElementById('blur')).filter.includes('blur'));
  await popup.getByRole('switch', { name: 'Page fixes on this site', exact: true }).click();
  await source.waitForFunction(() => window.AOToolbox.cfg.contextmenu === false);
  assert.equal(await source.evaluate(() => document.getElementById('blocked').getAttribute('oncontextmenu')), 'return false');
  await popup.getByRole('switch', { name: 'Page fixes on this site', exact: true }).click();
  await popup.getByRole('button', { name: 'Balanced', exact: true }).click();
  await source.waitForFunction(() => window.AOToolbox.cfg.contextmenu === true && window.AOToolbox.cfg.unblur === true);
  await popup.getByRole('tab', { name: 'Utilities', exact: true }).click();
  await assertTabIndicator(popup);
  const beforeUpdates = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.equal(await popup.locator('#update-repository, #update-save').count(), 0, 'Users must not be asked to enter a repository');
  assert.equal(await popup.locator('#update-source').getAttribute('href'), OFFICIAL_REPOSITORY);
  const rejectedSource = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'updates:configure', repository: 'https://github.com/other/toolbox', automatic: true }));
  assert.match(rejectedSource.error, /source is fixed/);
  const fixedSource = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'updates:get' }));
  assert.equal(fixedSource.repository, OFFICIAL_REPOSITORY);
  assert.equal(await popup.locator('#update-install').isHidden(), true, 'An unsigned helper must not be offered for installation');
  assert.match(await popup.locator('#native-updater-status').textContent(), fixtureBeta ? /BETA experiment|BETA folder/ : /unavailable|No executable installer/);
  assert.equal(await popup.locator('#folder-updater-setup').isVisible(), fixtureBeta);
  await popup.waitForFunction(() => document.getElementById('update-auto').getAttribute('aria-checked') === 'true');
  await popup.locator('#update-check').click();
  await popup.locator('#update-release').waitFor({ state: 'visible' });
  await popup.waitForFunction((version) => document.getElementById('updates-panel').getAttribute('aria-busy') === 'false' &&
    document.getElementById('update-status').textContent.includes(version), fixtureVersion);
  assert.ok((await popup.locator('#update-status').textContent()).includes(fixtureVersion));
  assert.equal(await popup.locator('#update-download').isVisible(), true);
  const afterUpdates = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.deepEqual(afterUpdates, beforeUpdates, 'GitHub checks must not replace saved userscripts');
  assert.equal(await worker.evaluate(() => globalThis.fixtureNativeCalls), 0, 'Manual-only builds must not launch any native host');
  await popup.getByRole('switch', { name: 'Automatic update checks', exact: true }).click();
  await popup.waitForFunction(() => document.getElementById('update-auto').getAttribute('aria-checked') === 'false');
  assert.equal(await popup.locator('#update-check').isEnabled(), true, 'Manual checks stay available after automatic checks are disabled');
  await popup.locator('body').screenshot({ path: join(output, 'popup-utilities.png'), animations: 'disabled' });
  await popup.getByRole('button', { name: 'Remove overlays', exact: true }).click();
  await source.waitForFunction(() => document.getElementById('overlay').style.display === 'none');
  await popup.getByRole('button', { name: 'Undo overlay removal', exact: true }).click();
  await source.waitForFunction(() => document.getElementById('overlay').style.display === '');
  await popup.getByRole('button', { name: 'Focus reading view', exact: true }).click();
  await source.waitForSelector('#ao-reading-view'); await source.keyboard.press('Escape');
  await source.locator('#ao-reading-view').waitFor({ state: 'detached' });
  await popup.locator('#playback-speed').selectOption('1.5');
  await source.waitForFunction(() => document.getElementById('video').playbackRate === 1.5);
  await popup.getByRole('tab', { name: 'Library', exact: true }).click();
  await popup.locator('[data-media-filter="pdf"]').click();
  assert.equal(await popup.locator('.card:visible').count(), 1);
  await popup.locator('#media-search').fill('definitely not here');
  assert.equal(await popup.locator('#media-empty').isVisible(), true);
  await popup.locator('#media-search').fill(''); await popup.locator('[data-media-filter="all"]').click();
  await popup.locator('body').screenshot({ path: join(output, 'popup.png'), animations: 'disabled' });

  function waitForDownload() {
    return worker.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        chrome.downloads.onChanged.removeListener(listener);
        const jobs = (await chrome.storage.session.get('jobs')).jobs?.map((job) => ({ state: job.state, phase: job.phase, message: job.message }));
        const updater = globalThis.fixtureUpdateDebug ? await globalThis.fixtureUpdateDebug() : null;
        reject(new Error('Browser download did not finish within 30 seconds: ' + JSON.stringify({ jobs, updater })));
      }, 30000);
      const listener = async (event) => {
        if (!event.state || !['complete', 'interrupted'].includes(event.state.current)) return;
        clearTimeout(timer); chrome.downloads.onChanged.removeListener(listener);
        resolve((await chrome.downloads.search({ id: event.id }))[0]);
      };
      chrome.downloads.onChanged.addListener(listener);
    }));
  }
  failPdf = true;
  let finished = waitForDownload();
  await popup.locator('.card:has(.ico.pdf)').first().getByRole('button', { name: 'Save', exact: true }).click();
  let download = await finished;
  assert.equal(download.state, 'complete'); assert.deepEqual(await readFile(download.filename), pdf);
  assert.match(await popup.locator('.card:has(.ico.pdf)').first().innerText(), /captur|fallback|saved copy|complete PDF already received/i);
  failVideoOnce = true; partialVideo = true; finished = waitForDownload();
  await popup.locator('.card:has(.ico.media)').first().getByRole('button', { name: 'Download', exact: true }).click();
  download = await finished;
  assert.equal(download.state, 'complete'); assert.deepEqual(await readFile(download.filename), video);
  await popup.locator('.card:has(.ico.media) .status.ok').first().waitFor();
  assert.ok(requests.filter((request) => request.url === '/fixture.webm' && request.headers.range).length >= 2);

  for (const scenario of ['wrong-start', 'missing-validator']) {
    const before = requests.length;
    wrongVideoStartOnce = scenario === 'wrong-start'; noValidatorVideo = scenario === 'missing-validator';
    finished = waitForDownload();
    await popup.locator('.card:has(.ico.media)').first().getByRole('button', { name: 'Download', exact: true }).click();
    download = await finished;
    assert.equal(download.state, 'complete'); assert.deepEqual(await readFile(download.filename), video);
    const fresh = requests.slice(before).find((request) => request.url === '/fixture.webm' && request.headers.range === 'bytes=0-');
    assert.ok(fresh, 'Range recovery must start again from byte zero: ' + scenario);
    assert.equal(fresh.headers['if-range'], undefined);
    if (scenario === 'missing-validator') {
      const spans = requests.slice(before).filter((request) => request.url === '/fixture.webm' && request.headers.range);
      assert.ok(spans.some((request) => /^bytes=[1-9]\d*-/.test(request.headers.range)), 'Validatorless capped files must fetch their remaining bytes');
      assert.ok(spans.every((request) => request.headers['if-range'] === undefined));
      assert.ok(spans.some((request) => request.headers.range === 'bytes=0-65535'), 'Recheck the leading bytes before saving');
    }
    await popup.locator('.card:has(.ico.media) .status.' + (scenario === 'missing-validator' ? 'warn' : 'ok')).first().waitFor();
    if (scenario === 'missing-validator') assert.match(await popup.locator('.card:has(.ico.media) .status.warn').first().textContent(), /Compatibility download/);
  }
  noValidatorVideo = false;
  for (const path of ['/ranges.m3u8', '/segments.m3u8']) {
    const url = origin + path;
    await source.evaluate((url) => fetch(url).then((response) => response.text()), url);
    await popup.waitForFunction(async ({ tabId, url }) => {
      const state = await chrome.runtime.sendMessage({ type: 'state', tabId });
      return state.items?.some((item) => item.kind === 'hls' && item.url === url);
    }, { tabId, url });
    const item = await popup.evaluate(async ({ tabId, url }) => (await chrome.runtime.sendMessage({ type: 'state', tabId })).items.find((item) => item.url === url), { tabId, url });
    const info = await popup.evaluate((msg) => chrome.runtime.sendMessage(msg), { type: 'hls-info', tabId, id: item.id });
    assert.equal(info.error, undefined);
    finished = waitForDownload();
    const started = await popup.evaluate((msg) => chrome.runtime.sendMessage(msg), { type: 'job-start', tabId, id: item.id,
      kind: 'hls', mode: 'video', quality: info.options[0].id, name: 'Capped HLS fixture' });
    assert.equal(started.error, undefined);
    download = await finished;
    assert.equal(download.state, 'complete'); assert.deepEqual(await readFile(download.filename), hlsMedia);
  }

  await popup.getByRole('tab', { name: 'Scripts', exact: true }).click();
  await popup.locator('.us').first().waitFor();
  assert.equal(await popup.locator('#ai-assist').getAttribute('open'), null);
  assert.equal(await popup.locator('#copy-prompt').isVisible(), false);
  await popup.locator('#ai-assist summary').click();
  assert.equal(await popup.locator('#copy-prompt').isVisible(), true);
  await popup.locator('#ai-assist summary').click();
  await popup.locator('main').evaluate((main) => { main.scrollTop = 0; });
  await popup.locator('body').screenshot({ path: join(output, 'popup-scripts.png'), animations: 'disabled' });
  const scriptState = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'us:list' }));
  assert.equal(await popup.locator('#us-banner').isVisible(), !scriptState.available, 'The user-script gate must reflect actual browser availability');
  assert.equal(scriptState.scripts[0].bundleId, 'browser-fixture');
  assert.equal(await popup.locator('.us').first().getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
  assert.equal(await popup.getByText('folder script (protected)', { exact: true }).isVisible(), true);
  const rejectedDelete = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'us:delete', id }), scriptState.scripts[0].id);
  assert.match(rejectedDelete.error, /Folder scripts cannot be deleted/);
  const preservedScripts = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'us:list' }));
  assert.equal(preservedScripts.scripts[0].id, scriptState.scripts[0].id);
  const toggle = popup.locator('.us-top button[role="switch"]').first();
  await toggle.click();
  await popup.waitForFunction(() => !document.querySelector('.us-top button[role="switch"]').disabled);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await toggle.click();
  await popup.waitForFunction(() => !document.querySelector('.us-top button[role="switch"]').disabled);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  const snapshot = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.ok(snapshot.index.length >= 1); assert.ok(snapshot.files.every((file) => file.path.startsWith('scripts/')));
  for (const width of [1280, 375]) {
    await popup.setViewportSize({ width, height: 720 });
    await popup.goto(extensionOrigin + '/popup/popup.html?dashboard=1&tab=' + tabId + '&view=tools');
    await popup.locator('#tab-tools:not([hidden])').waitFor();
    assert.equal(await popup.locator('#extension-version').isVisible(), true);
    assert.equal(await popup.locator('#extension-version').textContent(), 'v' + runningVersion);
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await assertCreditsVisible(popup);
    await assertTabIndicator(popup);
    await popup.screenshot({ path: join(output, 'dashboard-' + width + '.png'), animations: 'disabled' });
  }
  await popup.setViewportSize({ width: 320, height: 480 });
  await popup.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await popup.locator('.panel.active').evaluate((node) => getComputedStyle(node).animationName), 'none');
  assert.equal(await popup.locator('#tabs').evaluate((nav) => getComputedStyle(nav, '::after').transitionDuration), '0s');
  await assertTabIndicator(popup);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await popup.locator('#extension-version').isVisible(), true);
  assert.equal(await popup.locator('footer').evaluate((footer) => footer.getBoundingClientRect().bottom <= innerHeight), true);
  await assertCreditsVisible(popup);
  for (const button of await popup.locator('#tab-tools button:visible').all()) {
    const box = await button.boundingBox();
    assert.ok(box.width >= 24 && box.height >= 24, 'Web controls must meet the 24 CSS px target minimum');
  }
  const editor = await context.newPage(); editor.on('pageerror', (error) => errors.push(error.message));
  await editor.goto(extensionOrigin + '/popup/editor.html?tab=' + tabId + '&source=' + encodeURIComponent(origin + '/fixture.html'));
  await editor.locator('.CodeMirror').waitFor();
  assert.equal(await editor.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getInputField().getAttribute('aria-label')), 'Userscript code');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitForFunction(() => !!new URL(location.href).searchParams.get('id'));
  const savedId = new URL(editor.url()).searchParams.get('id');
  await editor.evaluate(() => {
    const cm = document.querySelector('.CodeMirror').CodeMirror;
    cm.replaceRange('\n// Saved revision fixture\n', cm.posFromIndex(cm.getValue().length));
  });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitForFunction(() => !document.getElementById('script-title').textContent.endsWith(' *'));
  assert.equal(new URL(editor.url()).searchParams.get('id'), savedId);
  const afterSave = await editor.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.equal(afterSave.index.length, snapshot.index.length + 1, 'Saving a warning-bearing script twice must not create duplicate records');
  for (const width of [1280, 375]) {
    await editor.setViewportSize({ width, height: 720 });
    assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await assertCreditsVisible(editor);
    await editor.screenshot({ path: join(output, 'editor-' + width + '.png'), animations: 'disabled' });
    await editor.locator('[data-view="scripts"]').click();
    const folderRow = editor.locator('#script-list .script-row').filter({ hasText: 'Browser fixture' });
    await folderRow.waitFor();
    assert.equal(await folderRow.getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
    assert.equal(await folderRow.getByText('Folder script (protected; disable instead of deleting)', { exact: true }).isVisible(), true);
    assert.equal(await editor.locator('#script-list .script-row').filter({ hasNotText: 'Browser fixture' }).getByRole('button', { name: 'Delete', exact: true }).isDisabled(), false);
    assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await editor.screenshot({ path: join(output, 'editor-scripts-' + width + '.png'), animations: 'disabled' });
    await editor.locator('[data-view="code"]').click();
  }
  await editor.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await editor.locator('#view-code').evaluate((node) => getComputedStyle(node).animationName), 'none');
  await editor.emulateMedia({ reducedMotion: 'no-preference' });

  await editor.getByRole('tab', { name: 'Help', exact: true }).click();
  const helpCredits = editor.getByText('Credits to Supreme for ALLEN Toolbox.', { exact: true });
  await helpCredits.scrollIntoViewIfNeeded(); assert.equal(await helpCredits.isVisible(), true);
  await editor.getByRole('tab', { name: 'Code', exact: true }).click();

  const shippedCode = `// ==UserScript==
// @name Shipped script fixture
// @namespace ALLEN Toolbox Tests
// @version 1.0.0
// @match ${origin}/*
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_xmlhttpRequest
// @connect self
// @run-at document-start
// ==/UserScript==
(async function () {
  GM_setValue('document-start', true);
  const runs = Number(await GM.getValue('runs', 0)) + 1;
  await GM.setValue('runs', runs);
  const [one, two, plain] = await Promise.all([
    GM.xmlHttpRequest({ method: 'POST', url: '${origin}/gm-echo', data: 'one', headers: { Cookie: 'fixture=one' }, responseType: 'json', timeout: 8000 }),
    GM.xmlHttpRequest({ method: 'POST', url: '${origin}/gm-echo', data: 'two', headers: { Cookie: 'fixture=two' }, responseType: 'json', timeout: 8000 }),
    fetch('${origin}/gm-echo', { method: 'POST', body: 'plain' }).then((response) => response.json()),
  ]);
  if (one.response.cookie !== 'fixture=one' || two.response.cookie !== 'fixture=two' || plain.cookie.includes('fixture=')) throw new Error('GM request headers crossed contexts');
  if (one.response.method !== 'POST' || one.response.body !== 'one' || two.response.body !== 'two') throw new Error('GM request method or body changed');
  if (!document.documentElement) await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  document.documentElement.dataset.shippedScript = String(runs);
})();
`;
  await editor.locator('#new-script').click();
  await editor.waitForURL((url) => !url.searchParams.has('id'));
  await editor.locator('.CodeMirror').waitFor();
  await editor.locator('#import-toggle').click();
  const [choosing] = await Promise.all([editor.waitForEvent('filechooser'), editor.locator('#upload').click()]);
  await choosing.setFiles({ name: 'shipped.user.js', mimeType: 'text/javascript', buffer: Buffer.from(shippedCode) });
  await editor.waitForFunction(() => document.querySelector('.CodeMirror').CodeMirror.getValue().includes('@name Shipped script fixture'));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitForFunction(() => !document.getElementById('script-title').textContent.endsWith(' *'));
  await allowScripts(context, new URL(worker.url()).hostname);
  const senderScripts = await editor.evaluate(() => chrome.runtime.sendMessage({ type: 'us:list' }));
  assert.equal(senderScripts.available, true);
  failPdf = false; partialVideo = false;
  await source.reload(); await source.waitForFunction(() => document.documentElement.dataset.shippedScript === '1');
  await source.reload(); await source.waitForFunction(() => document.documentElement.dataset.shippedScript === '2');

  const savedSnapshot = await editor.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  finished = waitForDownload();
  editor.on('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Export Extension ZIP', exact: true }).click();
  download = await finished;
  assert.equal(download.state, 'complete'); assert.match(download.filename, /\.zip$/i);
  const recipientDirectory = join(output, 'recipient');
  const release = await extractRelease(download.filename, recipientDirectory);
  for (const path of ['manifest.json', 'popup/popup.html', 'popup/editor.html', 'README.md']) {
    assert.match(release.get('allen-toolbox/' + path).toString('utf8'), /Supreme/, 'Credits must ship in ' + path);
  }
  const index = JSON.parse(release.get('allen-toolbox/scripts/scripts.json').toString('utf8'));
  assert.deepEqual(index, savedSnapshot.index);
  for (const file of savedSnapshot.files) assert.equal(release.get('allen-toolbox/' + file.path).toString('utf8'), file.text);

  recipientContext = await launch(join(recipientDirectory, 'allen-toolbox'), 'recipient-profile');
  const recipientWorker = recipientContext.serviceWorkers()[0] || await recipientContext.waitForEvent('serviceworker', { timeout: 15000 });
  const recipientOrigin = 'chrome-extension://' + new URL(recipientWorker.url()).hostname;
  const recipient = await recipientContext.newPage(); recipient.on('pageerror', (error) => errors.push(error.message));
  await recipient.goto(recipientOrigin + '/popup/popup.html');
  await recipient.getByRole('tab', { name: 'Scripts', exact: true }).click();
  await recipient.locator('.us').first().waitFor();
  await assertCreditsVisible(recipient);
  const imported = await recipient.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.deepEqual(imported.index, savedSnapshot.index); assert.deepEqual(imported.files, savedSnapshot.files);
  const recipientStorage = await recipientWorker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(Object.keys(recipientStorage).some((key) => key.startsWith('usval:')), false, 'Private sender values must not ship');
  await allowScripts(recipientContext, new URL(recipientWorker.url()).hostname);
  const readyScripts = await recipient.evaluate(() => chrome.runtime.sendMessage({ type: 'us:list' }));
  assert.equal(readyScripts.available, true);
  const recipientSource = await recipientContext.newPage();
  await recipientSource.goto(origin + '/fixture.html');
  await recipientSource.waitForFunction(() => document.documentElement.dataset.shippedScript === '1');
  await recipientSource.reload(); await recipientSource.waitForFunction(() => document.documentElement.dataset.shippedScript === '2');
  await recipient.evaluate(() => chrome.runtime.sendMessage({ type: 'us:scan-bundles' }));
  const rescanned = await recipient.evaluate(() => chrome.runtime.sendMessage({ type: 'us:bundle-export' }));
  assert.deepEqual(rescanned, imported, 'A folder rescan must not duplicate or replace the shipped scripts');
  assert.deepEqual(errors, []);
  console.log('PASS: real MV3 startup and native toolbar-popup sizing, graphite/blue theme, animated tabs and reduced-motion support, PDF cached fallback after HTTP 403, retried/capped-range genuine WebM byte identity, zero-based recovery of wrong offsets and unvalidated default prefixes, capped HLS range and whole-segment byte identity, native download completion, GitHub update controls with local metadata, persistent validation feedback and saved-script preservation, independent page-fix switches, blur/scroll restoration, site pause, overlay undo, reading view, playback speed, file filters, desktop/mobile UI with visible Supreme credits, protected folder Delete controls and backend rejection, native userscript file upload, concurrent GM header isolation, credited ZIP export and fresh-recipient script import/execution with private values excluded.');
  console.log('Artifacts: ' + output);
} catch (error) {
  console.error('Browser test artifacts: ' + output);
  if (context) await Promise.all(context.pages().map((page, index) => page.screenshot({ path: join(output, 'failure-' + index + '.png') }).catch(() => {})));
  if (recipientContext) await Promise.all(recipientContext.pages().map((page, index) => page.screenshot({ path: join(output, 'recipient-failure-' + index + '.png') }).catch(() => {})));
  throw error;
} finally {
  if (recipientContext) await recipientContext.close();
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
}
