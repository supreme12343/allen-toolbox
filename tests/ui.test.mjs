import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const theme = await readFile(new URL('../popup/theme.css', import.meta.url), 'utf8');
const colors = Object.fromEntries([...theme.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]));
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
test('shared dark theme meets AA text contrast for body, feedback and primary controls', () => {
  for (const background of ['bg', 'panel', 'card', 'input', 'button', 'button-hover', 'button-pressed', 'selection']) {
    for (const foreground of ['text', 'mute']) assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, foreground + '/' + background);
  }
  for (const feedback of ['success', 'red', 'amber']) assert.ok(contrast(colors[feedback], colors.card) >= 4.5, feedback);
  for (const background of ['primary', 'primary-hover', 'primary-pressed']) assert.ok(contrast(colors['accent-ink'], colors[background]) >= 4.5, background);
  assert.ok(contrast(colors.blue, colors.panel) >= 4.5, 'accent/panel');
  assert.ok(contrast(colors.amber, colors['warning-bg']) >= 4.5);
  assert.ok(contrast(colors.red, colors['error-bg']) >= 4.5);
});
test('control boundaries and focus accents meet non-text contrast requirements', () => {
  for (const background of ['panel', 'card', 'input', 'button', 'button-hover', 'button-pressed']) {
    assert.ok(contrast(colors['control-border'], colors[background]) >= 3, background);
    assert.ok(contrast(colors.blue, colors[background]) >= 3, 'focus/' + background);
  }
});
test('popup and editor share local theme assets without skill content or remote fonts', async () => {
  for (const filename of ['popup.html', 'editor.html']) {
    const html = await readFile(new URL('../popup/' + filename, import.meta.url), 'utf8');
    assert.match(html, /href="theme\.css"/);
    assert.ok(!html.includes('ui-ux-pro-max'));
    assert.ok(!html.includes('fonts.googleapis.com'));
  }
  const packaging = await readFile(new URL('../shared/package.js', import.meta.url), 'utf8');
  assert.ok(packaging.includes("'popup/theme.css'"));
  assert.ok(!packaging.includes('.config/kilo'));
});

test('toolbar popup has intrinsic dimensions while the dashboard can shrink to its viewport', async () => {
  const css = await readFile(new URL('../popup/popup.css', import.meta.url), 'utf8');
  const root = css.match(/(?:^|\n)html\s*\{([^}]+)\}/)[1];
  assert.match(root, /min-width:\s*448px/);
  assert.match(root, /height:\s*590px/);
  assert.match(css, /html:has\(> body\.dashboard\)\s*\{[^}]*min-width:\s*0/);
  const body = css.match(/(?:^|\n)body\s*\{([^}]+)\}/)[1];
  assert.match(body, /(?:^|;)\s*width:\s*100%/);
  assert.match(body, /(?:^|;)\s*max-width:\s*100vw/);
  assert.doesNotMatch(body, /(?:^|;)\s*width:\s*(?:100vw|min\(448px,\s*100vw\))/);
});

test('professional theme uses blue actions and neutral success states, without mint branding', async () => {
  for (const name of ['blue', 'blue-h', 'primary', 'primary-hover', 'primary-pressed', 'success']) {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(colors[name].slice(offset, offset + 2), 16));
    assert.ok(b >= g && b >= r, name + ' must be blue or neutral, not green');
  }
  for (const name of ['theme.css', 'popup.css', 'editor.css']) {
    const css = await readFile(new URL('../popup/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(css, /55d6b0|81e5c8|7ee2b8|213f35|203c35|b6db99|var\(--green\)/i);
  }
  const html = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /YOUR STUDY TOOLKIT|Your study files\.|Make it your toolbox\./);
  const assistance = html.match(/<details[^>]*id="ai-assist"[^>]*>/)[0];
  assert.doesNotMatch(assistance, /\bopen\b/);
  assert.match(html, /<summary>AI script assistance<\/summary>/);
});

test('SVG and generated toolbar icons share the non-green palette at every size', async () => {
  const svg = await readFile(new URL('../icons/logo.svg', import.meta.url), 'utf8');
  assert.ok(svg.includes(colors.blue)); assert.ok(svg.includes(colors.panel));
  assert.doesNotMatch(svg, /55d6b0|81e5c8/i);
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(new URL('../icons/icon' + size + '.png', import.meta.url)), blocks = [];
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    for (let offset = 8; offset + 12 <= png.length;) {
      const length = png.readUInt32BE(offset), kind = png.toString('ascii', offset + 4, offset + 8);
      if (kind === 'IDAT') blocks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const bytes = inflateSync(Buffer.concat(blocks)), stride = size * 4 + 1;
    for (let y = 0; y < size; y++) {
      assert.equal(bytes[y * stride], 0);
      for (let x = 0; x < size; x++) {
        const pixel = y * stride + 1 + x * 4;
        assert.ok(bytes[pixel + 2] >= bytes[pixel + 1] && bytes[pixel + 2] >= bytes[pixel], 'Unexpected green icon pixel at ' + size);
      }
    }
  }
});

test('motion uses restrained transform/opacity transitions and is disabled for reduced motion', async () => {
  const popup = await readFile(new URL('../popup/popup.css', import.meta.url), 'utf8');
  assert.match(popup, /nav::after\s*\{[^}]*transition:\s*transform var\(--motion-nav\)/);
  assert.match(popup, /@keyframes toolbox-panel-enter/); assert.match(popup, /@keyframes toolbox-card-enter/);
  for (const filename of ['popup.css', 'editor.css']) {
    const css = await readFile(new URL('../popup/' + filename, import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /animation:\s*none\s*!important/); assert.match(css, /transition:\s*none\s*!important/);
    assert.doesNotMatch(css, /animation:[^;}]*infinite/);
  }
  const js = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  assert.match(js, /new ResizeObserver\(updateTabIndicator\)/);
  assert.match(js, /Math\.min\(cards\.size \* 30, 120\)/);
});

test('Supreme credits appear across the UI without replacing third-party attribution or live status', async () => {
  for (const filename of ['popup.html', 'editor.html']) {
    const html = await readFile(new URL('../popup/' + filename, import.meta.url), 'utf8');
    const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)[1];
    assert.match(footer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /Credits to Supreme/);
    const status = footer.match(/<span id="status"[^>]*>([\s\S]*?)<\/span>/)[1];
    assert.doesNotMatch(status, /Supreme/, 'Static credits must not be announced with every status update');
  }
  const editor = await readFile(new URL('../popup/editor.html', import.meta.url), 'utf8');
  assert.match(editor, /<h3>Credits<\/h3>/);
  assert.ok(editor.includes('../lib/pdfjs-LICENSE.txt'));
  assert.ok(editor.includes('../lib/codemirror.LICENSE'));
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.match(manifest.description, /Credits to Supreme/);
  assert.ok(manifest.description.length <= 132);
  assert.match(manifest.action.default_title, /Credits to Supreme/);
});
