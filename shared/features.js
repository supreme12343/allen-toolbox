// Single source of truth for every switch shown in the popup.
export const FEATURES = [
  { g: 'Interaction', id: 'contextmenu', name: 'Right-click menu',     desc: 'Undo contextmenu blocking',              def: true },
  { g: 'Interaction', id: 'selection',   name: 'Text selection',       desc: 'Force user-select: text',                def: true },
  { g: 'Interaction', id: 'clipboard',   name: 'Copy / cut / paste',   desc: 'Unblock clipboard events',               def: true },
  { g: 'Interaction', id: 'drag',        name: 'Drag & drop',          desc: 'Allow dragstart / drag events',          def: true },

  { g: 'Keys & focus', id: 'keys',   name: 'Keyboard shortcuts',        desc: 'Ctrl+C/A/P/S/F/U, F12, F5',            def: true },
  { g: 'Keys & focus', id: 'zoom',   name: 'Zoom',                      desc: 'Ctrl+scroll, pinch, viewport meta',    def: true },
  { g: 'Keys & focus', id: 'unload', name: 'Skip leave-page prompt',    desc: 'Optional: can hide unsaved-work warnings', def: false },
  { g: 'Keys & focus', id: 'alerts', name: 'Silence alert()/confirm()', desc: 'Dismiss popup spam; confirmations are cancelled', def: false },

  { g: 'Page', id: 'printCss',   name: 'Print stylesheet rescue', desc: 'Force content visible when printing',  def: true },
  { g: 'Page', id: 'unblur',     name: 'Remove blur',             desc: 'Clear blur without changing other color filters', def: true },
  { g: 'Page', id: 'scrollLock', name: 'Unlock page scroll',      desc: 'Clears overflow:hidden on html/body',  def: true },
  { g: 'Page', id: 'watermark',  name: 'Hide watermark overlays', desc: 'Hides faint fixed ALLEN overlays',     def: false },

  { g: 'Documents', id: 'pdfDetect',     name: 'Detect viewer PDFs',    desc: 'Capture /viewer/stream documents',            def: true },
  { g: 'Documents', id: 'pdfPrefetch',   name: 'Read name on capture',  desc: 'Work out the title while the token is fresh', def: true },
  { g: 'Documents', id: 'pdfPreferText', name: 'Prefer printed title',  desc: 'Ignore the PDF /Title metadata',              def: false },
  { g: 'Documents', id: 'viewerArgs',    name: 'Strip #toolbar=0',      desc: 'Remove viewer URL restrictions',              def: true },
  { g: 'Documents', id: 'viewerButtons', name: 'Reveal viewer buttons', desc: 'Unhide download / print in pdf.js',           def: true },

  { g: 'Video & audio', id: 'mediaDetect', name: 'Detect video & audio', desc: 'Find HLS streams and media files', def: true },

  { g: 'Anti-devtools', id: 'consoleClear', name: 'Keep console output',   desc: 'Neutralise console.clear()',    def: true },
  { g: 'Advanced', id: 'viewport',     name: 'Normalize window size', desc: 'Optional: may affect responsive page layouts', def: false },
];

export const SETTINGS = { concurrency: 8, disabledSites: [], enabledSites: [] };

export const DEFAULTS = Object.assign({}, SETTINGS, Object.fromEntries(FEATURES.map((f) => [f.id, f.def])));

export const PAGE_FIX_IDS = FEATURES.filter((f) => !['pdfDetect', 'pdfPrefetch', 'pdfPreferText', 'mediaDetect'].includes(f.id)).map((f) => f.id);

export function siteKey(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; }
}

export function isAllenSite(url) {
  try { return /(^|\.)allenoverseas\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

export function siteFixesEnabled(config, url) {
  const origin = siteKey(url);
  return !!origin && !(Array.isArray(config.disabledSites) && config.disabledSites.includes(origin)) &&
    (isAllenSite(url) || (Array.isArray(config.enabledSites) && config.enabledSites.includes(origin)));
}

export function effectiveConfig(config, url) {
  const result = { ...config };
  if (!siteFixesEnabled(config, url)) for (const id of PAGE_FIX_IDS) result[id] = false;
  return result;
}

export function presetConfig(preset) {
  if (preset === 'balanced') return Object.fromEntries(FEATURES.filter((f) => PAGE_FIX_IDS.includes(f.id)).map((f) => [f.id, f.def]));
  if (preset === 'full' || preset === 'off') return Object.fromEntries(PAGE_FIX_IDS.map((id) => [id, preset === 'full']));
  throw new Error('Unknown page fix preset');
}
