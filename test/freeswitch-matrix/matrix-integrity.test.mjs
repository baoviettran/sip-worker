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

// ── 3. No committed tls/*.key or *.pem ──────────────────────────────────
// TLS certs are minted per-run by materialize.mjs and must never be committed.

const tlsDir = join(__dirname, 'tls');
const hasTls = existsSync(tlsDir);

test('no committed tls/*.key files', () => {
  if (!hasTls) return; // no tls/ directory — clean
  const files = walkDir(tlsDir);
  const keyFiles = files.filter((f) => f.endsWith('.key'));
  assert.strictEqual(keyFiles.length, 0, `found committed .key files: ${keyFiles.join(', ')}`);
});

test('no committed tls/*.pem files', () => {
  if (!hasTls) return; // no tls/ directory — clean
  const files = walkDir(tlsDir);
  const pemFiles = files.filter((f) => f.endsWith('.pem'));
  assert.strictEqual(pemFiles.length, 0, `found committed .pem files: ${pemFiles.join(', ')}`);
});
