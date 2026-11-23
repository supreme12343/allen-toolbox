import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

function node(tag, text = '', className = '') {
  return { tag, textContent: text, className, children: [], style: {}, attributes: {}, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
    get childElementCount() { return this.children.length; } };
}
const descendants = (item) => [item, ...item.children.flatMap(descendants)];

for (const filename of ['popup.js', 'editor.js']) {
  const source = await readFile(new URL('../popup/' + filename, import.meta.url), 'utf8');
  const adapter = /async function bg\(type[^\n]*\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(adapter, 'The editor and popup keep a local RPC adapter');
  const make = (response) => runInNewContext(adapter + '\nbg', { chrome: { runtime: { sendMessage: async () => response } }, tabId: 7, Error });
  test(filename + ': committed script warnings preserve the record ID and enabled state', async () => {
    const record = { id: 'saved-local-id', enabled: true, updatedAt: 123, error: 'Enable Allow User Scripts before running this saved script.' };
    assert.equal((await make(record)('us:save')).id, record.id);
    assert.equal((await make(record)('us:toggle')).enabled, true);
  });
  test(filename + ': storage/transport errors and missing responses still fail explicitly', async () => {
    await assert.rejects(make({ error: 'Storage failed' })('us:save'), /Storage failed/);
    await assert.rejects(make({ error: 'Unable to fetch PDF', code: 'PDF_NETWORK' })('pdf-save'), /Unable to fetch PDF/);
    await assert.rejects(make(undefined)('state'), /respond/);
  });
  test(filename + ': folder Delete is disabled and explained, while manual Delete and Edit/toggle remain available', async () => {
    const popup = filename === 'popup.js';
    const renderer = (popup ? /function scriptCard\(s\) \{[\s\S]*?\n\}/ : /async function refreshScripts\(\) \{[\s\S]*?\n\}/).exec(source)?.[0];
    assert.ok(renderer);
    for (const bundleId of ['folder-one', '']) {
      const record = { id: 'local-id', bundleId, name: 'Script', matches: ['https://example.org/*'], enabled: false,
        noneGrant: true, grants: [], hasMatch: true, access: true };
      const calls = [], controls = Object.fromEntries(['#us-banner', '#scripts-empty', '#script-list', '#draft-list'].map((id) => [id, node('div')]));
      const card = await runInNewContext(renderer + '\n' + (popup ? 'scriptCard(record)' : 'refreshScripts().then(() => controls["#script-list"].children[0])'), {
        record, controls, available: false, scriptId: null, $: (id) => controls[id],
        el: (tag, cls, text) => node(tag, text, cls), element: node, tag: (text) => node('span', text),
        bg: async (type) => { calls.push(type); return type === 'us:list' ? { available: true, scripts: [record], bundles: { errors: [] } } : { ok: true }; },
        chrome: { storage: { local: { get: async () => ({}) } } },
        confirm: () => true, setTimeout: () => 0, status() {}, openEditor() {}, navigate: async () => {}, renderScripts: async () => {},
      });
      const elements = descendants(card), remove = elements.find((item) => item.tag === 'button' && item.textContent === 'Delete');
      assert.ok(remove);
      assert.equal(remove.disabled, !!bundleId);
      if (bundleId) {
        assert.match(remove.title, /Disable the script instead/);
        assert.ok(elements.some((item) => /folder script.*protected/i.test(item.textContent)));
      }
      await remove.onclick();
      if (popup) await remove.onclick();
      assert.equal(calls.filter((type) => type === 'us:delete').length, bundleId ? 0 : 1);
      const edit = elements.find((item) => item.tag === 'button' && item.textContent === 'Edit');
      const toggle = elements.find((item) => popup ? item.attributes.role === 'switch' : item.tag === 'input');
      assert.equal(edit.disabled, false);
      assert.equal(typeof edit.onclick, 'function');
      assert.equal(toggle.disabled, false);
    }
  });
}
