import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, FEATURES, PAGE_FIX_IDS, siteKey, siteFixesEnabled, effectiveConfig, presetConfig } from '../shared/features.js';

test('page fix defaults preserve leave-page warnings and real window dimensions', () => {
  assert.equal(DEFAULTS.unload, false); assert.equal(DEFAULTS.alerts, false); assert.equal(DEFAULTS.viewport, false);
  assert.equal(new Set(FEATURES.map((feature) => feature.id)).size, FEATURES.length);
});
test('site pause is scoped by origin and leaves detection available', () => {
  const config = { ...DEFAULTS, disabledSites: ['https://learn.allenoverseas.com'] };
  const result = effectiveConfig(config, 'https://learn.allenoverseas.com/lecture');
  assert.equal(siteFixesEnabled(config, 'https://learn.allenoverseas.com/lecture'), false);
  for (const id of PAGE_FIX_IDS) assert.equal(result[id], false);
  assert.equal(result.pdfDetect, true); assert.equal(result.mediaDetect, true);
  assert.equal(result.pdfPrefetch, true); assert.equal(config.contextmenu, true);
  assert.equal(siteFixesEnabled(config, 'https://other.allenoverseas.com/lecture'), true);
});
test('other websites require explicit opt-in and internal pages never opt in', () => {
  assert.equal(siteFixesEnabled(DEFAULTS, 'https://example.org/'), false);
  assert.equal(siteFixesEnabled({ ...DEFAULTS, enabledSites: ['https://example.org'] }, 'https://example.org/path'), true);
  assert.equal(siteFixesEnabled(DEFAULTS, 'https://allenoverseas.com.attacker.org/'), false);
  assert.equal(siteKey('chrome://extensions'), ''); assert.equal(siteKey('file:///local.pdf'), '');
});
test('presets change page fixes, not download or document detection preferences', () => {
  for (const preset of ['balanced', 'full', 'off']) {
    const patch = presetConfig(preset);
    assert.equal(Object.hasOwn(patch, 'pdfDetect'), false); assert.equal(Object.hasOwn(patch, 'mediaDetect'), false);
    assert.equal(Object.hasOwn(patch, 'concurrency'), false);
  }
  assert.equal(presetConfig('balanced').unload, false);
  assert.equal(Object.values(presetConfig('full')).every(Boolean), true);
  assert.equal(Object.values(presetConfig('off')).some(Boolean), false);
  assert.throws(() => presetConfig('unknown'), /Unknown/);
});
