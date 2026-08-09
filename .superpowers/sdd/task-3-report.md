# Task 3: Dialog route correctness

## Scope

Corrected RFC 3261 section 12.2.1.1 routing for UAC in-dialog requests.

## TDD evidence

### RED

After replacing the inverted routing expectations with RFC cases, ran:

```text
npm test -- --run test/dialogs
```

Result: 2 failing, 14 passing dialog tests. The loose-routing case received
`sip:p2.example.com;lr` instead of the required remote target
`sip:bob@192.0.2.5:5060`; the strict-routing case received the remote target
instead of required first strict route `sip:p1.example.com`. These failures
demonstrated the existing inverted routing branches before production changes.

### GREEN

Applied the minimum production correction and ran the same focused suite:

```text
Test Files  1 passed (1)
Tests       16 passed (16)
```

## Files changed

- `src/dialogs/dialog.ts`: loose routing now puts the remote target in the
  Request-URI and the entire route set in `Route`; strict routing puts the
  first route in the Request-URI and remaining routes followed by remote target
  in `Route`.
- `src/dialogs/header-values.ts`: `extractUri` now accepts a trimmed bare URI,
  preserving support for bracketed URI values.
- `test/dialogs/dialog.test.ts`: uses repeated `Record-Route` fields and a
  bare Contact URI in the loose-routing RFC regression test; verifies strict
  routing has the first route as Request-URI and the required remaining Route

## Review follow-up: bare Contact header parameters

### RED

Added the focused regression for a bare Contact value:

```text
Contact: sip:bob@host;expires=60
```

Then ran:

```text
npm test -- --run test/dialogs
```

Result: 1 failing, 16 passing. The new assertion expected `sip:bob@host` but
received `sip:bob@host;expires=60`, confirming that `extractUri` was treating
the Contact `expires` parameter as part of the remote target.

### GREEN

`extractUri` now removes a bare Contact's distinguishable `expires` or `q`
header parameter while retaining URI parameters that precede it (for example,
`transport=tcp`). Re-ran the focused suite:

```text
Test Files  1 passed (1)
Tests       17 passed (17)
```

### Files changed

- `src/dialogs/header-values.ts`: strips known Contact header parameters from
  bare addr-spec values without changing bracketed URI handling.
- `test/dialogs/dialog.test.ts`: adds the bare `;expires=60` remote-target
  regression.

### Verification

- `npm test -- --run test/dialogs` — 1 file, 17 tests passed.
- `npm test` — 38 files, 422 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

### Self-review

The parser change is intentionally narrow: `expires` and `q` are known
Contact header parameters, while arbitrary extension parameters are ambiguous
with SIP URI parameters in an unbracketed addr-spec and are left untouched.
The regression covers the reported target-corruption case; no dialog routing
behavior was changed.


## Review follow-up: optional whitespace before bare Contact parameters

### RED

Added focused regression coverage for bare Contact values with optional
whitespace around the known header-parameter separator and assignment:

```text
Contact: sip:bob@host ; expires = 60
Contact: sip:bob@host ; q = 0.5
```

Also added guard coverage confirming that `sip:bob@host;transport=tcp;expires=60`
retains `;transport=tcp`, and that `<sip:bob@host;transport=tcp>;expires=60`
continues to retain the bracketed URI parameter.

Ran before production changes:

```text
npm test -- --run test/dialogs
```

Result: 2 failing, 19 passing dialog tests. Both whitespace cases expected
`sip:bob@host` but received `sip:bob@host `, confirming the bare-URI regex
captured optional whitespace preceding `expires` or `q`.

### GREEN

Changed only the captured bare-URI branch in `extractUri` to trim its captured
prefix. Bracketed URIs remain on their existing early-return path, and URI
parameters before a bare Contact header parameter remain in the prefix.

Re-ran:

```text
npm test -- --run test/dialogs
```

Result:

```text
Test Files  1 passed (1)
Tests       21 passed (21)
```

### Files changed

- `src/dialogs/header-values.ts`: trims the bare addr-spec prefix captured
  before a known Contact `expires` or `q` parameter.
- `test/dialogs/dialog.test.ts`: adds `expires` and `q` whitespace regressions
  plus URI-parameter preservation guards for bare and bracketed Contacts.

### Verification

- `npm test -- --run test/dialogs` — 1 file, 21 tests passed.
- `npm test` — 38 files, 426 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

### Self-review

The adjustment is intentionally limited to the extracted bare-URI prefix. It
removes separator whitespace without changing the recognized Contact header
parameters, arbitrary bare extension handling, bracketed URI parsing, or
dialog routing behavior. The regression tests cover both whitespace-tolerant
known header parameters and the previously documented URI-parameter behavior.
