import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Approved one-way dependency graph. `core` is the foundation; `browser` and
 * `node` may depend on `core` (and each other's absence is asserted). The
 * forbidden patterns decide whether a bare/module specifier is legal for a given
 * package. Applied verbatim from the task brief.
 */
const forbidden = {
  core: [/^node:/, /^sip-worker(?:\/|$)/, /^@sip-worker\/node(?:\/|$)/],
  browser: [/^node:/, /^@sip-worker\/node(?:\/|$)/],
  node: [/^sip-worker(?:\/|$)/],
};

/** Executable identifier references that must never appear in production source. */
const FORBIDDEN_IDENTIFIERS = new Set([
  'globalThis',
  'window',
  'document',
  'navigator',
  'RTCPeerConnection',
  'Worker',
  'WebSocket',
]);

/**
 * The one, narrowly-scoped exception to the executable-global scan.
 *
 * `packages/browser/src/media/error-mapper.ts` owns the v0.5 browser media
 * environment seam: its `readMediaGlobals()` is the ONLY place the browser
 * package resolves real environment globals, and it does so LAZILY inside
 * `createBrowserMediaEnvironment()` / per-call accessors — never at module
 * import. Importing `sip-worker` must stay side-effect free; that guarantee is
 * enforced at runtime by `test/architecture/import-safety.test.mjs`, which
 * replaces the same globals with throwing sentinels and asserts every public
 * browser entry point imports cleanly (see the seam's README/design: "must not
 * touch navigator/RTCPeerConnection/document merely by importing").
 *
 * The other browser/node modules (including `browser-user-agent.ts`, which
 * builds its window-backed clock through injected `Date`/timer globals) must
 * NOT read forbidden globals at all — this exemption is scoped to the single
 * dedicated seam file, not to the whole browser package.
 */
const LAZY_GLOBAL_SEAM_FILES = new Set([
  join(repoRoot, 'packages', 'browser', 'src', 'media', 'error-mapper.ts'),
]);

/**
 * Type-only AST nodes. Descending into these would surface type references such
 * as `typeof window` or `WebSocket` inside a type literal, which are not
 * executable environment access and must be ignored.
 */
const TYPE_NODE_KINDS = new Set([
  ts.SyntaxKind.TypeReference,
  ts.SyntaxKind.TypeLiteral,
  ts.SyntaxKind.ArrayType,
  ts.SyntaxKind.UnionType,
  ts.SyntaxKind.IntersectionType,
  ts.SyntaxKind.TypeOperator,
  ts.SyntaxKind.TypeQuery,
  ts.SyntaxKind.TupleType,
  ts.SyntaxKind.OptionalType,
  ts.SyntaxKind.RestType,
  ts.SyntaxKind.ParenthesizedType,
  ts.SyntaxKind.FunctionType,
  ts.SyntaxKind.ConstructorType,
  ts.SyntaxKind.TemplateLiteralType,
  ts.SyntaxKind.LiteralType,
  ts.SyntaxKind.TypePredicate,
  ts.SyntaxKind.IndexedAccessType,
  ts.SyntaxKind.MappedType,
  ts.SyntaxKind.ConditionalType,
  ts.SyntaxKind.ImportType,
  ts.SyntaxKind.NamedTupleMember,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.TypeParameterDeclaration,
]);

/**
 * Parent node kinds whose `name` field is a declaration/binding identifier
 * rather than an executable reference (e.g. `class Worker {}`, `const window`).
 */
const NAME_HOLDER_KINDS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

/**
 * Collect production `.ts` files only — the gate enforces the dependency graph
 * and import-time safety over the package src trees exactly, never test
 * fixtures or generated `.d.ts`. Relative imports inside a package's own test
 * directory legitimately reach `test/support` and must stay out of scope.
 */
function collectTsFiles(packagesDir, out = []) {
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, 'src');
    if (!existsSync(srcDir)) continue;
    walkSrc(srcDir, out);
  }
  return out;
}

function walkSrc(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
}

function packageOf(file) {
  const rel = file.slice(repoRoot.length + 1);
  const parts = rel.split(sep);
  if (parts[0] === 'packages' && parts[1]) return parts[1];
  return undefined;
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Walk one source file, collecting import specifiers (static + dynamic) and any
 * executable reference to a forbidden environment global.
 */
function analyzeFile(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const specifiers = [];
  const globalRefs = [];

  function walk(node) {
    if (TYPE_NODE_KINDS.has(node.kind)) return;

    if (ts.isIdentifier(node)) {
      const text = node.text;
      if (FORBIDDEN_IDENTIFIERS.has(text) && isExecutableReference(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        globalRefs.push({ file, line: line + 1, name: text });
      }
      return;
    }

    if (isImportSpecifierNode(node)) {
      const text = moduleSpecifierText(node);
      if (text !== undefined) specifiers.push(text);
    } else if (isDynamicImportCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
    } else if (isRequireCall(node)) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
    }

    ts.forEachChild(node, (child) => {
      if (child) walk(child);
    });
  }

  walk(source);
  return { specifiers, globalRefs };
}

function isImportSpecifierNode(node) {
  return (
    ts.isImportDeclaration(node)
    || ts.isExportDeclaration(node)
    || ts.isImportEqualsDeclaration(node)
  );
}

function moduleSpecifierText(node) {
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
    if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      return node.moduleSpecifier.text;
    }
  }
  if (ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      return node.moduleSpecifier.text;
    }
  }
  return undefined;
}

function isDynamicImportCall(node) {
  return (
    ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

function isRequireCall(node) {
  return (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require'
  );
}

/** True when `node` is an identifier used as a value/reference, not a name. */
function isExecutableReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  // A declaration name (`class Worker`, `const window`) is not a reference.
  if (NAME_HOLDER_KINDS.has(parent.kind) && parent.name === node) return false;
  // A property name (`obj.window`) is not a reference; the object side is.
  if (parent.kind === ts.SyntaxKind.PropertyAccessExpression && parent.name === node) {
    return false;
  }
  return true;
}

const files = collectTsFiles(join(repoRoot, 'packages'));

test('the one-way dependency graph forbids upward and cross-workspace imports', () => {
  const diagnostics = [];
  for (const file of files) {
    const pkg = packageOf(file);
    if (!pkg || !(pkg in forbidden)) continue;
    const { specifiers } = analyzeFile(file);
    for (const specifier of specifiers) {
      if (isRelative(specifier)) continue; // governed by the src-containment check
      for (const pattern of forbidden[pkg]) {
        if (pattern.test(specifier)) {
          diagnostics.push(`${short(file)} -> ${specifier} (forbidden by ${pattern})`);
        }
      }
    }
  }
  assert.deepEqual(
    diagnostics,
    [],
    `forbidden cross-workspace / environment imports:\n${diagnostics.join('\n')}`,
  );
});

test('relative imports never leave their package src directory', () => {
  const diagnostics = [];
  for (const file of files) {
    const pkg = packageOf(file);
    if (!pkg) continue;
    const srcDir = resolve(repoRoot, 'packages', pkg, 'src');
    const { specifiers } = analyzeFile(file);
    for (const specifier of specifiers) {
      if (!isRelative(specifier)) continue;
      const resolved = resolve(dirname(file), specifier);
      if (!(resolved === srcDir || resolved.startsWith(srcDir + sep))) {
        diagnostics.push(`${short(file)} -> ${specifier} (resolves outside ${pkg}/src)`);
      }
    }
  }
  assert.deepEqual(
    diagnostics,
    [],
    `relative imports leaving package src:\n${diagnostics.join('\n')}`,
  );
});

test('no executable reference to environment globals in production source', () => {
  const diagnostics = [];
  for (const file of files) {
    // The single lazy browser-media environment seam is exempt (see the
    // LAZY_GLOBAL_SEAM_FILES note); its lazy resolution is verified at runtime
    // by import-safety. Every other production file must stay global-free.
    if (LAZY_GLOBAL_SEAM_FILES.has(file)) continue;
    const { globalRefs } = analyzeFile(file);
    for (const ref of globalRefs) {
      diagnostics.push(`${short(file)}:${ref.line} references executable ${ref.name}`);
    }
  }
  assert.deepEqual(
    diagnostics,
    [],
    `executable environment-global references:\n${diagnostics.join('\n')}`,
  );
});

test('core-owned filenames live only under packages/core/src', () => {
  const owned = ['parser.ts', 'coordinator.ts', 'dialog.ts', 'manager.ts', 'registrar.ts', 'inviter.ts', 'invitation.ts'];
  const coreSrcDir = resolve(repoRoot, 'packages', 'core', 'src');
  const diagnostics = [];
  for (const file of files) {
    const base = file.slice(file.lastIndexOf(sep) + 1);
    if (!owned.includes(base)) continue;
    if (!file.startsWith(coreSrcDir + sep)) {
      diagnostics.push(`${short(file)} owns ${base} but lives outside core/src`);
    }
  }
  assert.deepEqual(diagnostics, [], `core-owned filenames outside core/src:\n${diagnostics.join('\n')}`);
});

function short(file) {
  return file.slice(repoRoot.length + 1);
}