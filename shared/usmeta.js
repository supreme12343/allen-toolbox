// Userscript metadata (==UserScript== blocks, the format Violentmonkey / Tampermonkey / Greasemonkey share)
// plus helpers that turn @match / @include / @exclude into Chrome match patterns and exact runtime filters.

// Preserve previously accepted 2 Mi UTF-16-unit sources while using one UTF-8 byte limit everywhere.
export const MAX_SCRIPT_BYTES = 6 * 1024 * 1024;
export function assertScriptSize(code) {
  if (typeof code !== 'string') throw new Error('The userscript source must be text');
  if (code.length > MAX_SCRIPT_BYTES || new TextEncoder().encode(code).byteLength > MAX_SCRIPT_BYTES) {
    throw new Error('The script exceeds the 6 MiB UTF-8 limit');
  }
}

// Every spelling of a grant maps to one canonical name.
const GRANT_ALIASES = {
  'GM.getValue': 'GM_getValue', 'GM.setValue': 'GM_setValue', 'GM.deleteValue': 'GM_deleteValue', 'GM.listValues': 'GM_listValues',
  'GM.xmlHttpRequest': 'GM_xmlhttpRequest', 'GM.xmlhttpRequest': 'GM_xmlhttpRequest', 'GM.openInTab': 'GM_openInTab',
  'GM.notification': 'GM_notification', 'GM.setClipboard': 'GM_setClipboard', 'GM.registerMenuCommand': 'GM_registerMenuCommand',
  'GM.unregisterMenuCommand': 'GM_registerMenuCommand', 'GM_unregisterMenuCommand': 'GM_registerMenuCommand',
  'GM.addStyle': 'GM_addStyle', 'GM.addElement': 'GM_addElement', 'GM.download': 'GM_download', 'GM.log': 'GM_log',
  'GM.getResourceText': 'GM_getResourceText', 'GM.getResourceUrl': 'GM_getResourceURL', 'GM.getResourceURL': 'GM_getResourceURL',
  'GM_getResourceUrl': 'GM_getResourceURL', 'GM_addValueChangeListener': 'GM_addValueChangeListener',
  'GM_removeValueChangeListener': 'GM_addValueChangeListener', 'GM.info': 'GM_info',
};

const RUN_AT = { 'document-start': 'document_start', 'document-body': 'document_end', 'document-end': 'document_end', 'document-idle': 'document_idle' };

export function parseMeta(code) {
  const m = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i.exec(code);
  const meta = {
    hasHeader: !!m, name: '', namespace: '', version: '', description: '', author: '', homepage: '', icon: '',
    matches: [], includes: [], excludes: [], excludeMatches: [], grants: [], requires: [], resources: [], connects: [],
    runAt: 'document-idle', noframes: false, injectInto: 'auto', updateURL: '', downloadURL: '',
  };
  if (!m) return meta;
  const grants = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    const x = /^\s*\/\/\s*@([A-Za-z][\w-]*)(?::[A-Za-z-]+)?(?:[ \t]+(.*?))?\s*$/.exec(line);
    if (!x) continue;
    const localized = /^\s*\/\/\s*@[A-Za-z][\w-]*:[A-Za-z-]+/.test(line);
    const key = x[1].toLowerCase(), val = (x[2] || '').trim();
    switch (key) {
      case 'name': if (!localized && !meta.name) meta.name = val; break;
      case 'description': if (!localized && !meta.description) meta.description = val; break;
      case 'namespace': meta.namespace = val; break;
      case 'version': meta.version = val; break;
      case 'author': meta.author = val; break;
      case 'homepage': case 'homepageurl': meta.homepage = val; break;
      case 'icon': meta.icon = val; break;
      case 'match': if (val) meta.matches.push(val); break;
      case 'include': if (val) meta.includes.push(val); break;
      case 'exclude': if (val) meta.excludes.push(val); break;
      case 'exclude-match': if (val) meta.excludeMatches.push(val); break;
      case 'grant': if (val) grants.add(GRANT_ALIASES[val] || val); break;
      case 'require': if (val) meta.requires.push(val); break;
      case 'resource': { const r = /^(\S+)\s+(\S+)$/.exec(val); if (r) meta.resources.push({ name: r[1], url: r[2] }); break; }
      case 'connect': if (val) meta.connects.push(val.toLowerCase()); break;
      case 'run-at': meta.runAt = val.toLowerCase(); break;
      case 'noframes': meta.noframes = true; break;
      case 'inject-into': meta.injectInto = val.toLowerCase(); break;
      case 'updateurl': meta.updateURL = val; break;
      case 'downloadurl': meta.downloadURL = val; break;
      default: break;
    }
  }
  meta.noneGrant = grants.has('none') || grants.size === 0;
  grants.delete('none');
  meta.grants = [...grants];
  return meta;
}

export const chromeRunAt = (meta) => RUN_AT[meta.runAt] || 'document_idle';

/* ------------------------------------------------------------------ patterns */
const VALID_PATTERN = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;

export function matchPatternToRegex(p) {
  if (p === '<all_urls>') return /^(https?|file|ftp):\/\/.*/i;
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(p);
  if (!m) return null;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : esc(m[1]);
  const host = m[2] === '*' ? '[^/]+' : m[2].startsWith('*.') ? '([^/]+\\.)?' + esc(m[2].slice(2)) : esc(m[2]);
  return new RegExp('^' + scheme + ':\\/\\/' + host + '(:\\d+)?' + m[3].split('*').map(esc).join('.*') + '$', 'i');
}

export function globToRegex(g) {
  return new RegExp('^' + g.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 'i');
}

/** Descriptor list the injected script uses to decide, at runtime, whether to run on the current URL. */
function filterEntry(s) {
  if (/^\/.*\/[gimsuy]*$/.test(s)) { const i = s.lastIndexOf('/'); return { t: 'r', s: s.slice(1, i), f: s.slice(i + 1).replace(/[gy]/g, '') }; }
  if (/^(\*|https?|file|ftp|http\*):\/\/.*\/.*$/.test(s) || s === '<all_urls>') return { t: 'm', s: s.replace(/^http\*/, '*') };
  return { t: 'g', s };
}

/** Chrome-level patterns for registration + a precise runtime filter. */
export function buildTargets(meta) {
  const matches = new Set(), excludeMatches = new Set();
  const includeFilter = [], excludeFilter = [];
  let broad = false;
  const add = (set, p) => { if (VALID_PATTERN.test(p) || p === '<all_urls>') set.add(p); else return false; return true; };

  for (const raw of meta.matches) {
    const p = raw.replace(/^http\*:/, '*:');
    if (!add(matches, p)) broad = true;
    includeFilter.push(filterEntry(p));
  }
  for (const raw of meta.includes) {
    includeFilter.push(filterEntry(raw));
    if (raw === '*') { matches.add('<all_urls>'); continue; }
    const f = filterEntry(raw);
    if (f.t === 'm' && add(matches, f.s)) continue;
    if (f.t === 'g') {
      const g = /^(\*|https?|http\*):\/\/([^/*]*|\*\.[^/*]+)(\/.*)$/.exec(raw);
      if (g && add(matches, (g[1] === 'http*' ? '*' : g[1]) + '://' + g[2] + g[3])) continue;
    }
    matches.add('<all_urls>'); broad = true;
  }
  for (const raw of meta.excludeMatches) { const p = raw.replace(/^http\*:/, '*:'); if (!add(excludeMatches, p)) broad = true; excludeFilter.push(filterEntry(p)); }
  for (const raw of meta.excludes) {
    excludeFilter.push(filterEntry(raw));
    const f = filterEntry(raw);
    if (f.t === 'm') add(excludeMatches, f.s);
  }
  return {
    matches: [...matches], excludeMatches: [...excludeMatches],
    needsFilter: broad || includeFilter.some((e) => e.t !== 'm') || excludeFilter.length > 0,
    includeFilter, excludeFilter,
  };
}

/** Does `url` pass the filter? (Used by tests; the injected code carries its own copy of this logic.) */
export function urlPasses(targets, url) {
  const hit = (e) => (e.t === 'm' ? !!(matchPatternToRegex(e.s) || /$^/).test(url) : e.t === 'g' ? globToRegex(e.s).test(url) : new RegExp(e.s, e.f).test(url));
  if (targets.includeFilter.length && !targets.includeFilter.some(hit)) return false;
  return !targets.excludeFilter.some(hit);
}

/** If pasted code has no header, build one (name + where to run + the grants the code appears to use). */
export function ensureHeader(code, { name, match }) {
  if (/\/\/\s*==UserScript==/i.test(code)) return code;
  const used = new Set();
  for (const g of code.matchAll(/\b(GM_[A-Za-z]+|GM\.[A-Za-z]+)\b/g)) used.add(GRANT_ALIASES[g[1]] || g[1]);
  if (/\bAO\./.test(code)) used.add('AO');
  const lines = ['// ==UserScript==', '// @name        ' + (name || 'Untitled script'), '// @match       ' + (match || '*://*/*')];
  if (used.size) for (const g of used) lines.push('// @grant       ' + g); else lines.push('// @grant       none');
  lines.push('// ==/UserScript==', '');
  return lines.join('\n') + code;
}

/** Snapshot the originating page without putting credentials, queries or fragments in the editor URL. */
export function sourceUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : '';
  } catch (e) { return ''; }
}

export function siteMatch(url, page = false) {
  const source = sourceUrl(url);
  if (!source) return '';
  const u = new URL(source);
  // Target the whole website, including development-server ports.
  return u.protocol + '//' + u.hostname + (page ? u.pathname + '*' : '/*');
}

export function newScript(url) {
  const source = sourceUrl(url);
  const name = 'New script' + (source ? ' - ' + new URL(source).hostname : '');
  return [
    '// ==UserScript==',
    '// @name         ' + name,
    '// @namespace    ALLEN Toolbox Scripts',
    '// @version      1.0.0',
    '// @description  ',
    '// @author       -',
    '// @match        ' + (siteMatch(source) || '*://example.org/*'),
    '// @grant        none',
    '// @run-at       document-idle',
    '// ==/UserScript==',
    '',
    '(function () {',
    "  'use strict';",
    '',
    '  // Your code here.',
    '})();',
    '',
  ].join('\n');
}

/** Edit only the requested metadata key, retaining unrelated and localized header lines. */
export function setMetaValue(code, key, values) {
  const block = /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/i.exec(code);
  if (!block) return code;
  const eol = block[0].includes('\r\n') ? '\r\n' : '\n';
  const lines = block[0].split(/\r?\n/);
  const pattern = new RegExp('^\\s*//\\s*@' + key + '(?:[ \\t]|$)', 'i');
  const first = lines.findIndex((line) => pattern.test(line));
  const kept = lines.filter((line) => !pattern.test(line));
  const entries = values.map((value) => '// @' + key.padEnd(13) + (value ? ' ' + value : ''));
  kept.splice(first < 0 ? kept.length - 1 : first, 0, ...entries);
  return code.slice(0, block.index) + kept.join(eol) + code.slice(block.index + block[0].length);
}

export function scriptOrigins(meta) {
  const wanted = new Set(buildTargets(meta).matches);
  for (const url of [...meta.requires, ...meta.resources.map((r) => r.url)]) {
    try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) wanted.add(u.origin + '/*'); } catch (e) { /* invalid dependency */ }
  }
  const addConnectHost = (host) => {
    if (!/^(?:\*\.)?[a-z\d.-]+$/i.test(host)) return;
    wanted.add('*://' + host + '/*');
    const base = host.replace(/^\*\./, '');
    if (!/^\d+(?:\.\d+){3}$/.test(base)) wanted.add('*://*.' + base + '/*');
  };
  for (const entry of meta.connects) {
    const host = entry.toLowerCase();
    if (host === '*') { wanted.add('<all_urls>'); continue; }
    if (host === 'self') {
      for (const match of buildTargets(meta).matches) {
        const domain = /^(?:https?|\*):\/\/([^/]+)\//i.exec(match)?.[1];
        if (domain && domain !== '*') addConnectHost(domain);
      }
      continue;
    }
    addConnectHost(host);
  }
  return [...wanted];
}
