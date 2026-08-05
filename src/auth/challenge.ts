import { ParseError } from '../errors.js';
import type { ParseResult } from '../messages/message.js';

/**
 * A parsed Digest challenge extracted from a WWW-Authenticate or
 * Proxy-Authenticate field value (RFC 2617 3.2.1).
 */
export interface DigestChallenge {
  readonly realm: string;
  readonly nonce: string;
  readonly algorithm?: 'MD5' | 'SHA-256';
  /**
   * The raw algorithm token exactly as challenged, including unsupported
   * values (e.g. `MD5-sess`). Retained so `selectChallenge` can reject
   * candidates whose algorithm this client cannot answer.
   */
  readonly rawAlgorithm?: string;
  readonly qop?: ReadonlyArray<'auth' | 'auth-int'>;
  readonly opaque?: string;
  readonly stale?: boolean;
  readonly domain?: string;
}

/** Algorithms this client can answer. Keyed by the normalized (upper-case) token. */
const SUPPORTED_ALGORITHMS = new Set(['MD5', 'SHA-256']);

function fail<T>(offset: number, message: string): ParseResult<T> {
  return { ok: false, error: new ParseError(offset, message) };
}

/**
 * Parses a list of `WWW-Authenticate`/`Proxy-Authenticate` raw field values
 * into Digest challenges. Handles multiple challenges per value and across
 * values, tracking quoted-string/escape state so a comma inside a quoted
 * value never splits a challenge. Never throws: malformed input yields
 * `{ ok: false, error: ParseError }` with a byte offset.
 */
export function parseDigestChallenges(values: string[]): ParseResult<DigestChallenge[]> {
  // Concatenate every raw value; a challenge may span multiple header rows.
  const raw = values.join(',');
  const challenges: DigestChallenge[] = [];

  let i = 0;
  while (i < raw.length) {
    // Skip linear whitespace and leading commas between challenges.
    while (i < raw.length && isSpace(raw.charCodeAt(i))) i += 1;
    if (i >= raw.length) break;

    // Scheme token: must be "Digest" (case-insensitive).
    const schemeStart = i;
    while (i < raw.length && isTokenChar(raw.charCodeAt(i))) i += 1;
    const scheme = raw.slice(schemeStart, i);
    if (scheme.toLowerCase() !== 'digest') {
      return fail(schemeStart, `unsupported auth scheme "${scheme}"`);
    }
    if (i < raw.length && raw[i] === ',') {
      // Digest with no parameters; the comma separates challenges.
      i += 1;
      continue;
    }
    if (i < raw.length && isSpace(raw.charCodeAt(i))) {
      while (i < raw.length && isSpace(raw.charCodeAt(i))) i += 1;
    } else if (i < raw.length) {
      return fail(schemeStart, 'expected whitespace after Digest scheme');
    }

    const params: Record<string, string> = {};
    let paramStart: number | undefined;
    let inQuotes = false;
    let escaped = false;

    for (;;) {
      if (i >= raw.length) {
        // A dangling backslash is a malformed escape; otherwise the last
        // parameter ends cleanly at end of input (flushed after the loop).
        if (escaped) return fail(i, 'malformed escape at end of input');
        break;
      }
      const ch = raw[i]!;

      if (inQuotes) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inQuotes = false;
        }
        i += 1;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }

      // A comma ends the challenge when followed by whitespace + a scheme
      // token (the break target; the trailing parameter is flushed right
      // after the loop); otherwise it separates parameters of the challenge.
      if (ch === ',') {
        let j = i + 1;
        while (j < raw.length && isSpace(raw.charCodeAt(j))) j += 1;
        let k = j;
        while (k < raw.length && isTokenChar(raw.charCodeAt(k))) k += 1;
        if (raw.slice(j, k).toLowerCase() === 'digest') {
          break;
        }
        // Parameter separator: flush the current parameter and continue.
        const err = commitParam(params, raw, paramStart, i);
        if (err !== undefined) return fail(err.offset, err.message);
        paramStart = undefined;
        i += 1;
        continue;
      }

      // Whitespace separates a name from its value; flush any pending text.
      if (ch === ' ' || ch === '\t') {
        const err = commitParam(params, raw, paramStart, i);
        if (err !== undefined) return fail(err.offset, err.message);
        paramStart = undefined;
        i += 1;
        continue;
      }

      if (ch === '=') {
        i += 1;
        continue;
      }

      if (paramStart === undefined) paramStart = i;
      i += 1;
    }

    // Flush any trailing parameter before the challenge boundary.
    const err = commitParam(params, raw, paramStart, i);
    if (err !== undefined) return fail(err.offset, err.message);

    const realm = params['realm'];
    const nonce = params['nonce'];
    if (realm === undefined) return fail(0, 'Digest challenge missing realm');
    if (nonce === undefined) return fail(0, 'Digest challenge missing nonce');

    const algorithm = params['algorithm'];
    const qop = params['qop'] !== undefined
      ? params['qop'].split(',').flatMap((q) => {
        const t = q.trim().toLowerCase();
        if (t === 'auth') return ['auth' as const];
        if (t === 'auth-int') return ['auth-int' as const];
        return [];
      })
      : undefined;
    const challenge: DigestChallenge = {
      realm,
      nonce,
      ...(algorithm !== undefined
        ? { rawAlgorithm: algorithm }
        : {}),
      ...(algorithm !== undefined && SUPPORTED_ALGORITHMS.has(algorithm.toUpperCase())
        ? { algorithm: algorithm.toUpperCase() as 'MD5' | 'SHA-256' }
        : {}),
      ...(qop !== undefined ? { qop } : {}),
      ...(params['opaque'] !== undefined ? { opaque: params['opaque'] } : {}),
      ...(params['stale'] !== undefined ? { stale: params['stale'].toLowerCase() === 'true' } : {}),
      ...(params['domain'] !== undefined ? { domain: params['domain'] } : {}),
    };

    challenges.push(challenge);
    // Consume the challenge boundary (the comma we broke out on).
    if (i < raw.length && raw[i] === ',') i += 1;
  }

  return { ok: true, value: challenges };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

function isTokenChar(code: number): boolean {
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  switch (code) {
    case 33: case 35: case 36: case 37: case 38: case 39: case 42: case 43:
    case 45: case 46: case 94: case 95: case 96: case 124: case 126:
      return true;
    default:
      return false;
  }
}

/**
 * Records the parameter spanning `[start, end)` of `raw` into `params`.
 * Names are lower-cased; quoted values are unquoted and backslash escapes are
 * resolved. Returns a `ParseError` on an unterminated string or a dangling
 * escape, or `undefined` on success.
 */
function commitParam(
  params: Record<string, string>,
  raw: string,
  start: number | undefined,
  end: number,
): ParseError | undefined {
  if (start === undefined) return undefined;
  const text = raw.slice(start, end).trim();
  const eq = text.indexOf('=');
  if (eq <= 0) return undefined;
  const name = text.slice(0, eq).trim();
  let value = text.slice(eq + 1).trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) {
      return new ParseError(start, 'unterminated quoted string');
    }
    const unquoted = unquote(value);
    if (unquoted === undefined) return new ParseError(start, 'malformed escape in quoted string');
    value = unquoted;
  }
  params[name.toLowerCase()] = value;
  return undefined;
}

/** Removes surrounding quotes and resolves escapes; `undefined` on a dangling backslash. */
function unquote(text: string): string | undefined {
  const inner = text.slice(1, -1);
  let out = '';
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else {
      out += ch;
    }
  }
  return escaped ? undefined : out;
}

/**
 * Selects the best challenge to answer: prefer SHA-256 over MD5, and within
 * the same preference prefer one advertising `qop=auth`. Candidates lacking a
 * realm or nonce, or using an unsupported algorithm, are ignored.
 */
export function selectChallenge(challenges: DigestChallenge[]): DigestChallenge | undefined {
  let best: DigestChallenge | undefined;
  let bestScore = -1;
  for (const c of challenges) {
    if (c.realm === undefined || c.nonce === undefined) continue;
    if (c.rawAlgorithm !== undefined && !SUPPORTED_ALGORITHMS.has(c.rawAlgorithm.toUpperCase())) continue;
    const algScore = c.algorithm === 'SHA-256' ? 2 : c.algorithm === 'MD5' ? 1 : 0;
    const qopScore = c.qop !== undefined && c.qop.includes('auth') ? 1 : 0;
    const score = algScore * 2 + qopScore;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}