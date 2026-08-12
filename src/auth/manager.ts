/**
 * Immutable authentication retry manager.
 *
 * Takes an original request, the 401/407 that challenged it, and credentials,
 * then returns a NEW request - cloned from the original - carrying the
 * retried Digest authorization. The original message, its headers and its
 * body are never mutated.
 *
 * Retains (byte-identical where bytes are involved): body, Call-ID, From, To,
 * Contact, Route, request URI, Max-Forwards and Content-Type.
 * Replaces: numeric CSeq (incremented once), Via (exactly one, new branch),
 * and the appropriate auth header (Authorization or Proxy-Authorization
 * mirroring the challenge header the response carried). The opposite auth
 * header is deleted, so the "one Via / one auth header" invariants hold after
 * the retry.
 *
 * Nonce counts are keyed by realm+nonce and start at `00000001` per new
 * nonce. cnonce and the Via branch come from the injected `IdGenerator`.
 * Ordinary retries are keyed by requestId and budgeted to three per request.
 * A `stale=true` challenge uses the new nonce without consuming that ordinary
 * budget, but is bounded by its own absolute retry cap.
 */

import { makeRequest } from '../messages/message.js';
import { Headers } from '../messages/headers.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import type { IdGenerator } from '../dialogs/dialog.js';
import { makeBranch } from '../dialogs/header-values.js';
import { SipError } from '../errors.js';
import { parseDigestChallenges, selectChallenge } from './challenge.js';
import type { DigestChallenge } from './challenge.js';
import { computeDigest } from './digest.js';
import { renderAuthorization } from './authorization.js';

export type { IdGenerator } from '../dialogs/dialog.js';

/** Per-request context for a single 401/407-answer. */
export interface AuthContext {
  readonly requestId: string;
  readonly request: SipRequestMessage;
  readonly response: SipResponseMessage;
  readonly credentials: { username: string; password: string };
}

/** Why a retry could not be built. `exhausted` = retry budget spent. */
export type AuthFailure = {
  readonly type: 'unsupported' | 'exhausted' | 'malformed';
  readonly error: SipError;
};

/** Default cap on ordinary (non-stale) retries per requestId. */
const DEFAULT_MAX_RETRIES = 3;
/** Absolute cap on stale=true retries within one logical exchange. */
const DEFAULT_MAX_STALE_RETRIES = 3;

/** Cap on distinct realm+nonce counters retained; evict the oldest insertion. */
const MAX_NONCE_COUNTS = 64;

const AUTH_HEADERS = ['Authorization', 'Proxy-Authorization'] as const;
const CHALLENGE_HEADERS = ['WWW-Authenticate', 'Proxy-Authenticate'] as const;

const decoder = new TextDecoder('utf-8');

/** A single digest challenge the response wants answered, plus its origin. */
interface AnsweredChallenge {
  readonly challenge: DigestChallenge;
  readonly proxy: boolean;
}

/**
 * Extracts the Digest challenge to answer. A 407 is challenged via
 * Proxy-Authenticate and answered via Proxy-Authorization; every other
 * challenge (401 typically) comes via WWW-Authenticate and is answered via
 * Authorization. Returns an error when no challenge is present, none parses,
 * or none is supported.
 */
function readChallenge(
  response: SipResponseMessage,
): AnsweredChallenge | AuthFailure {
  const proxyAuthenticate = response.headers.getAll('Proxy-Authenticate');
  const challengeValues =
    proxyAuthenticate.length > 0
      ? proxyAuthenticate
      : response.headers.getAll('WWW-Authenticate');
  const proxy = proxyAuthenticate.length > 0;

  if (challengeValues.length === 0) {
    return {
      type: 'malformed',
      error: new SipError(
        response.statusCode,
        `cannot retry: no Digest challenge (${CHALLENGE_HEADERS.join('/')}) present in ${response.statusCode} response`,
        'PROTOCOL_ERROR',
      ),
    };
  }

  const parsed = parseDigestChallenges(challengeValues);
  if (!parsed.ok) {
    return {
      type: 'malformed',
      error: new SipError(response.statusCode, `cannot retry: malformed Digest challenge (${parsed.error.message})`, 'PROTOCOL_ERROR'),
    };
  }

  const challenge = selectChallenge(parsed.value);
  if (challenge === undefined) {
    return {
      type: 'unsupported',
      error: new SipError(response.statusCode, 'cannot retry: no supported Digest challenge received', 'AUTHENTICATION_UNSUPPORTED'),
    };
  }

  return { challenge, proxy };
}

/**
 * Manages retry state scoped to one client/server exchange. Call `retry` for
 * each 401/407 received; each call returns a fresh request and never mutates
 * the input.
 */
export class AuthManager {
  private readonly idGenerator: IdGenerator;
  private readonly maxOrdinary: number;
  private readonly retriesByRequest: Map<string, number> = new Map();
  private readonly staleRetriesByRequest: Map<string, number> = new Map();
  private readonly challengesByRequest: Map<string, AnsweredChallenge> = new Map();
  private readonly nonceCounts: Map<string, number> = new Map();

  constructor(idGenerator: IdGenerator, maxOrdinary = DEFAULT_MAX_RETRIES) {
    this.idGenerator = idGenerator;
    this.maxOrdinary = maxOrdinary;
  }

  /** Number of distinct nonce counters currently retained. */
  get nonceCountSize(): number {
    return this.nonceCounts.size;
  }

  /** Number of in-flight request retry budgets currently retained. */
  get retriesByRequestSize(): number {
    let size = this.retriesByRequest.size;
    for (const requestId of this.staleRetriesByRequest.keys()) {
      if (!this.retriesByRequest.has(requestId)) size += 1;
    }
    return size;
  }

  /** Mark an exchange (by requestId) complete so its retry budget is released. */
  settle(requestId: string): void {
    this.retriesByRequest.delete(requestId);
    this.staleRetriesByRequest.delete(requestId);
    this.challengesByRequest.delete(requestId);
  }

  /**
   * Builds the retried request, or an `AuthFailure` when the response cannot
   * be answered. Never mutates `context.request`.
   */
  retry(context: AuthContext): SipRequestMessage | AuthFailure {
    const { requestId, request, response, credentials } = context;
    const answered = readChallenge(response);
    if ('error' in answered) return answered;
    const { challenge } = answered;

    // The REGISTER path has no meaningful entity body, so `auth-int` integrity
    // adds nothing and cannot be answered without a body (computeDigest would
    // reject it). Decline an auth-int-only challenge outright: this must happen
    // before the budget bookkeeping below, so an unsupported qop never consumes
    // an ordinary retry slot.
    if (
      challenge.qop !== undefined &&
      challenge.qop.includes('auth-int') &&
      !challenge.qop.includes('auth')
    ) {
      return {
        type: 'unsupported',
        error: new SipError(
          response.statusCode,
          'authentication qop "auth-int" is not supported',
          'AUTHENTICATION_UNSUPPORTED',
        ),
      };
    }

    const budget = challenge.stale === true
      ? this.staleRetriesByRequest
      : this.retriesByRequest;
    const maximum = challenge.stale === true ? DEFAULT_MAX_STALE_RETRIES : this.maxOrdinary;
    const spent = budget.get(requestId) ?? 0;
    if (spent >= maximum) {
      return {
        type: 'exhausted',
        error: new SipError(response.statusCode, `authentication retry budget exhausted for request "${requestId}"`, 'AUTHENTICATION_FAILED'),
      };
    }
    budget.set(requestId, spent + 1);

    this.challengesByRequest.set(requestId, answered);
    return this.authorize(request, credentials, answered, true);
  }

  /**
   * Re-render Digest for a request changed within the same logical exchange.
   * This consumes the next nonce-count but not another challenge retry slot,
   * and preserves the request's already-allocated CSeq and Via branch.
   */
  reauthorize(context: Omit<AuthContext, 'response'>): SipRequestMessage | AuthFailure {
    const answered = this.challengesByRequest.get(context.requestId);
    if (answered === undefined) {
      return {
        type: 'malformed',
        error: new SipError(0, `cannot regenerate authentication for unknown exchange "${context.requestId}"`, 'PROTOCOL_ERROR'),
      };
    }
    return this.authorize(context.request, context.credentials, answered, false);
  }

  private authorize(
    request: SipRequestMessage,
    credentials: AuthContext['credentials'],
    answered: AnsweredChallenge,
    advanceTransaction: boolean,
  ): SipRequestMessage {
    const { challenge, proxy } = answered;
    const cnonce = this.idGenerator.branch();
    const nc = this.nextNonceCount(challenge.realm, challenge.nonce);
    // Only a valid qop token reaches computeDigest/renderAuthorization. The
    // challenge.qop array may retain unrecognized verbatim tokens (e.g. an
    // unquoted multi-word value); pick the first exact 'auth'. 'auth-int' is
    // declined above (unsupported on this path), so it never reaches the digest.
    const qop = challenge.qop?.find((value) => value === 'auth');

    const responseDigest = computeDigest({
      algorithm: challenge.algorithm ?? 'MD5',
      username: credentials.username,
      password: credentials.password,
      realm: challenge.realm,
      nonce: challenge.nonce,
      method: request.method,
      uri: request.uri,
      qop,
      nc,
      cnonce,
    });

    const rendered = renderAuthorization(
      {
        username: credentials.username,
        realm: challenge.realm,
        nonce: challenge.nonce,
        uri: request.uri,
        response: responseDigest,
        algorithm: challenge.algorithm,
        qop,
        nc,
        cnonce,
        opaque: challenge.opaque,
      },
      proxy,
    );

    // renderAuthorization returns the full header line, e.g.
    // `Authorization: Digest username="alice", …`. Split at ": " to get the
    // header name and the field value.
    const colon = rendered.indexOf(':');
    const headerName = rendered.slice(0, colon);
    const fieldValue = rendered.slice(colon + 2);

    const headers = request.headers.clone();
    if (advanceTransaction) {
      headers.set('CSeq', nextCSeq(request.headers, request.method));
      headers.set('Via', nextVia(this.idGenerator, request.headers));
    }
    headers.set(headerName, fieldValue);
    for (const name of AUTH_HEADERS) {
      if (name !== headerName) headers.delete(name);
    }

    // Preserve the original body object by copying its bytes.
    const body = new Uint8Array(request.body.length);
    body.set(request.body);

    return makeRequest(request.method, request.uri, headers, body);
  }

  /**
   * Serializes an exchange for logging with every credential byte masked, so
   * no header entry (or body) can leak the secret. Every value is a fresh
   * placeholder: the original username/password never appear.
   */
  static redact(context: {
    requestId: string;
    request: SipRequestMessage;
    response: SipResponseMessage;
    credentials: { username: string; password: string };
  }): Record<string, unknown> {
    const redactHeaders = (headers: Headers): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      for (const [name] of headers.entries()) {
        out[name] = ['[redacted]'];
      }
      return out;
    };
    return {
      requestId: context.requestId,
      request: {
        method: context.request.method,
        uri: context.request.uri,
        headers: redactHeaders(context.request.headers),
        bodyLength: context.request.body.length,
        body: decoder.decode(context.request.body).replace(/[^\s]+/g, '[redacted]'),
      },
      response: {
        statusCode: context.response.statusCode,
        reasonPhrase: context.response.reasonPhrase,
        headers: redactHeaders(context.response.headers),
        bodyLength: context.response.body.length,
        body: decoder.decode(context.response.body).replace(/[^\s]+/g, '[redacted]'),
      },
      credentials: {
        username: '[redacted]',
        password: '[redacted]',
      },
    };
  }

  private nextNonceCount(realm: string, nonce: string): string {
    const key = `${realm.length}:${realm}${nonce}`;
    if (this.nonceCounts.size >= MAX_NONCE_COUNTS && !this.nonceCounts.has(key)) {
      // Map insertion order is oldest-first; evict it to stay under the cap.
      const oldest = this.nonceCounts.keys().next().value;
      if (oldest !== undefined) this.nonceCounts.delete(oldest);
    }
    const next = (this.nonceCounts.get(key) ?? 0) + 1;
    this.nonceCounts.set(key, next);
    return next.toString(16).padStart(8, '0');
  }
}

/** Returns the CSeq with its numeric field incremented exactly once. */
function nextCSeq(headers: Headers, method: string): string {
  const cseq = headers.get('CSeq');
  if (cseq === undefined) return `1 ${method}`;
  const match = cseq.match(/^(\d+)\s+(.+)$/);
  if (match === null) return cseq;
  return `${String(Number.parseInt(match[1]!, 10) + 1)} ${match[2]}`;
}

/**
 * Builds a fresh Via from the original top Via, replacing only the branch and
 * keeping every other param (`;received`, `;comp`, `;transport`, `;rport`, …)
 * verbatim. Falls back to a UDP sent-by when no Via is present.
 */
function nextVia(idGenerator: IdGenerator, headers: Headers): string {
  const via = headers.get('Via');
  if (via === undefined) {
    return `SIP/2.0/UDP 192.0.2.1:5060;branch=${makeBranch(idGenerator.branch())}`;
  }
  const branch = makeBranch(idGenerator.branch());
  // Replace the branch param in place; keep everything else.
  const reBranch = /(^|;|\s)branch=[^;]*/;
  return reBranch.test(via)
    ? via.replace(/branch=[^;]*/, `branch=${branch}`)
    : `${via};branch=${branch}`;
}