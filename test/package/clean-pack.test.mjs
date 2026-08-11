import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
const idGenerator = { branch: () => 'z9hG4bK-pack' };
const transport = {
  egress() {},
  capabilities: { reliable: true, framing: 'message', token: 'WSS' },
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  send: () => Promise.resolve(),
  subscribe: () => () => {},
  isConnected: () => false,
};

/**
 * ESM consumer that resolves every advertised subpath, asserts root/subpath
 * instanceof identity, and exercises the native ping adapter. Runs against an
 * installed tarball so the exports map is exercised end to end.
 */
const CONSUMER = `
import { strict as assert } from 'node:assert';
import {
  AuthManager, Dialog, SipStreamDecoder, TransactionLayer, TypedEventEmitter,
  UserAgent, WorkerMediaController, makeRequest, makeResponse,
} from 'sip-worker';
import { AuthManager as AuthAlt } from 'sip-worker/auth';
import { Dialog as DialogAlt } from 'sip-worker/dialogs';
import { SipStreamDecoder as StreamAlt } from 'sip-worker/stream';
import { TransactionLayer as TxAlt } from 'sip-worker/transactions';
import { TypedEventEmitter as TEEvtAlt } from 'sip-worker/ua';
import { UserAgent as UAAlt } from 'sip-worker/ua';
import { WorkerMediaController as MediaAlt } from 'sip-worker/media';
import { toNativePingSocket } from 'sip-worker/transport/node';

const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
const idGen = { branch: () => 'z9hG4bK-esm' };
const transport = {
  egress() {},
  capabilities: { reliable: true, framing: 'message', token: 'WSS' },
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  send: () => Promise.resolve(),
  subscribe: () => () => {},
  isConnected: () => false,
};

const pairs = [
  [new SipStreamDecoder(), StreamAlt],
  [new TypedEventEmitter(), TEEvtAlt],
  [new AuthManager(idGen), AuthAlt],
  [new WorkerMediaController({ postMessage() {}, subscribe: () => () => {} }), MediaAlt],
  [new UserAgent({ transport, clock, registrarUri: 'sip:x', aor: 'sip:a@x', contact: 'sip:a@x', idGenerator: idGen, authManager: new AuthManager(idGen) }), UAAlt],
  [new TransactionLayer({ transport, clock, timers: { T1: 500, T2: 4000, TF: 32000, T4: 5000, TK: 4000 }, reliable: true, emit() {} }), TxAlt],
];
for (const [instance, ctor] of pairs) {
  assert.ok(instance instanceof ctor, 'root value not instanceof subpath class ' + (ctor?.name ?? '?'));
}
{
  const req = makeRequest('INVITE', 'sip:bob@example.test');
  req.headers.append('From', '<sip:alice@example.test>;tag=a1');
  req.headers.append('Call-ID', 'cid-esm');
  req.headers.append('Max-Forwards', '70');
  const res = makeResponse(200, 'OK');
  res.headers.append('To', '<sip:bob@example.test>;tag=b1');
  res.headers.append('Contact', '<sip:bob@example.test>');
  const d = Dialog.fromUac(req, res, idGen, { token: 'UDP', sentBy: '192.0.2.1:5060' });
  assert.ok(d instanceof DialogAlt, 'Dialog not instanceof ./dialogs');
}
assert.equal(toNativePingSocket(undefined), undefined);
assert.equal(toNativePingSocket({}), undefined);
const native = { ping() {}, on() {}, off() {} };
const sock = toNativePingSocket(native);
assert.ok(sock && typeof sock.ping === 'function' && typeof sock.onPong === 'function');
console.log('esm-instanceof OK');
`;

const temporaryRoot = await mkdtemp(join(tmpdir(), 'sip-worker-clean-pack-'));
try {
  // ---- reset dist so "clean" means "freshly built via the prepack gate" ----
  await rm(join(packageRoot, 'dist'), { recursive: true, force: true });

  // ---- the prepack gate must rebuild dist (publishing precondition) ----
  await execFileAsync('npm', ['run', 'prepack'], { cwd: packageRoot });
  assert.ok((await readdir(join(packageRoot, 'dist'))).length > 0, 'prepack produced no dist');

  // ---- pack ----
  const packed = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: packageRoot },
  );
  const packJson = JSON.parse(packed.stdout);
  const packResults = Array.isArray(packJson) ? packJson : Object.values(packJson);
  assert.equal(packResults.length, 1);
  const tarball = join(temporaryRoot, packResults[0].filename);

  // ---- clean archive: every entry is a dist artifact under package/dist ----
  const entries = (await execFileAsync('tar', ['--list', `--file=${tarball}`]))
    .stdout.split('\n').filter(Boolean);
  const prefix = 'package/';
  const off = entries.filter((e) => !e.startsWith(prefix));
  assert.deepEqual(off, [], `tarball has non-package entries: ${off.join(', ')}`);
  // npm always packs package/package.json, package/README.md, and package/LICENSE;
  // everything else must be a dist/ artifact (proves the `files: ["dist"]` policy).
  const alwaysIncluded = new Set(['', 'dist', 'package.json', 'README.md', 'LICENSE']);
  for (const e of entries) {
    const path = e.slice(prefix.length);
    if (alwaysIncluded.has(path)) continue;
    assert.ok(path.startsWith('dist/'), `non-dist entry in tarball: ${path}`);
  }

  // ---- install into an isolated ESM consumer and run the instanceof/ping checks ----
  const consumerDir = join(temporaryRoot, 'consumer');
  await mkdir(consumerDir, { recursive: true });
  await writeFile(
    join(consumerDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );
  await writeFile(join(consumerDir, 'index.mjs'), CONSUMER);
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    { cwd: consumerDir },
  );
  const r = await execFileAsync(process.execPath, [join(consumerDir, 'index.mjs')], { cwd: consumerDir });
  assert.match(r.stdout, /esm-instanceof OK/, 'installed consumer did not pass');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log('clean-pack OK');