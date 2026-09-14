// test/matrix-shared/no-src-imports.test.mjs
// The harness may consume sip-worker and @sip-worker/core ONLY through packed
// tarballs (build-matrix.mjs installs them into a temp fixture and bundles
// against that node_modules). An import that resolves into packages/**/src
// would silently test the sources instead of the artifact under test — the
// whole point of the harness.
//
// FreeSWITCH has its own gate at test/freeswitch-matrix/no-src-imports.test.mjs,
// and it is NOT a duplicate of this one — do not delete it as redundant, and do
// not assume this one covers it. They check overlapping but different things:
// that gate scans only page.ts and *.spec.ts in ITS directory and additionally
// forbids value imports of @sip-worker/*; this one scans every .ts/.mjs/.js in
// all three trees but, with the rule added below, now checks both. FreeSWITCH is
// in TREES, so it is covered twice for the packages/**/src rule, which is
// harmless; the FS gate is left exactly as it is because that tree is frozen and
// a redundant green gate costs nothing, whereas deleting a FreeSWITCH gate
// during the Asterisk workstream is a FreeSWITCH change by another name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['matrix-shared', 'asterisk-matrix', 'freeswitch-matrix'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'artifacts') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * A VALUE import of `@sip-worker/*`, mirroring the FreeSWITCH gate's rule but
 * without its false positive. That gate tests `/import\s+(?!type\b)[^\n]*from\s+
 * ['"]@sip-worker\//`, which also flags the legal type-only form
 * `import { type Foo } from '@sip-worker/core'` — the lookahead sits right after
 * `import`, and that clause starts with `{`. The FreeSWITCH tree never trips it
 * because its only `import { type X }` is a RELATIVE path (`./fsctl`), so the
 * `@sip-worker/` specifier never appears. This tree has no such import today
 * either, but the regex would flag one the moment it was written, and a gate
 * that fails on correct code is a gate someone deletes. So: inspect the clause.
 */
const IMPORT_FROM = /import\s+([^;]*?)\s+from\s+['"](@sip-worker\/[^'"]+)['"]/g;

/**
 * Drop comment-only lines before scanning. Both rules below are plain text
 * matches, and this file's own explanation quotes the very patterns it forbids,
 * so a sentence ABOUT an illegal import reads exactly like one.
 *
 * Measured, not theorised: as first written this gate was red on its own tree
 * and could never go green — `IMPORT_FROM`'s clause is `[^;]*?`, which crosses
 * newlines, so the prose here ("A VALUE import of `@sip-worker/...`") was
 * captured as the import clause and the file reported itself as an offender.
 * The FreeSWITCH gate escapes this only by accident: its clause is `[^\n]*`, so
 * it cannot span lines, and its comment never quotes a `from '@sip-worker/…'`
 * on the same line. Widening the clause to catch multi-line imports removed
 * that accident, so the prose has to be excluded deliberately.
 *
 * A line whose first non-space characters are `//`, `/*` or `*` is a comment in
 * this repo's house style, and a line of code never is — so this cannot hide a
 * real import. Trailing comments after code are deliberately NOT stripped:
 * removing them means guessing at `//` inside string literals (every
 * `https://…` in the tree), and a wrong guess there could hide a real offender.
 */
function withoutCommentLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

function valueImportsOfSipWorker(source) {
  const bad = [];
  for (const m of source.matchAll(IMPORT_FROM)) {
    const clause = m[1].trim();
    if (clause.startsWith('type ')) continue; // import type { X } from …
    // `import { a, type B } from …` — every binding must be `type`-prefixed.
    const names = clause
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.some((n) => !n.startsWith('type '))) bad.push(m[2]);
  }
  return bad;
}

test('no harness file imports across the packed-tarball boundary', () => {
  const offenders = [];
  for (const tree of TREES) {
    const root = join(testDir, tree);
    if (!statSync(root).isDirectory()) continue;
    for (const file of walk(root)) {
      const text = withoutCommentLines(readFileSync(file, 'utf8'));
      const srcImport = /from\s+['"][^'"]*packages\/[^'"]*\/src/.test(text) || /require\(['"][^'"]*packages\//.test(text);
      const valueImport = valueImportsOfSipWorker(text).length > 0;
      if (srcImport || valueImport) {
        offenders.push(
          `${relative(testDir, file)}${valueImport ? ` (value import of ${valueImportsOfSipWorker(text).join(', ')})` : ''}`,
        );
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `files cross the packed-tarball boundary: ${offenders.join(', ')}`);
});

test('the trees were actually walked (floor check)', () => {
  // Per tree, NOT on the aggregate. Measured: the three trees hold 11 + 15 + 19
  // = 45 scanned files today, so an aggregate floor of 30 is satisfied by any
  // two of them (asterisk + freeswitch alone is 34) — it cannot see a tree that
  // dropped out of TREES, which is the one thing this check exists to notice. A
  // per-tree floor of 5 keeps real headroom (the smallest tree has 11) and fails
  // loudly on a tree that contributed nothing. The aggregate form would have
  // passed the exact mutation it was written to catch.
  for (const t of TREES) {
    const n = walk(join(testDir, t)).length;
    assert.ok(n >= 5, `only ${n} files scanned under ${t} — that tree was not walked`);
  }
});
