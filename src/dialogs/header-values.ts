import type { Headers } from '../messages/headers.js';

/** The RFC 3261 magic cookie that must appear in the top Via branch. */
export const MAGIC_COOKIE = 'z9hG4bK';

/** Extracts the `;tag=...` parameter from a header value (e.g. From/To). */
export function extractTag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/;tag=([^;,\s]+)/);
  return match?.[1];
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

/** Whether a route set entry is a strict (non-loose) router, i.e. has no `;lr`. */
export function isStrictRouter(route: string): boolean {
  return !/;\s*lr\b/i.test(route);
}

/** Build a fresh Via branch value that incorporates the magic cookie. */
export function makeBranch(branch: string): string {
  return `${MAGIC_COOKIE}-${branch}`;
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
