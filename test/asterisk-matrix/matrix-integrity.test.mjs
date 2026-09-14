// test/asterisk-matrix/matrix-integrity.test.mjs
// Integrity gate for the Asterisk call-matrix harness. Mirrors the FreeSWITCH
// gate (test/freeswitch-matrix/matrix-integrity.test.mjs) with one rule
// inverted and one added — see below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test('every MATRIX_STEPS spec file exists on disk', () => {
  assert.strictEqual(Object.keys(MATRIX_STEPS).length, 10, 'manifest has exactly ten steps');
  for (const [step, file] of Object.entries(MATRIX_STEPS)) {
    assert.ok(existsSync(join(__dirname, file)), `step ${step}: missing ${file}`);
  }
});

test('manifest maps to exactly six unique spec files', () => {
  const unique = [...new Set(Object.values(MATRIX_STEPS))];
  assert.strictEqual(unique.length, 6, `expected 6 unique specs, got ${unique.length}: ${unique.join(', ')}`);
});

function walkDir(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

const TOKEN_RE = /__[A-Z][A-Z_]*[A-Z]__/;

// ── The token rule, INVERTED from the FreeSWITCH gate ──────────────────
// FreeSWITCH's gate asserts its committed conf has NO tokens, because
// materialize.mjs renders an overlay. Here the committed ast-conf tree IS the
// template, so every PORT must be a token: a hardcoded port would survive
// review and then collide with the FreeSWITCH matrix on a shared machine.
//
// Scoped by name, and the scope is load-bearing. Only three of the seven
// committed conf files carry a port at all — pjsip.conf (WSS transport),
// http.conf (HTTP + WSS), manager.conf (AMI). The other four carry none:
// extensions.conf is a dialplan, logger.conf and modules.conf configure no
// listener, and rtp.conf pins `rtpstart=20102`/`rtpend=20202` as deliberate
// LITERALS, because that range's whole purpose is to differ from FreeSWITCH's
// and it is fixed for every run (Global Constraints). A rule demanding a token
// in every file would therefore fail on the tree Task 2 already shipped and
// Task 3's boot gate already exercises — and "fixing" that by tokenising the
// RTP range would break the very collision it exists to prevent. If a later
// task gives extensions.conf a port, add it here rather than widening the walk.
const TOKEN_FILES = ['pjsip.conf', 'http.conf', 'manager.conf'];

test('every port-bearing ast-conf file uses tokens, not literals', () => {
  for (const name of TOKEN_FILES) {
    const file = join(__dirname, 'ast-conf', name);
    assert.ok(existsSync(file), `ast-conf/${name} is missing — the committed tree is incomplete`);
    assert.ok(TOKEN_RE.test(readFileSync(file, 'utf8')), `ast-conf/${name} carries no port token`);
  }
});

test('ast-conf binds nothing outside loopback', () => {
  for (const file of walkDir(join(__dirname, 'ast-conf'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(bindaddr|tlsbindaddr|bind)\s*=\s*(.+)$/gm)) {
      assert.ok(
        m[2].startsWith('127.0.0.1'),
        `${relative(__dirname, file)} binds ${m[2].trim()} — the matrix is loopback-only`,
      );
    }
  }
});

// ── No committed key material, anywhere in the shared or Asterisk trees ──
test('no .key or .pem files in the committed Asterisk or shared trees', () => {
  const offenders = [...walkDir(__dirname), ...walkDir(join(__dirname, '..', 'matrix-shared'))]
    .filter((f) => f.endsWith('.key') || f.endsWith('.pem'));
  assert.deepStrictEqual(offenders, [], `found committed key material: ${offenders.join(', ')}`);
});

// ── The image digest cannot drift between conf.ts and CI ───────────────
// Two places pin the image; a silent divergence would mean the digest in the
// spec, the plan, and the workflow no longer describe the image under test.
test('the pinned digest in conf.ts matches the one in the CI workflow', () => {
  const conf = readFileSync(join(__dirname, 'conf.ts'), 'utf8');
  const digest = /andrius\/asterisk@sha256:([0-9a-f]{64})/.exec(conf);
  assert.ok(digest, 'conf.ts does not pin an andrius/asterisk digest');
  const workflow = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'asterisk-matrix.yml'),
    'utf8',
  );
  assert.ok(
    workflow.includes(digest[0]),
    `asterisk-matrix.yml does not reference ${digest[0]} — the workflow and the harness disagree about the image`,
  );
});

test('matrix tree is fully enumerated (floor check)', () => {
  const files = walkDir(__dirname);
  assert.ok(files.length >= 15, `asterisk-matrix has ${files.length} files, expected >= 15 — scan may be incomplete`);
});
