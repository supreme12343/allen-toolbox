import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const runtime = await readFile(new URL('../gm/gm-runtime.js', import.meta.url), 'utf8');
const relay = await readFile(new URL('../gm/gm-relay.js', import.meta.url), 'utf8');
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, emit(message) { for (const fn of [...this.listeners]) fn(message); } });

function environment(mode = 'page', initial = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(e) { for (const fn of [...(this.listeners.get(e.type) || [])]) fn(e); return true; }
  }
  class Event { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } preventDefault() {} }
  const doc = new Target(); doc.readyState = 'complete'; doc.documentElement = {};
  const win = new Target(); win.top = win;
  const ports = [], timers = new Set();
  const context = vm.createContext({
    document: doc, window: win, EventTarget: Target, Event, CustomEvent: Event, console, URL, location: { href: 'https://example.org/page' },
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    chrome: { runtime: { connect() {
      const port = { messages: [], onMessage: event(), onDisconnect: event(), closed: false,
        postMessage(message) { if (this.closed) throw new Error('Port closed'); this.messages.push(JSON.parse(JSON.stringify(message))); },
        disconnect() { this.closed = true; this.onDisconnect.emit(); },
      };
      ports.push(port); return port;
    } } },
  });
  return {
    ports, timers,
    start() {
      const grants = ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_registerMenuCommand', 'GM_xmlhttpRequest'];
      vm.runInContext(`globalThis.api = (${runtime})('channel', {script:{id:'id', name:'Fixture'}}, ${JSON.stringify(grants)}, ${JSON.stringify(initial)}, {}, ${JSON.stringify(mode)});`, context);
      return context.api;
    },
    relay() { vm.runInContext(`(${relay})('channel', 'id');`, context); },
  };
}

test('page-first startup buffers early writes until relay and backend are ready', async () => {
  const env = environment('page', { stale: 1 }), api = env.start();
  api.GM_setValue('early', true);
  const fresh = api.GM.getValue('fresh', 0);
  assert.equal(env.ports.length, 0);
  env.relay();
  const [port] = env.ports;
  assert.equal(port.messages.length, 0, 'Native connect is not backend authorization');
  port.onMessage.emit({ ev: 'hello', values: { fresh: 7, early: false } });
  assert.equal(await fresh, 7);
  assert.equal(api.GM_getValue('early'), true, 'Handshake must not clobber a queued local write');
  assert.equal(api.GM_getValue('stale', 0), 0);
  assert.deepEqual(port.messages, [{ op: 'val.set', args: { key: 'early', value: 'true' } }]);
  assert.equal(env.timers.size, 0);
});

test('relay-first startup and promise value mutations wait for persisted acknowledgements', async () => {
  const env = environment(); env.relay(); const api = env.start(), [port] = env.ports;
  const menu = api.GM_registerMenuCommand('Fixture command', () => {});
  let saved = false;
  const save = api.GM.setValue('counter', 42).then(() => { saved = true; });
  assert.equal(port.messages.length, 0);
  port.onMessage.emit({ ev: 'hello', values: {} });
  await Promise.resolve(); assert.equal(saved, false);
  assert.equal(port.messages.filter((message) => message.op === 'menu.reg').length, 1);
  const write = port.messages.find((message) => message.op === 'val.set');
  assert.ok(write.id);
  port.onMessage.emit({ id: write.id, ok: true, result: true });
  await save; assert.equal(saved, true);
  const deletion = api.GM.deleteValue('counter');
  const remove = port.messages.find((message) => message.op === 'val.delete');
  port.onMessage.emit({ id: remove.id, ok: true, result: true }); await deletion;
  assert.equal(api.GM_getValue('counter', 0), 0);
  api.GM_unregisterMenuCommand(menu);
  assert.equal(port.messages.at(-1).op, 'menu.unreg');
});

test('sandbox ports reject pending calls on disconnect and refresh values on reconnect', async () => {
  const env = environment('content'), api = env.start(), [first] = env.ports;
  const read = api.GM.getValue('counter', 0);
  first.onMessage.emit({ ev: 'hello', values: { counter: 8 } });
  assert.equal(await read, 8);
  const pending = api.GM.setValue('unconfirmed', 99);
  const failed = assert.rejects(pending, /Connection to the extension was lost/);
  first.disconnect(); await failed;
  const refreshed = api.GM.getValue('counter', 0), second = env.ports[1];
  second.onMessage.emit({ ev: 'hello', values: { counter: 9 } });
  assert.equal(await refreshed, 9);
  assert.equal(api.GM_getValue('unconfirmed', 0), 0);
  assert.equal(second.messages.length, 0, 'Do not replay an unconfirmed mutation after disconnection');
});

test('unreachable relays have bounded startup queues and reject waiting promises', async () => {
  const env = environment(), api = env.start();
  const waiting = api.GM.getValue('counter', 0);
  const failed = assert.rejects(waiting, /connection timed out/i);
  for (let i = 0; i < 100; i++) api.GM_setValue('key-' + i, i);
  assert.throws(() => api.GM_setValue('overflow', true), /Too many userscript requests/);
  [...env.timers][0].fn(); await failed;
});

test('backend authorization failures reject streaming GM promises instead of hanging', async () => {
  const env = environment('content'), api = env.start(), [port] = env.ports;
  const request = api.GM.xmlHttpRequest({ url: 'https://example.org/api' });
  // GM XHR promise failures carry the response object, rather than an Error instance.
  const failed = assert.rejects(request, (reply) => reply.error === 'Missing required grant' && reply.status === 0 && reply.readyState === 4);
  port.onMessage.emit({ ev: 'hello', values: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const message = port.messages.find((entry) => entry.op === 'xhr');
  port.onMessage.emit({ id: message.id, ok: false, error: 'Missing required grant' });
  await failed;
});
