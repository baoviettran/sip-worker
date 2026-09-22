// test/browser-matrix/provision.mjs — install one row's build, verify the
// version it reports, print its absolute executable path.
//
//   node test/browser-matrix/provision.mjs <row-id>
//
// Exit 0 means "installed AND the binary reports the row's expectedVersion".
// stdout carries the path and nothing else (a bundled row prints nothing, since
// Playwright resolves its own build). Every diagnostic goes to stderr.
//
// It never falls back to a runner-installed binary: an unavailable vendor
// artifact is a failed release prerequisite, not a reason to test something
// else. All three URL templates were fetched during the 2026-09-21 spike.
//
// The bundled kind is the one kind whose version is NOT probed here. Its pin is
// not left unverified either: the integrity gate asserts the revision AND the
// version against node_modules/playwright-core/browsers.json offline, and
// version.spec.ts asserts the version the launched build reports in-suite.
import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { ROWS } from './rows.mjs';

const execFileAsync = promisify(execFile);

export const URL_TEMPLATES = {
  cft: (pin) => `https://storage.googleapis.com/chrome-for-testing-public/${pin}/linux64/chrome-linux64.zip`,
  'pw-firefox': (pin) =>
    `https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/${pin}/firefox-ubuntu-24.04.zip`,
  'edge-deb': (pin) =>
    `https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/microsoft-edge-stable_${pin}-1_amd64.deb`,
};

/** Where the executable sits inside the extraction root, per the spike. */
export const EXTRACTED_PATHS = {
  cft: 'chrome-linux64/chrome',
  'pw-firefox': 'firefox/firefox',
  'edge-deb': 'opt/microsoft/msedge/msedge',
};

export function artifactUrl(row) {
  const template = URL_TEMPLATES[row.provision.kind];
  if (!template) {
    throw new Error(
      `row ${row.id}: provision kind ${row.provision.kind} has no artifact URL — bundled rows are Playwright's own ` +
        'download and runner rows are provisioned by the macOS workflow',
    );
  }
  return template(row.provision.pin);
}

export function extractedExecutablePath(row, cacheDir) {
  const relative = EXTRACTED_PATHS[row.provision.kind];
  if (!relative) throw new Error(`row ${row.id}: provision kind ${row.provision.kind} has no extracted executable`);
  return join(cacheDir, row.id, relative);
}

/**
 * The version a vendor binary prints. Every one of them prints it as the last
 * token of its first non-empty line ("Google Chrome 152.0.7977.82",
 * "Microsoft Edge 153.0.4234.48", "Mozilla Firefox 151.0"). Anything else is a
 * parse failure, never a guess: a silent 'unknown' would turn a broken probe
 * into an indistinguishable-from-success state.
 */
export function parseVersion(stdout) {
  const line = String(stdout).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const tokens = line.split(/\s+/);
  const candidate = tokens[tokens.length - 1] ?? '';
  if (!/^\d+\.\d+(\.\d+){0,3}$/.test(candidate)) {
    throw new Error(`cannot parse a version from ${JSON.stringify(line)}`);
  }
  return candidate;
}

export async function provisionRow(row, deps) {
  const kind = row.provision.kind;
  if (kind === 'bundled') return { executablePath: null, observed: null };
  if (kind === 'runner') {
    throw new Error(`row ${row.id} is provisioned by the macOS workflow, not by this provisioner`);
  }
  const url = artifactUrl(row);
  const archive = join(deps.cacheDir, basename(new URL(url).pathname));
  const dir = join(deps.cacheDir, row.id);
  mkdirSync(deps.cacheDir, { recursive: true });
  await deps.fetchToFile(url, archive);
  await deps.extract(archive, dir);
  const executablePath = extractedExecutablePath(row, deps.cacheDir);
  const observed = parseVersion(await deps.probeVersion(executablePath));
  if (observed !== row.expectedVersion) {
    // Fail here, with everything in one message, rather than midway through a
    // suite (spec: "a mis-pinned row fails at provision time").
    throw new Error(
      `row ${row.id}: ${executablePath} reports ${observed}, expected ${row.expectedVersion} ` +
        `(pin ${row.provision.pin}, url ${url})`,
    );
  }
  return { executablePath, observed };
}

/** Node-stdlib implementations of the three injected seams. */
export function defaultDeps() {
  return {
    cacheDir: resolve(process.env.MATRIX_CACHE_DIR ?? '.matrix-cache'),
    fetchToFile: (url, dest) =>
      new Promise((res, rej) => {
        https
          .get(url, (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              rej(new Error(`GET ${url} -> HTTP ${response.statusCode}`));
              return;
            }
            pipeline(response, createWriteStream(dest)).then(res, rej);
          })
          .on('error', (error) => rej(new Error(`GET ${url} -> ${error.message}`)));
      }),
    extract: async (archive, destDir) => {
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(destDir, { recursive: true });
      const argv = archive.endsWith('.deb') ? ['-x', archive, destDir] : ['-q', '-o', archive, '-d', destDir];
      const [command, args] = archive.endsWith('.deb') ? ['dpkg-deb', argv] : ['unzip', argv];
      await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024 });
    },
    probeVersion: async (executablePath) => {
      // `--version` exits before any sandbox setup, so an extracted Edge that
      // would need --no-sandbox to LAUNCH still answers here. Version probing
      // and launching are different questions; see the edge rows' first-run note.
      const { stdout } = await execFileAsync(executablePath, ['--version'], { maxBuffer: 1024 * 1024 });
      return stdout;
    },
  };
}

// CLI. Kept out of the exports above so the unit tests never touch the network.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const rowId = process.argv[2];
  const row = ROWS.find((r) => r.id === rowId);
  if (!row) {
    process.stderr.write(`provision: unknown row id ${JSON.stringify(rowId)} (known: ${ROWS.map((r) => r.id).join(', ')})\n`);
    process.exit(1);
  }
  try {
    const { executablePath, observed } = await provisionRow(row, defaultDeps());
    process.stderr.write(
      executablePath ? `provision: ${row.id} ready at ${executablePath} (reports ${observed})\n`
                     : `provision: ${row.id} uses Playwright's own build; nothing to install\n`,
    );
    if (executablePath) process.stdout.write(`${executablePath}\n`);
  } catch (error) {
    process.stderr.write(`provision: ${error.message}\n`);
    process.exit(1);
  }
}
