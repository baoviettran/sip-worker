// Packed-artifact build for the FreeSWITCH pilot app.
//
// Produces a self-contained dist/ directory under examples/freeswitch-pilot/dist/
// containing:
//   - index.html (production: PILOT_TEST_HOOK stripped; test: relay import injected)
//   - styles.css
//   - main.js (esbuild IIFE bundle resolved against a temp fixture, not the workspace)
//
// Build metadata (__SIP_WORKER_PILOT_BUILD__) is injected at bundle time with
// the browser package version, git commit, and SHA-256 of the browser tarball.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  packWorkspaces,
  makeTempDir,
  cleanup,
  packageRoot,
} from '../package/pack-workspaces.mjs';

const execFileAsync = promisify(execFile);

const pilotDir = join(packageRoot, 'examples', 'freeswitch-pilot');
const srcDir = join(pilotDir, 'src');
const distDir = join(pilotDir, 'dist');

const log = (line) => console.log(`[build-pilot] ${line}`);

export async function buildPilot({ outputDirectory = distDir, testMode = false } = {}) {
  const fixture = await makeTempDir('sip-worker-pilot-');
  const webRoot = join(outputDirectory);
  const entryDir = join(fixture, 'entry');
  const tarballDir = join(fixture, 'tarballs');
  await mkdir(webRoot, { recursive: true });
  await mkdir(entryDir, { recursive: true });
  await mkdir(tarballDir, { recursive: true });

  try {
    log('packing workspaces (prepack build + release gate)');
    const tarballs = await packWorkspaces(tarballDir);
    const coreTarball = tarballs['@sip-worker/core'];
    const browserTarball = tarballs['sip-worker'];
    if (!coreTarball || !browserTarball) {
      throw new Error('packWorkspaces returned no core/browser tarball');
    }

    // Compute SHA-256 of the browser tarball bytes.
    const tarballBytes = await readFile(browserTarball);
    const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex');

    // Read the browser package version.
    const browserPkg = JSON.parse(
      await readFile(join(packageRoot, 'packages', 'browser', 'package.json'), 'utf-8'),
    );
    const packageVersion = browserPkg.version;

    // Get the current git commit SHA.
    const { stdout: gitCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: packageRoot,
    });

    log(`installing packed tarballs into fixture`);
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'sip-worker-pilot-fixture', private: true, type: 'module' }, null, 2),
    );
    await execFileAsync('npm', [
      'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      coreTarball, browserTarball,
    ], { cwd: fixture });

    log('copying pilot assets into fixture');
    await cp(join(pilotDir, 'index.html'), join(entryDir, 'index.html'));
    await cp(join(srcDir, 'styles.css'), join(webRoot, 'styles.css'));
    // Copy all pilot TS source files into the entry directory.
    await cp(srcDir, join(entryDir, 'src'), { recursive: true });

    log('esbuild-bundling entry against the fixture node_modules');
    await build({
      entryPoints: [join(entryDir, 'src', 'main.ts')],
      outfile: join(webRoot, 'main.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['es2020'],
      sourcemap: false,
      logLevel: 'warning',
      define: {
        __SIP_WORKER_PILOT_BUILD__: JSON.stringify({
          packageVersion,
          gitCommit: gitCommit.trim(),
          tarballSha256,
        }),
      },
    });

    // --- HTML processing ---
    let html = await readFile(join(entryDir, 'index.html'), 'utf-8');

    // Rewrite stylesheet path: src/styles.css -> styles.css (now at same level).
    html = html.replace('href="src/styles.css"', 'href="styles.css"');

    if (testMode) {
      // Test mode: replace PILOT_TEST_HOOK with conditional relay import.
      html = html.replace(
        '<!-- PILOT_TEST_HOOK -->',
        '<script type="module">\n' +
          '  if (new URLSearchParams(location.search).get("relay") === "1") {\n' +
          '    await import("/relay.js");\n' +
          '  }\n' +
          '</script>',
      );
      // Copy relay and synthetic-peer assets into webRoot.
      await cp(
        join(packageRoot, 'test', 'example', 'relay.js'),
        join(webRoot, 'relay.js'),
      );
      await cp(
        join(packageRoot, 'test', 'browser-media', 'synthetic-peer.ts'),
        join(webRoot, 'synthetic-peer.js'),
      );
    } else {
      // Production mode: strip PILOT_TEST_HOOK entirely.
      html = html.replace('  <!-- PILOT_TEST_HOOK -->\n', '');
    }

    await writeFile(join(webRoot, 'index.html'), html);

    log(`build complete -> ${webRoot}`);
    return { outputDirectory: webRoot, metadata: { packageVersion, gitCommit: gitCommit.trim(), tarballSha256 } };
  } finally {
    log(`cleaning fixture ${fixture}`);
    await cleanup(fixture);
  }
}

// Run only when invoked directly.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const testMode = process.argv.includes('--test');
  buildPilot({ testMode }).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
