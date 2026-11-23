(function (CHAN, SID) {
  'use strict';
  /*
   * ALLEN Toolbox — relay. Runs in the extension's own (isolated) world on the same page as a userscript.
   * It forwards the script's requests to the background worker over a chrome.runtime port and hands the
   * answers back. The event names contain a secret that only the extension and that one script know,
   * so other scripts on the page cannot talk to the extension through it.
   */
  let port = null, keep = false, retry = null;
  const toPage = (m) => document.dispatchEvent(new CustomEvent(CHAN + ':res', { detail: JSON.stringify(m) }));

  function connect() {
    port = chrome.runtime.connect({ name: 'gm:' + SID + ':' + CHAN });
    port.onMessage.addListener(toPage);
    port.onDisconnect.addListener(() => {
      port = null;
      toPage({ ev: 'disconnected' });
      // scripts with menu commands must stay reachable even if the background worker was recycled
      if (keep && !retry) retry = setTimeout(() => { retry = null; try { connect(); } catch (e) { /* extension reloaded */ } }, 1000);
    });
  }

  document.addEventListener(CHAN + ':req', (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (err) { return; }
    if (!m || typeof m.op !== 'string') return;
    if (m.op === 'connect') { try { if (!port) connect(); } catch (err) { toPage({ ev: 'disconnected' }); } return; }
    if (m.op === 'menu.reg') keep = true;
    try { if (!port) connect(); port.postMessage(m); }
    catch (err) { try { port = null; connect(); port.postMessage(m); } catch (e2) { toPage({ id: m.id, ok: false, error: 'The extension is not reachable (reload the page)' }); } }
  }, true);
  // Works whether the page runtime loads before or after this document-start relay.
  toPage({ ev: 'ready' });
})
