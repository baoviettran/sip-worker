/**
 * Public phone contracts for @sip-worker browser (v0.7).
 *
 * This module declares types and constants only. It reads no DOM, WebRTC, or
 * browser global at module scope so every phone entry point stays side-effect
 * free and import-safe in Node and test environments. WebRTC/DOM types appear
 * here only as type annotations.
 */

import type { BrowserMediaOptions, MediaSessionState } from '../media/index.js';
import type { MediaError, MediaErrorCode } from '@sip-worker/core';

/**
 * Per-operation control options reused by every cancellable public mutation.
 * Imported from {@link @sip-worker/core}, never redefined here.
 */
import type { OperationOptions } from '@sip-worker/core';
export type { OperationOptions };

/** Bounded reconnect policy for a phone's signaling transport. */
export interface ReconnectOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  readonly recoveryTimeoutMs: number;
}

/** Defaults applied to every omitted reconnect field. Frozen and immutable. */
export const DEFAULT_RECONNECT_OPTIONS: Readonly<ReconnectOptions> = Object.freeze({
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  maxAttempts: 8,
  recoveryTimeoutMs: 30_000,
});

/** Validation caps for reconnect fields (from the Global Constraints). */
export const MIN_RECONNECT_ATTEMPTS = 1;
export const MAX_RECONNECT_ATTEMPTS = 20;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const MAX_RECOVERY_TIMEOUT_MS = 120_000;

/** A survey/registration to signal-name on hold, by convention per RFC 3796. */
export type RemoteIdentity = {
  readonly uri: string;
  readonly displayName?: string;
};

/** Asynchronous, cancellable acquisition of refreshed short-lived ICE servers. */
export type IceServerProvider = (options: {
  readonly signal: AbortSignal;
}) => Promise<readonly RTCIceServer[]>;

/** Public product configuration accepted by the {@link BrowserPhone} root. */
export interface BrowserPhoneOptions {
  readonly signaling: {
    readonly url: string;
    readonly allowInsecureWebSocket?: boolean;
    readonly reconnect?: Partial<ReconnectOptions>;
  };
  readonly account: {
    readonly registrarUri: string;
    readonly aor: string;
    readonly contact: string;
    readonly username?: string;
    readonly password?: string;
  };
  readonly media?: BrowserMediaOptions & {
    readonly iceServerProvider?: IceServerProvider;
    readonly holdDirection?: 'sendonly' | 'inactive';
  };
  readonly diagnostics?: { readonly logger?: DiagnosticLogger };
}

/** Normalized (copied, validated, frozen) form of {@link BrowserPhoneOptions}. */
export type NormalizedBrowserPhoneOptions = {
  readonly signaling: {
    readonly url: string;
    readonly allowInsecureWebSocket: boolean;
    readonly reconnect: Readonly<ReconnectOptions>;
  };
  readonly account: {
    readonly registrarUri: string;
    readonly aor: string;
    readonly contact: string;
    readonly username?: string;
    readonly password?: string;
  };
  readonly media?: NormalizedMediaPhoneOptions;
  readonly diagnostics?: { readonly logger?: DiagnosticLogger };
};

/** Media option family after phone-level normalization/validation. */
export interface NormalizedMediaPhoneOptions extends BrowserMediaOptions {
  readonly iceServerProvider?: IceServerProvider;
  readonly holdDirection: 'sendonly' | 'inactive';
}

/** Orthogonal connection state of a {@link BrowserPhone}. */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'recovering'
  | 'failed'
  | 'disposed';

/** Orthogonal registration state of a {@link BrowserPhone}. */
export type RegistrationState =
  | 'unregistered'
  | 'registering'
  | 'registered'
  | 'recovering'
  | 'failed';

/** Call lifecycle state, orthogonal to signaling and hold. */
export type CallState =
  | 'new'
  | 'establishing'
  | 'established'
  | 'terminating'
  | 'terminated'
  | 'failed';

/** Call signaling health, orthogonal to lifecycle. */
export type CallSignalingState = 'stable' | 'recovering' | 'lost';

/** Independent local and remote hold flags for one call. */
export interface HoldState {
  readonly local: boolean;
  readonly remote: boolean;
}

/** Opaque local diagnostic handle for a call (never the SIP Call-ID). */
export type CallId = string;

/** Events emitted by a {@link BrowserPhone}. */
export interface BrowserPhoneEventMap {
  readonly connectionStateChanged: {
    readonly type: 'connectionStateChanged';
    readonly previous: ConnectionState;
    readonly state: ConnectionState;
  };
  readonly registrationStateChanged: {
    readonly type: 'registrationStateChanged';
    readonly previous: RegistrationState;
    readonly state: RegistrationState;
  };
  readonly incomingCall: {
    readonly type: 'incomingCall';
    readonly call: unknown; // IncomingBrowserCall — staged in a later task
  };
  readonly failed: {
    readonly type: 'failed';
    readonly error: Error;
  };
}

/** Events emitted by a {@link BrowserCall}. */
export interface BrowserCallEventMap {
  readonly stateChanged: {
    readonly type: 'stateChanged';
    readonly previous: CallState;
    readonly state: CallState;
  };
  readonly signalingStateChanged: {
    readonly type: 'signalingStateChanged';
    readonly previous: CallSignalingState;
    readonly state: CallSignalingState;
  };
  readonly holdStateChanged: {
    readonly type: 'holdStateChanged';
    readonly previous: HoldState;
    readonly state: HoldState;
  };
  readonly mutedChanged: {
    readonly type: 'mutedChanged';
    readonly previous: boolean;
    readonly state: boolean;
  };
  readonly mediaStateChanged: {
    readonly type: 'mediaStateChanged';
    readonly sessionId: string;
    readonly previous: MediaSessionState;
    readonly state: MediaSessionState;
    readonly reason?: MediaErrorCode;
  };
  readonly remoteAudio: {
    readonly type: 'remoteAudio';
    readonly sessionId: string;
    readonly stream: MediaStream;
  };
  readonly mediaFailed: {
    readonly type: 'mediaFailed';
    readonly sessionId: string;
    readonly error: MediaError;
  };
  readonly failed: {
    readonly type: 'failed';
    readonly error: Error;
  };
}

/**
 * Closed union of diagnostic event codes. Every code maps to one subsystem and
 * to a per-code allowlist of context keys (see {@link DiagnosticRecorder}).
 */
export type DiagnosticCode =
  | 'connection.connecting'
  | 'connection.connected'
  | 'connection.recovery_failed'
  | 'connection.closed'
  | 'registration.registering'
  | 'registration.registered'
  | 'registration.recovery_failed'
  | 'registration.unregistered'
  | 'call.established'
  | 'call.terminated'
  | 'call.failed'
  | 'media.failed'
  | 'lifecycle.disposed';

/** Diagnostic severity, as defined by the public schema. */
export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error';

/** Diagnostic subsystem, a closed union. */
export type DiagnosticSubsystem =
  | 'connection'
  | 'registration'
  | 'call'
  | 'media'
  | 'lifecycle';

/**
 * Vendor-neutral diagnostic record. `context` values are bounded and the keys
 * are allowlisted per code. Credentials, SDP, URIs, and raw browser text never
 * appear here.
 */
export interface DiagnosticRecord {
  readonly timestamp: number;
  readonly severity: DiagnosticSeverity;
  readonly subsystem: DiagnosticSubsystem;
  readonly code: DiagnosticCode;
  readonly connectionId?: string;
  readonly callId?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/** Injected sink that receives each emitted diagnostic record. */
export type DiagnosticLogger = (record: DiagnosticRecord) => void;

/** Read-only counts of the resources a phone currently owns. */
export interface ResourceSnapshot {
  readonly activeSocketGenerations: number;
  readonly reconnectAttempts: number;
  readonly reconnectTimers: number;
  readonly activeCalls: number;
  readonly activeNegotiations: number;
  readonly pendingOperations: number;
  readonly timers: number;
  readonly peerConnections: number;
  readonly localTracks: number;
  readonly lifecycleListeners: number;
  readonly deviceListeners: number;
}

export type {
  BrowserMediaOptions,
  MediaSessionState,
} from '../media/index.js';
export type { MediaError } from '@sip-worker/core';
