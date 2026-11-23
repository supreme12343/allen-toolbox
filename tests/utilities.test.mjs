import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPageLink, isAudioItem, matchesMediaFilter } from '../shared/utilities.js';
import { parseMeta, scriptOrigins } from '../shared/usmeta.js';
import { validateZipPath } from '../shared/zip.js';

test('clean links remove only known tracking and retain signed/functional query bytes', () => {
  assert.equal(cleanPageLink('https://example.org/notes?utm_source=mail&chapter=2&fbclid=abc#page=3'), 'https://example.org/notes?chapter=2#page=3');
  assert.equal(cleanPageLink('https://cdn.example.org/lesson?signature=ab%20~%2F&token=t%2b1&utm_campaign=test&X-Amz-Signature=secret'), 'https://cdn.example.org/lesson?signature=ab%20~%2F&token=t%2b1&X-Amz-Signature=secret');
  assert.equal(cleanPageLink('https://example.org/?UTM_Source=test&ref=chapter&%E0=x'), 'https://example.org/?ref=chapter&%E0=x');
  assert.equal(cleanPageLink('https://example.org/'), 'https://example.org/');
  assert.throws(() => cleanPageLink('chrome://extensions'), /normal website/);
});
test('media filters distinguish PDFs, direct audio and video without losing search matches', () => {
  const pdf = { kind: 'pdf', url: 'https://example.org/notes.pdf', title: 'Physics Notes' };
  const audio = { kind: 'media', url: 'https://example.org/audio?id=1', ct: 'audio/mpeg', title: 'Lecture' };
  const video = { kind: 'hls', url: 'https://example.org/master.m3u8', title: 'Physics recording' };
  assert.equal(isAudioItem(audio), true); assert.equal(isAudioItem(pdf), false);
  assert.equal(matchesMediaFilter(pdf, 'pdf', 'physics'), true);
  assert.equal(matchesMediaFilter(pdf, 'video'), false);
  assert.equal(matchesMediaFilter(audio, 'audio'), true);
  assert.equal(matchesMediaFilter(audio, 'video'), false);
  assert.equal(matchesMediaFilter(video, 'video', ' PHYSICS '), true);
  assert.equal(matchesMediaFilter(video, 'all', 'chemistry'), false);
});

test('script consent includes declared connection subdomains and self targets', () => {
  const meta = parseMeta('// ==UserScript==\n// @name Connections\n// @match https://example.org/*\n// @connect api.example.net\n// @connect self\n// @grant GM_xmlhttpRequest\n// ==/UserScript==\n');
  const origins = scriptOrigins(meta);
  assert.ok(origins.includes('*://*.api.example.net/*'));
  assert.ok(origins.includes('*://*.example.org/*'));
  assert.ok(!origins.includes('<all_urls>'));
});

test('portable archive paths reject Windows reserved names', () => {
  for (const path of ['CON.user.js', 'scripts/aux.user.js', 'plugins/LPT1/style.css']) assert.throws(() => validateZipPath(path), /Unsafe/);
  assert.equal(validateZipPath('scripts/console-helper.user.js'), 'scripts/console-helper.user.js');
});
