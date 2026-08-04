import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const root = await import('../../dist/index.js');
const messages = await import('../../dist/messages/index.js');
const stream = await import('../../dist/stream/index.js');
const nodeTransport = await import('sip-worker/transport/node');
const browserTransport = await import('sip-worker/transport/browser');
const required = require('../../dist/index.cjs');
const requiredNodeTransport = require('sip-worker/transport/node');
const requiredBrowserTransport = require('sip-worker/transport/browser');

assert.equal(typeof root.SipStreamDecoder, 'function');
assert.equal(typeof root.SipIngress, 'function');
assert.equal(typeof stream.SipStreamDecoder, 'function');
assert.equal(typeof messages.parseMessage, 'function');
assert.equal(typeof required.serializeMessage, 'function');
assert.equal(typeof nodeTransport.NodeUdpTransport, 'function');
assert.equal(typeof nodeTransport.NodeTcpTransport, 'function');
assert.equal(typeof nodeTransport.NodeWebSocketTransport, 'function');
assert.equal(typeof browserTransport.BrowserWebSocketTransport, 'function');
assert.equal(typeof requiredNodeTransport.NodeUdpTransport, 'function');
assert.equal(typeof requiredNodeTransport.NodeTcpTransport, 'function');
assert.equal(typeof requiredNodeTransport.NodeWebSocketTransport, 'function');
assert.equal(typeof requiredBrowserTransport.BrowserWebSocketTransport, 'function');

const consumerSource = [
  "import { NodeTcpTransport, NodeUdpTransport, NodeWebSocketTransport } from 'sip-worker/transport/node';",
  "import type { DatagramSocketLike, NodeWebSocketLike, StreamSocketLike } from 'sip-worker/transport/node';",
  "import { BrowserWebSocketTransport } from 'sip-worker/transport/browser';",
  "import type { BrowserWebSocketLike } from 'sip-worker/transport/browser';",
  '',
  'declare const datagramSocket: DatagramSocketLike;',
  'declare const streamSocket: StreamSocketLike;',
  'declare const nodeWebSocket: NodeWebSocketLike;',
  'declare const browserWebSocket: BrowserWebSocketLike;',
  '',
  'void new NodeUdpTransport(datagramSocket, {',
  '  localPort: 5060,',
  "  remoteHost: 'sip.example.test',",
  '  remotePort: 5060,',
  '});',
  "void new NodeTcpTransport(streamSocket, { host: 'sip.example.test', port: 5060 });",
  'void new NodeWebSocketTransport(nodeWebSocket);',
  "void new BrowserWebSocketTransport('wss://sip.example.test/ws', () => browserWebSocket);",
].join('\n');

const compilerOptions = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noEmit: true,
  skipLibCheck: false,
};

const temporaryRoot = await mkdtemp(join(tmpdir(), 'sip-worker-package-'));
try {
  const packed = await execFileAsync(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: packageRoot },
  );
  const packJson = JSON.parse(packed.stdout);
  const packResults = Array.isArray(packJson) ? packJson : Object.values(packJson);
  assert.equal(packResults.length, 1);
  const tarball = join(temporaryRoot, packResults[0].filename);

  await compileConsumer('esm-consumer', 'module', 'index.mts', tarball);
  await compileConsumer('cjs-consumer', 'commonjs', 'index.cts', tarball);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function compileConsumer(name, type, fixtureName, tarball) {
  const directory = join(temporaryRoot, name);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, type }, null, 2),
    ),
    writeFile(join(directory, fixtureName), consumerSource),
    writeFile(
      join(directory, 'tsconfig.json'),
      JSON.stringify({ compilerOptions, files: [fixtureName] }, null, 2),
    ),
  ]);
  await execFileAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: directory },
  );
  await execFileAsync(
    process.execPath,
    [join(packageRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'],
    { cwd: directory },
  );
}
