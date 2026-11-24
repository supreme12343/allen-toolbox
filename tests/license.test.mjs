import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXTENSION_ASSETS } from '../shared/package.js';

test('Shaan license distinguishes original restricted source, third-party licenses and installation consent', async () => {
  const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 Shaan/);
  assert.match(license, /improve, test, or modify an existing software system/);
  assert.match(license, /independently written implementations/);
  assert.match(license, /not copyleft/);
  assert.match(license, /Third-party licenses remain in full force/);
  assert.match(license, /does not authorize software installation/);
  assert.ok(EXTENSION_ASSETS.includes('LICENSE'));
});
