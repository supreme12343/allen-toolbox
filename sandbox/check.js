// Runs in a sandboxed extension page (the only place MV3 allows eval) purely to syntax-check pasted scripts.
window.addEventListener('message', (e) => {
  const { id, code } = e.data || {};
  if (e.source !== parent || typeof id !== 'string' || typeof code !== 'string') return;
  let error = '';
  try { new Function(code); } catch (err) { error = String(err && err.message || err); }
  e.source.postMessage({ id, error }, '*');
});
