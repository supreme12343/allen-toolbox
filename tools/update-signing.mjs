import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function publicUpdateKey(value) {
  if (value?.algorithm !== 'RSA-SHA256' || typeof value.modulus !== 'string' || typeof value.exponent !== 'string' ||
      !/^[a-z\d+/]+={0,2}$/i.test(value.modulus) || !/^[a-z\d+/]+={0,2}$/i.test(value.exponent)) throw new Error('Invalid updater verification key');
  const modulus = Buffer.from(value.modulus, 'base64'), exponent = Buffer.from(value.exponent, 'base64');
  if (modulus.length < 256 || modulus.length > 512 || exponent.length < 1 || exponent.length > 8) throw new Error('Invalid updater verification key size');
  return createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: modulus.toString('base64url'), e: exponent.toString('base64url') } });
}

export function signUpdate(bytes, privatePem, verification) {
  const key = createPrivateKey(privatePem), expected = publicUpdateKey(verification);
  if (key.asymmetricKeyType !== 'rsa' || !createPublicKey(key).export({ format: 'der', type: 'spki' }).equals(expected.export({ format: 'der', type: 'spki' }))) throw new Error('Signing key does not match the pinned updater verification key');
  return sign('sha256', bytes, key);
}

export function verifyUpdate(bytes, signature, verification) {
  return verify('sha256', bytes, publicUpdateKey(verification), signature);
}

async function initialize() {
  const gh = process.argv.find((arg) => arg.startsWith('--gh='))?.slice(5) || 'gh';
  const output = fileURLToPath(new URL('../updater/public-key.json', import.meta.url));
  try { await access(output); throw new Error('A pinned verification key already exists; it must not be silently replaced'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = publicKey.export({ format: 'jwk' });
  const verification = { algorithm: 'RSA-SHA256', modulus: Buffer.from(jwk.n, 'base64url').toString('base64'), exponent: Buffer.from(jwk.e, 'base64url').toString('base64') };
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  await new Promise((done, reject) => {
    const child = spawn(gh, ['secret', 'set', 'UPDATER_SIGNING_KEY', '--repo', 'supreme12343/allen-toolbox'], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? done() : reject(new Error('GitHub signing-secret setup failed')));
    child.stdin.end(pem);
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(verification, null, 2) + '\n');
  console.log('Pinned public verification key saved. The private key was sent only to the GitHub Actions secret.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--initialize')) { console.error('Use --initialize once to set up signed updater releases.'); process.exitCode = 1; }
  else initialize().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
