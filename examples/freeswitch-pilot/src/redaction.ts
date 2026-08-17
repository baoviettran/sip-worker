const MAX_MESSAGE_LENGTH = 512;

// ---------------------------------------------------------------------------
// Redaction patterns (order matters — applied longest-secret-first)
// ---------------------------------------------------------------------------

/** Lines that match these patterns are removed entirely. */
const LINE_REMOVAL_PATTERNS: RegExp[] = [
  /^\s*Authorization:\s+Digest\s.*$/im,
  /^\s*Proxy-Authorization:\s+Digest\s.*$/im,
];

/** SDP/ICE candidates and ICE credentials are stripped by pattern. */
const SDP_ICE_PATTERNS: RegExp[] = [
  /^a=candidate:.*$/gm,
  /^a=ice-pwd:.*$/gm,
  /^a=ice-ufrag:.*$/gm,
];

/** SIP URI user-part redaction: sip:USER@domain → sip:[redacted]@domain */
const SIP_URI_PATTERN = /sip:([^@]*)@/gi;

/** Extract numeric IP addresses that appear as SDP connection addresses. */
const SDP_CONNECTION_PATTERN = /^c=IN\s+IP\d+\s+(\S+)/gm;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact sensitive information from diagnostic/log text.
 *
 * Removes: explicit secrets (longest-first), Authorization/Proxy-Authorization
 * lines, SDP candidate lines, ICE credentials, SIP URI user-parts, and
 * numeric IP addresses in SDP connection fields. Returns at most 512 chars.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let output = text;

  // 1. Replace explicit secrets longest-first so shorter substrings of the
  //    same secret are not matched before the full secret.
  const sorted = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    output = output.replaceAll(secret, '[redacted]');
  }

  // 2. Remove Authorization / Proxy-Authorization lines
  for (const pattern of LINE_REMOVAL_PATTERNS) {
    output = output.replace(pattern, '');
  }

  // 3. Remove SDP/ICE lines
  for (const pattern of SDP_ICE_PATTERNS) {
    output = output.replace(pattern, '');
  }

  // 4. Redact SDP connection addresses (c= lines with numeric IPs)
  output = output.replace(SDP_CONNECTION_PATTERN, 'c=IN IP$1 [redacted]');

  // 5. Redact SIP URI user parts
  output = output.replace(SIP_URI_PATTERN, 'sip:[redacted]@');

  // 6. Trim and cap length
  output = output.trim();

  if (output.length > MAX_MESSAGE_LENGTH) {
    output = output.slice(0, MAX_MESSAGE_LENGTH);
  }

  return output;
}

/**
 * Produce a safe, serializable error object from an Error with an optional
 * `code` property. Never returns the original error, its cause, or stack.
 */
export function safeError(
  error: Error & { code?: string },
  secrets: readonly string[],
): { readonly code: string | undefined; readonly message: string } {
  return {
    code: error.code,
    message: redactText(error.message, secrets),
  };
}
