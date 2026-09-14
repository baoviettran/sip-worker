// Packed-artifact build for every PBX matrix page harness.
//
// Produces dist/matrix.js under process.cwd() — the tree being built (the
// Playwright webServer runs this script with its `cwd` set to that tree). A
// self-contained IIFE bundle of the tree's page.ts resolved against a TEMP
// FIXTURE's node_modules, not the workspace: the fixture installs the PACKED
// @sip-worker/core + sip-worker tarballs (pack-workspaces.mjs), so the harness
// page can never silently consume packages/**/src. `index.html` is committed
// next to this script and served by server.mjs; the built bundle is the only
// artifact in dist/ (gitignored, like every other gate's dist).
//
// Build metadata (__MATRIX_BUILD__) is injected at bundle time with the
// browser package version, git commit, and SHA-256 of the browser tarball —
// the build-pilot.mjs pattern.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

// The tree to bundle and write into: the Playwright webServer sets `cwd` to it.
const matrixDir = process.cwd();
const distDir = join(matrixDir, 'dist');

const log = (line) => console.log(`[build-matrix] ${line}`);

export async function buildMatrix() {
  const fixture = await makeTempDir('sip-worker-matrix-');
  const entryRoot = join(fixture, 'entry');
  const tarballDir = join(fixture, 'tarballs');
  await mkdir(distDir, { recursive: true });
  await mkdir(entryRoot, { recursive: true });
  await mkdir(tarballDir, { recursive: true });

  try {
    log('packing workspaces (prepack build + release gate)');
    const tarballs = await packWorkspaces(tarballDir);
    const coreTarball = tarballs['@sip-worker/core'];
    const browserTarball = tarballs['sip-worker'];
    if (!coreTarball || !browserTarball) {
      throw new Error('packWorkspaces returned no core/browser tarball');
    }

    // SHA-256 of the browser tarball bytes (build metadata evidence).
    const tarballBytes = await readFile(browserTarball);
    const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex');

    const browserPkg = JSON.parse(
      await readFile(join(packageRoot, 'packages', 'browser', 'package.json'), 'utf-8'),
    );
    const packageVersion = browserPkg.version;

    const { stdout: gitCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: packageRoot,
    });

    log('installing packed tarballs into the temp fixture');
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'sip-worker-matrix-fixture', private: true, type: 'module' }, null, 2),
    );
    await execFileAsync('npm', [
      'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
      coreTarball, browserTarball,
    ], { cwd: fixture });

    // Copy the tree's harness sources AND the shared ones, preserving the
    // relative layout: the entry imports '../matrix-shared/…', so the fixture
    // must mirror the test/ tree (only .ts harness sources travel — specs are
    // never bundled).
    log('copying the page tree into the fixture');
    const isHarnessSource = (f) =>
      f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts');
    for (const [from, to] of [
      [matrixDir, join(entryRoot, basename(matrixDir))],
      [join(matrixDir, '..', 'matrix-shared'), join(entryRoot, 'matrix-shared')],
    ]) {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from)) {
        if (entry === 'dist' || entry === 'node_modules') continue;
        if (isHarnessSource(entry)) await cp(join(from, entry), join(to, entry));
      }
    }

    log('esbuild-bundling page.ts against the fixture node_modules');
    await build({
      entryPoints: [join(entryRoot, basename(matrixDir), 'page.ts')],
      outfile: join(distDir, 'matrix.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['es2020'],
      sourcemap: false,
      logLevel: 'warning',
      define: {
        __MATRIX_BUILD__: JSON.stringify({
          packageVersion,
          gitCommit: gitCommit.trim(),
          tarballSha256,
        }),
      },
    });

    log(`build complete -> ${join(distDir, 'matrix.js')}`);
    return {
      outputDirectory: distDir,
      metadata: { packageVersion, gitCommit: gitCommit.trim(), tarballSha256 },
    };
  } finally {
    log(`cleaning fixture ${fixture}`);
    await cleanup(fixture);
  }
}

// Run only when invoked directly.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildMatrix()
    .then((m) => console.log(`[build-matrix] tarball sha256 ${m.metadata.tarballSha256}`))
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
}
