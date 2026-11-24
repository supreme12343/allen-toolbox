import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signUpdate, verifyUpdate } from '../tools/update-signing.mjs';

function key() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = pair.publicKey.export({ format: 'jwk' });
  return { privatePem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), verification: { algorithm: 'RSA-SHA256',
    modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: Buffer.from(jwk.e, 'base64url').toString('base64') } };
}
test('updater signatures authenticate exact ZIP bytes and stay deterministic across rebuilds', () => {
  const pair = key(), bytes = Buffer.from('release bytes'), signature = signUpdate(bytes, pair.privatePem, pair.verification);
  assert.equal(verifyUpdate(bytes, signature, pair.verification), true);
  assert.deepEqual(signUpdate(bytes, pair.privatePem, pair.verification), signature);
  assert.equal(verifyUpdate(Buffer.from('tampered'), signature, pair.verification), false);
});
test('a different signing key cannot silently replace the pinned verification identity', () => {
  const first = key(), other = key();
  assert.throws(() => signUpdate(Buffer.from('zip'), other.privatePem, first.verification), /does not match/);
});
