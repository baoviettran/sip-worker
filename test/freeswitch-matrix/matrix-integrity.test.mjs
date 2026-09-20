// test/freeswitch-matrix/matrix-integrity.test.mjs
// Integrity gate for the FreeSWITCH call-matrix harness. Mirrors the WS2
// corpus-integrity gate shape (test/sipp/corpus-integrity.test.mjs).
//
// Asserts:
//  1. MATRIX_STEPS — every mapped spec file exists on disk.
//  2. The committed fs-conf tree contains no __*__ port tokens (tokens must
//     live only in fs-conf.overlay and are rendered at materialize time).
//  3. No committed tls/*.key or *.pem (TLS certs are minted per-run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchOnlyKeysUnderContextOptions } from '../matrix-shared/playwright-config-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * MATRIX_STEPS — the ten logical steps of the call-matrix harness mapped to
 * their spec files.  Steps are 1-indexed; the value is the spec filename
 * (relative to this directory).  Multiple steps may share a spec file.
 */
const MATRIX_STEPS = {
  1:  'register.spec.ts',
  2:  'register.spec.ts',
  3:  'register.spec.ts',
  4:  'audio.spec.ts',
  5:  'call-inbound.spec.ts',
  6:  'controls.spec.ts',
  7:  'controls.spec.ts',
  8:  'dtmf.spec.ts',
  9:  'call-inbound.spec.ts',
  10: 'recovery.spec.ts',
};

/** Unique spec files referenced by the manifest. */
const UNIQUE_SPECS = [...new Set(Object.values(MATRIX_STEPS))];

// ── 1. Every mapped spec file exists on disk ────────────────────────────

test('every MATRIX_STEPS spec file exists on disk', () => {
  assert.strictEqual(Object.keys(MATRIX_STEPS).length, 10, 'manifest has exactly ten steps');
  for (const [step, file] of Object.entries(MATRIX_STEPS)) {
    assert.ok(existsSync(join(__dirname, file)), `step ${step}: missing ${file}`);
  }
});

test('manifest maps to exactly six unique spec files', () => {
  assert.strictEqual(UNIQUE_SPECS.length, 6, `expected 6 unique specs, got ${UNIQUE_SPECS.length}: ${UNIQUE_SPECS.join(', ')}`);
});

// ── 2. Committed fs-conf tree: no __*__ port tokens ────────────────────
// Port tokens like __SIP_PORT__ are render-time placeholders that exist in
// the overlay (fs-conf.overlay/).  The committed fs-conf/ tree is the
// rendered source-of-truth: the base vanilla config files (vars.xml, etc.)
// must not leak unreplaced tokens.  Files originating from the overlay
// (sip_profiles/ws-test.xml) intentionally carry tokens and are excluded.

function walkDir(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const overlayDir = join(__dirname, 'fs-conf.overlay');
const overlayRelPaths = existsSync(overlayDir)
  ? new Set(walkDir(overlayDir).map((f) => f.slice(overlayDir.length)))
  : new Set();

function isOverlayFile(filePath) {
  // Files that originated from fs-conf.overlay/ intentionally carry port
  // tokens and are rendered by materialize.mjs at runtime.
  const relPath = filePath.slice(fsConfDir.length);
  return overlayRelPaths.has(relPath);
}

const fsConfDir = join(__dirname, 'fs-conf');
const fsConfFiles = existsSync(fsConfDir) ? walkDir(fsConfDir) : [];

test('fs-conf tree is present (floor check)', () => {
  assert.ok(fsConfFiles.length >= 30, `fs-conf has ${fsConfFiles.length} files, expected >= 30 — tree may be missing or pruned`);
});

test('fs-conf base tree has no __*__ port tokens (overlay files excluded)', () => {
  // Match port-style tokens: __SIP_PORT__, __WS_PORT__, __WSS_PORT__, etc.
  // Requires uppercase letters between the double-underscores, excluding
  // decorative separators like _____________ in vars.xml.
  const tokenRe = /__[A-Z][A-Z_]*[A-Z]__/;
  for (const filePath of fsConfFiles) {
    if (isOverlayFile(filePath)) continue; // overlay template — tokens expected
    const content = readFileSync(filePath, 'utf8');
    const match = content.match(tokenRe);
    assert.ok(
      !match,
      `port token ${match?.[0]} found in ${filePath.replace(join(__dirname, '..') + '/', '')}`,
    );
  }
});

// ── 3. No committed key material ───────────────────────────────────────
// TLS certs are minted per-run by materialize.mjs into per-run tmpdirs
// (not a committed tls/ directory).  Scan the whole matrix tree for .key
// and .pem files — must be zero.

const allMatrixFiles = walkDir(__dirname);

test('no .key files anywhere in the committed matrix tree', () => {
  const keyFiles = allMatrixFiles.filter((f) => f.endsWith('.key'));
  assert.strictEqual(keyFiles.length, 0, `found committed .key files: ${keyFiles.join(', ')}`);
});

test('no .pem files anywhere in the committed matrix tree', () => {
  const pemFiles = allMatrixFiles.filter((f) => f.endsWith('.pem'));
  assert.strictEqual(pemFiles.length, 0, `found committed .pem files: ${pemFiles.join(', ')}`);
});

test('matrix tree is fully enumerated (floor check)', () => {
  assert.ok(allMatrixFiles.length >= 50, `matrix dir has ${allMatrixFiles.length} files, expected >= 50 — scan may be incomplete`);
});

// ── 4. Playwright launch-only options stay out of contextOptions ────────
// `firefoxUserPrefs` under `contextOptions` is accepted and silently ignored,
// making every pref inert and every Firefox leg of the matrix fail while every
// Chromium leg passes. It shipped in this config once already (279c90e) and the
// PR job registers Chromium only, so nothing else here catches it. Runs in the
// PR job via `npm run test:matrix:integrity`.

test('playwright.config.ts keeps launch-only options out of contextOptions', () => {
  const configPath = join(__dirname, 'playwright.config.ts');
  const found = launchOnlyKeysUnderContextOptions(readFileSync(configPath, 'utf8'));
  assert.deepStrictEqual(
    found,
    [],
    `launch-only option(s) under contextOptions in playwright.config.ts — inert there: ${found
      .map((f) => `${f.key} (line ${f.line})`)
      .join(', ')}`,
  );
});

// ── 5. fs-conf.overlay is the source of truth for every path it carries ──
// materialize.mjs rebuilds fs-conf/ from the pinned image and then copies the
// overlay over it (step 6), so any edit made ONLY to fs-conf/ is silently
// reverted by the documented image-bump procedure (README, "FS-image bump"):
// the PR job registers Chromium only, so a Chromium-passing regression would
// resurface in the nightly weeks later inside a commit that reads as an
// unrelated image bump. An overlay file that is absent from fs-conf/ is a
// different failure — the overlay's own paths must exist in the output too.
// This is the parity rule the port-token check above cannot see, because a
// stale fs-conf/ copy has no tokens to flag.
test('every fs-conf.overlay path is byte-identical in fs-conf', () => {
  for (const relPath of overlayRelPaths) {
    const generated = join(fsConfDir, relPath);
    if (!existsSync(generated)) {
      assert.fail(
        `fs-conf.overlay${relPath} has no counterpart in fs-conf — run ` +
          '`node test/freeswitch-matrix/materialize.mjs`',
      );
    }
    assert.strictEqual(
      readFileSync(generated, 'utf8'),
      readFileSync(join(overlayDir, relPath), 'utf8'),
      `fs-conf${relPath} differs from its fs-conf.overlay source. Edits must be ` +
        'made in fs-conf.overlay/ (or mirrored there), or materialize.mjs will ' +
        'revert them on the next image bump.',
    );
  }
});
