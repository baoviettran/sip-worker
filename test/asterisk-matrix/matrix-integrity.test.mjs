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

// NOTE: the local `TOKEN_RE` that used to be declared here is gone — the port
// rule below no longer uses it. (`conf.ts` exports its own `TOKEN_RE`, which IS
// live and unrelated; do not confuse the two, and do not remove that one.)
// The committed file at Task 13 fix round 1 still carried the dead local copy;
// delete it on the next touch of that file. No lint runs over these `.mjs`
// gates — there is no `lint` script and no eslint config in this repo — so
// nothing else will ever catch a dead const in them.

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

// PORT-LEVEL, not file-level. **Corrected during Task 13, by measurement.**
// The original rule here was `assert.ok(TOKEN_RE.test(readFileSync(file, 'utf8')))`
// — "this file contains at least one token". Task 13 measured what that misses:
// replacing `tlsbindaddr`'s token with a literal port while `__HTTP_PORT__`
// survived in the same file left the gate GREEN. So a genuine hardcoded port
// could survive review and collide with the FreeSWITCH matrix on a shared
// machine — the exact failure this rule's comment above says it exists to
// prevent. The rule below checks every port-bearing assignment instead.
//
// `bindaddr` is deliberately NOT a directive HERE: its value may legitimately be a
// bare address with no port at all (`bindaddr=127.0.0.1`), so demanding a token in
// it would fail on the correct committed tree. It is NOT left unchecked, though —
// the loopback rule below requires any port it does carry to be a token. The
// earlier claim on this line ("carries a loopback ADDRESS with no port") was FALSE
// and is corrected at that rule.
//
// **Corrected during Task 13 fix round 1's re-review, by measurement.** Asterisk
// truncates a config line at the first unescaped `;` (main/config.c), so
// `bindport=8088 ; the HTTP port` is a VALID line carrying a real port. The value
// clause here was `(\S+)\s*$`, anchored at end-of-line, so no such line could
// match — measured: it left the gate GREEN (9 pass / 0 fail, exit 0), a hardcoded
// port passing the check whose entire job is to stop hardcoded ports. The hole was
// wider than a literal: even `bindport=__HTTP_PORT__ ; c`, a correctly tokened
// line, was invisible, so the rule's coverage silently dropped for EVERY commented
// directive. Both rules now strip the comment first, via one helper.
//
// (The `;`-truncation itself is read from Asterisk master, not from the pinned
// digest's revision — but the rule is written to require tokens in a commented
// directive either way, so it does not depend on which revision is right.)
function withoutInlineComment(line) {
  const i = line.indexOf(';');
  return i === -1 ? line : line.slice(0, i);
}

const PORT_DIRECTIVE = /^\s*(?:bindport|tlsbindaddr|bind|port)\s*=\s*(\S+)\s*$/i;
// The value may carry a host prefix: `bind=127.0.0.1:__WSS_PORT__`.
const HOST_AND_TOKEN = /^(?:[^:\s]+:)?__[A-Z][A-Z_]*[A-Z]__$/;
// What a bind directive's value may be: the loopback address, OPTIONALLY followed
// by a tokened port. A port LITERAL here is not acceptable, and that is not
// hypothetical — in http.conf an inline port on `bindaddr` takes precedence over
// `bindport` (http.c sets bindport only `if (!ast_sockaddr_port(&addrs[i]))`), so
// `bindaddr=127.0.0.1:18090` is a hardcoded port that silently wins. Measured
// during the re-review: it passed BOTH gates, because it starts with `127.0.0.1`
// and `bindaddr` is not in the port rule. (Same hedge as above: the precedence
// comes from master, not the pinned revision. The rule is tightened regardless —
// a port literal in a bind value violates the Global Constraint either way.)
const LOOPBACK_OPTIONAL_TOKENDED_PORT = /^127\.0\.0\.1(?::__[A-Z][A-Z_]*[A-Z]__)?$/;

test('every port-bearing ast-conf file uses tokens, not literals', () => {
  for (const name of TOKEN_FILES) {
    const file = join(__dirname, 'ast-conf', name);
    assert.ok(existsSync(file), `ast-conf/${name} is missing — the committed tree is incomplete`);
    let directives = 0;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*[;#]/.test(raw)) continue; // a commented-out directive binds nothing
      const m = PORT_DIRECTIVE.exec(withoutInlineComment(raw));
      if (!m) continue;
      directives += 1;
      assert.ok(HOST_AND_TOKEN.test(m[1]), `ast-conf/${name}: port literal "${m[1]}" — every port must be a token`);
    }
    // A file with no port directive at all would otherwise pass vacuously.
    assert.ok(directives >= 1, `ast-conf/${name} declares no port directive — the rule cannot see it`);
    // KNOWN LIMIT, measured during Task 13 fix round 1 and left open deliberately:
    // this is a per-FILE floor, not per-directive. Deleting ONE of http.conf's two
    // port directives leaves the other in place, so the floor passes and the gate
    // stays GREEN (measured: 9 pass / 0 fail, exit 0). A file that loses only SOME
    // of its ports is a regression this rule cannot see; only losing all of them is.
    //
    // Not fixed, for three reasons. (1) It is incompleteness, not vacuity: every
    // directive the rule does see is asserted on, so unlike the loopback rule below
    // — which reported `ok` while executing zero assertions — this one cannot
    // report success while asserting nothing. (2) The mutation cannot ship
    // silently: deleting a listener directive removes a listener, and the boot gate
    // and the page suite fail loudly on a socket nobody is bound to. (3) Closing it
    // means freezing per-file directive counts or a per-directive expectation
    // table — a third parallel list naming the same three files, which turns every
    // legitimate config change into a red gate, to catch something already caught
    // at runtime.
    //
    // Carried to the final whole-branch review as a known-open condition.
  }
});

// NOTE FOR THE IMPLEMENTER: BOTH rules in this file are DESIGNED, not yet proved
// — they were written from reading the three conf files, not from running them.
// Prove all SIX of these by mutation and report the observed output. 1-4 were
// proved in fix round 1; 5 and 6 are new in round 2 — the two doors round 1's fix
// left open, both measured GREEN when they should have been RED. Re-run all six:
// do not assume 1-4 survived the round-2 edits, because both edits changed the
// code paths they exercise.
//
//   1. REPORT what the port rule actually matched — every `file:line:value` it
//      accepted. It must be exactly four directives: pjsip.conf `bind`,
//      http.conf `bindport`, http.conf `tlsbindaddr`, manager.conf `port`. A
//      rule that also matches something else is a defect to report, not to
//      quietly narrow.
//   2. Replace ONE token with a literal port while another token survives in the
//      same file → the port rule must go RED.
//   3. Delete a port directive entirely → the port rule must go RED on
//      `directives >= 1`.
//   4. Delete the `bindaddr=127.0.0.1` line from manager.conf → the loopback
//      rule must go RED on `seen.length >= 1`.
//   5. NEW — `http.conf`: `bindport=8088 ; the HTTP port` → the port rule must go
//      RED. Before `withoutInlineComment` this line was INVISIBLE to the rule (no
//      match at all) and the gate stayed GREEN (9 pass / 0 fail, measured). Also
//      prove the benign half: `bindport=__HTTP_PORT__ ; c` must still be SEEN and
//      still pass, because a commented TOKENED line was invisible too — the hole
//      was wider than a literal.
//   6. NEW — `http.conf`: `bindaddr=127.0.0.1:18090` → the loopback rule must go
//      RED. Before `LOOPBACK_OPTIONAL_TOKENDED_PORT` this cleared BOTH gates
//      (measured): it starts with `127.0.0.1`, and `bindaddr` is not in the port
//      rule. The bare `bindaddr=127.0.0.1` must stay GREEN, in both files.
//
// A rule that only ever passes is the failure mode this whole task exists to
// prevent. 2, 4, 5 and 6 are the four measured GREEN when they should have been
// RED — and 5 and 6 were found by the round-1 RE-REVIEW, after 2 and 4 had
// already been fixed, which is why the re-review re-ran the whole set instead of
// spot-checking the fix.
//
// PROVED, all six, during Task 13 fix round 2 — the observed output is in
// .superpowers/sdd/2026-09-14-v0.9-asterisk-matrix/task-13-fix-r2-report.md:
//   1. exactly 4 directives, as listed above, no extras, on the committed tree:
//      pjsip.conf:13 `127.0.0.1:__WSS_PORT__`, http.conf:9 `__HTTP_PORT__`,
//      http.conf:11 `127.0.0.1:__WSS_PORT__`, manager.conf:9 `__AMI_PORT__`;
//      gate exit 0.
//   2. RED — `not ok 3 - every port-bearing ast-conf file uses tokens, not literals`
//      (`port literal "127.0.0.1:18083"`), with `__HTTP_PORT__` still present in
//      the same file. This is the case the file-level rule missed. (It now fails
//      the loopback rule as well — 7 pass / 2 fail — since a literal port inside
//      a bind value is also a bind-value violation.)
//   3. RED — same subtest, on `declares no port directive` (the file's ONLY port
//      directive was deleted, so `directives >= 1` fires); also trips the
//      loopback floor, 7 pass / 2 fail.
//   4. RED — `not ok 4 - ast-conf binds nothing outside loopback`
//      (`manager.conf yields no bind directive`).
//   5. RED — `not ok 3`, `port literal "8088"`. This line was INVISIBLE before
//      `withoutInlineComment`: no match at all, gate GREEN. Benign half proved by
//      instrumenting the rule: `bindport=__HTTP_PORT__ ; c` is SEEN
//      (`MATCHED ast-conf/http.conf:9:__HTTP_PORT__`) and the gate stays exit 0.
//   6. RED — `not ok 4`, `binds "127.0.0.1:18090"`. This cleared BOTH gates
//      before. Benign half: bare `bindaddr=127.0.0.1` in http.conf and
//      `bindaddr = 127.0.0.1` in manager.conf stay GREEN, 9 pass / 0 fail.
//
// The per-FILE `directives >= 1` limit is stated in the port test above and is a
// known-open condition carried to the final whole-branch review.

// ── Loopback-only, WITH A FLOOR. **Corrected during Task 13, by measurement.** ──
// As first written this test was VACUOUS, and the review measured it: `matchAll`
// over zero matches runs zero assertions, so deleting every
// `bind`/`bindaddr`/`tlsbindaddr` line from the committed config left it GREEN
// (`ok 4`, exit 0). A gate that cannot fail reads as coverage without being any,
// which is the failure mode this whole task exists to prevent.
//
// The value check keeps its full walk over `ast-conf/` — a NEW file that binds a
// listener must still be caught — and the floor is added on top, per named file,
// so that one file going invisible is named in the failure rather than absorbed
// by the other two. The floor cannot be applied per file across the walk: only
// three of the seven conf files bind a listener at all.
const BIND_FILES = ['pjsip.conf', 'http.conf', 'manager.conf'];

test('ast-conf binds nothing outside loopback', () => {
  // (a) no file anywhere in ast-conf may bind outside loopback, and any port a bind
  // value carries must be a token — not merely start with `127.0.0.1`. That prefix
  // test was the re-review's second finding: `bindaddr=127.0.0.1:18090` starts with
  // the loopback address and so passed, while the port rule never looked at
  // `bindaddr` at all, so a hardcoded port cleared BOTH gates.
  //
  // The comment strip is needed here too, in the opposite direction: without it,
  // `bindaddr=127.0.0.1 ; loopback only` would be compared whole and rejected — the
  // same bug pointed the other way. One helper, both rules.
  for (const file of walkDir(join(__dirname, 'ast-conf'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*(bindaddr|tlsbindaddr|bind)\s*=\s*(.+)$/gm)) {
      const value = withoutInlineComment(m[2]).trim();
      assert.ok(
        LOOPBACK_OPTIONAL_TOKENDED_PORT.test(value),
        `${relative(__dirname, file)} binds "${value}" — must be 127.0.0.1, optionally with a __TOKEN__ port`,
      );
    }
  }
  // (b) …and each file that is supposed to bind a listener must have been SEEN
  // doing it. Measured today: pjsip.conf 1 (`bind`), http.conf 2 (`bindaddr`,
  // `tlsbindaddr`), manager.conf 1 (`bindaddr`).
  for (const name of BIND_FILES) {
    const file = join(__dirname, 'ast-conf', name);
    assert.ok(existsSync(file), `ast-conf/${name} is missing — the committed tree is incomplete`);
    const seen = [...readFileSync(file, 'utf8').matchAll(/^\s*(bindaddr|tlsbindaddr|bind)\s*=\s*(.+)$/gm)];
    assert.ok(seen.length >= 1, `ast-conf/${name} yields no bind directive — the rule cannot see the file it guards`);
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
