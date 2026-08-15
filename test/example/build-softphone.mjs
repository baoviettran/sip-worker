// Task 15 GREEN pipeline: build the packed reference softphone and serve it.
//
// The example must exercise ONLY the packed public `sip-worker` artifact:
//
//   1. pack every workspace with the shared helper (`packWorkspaces`), which
//      runs each `prepack` (build + release gate) and produces fresh tarballs;
//   2. install the exact `@sip-worker/core` + `sip-worker` tarballs into a
//      throwaway temp fixture (never the workspace source);
//   3. copy the example's `index.html`/`styles.css` and the entry TS into the
//      fixture, then esbuild-bundle `src/main.ts` against the FIXTURE's
//      node_modules (the entry lives in /tmp, so resolution cannot fall back to
//      the repo's workspace source);
//   4. serve ONLY the built artifact plus the fake SIP server's WS/control
//      endpoints and the test-hook relay assets.
//
// The server 503s when an artifact is absent, so a broken build fails the gate
// loudly instead of serving a stale bundle.

import http from 'node:http';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import {
  packWorkspaces,
  makeTempDir,
  cleanup,
  packageRoot,
} from '../package/pack-workspaces.mjs';
import { SipFakeServer } from './fake-sip-server.mjs';

const execFileAsync = promisify(execFile);

const here = fileURLToPath(new URL('.', import.meta.url)); // test/example/
const exampleDir = join(packageRoot, 'examples', 'browser-softphone');
const HOST = '127.0.0.1';
const PORT = 4200;

const log = (line) => console.log(`[build-softphone] ${line}`);

async function main() {
  const fixture = await makeTempDir('sip-worker-example-');
  const webRoot = join(fixture, 'web');
  const entryDir = join(fixture, 'entry');
  const tarballDir = join(fixture, 'tarballs');
  await mkdir(webRoot, { recursive: true });
  await mkdir(entryDir, { recursive: true });
  // `npm pack --pack-destination` writes into an existing directory; create it
  // before packing so the tarballs land exactly where packWorkspaces points.
  await mkdir(tarballDir, { recursive: true });

  const shutdown = () => {
    log(`removing fixture ${fixture}`);
    cleanup(fixture).finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    log('packing workspaces (prepack build + release gate)');
    const tarballs = await packWorkspaces(tarballDir);
    const coreTarball = tarballs['@sip-worker/core'];
    const browserTarball = tarballs['sip-worker'];
    if (!coreTarball || !browserTarball) {
      throw new Error('packWorkspaces returned no core/browser tarball');
    }

    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'sip-worker-example-fixture', private: true, type: 'module' }, null, 2),
    );

    log('installing packed tarballs into fixture');
    await execFileAsync('npm', [
      'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      coreTarball, browserTarball,
    ], { cwd: fixture });

    log('copying example assets into fixture');
    await cp(join(exampleDir, 'index.html'), join(webRoot, 'index.html'));
    await cp(join(exampleDir, 'src', 'styles.css'), join(webRoot, 'styles.css'));
    await cp(join(exampleDir, 'src', 'main.ts'), join(entryDir, 'main.ts'));
    // The synthetic peer is plain-JS (JSDoc types), served directly as ESM.
    await cp(join(packageRoot, 'test', 'browser-media', 'synthetic-peer.ts'), join(webRoot, 'synthetic-peer.js'));
    await cp(join(here, 'relay.js'), join(webRoot, 'relay.js'));

    log('esbuild-bundling entry against the fixture node_modules');
    await build({
      entryPoints: [join(entryDir, 'main.ts')],
      outfile: join(webRoot, 'main.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['es2020'],
      sourcemap: false,
      logLevel: 'warning',
    });

    const fakeServer = new SipFakeServer();
    const server = createServer(webRoot, fakeServer);
    server.on('upgrade', (req, socket, head) => fakeServer.handleUpgrade(req, socket, head));

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, resolve);
    });

    log(`packed softphone serving on http://${HOST}:${PORT}/ (fixture ${fixture})`);
  } catch (err) {
    log(`build failed: ${err && err.stack ? err.stack : err}`);
    await cleanup(fixture);
    process.exit(1);
  }
}

/** HTTP server: fake-SIP control plane + static serving of the built artifact. */
function createServer(webRoot, fakeServer) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    if (path.startsWith('/control/')) {
      fakeServer.handleControl(req, res).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"control handler failed"}');
      });
      return;
    }

    const safe = path === '/' ? '/index.html' : path;
    const file = join(webRoot, safe);
    if (!file.startsWith(webRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    readFile(file)
      .then((data) => {
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Length': data.length,
        });
        res.end(data);
      })
      .catch(() => {
        if (path === '/index.html' || path === '/main.js' || path === '/synthetic-peer.js') {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('packed artifact not built');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      });
  });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
