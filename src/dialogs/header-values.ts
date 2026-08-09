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
  return match?.[1] ?? (trimmed === '' ? undefined : trimmed);
}

/** Whether a route set entry is a strict (non-loose) router, i.e. has no `;lr`. */
export function isStrictRouter(route: string): boolean {
  return !/;\s*lr\b/i.test(route);
}

/** Build a fresh Via branch value that incorporates the magic cookie. */
export function makeBranch(branch: string): string {
  return `${MAGIC_COOKIE}-${branch}`;
}

/**
 * Parse a Record-Route header into a list of route URIs, in wire order.
 * Returns an empty array when the header is absent.
 */
export function parseRecordRoutes(headers: Headers): string[] {
  const values = headers.getAll('Record-Route');
  const out: string[] = [];
  for (const value of values) {
    for (const entry of value.split(',')) {
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
