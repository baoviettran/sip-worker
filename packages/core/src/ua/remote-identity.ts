/**
 * Immutable, size-bounded remote participant identity parsed from a From/To
 * address header. Used by call owners to expose who is on the other side
 * without depending on a live dialog or copying the value into error objects.
 */

import { extractAddressUri, extractTag } from '../dialogs/header-values.js';

/** Max length for any parsed identity field (bounds hostile header input). */
const MAX_FIELD_LENGTH = 256;

export interface RemoteIdentity {
  readonly uri: string;
  readonly displayName?: string;
  readonly tag?: string;
}

function bound(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? value.slice(0, MAX_FIELD_LENGTH) : value;
}

/**
 * Parse an immutable remote identity from an address header value. Returns
 * `undefined` when no meaningful address URI can be extracted. The returned
 * object is frozen (immutable) and every field is size-bounded.
 */
export function parseRemoteIdentity(address: string | undefined): RemoteIdentity | undefined {
  if (address === undefined) return undefined;
  const uri = extractAddressUri(address);
  if (uri === undefined || uri === '') return undefined;

  // Display name is the part before a name-addr angle bracket, if any.
  const angle = address.indexOf('<');
  let displayName: string | undefined;
  if (angle > 0) {
    const candidate = address.slice(0, angle).trim().replace(/^"?([^"]*)"?$/, '$1').trim();
    if (candidate !== '') displayName = bound(candidate);
  }

  const tag = extractTag(address);
  return Object.freeze({
    uri: bound(uri),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(tag !== undefined ? { tag } : {}),
  });
}
