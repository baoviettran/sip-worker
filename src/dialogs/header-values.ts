import type { Headers } from '../messages/headers.js';
import type { TransportToken } from '../transport/transport.js';

/** The RFC 3261 magic cookie that must appear in the top Via branch. */
export const MAGIC_COOKIE = 'z9hG4bK';

/** Locate the header-parameter section without treating URI contents as parameters. */
function headerParameterStart(value: string): number {
  let quoted = false;
  let escaped = false;
  let angleStart = -1;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '<') {
      angleStart = index;
    } else if (character === '>' && angleStart !== -1) {
      return index + 1;
    }
  }

  // An unmatched name-addr is malformed; do not mine its URI for a tag.
  return angleStart === -1 ? 0 : value.length;
}

interface LocatedTag {
  readonly value: string;
  /** Index of the semicolon introducing the tag parameter. */
  readonly start: number;
  /** Index immediately after the tag parameter, before the next delimiter. */
  readonly end: number;
}

/**
 * Locate the case-insensitive tag header parameter and its exact source span.
 * Quoted display names, quoted parameter values, and name-addr URI parameters
 * are deliberately excluded.
 */
function locateTag(value: string): LocatedTag | undefined {
  const scanStart = headerParameterStart(value);
  let quoted = false;
  let escaped = false;
  let parameterStart = -1;
  let delimiterStart = -1;

  for (let index = scanStart; index <= value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;

    if (character === ';') {
      if (parameterStart !== -1) {
        const candidate = value.slice(parameterStart, index).trim();
        const match = candidate.match(/^tag\s*=\s*([!#$%&'*+\-.^_|\x60~0-9A-Za-z]+)\s*$/i);
        if (match !== null) return { value: match[1]!, start: delimiterStart, end: index };
      }
      delimiterStart = index;
      parameterStart = index + 1;
      continue;
    }

    if (character === ',' || index === value.length) {
      if (parameterStart !== -1) {
        const candidate = value.slice(parameterStart, index).trim();
        const match = candidate.match(/^tag\s*=\s*([!#$%&'*+\-.^_|\x60~0-9A-Za-z]+)\s*$/i);
        if (match !== null) return { value: match[1]!, start: delimiterStart, end: index };
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * Extract the case-insensitive tag header parameter from a From/To value.
 * Quoted display names, quoted parameter values, and name-addr URI parameters
 * are deliberately excluded.
 */
export function extractTag(value: string | undefined): string | undefined {
  return value === undefined ? undefined : locateTag(value)?.value;
}

/** Extract the URI from an address, including a bare Contact / Record-Route URI. */
export function extractUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  if (match !== null) return match[1];
  if (trimmed === '') return undefined;

  // On a bare Contact addr-spec, known Contact header parameters are not URI
  // parameters. Keep URI parameters before them (for example, ;transport=tcp).
  return trimmed.match(/^(.*?);\s*(?:expires|q)\s*=/i)?.[1]?.trim() ?? trimmed;
}

/**
 * Extract the URI identity from a From/To address.
 *
 * A bare addr-spec has no angle brackets to separate URI parameters from
 * header parameters. Preserve every URI parameter while removing only the
 * recognized `tag` header parameter used to form the dialog identity.
 */
export function extractAddressUri(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const uri = extractUri(trimmed);
  if (uri === undefined || headerParameterStart(trimmed) !== 0) return uri;
  const tag = locateTag(trimmed);
  if (tag === undefined) return uri;
  return extractUri(
    `${trimmed.slice(0, tag.start)}${trimmed.slice(tag.end)}`,
  );
}

/** Whether a route set entry is a strict (non-loose) router, i.e. has no `;lr`. */
export function isStrictRouter(route: string): boolean {
  return !/;\s*lr\b/i.test(route);
}

/** Build a fresh Via branch value that incorporates the magic cookie. */
export function makeBranch(branch: string): string {
  return `${MAGIC_COOKIE}-${branch}`;
}

/** The transport protocol and sent-by used to stamp a new top Via header. */
export interface ViaConfig {
  /** Via transport token (RFC 3261 20.42 / RFC 7118). */
  readonly token: TransportToken;
  /** Caller-supplied sent-by host:port (never inferred from a remote socket). */
  readonly sentBy: string;
}

/**
 * Build a top Via header value from the transport token and a caller-supplied
 * sent-by, with a fresh RFC 3261 magic-cookie branch. The sent-by is always
 * explicit — never inferred from a remote socket endpoint.
 */
export function makeTopVia(config: ViaConfig, branch: string): string {
  return `SIP/2.0/${config.token} ${config.sentBy};branch=${branch}`;
}

/** Split a comma-separated address list without splitting quoted display names or URIs. */
function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '<') {
      angleDepth += 1;
    } else if (character === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (character === ',' && angleDepth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries;
}

/**
 * Parse a Record-Route header into a list of route URIs, in wire order.
 * Returns an empty array when the header is absent.
 */
export function parseRecordRoutes(headers: Headers): string[] {
  const values = headers.getAll('Record-Route');
  const out: string[] = [];
  for (const value of values) {
    for (const entry of splitAddressList(value)) {
      const trimmed = entry.trim();
      if (trimmed === '') continue;
      const uri = extractUri(trimmed) ?? trimmed;
      out.push(uri);
    }
  }
  return out;
}

/**
 * Build the UAC route set as the reversed Record-Route order (RFC 3261 12.1.1).
 * The top of the route set is the last Record-Route entry.
 */
export function reverseRouteSet(recordRoutes: string[]): string[] {
  return [...recordRoutes].reverse();
}
