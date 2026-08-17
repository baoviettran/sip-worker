import type { BrowserPhoneOptions, DiagnosticLogger } from 'sip-worker';

// ---------------------------------------------------------------------------
// Public form interfaces
// ---------------------------------------------------------------------------

/** Raw values from the pilot configuration form. */
export interface PilotFormValues {
  readonly wssUrl: string;
  readonly sipDomain: string;
  readonly extension: string;
  readonly password: string;
  readonly testerLabel: string;
  readonly relayOnly: boolean;
  readonly iceServers: readonly PilotIceServerInput[];
}

/** A single ICE server entry (STUN or TURN) from the form. */
export interface PilotIceServerInput {
  readonly urls: string;
  readonly username: string;
  readonly credential: string;
}

/** Validated, frozen pilot configuration ready for phone construction. */
export interface PilotConfig {
  readonly wssUrl: string;
  readonly sipDomain: string;
  readonly extension: string;
  readonly password: string;
  readonly testerLabel: string;
  readonly relayOnly: boolean;
  readonly iceServers: ReadonlyArray<RTCIceServer>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ALLOWED_ICE_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:'] as const;

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} is required and must not be empty.`);
  }
  return trimmed;
}

function assertNoWhitespace(value: string, field: string): void {
  if (/\s/.test(value)) {
    throw new Error(`${field} must not contain whitespace.`);
  }
}

function assertNoSlashOrAt(value: string, field: string): void {
  if (value.includes('/') || value.includes('@')) {
    throw new Error(`${field} must not contain '/' or '@'.`);
  }
}

// ---------------------------------------------------------------------------
// Core parsing
// ---------------------------------------------------------------------------

/**
 * Validate raw form values and return a frozen {@link PilotConfig}.
 *
 * Throws on:
 * - Non-WSS signaling URL
 * - URL-embedded credentials
 * - Empty or whitespace-only domain/extension/password
 * - Invalid characters in domain or extension
 * - TURN servers with incomplete credentials
 */
export function parsePilotConfig(values: PilotFormValues): PilotConfig {
  // --- WSS URL validation ---
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(values.wssUrl);
  } catch {
    throw new Error('Invalid WSS URL: must be a valid URL with wss: protocol.');
  }

  if (parsedUrl.protocol !== 'wss:') {
    throw new Error('Invalid WSS URL: protocol must be wss:.');
  }

  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new Error('Invalid WSS URL: must not contain credentials in the URL.');
  }

  // --- Account fields ---
  const sipDomain = assertNonEmpty(values.sipDomain, 'SIP domain');
  assertNoWhitespace(sipDomain, 'SIP domain');
  assertNoSlashOrAt(sipDomain, 'SIP domain');

  const extension = assertNonEmpty(values.extension, 'Extension');
  assertNoWhitespace(extension, 'Extension');
  assertNoSlashOrAt(extension, 'Extension');

  const password = assertNonEmpty(values.password, 'Password');

  // --- ICE servers ---
  const iceServers: RTCIceServer[] = [];
  for (const ice of values.iceServers) {
    const urls = ice.urls.trim();
    if (urls.length === 0) continue;

    const hasUsername = ice.username.trim().length > 0;
    const hasCredential = ice.credential.trim().length > 0;
    if (hasUsername !== hasCredential) {
      throw new Error(
        'TURN username and credential must be provided together or both omitted.',
      );
    }

    const scheme = urls.split(':')[0]?.toLowerCase() + ':';
    if (!ALLOWED_ICE_SCHEMES.includes(scheme as typeof ALLOWED_ICE_SCHEMES[number])) {
      throw new Error(
        `Invalid ICE scheme: ${scheme}. Allowed: ${ALLOWED_ICE_SCHEMES.join(', ')}.`,
      );
    }

    const server: RTCIceServer = { urls };
    if (hasUsername) {
      server.username = ice.username.trim();
      server.credential = ice.credential.trim();
    }
    iceServers.push(server);
  }

  const config: PilotConfig = {
    wssUrl: values.wssUrl,
    sipDomain,
    extension,
    password,
    testerLabel: values.testerLabel,
    relayOnly: values.relayOnly,
    iceServers: Object.freeze(iceServers),
  };

  return Object.freeze(config);
}

// ---------------------------------------------------------------------------
// Mapping to BrowserPhoneOptions
// ---------------------------------------------------------------------------

/**
 * Map a validated {@link PilotConfig} to the public {@link BrowserPhoneOptions}
 * contract consumed by `BrowserPhone`.
 */
export function toBrowserPhoneOptions(
  config: PilotConfig,
  logger: DiagnosticLogger,
  microphoneDeviceId?: string,
): BrowserPhoneOptions {
  const identity = `sip:${config.extension}@${config.sipDomain}`;

  return {
    signaling: { url: config.wssUrl },
    account: {
      registrarUri: `sip:${config.sipDomain}`,
      aor: identity,
      contact: identity,
      username: config.extension,
      password: config.password,
    },
    media: {
      iceServers: config.iceServers,
      iceTransportPolicy: config.relayOnly ? 'relay' : 'all',
      holdDirection: 'sendonly',
      ...(microphoneDeviceId === undefined ? {} : { microphoneDeviceId }),
    },
    diagnostics: { logger },
  };
}

// ---------------------------------------------------------------------------
// Safe evidence summary
// ---------------------------------------------------------------------------

/**
 * Return a safe summary of a signaling URL containing only protocol, host,
 * port, and path. Strips credentials, query parameters, and fragments.
 */
export function safeEndpointSummary(url: string): string {
  try {
    const parsed = new URL(url);
    let summary = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    // Remove trailing slash only if there's a path beyond the root
    if (summary.endsWith('/') && parsed.pathname !== '/') {
      summary = summary.slice(0, -1);
    }
    return summary;
  } catch {
    return '[invalid-url]';
  }
}
