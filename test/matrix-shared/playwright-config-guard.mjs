// test/matrix-shared/playwright-config-guard.mjs
//
// Guards a Playwright config against a defect that has shipped twice in this
// repo and that nothing else catches.
//
//   `firefoxUserPrefs` is a LAUNCH option — BrowserContextOptions has no such
//   key — so under `contextOptions` it is accepted and silently ignored, and
//   every pref in it is inert. The load-bearing casualty is
//   `media.peerconnection.ice.loopback`: without it Firefox gathers only mDNS
//   `.local` host candidates, has no address literal for the media connection
//   line, and EVERY Firefox leg of a matrix fails while every Chromium leg
//   passes.
//
// Shipped in test/asterisk-matrix (fixed a420a46) and test/freeswitch-matrix
// (fixed 279c90e, found only after two red nights). Invisible to `tsc`: these
// configs build the project as an unannotated `const … = { use: {…} }` spread
// into `projects`, which loses object-literal freshness, so excess-property
// checking never fires. No tsconfig covers test/*/playwright.config.ts either,
// so `npm run typecheck` never reads the file at all.
//
// This PARSES the config with the TypeScript compiler API rather than scanning
// its text. That is the house rule at the bottom of
// test/asterisk-matrix/matrix-integrity.test.mjs ("Parse, do not scan"): two
// hand-rolled text scanners were unsound in both directions and the second was
// deleted rather than repaired. A scanner has to re-derive strings, comments,
// templates and brace nesting by hand and gets each one wrong; the parser
// already knows. `typescript` is a declared devDependency (^5.5.0) installed by
// `npm ci` in every CI job that runs these gates.
//
// Known blind spot: a key arriving through a SPREAD (`contextOptions: {
// ...prefs }`) is not resolved — the object literal is inspected for its own
// named properties only. Both configs write the prefs inline, and a spread
// would be a deliberate obfuscation rather than the accident this guards
// against; flag it in review rather than here.

import ts from 'typescript';

/**
 * Playwright options that exist on LaunchOptions but NOT on
 * BrowserContextOptions — accepted and silently ignored wherever they land in
 * the wrong one. Extend as new launch-only options are adopted; each entry
 * needs a case in playwright-config-guard.unit.test.ts.
 */
export const LAUNCH_ONLY_KEYS = ['firefoxUserPrefs'];

/** Property name of an object-literal member, or null when it is computed. */
function propertyName(name) {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * Find launch-only options sitting under a `contextOptions` object literal.
 *
 * @param {string} source raw text of a playwright.config.ts
 * @param {string} [fileName] name to parse as, for error line numbers
 * @returns {{ key: string, line: number }[]} one entry per offending property
 */
export function launchOnlyKeysUnderContextOptions(source, fileName = 'playwright.config.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'contextOptions' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const member of node.initializer.properties) {
        if (!ts.isPropertyAssignment(member)) continue;
        const key = propertyName(member.name);
        if (key !== null && LAUNCH_ONLY_KEYS.includes(key)) {
          const { line } = sf.getLineAndCharacterOfPosition(member.getStart(sf));
          found.push({ key, line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return found;
}
