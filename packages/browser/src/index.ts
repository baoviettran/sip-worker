export * from '@sip-worker/core';
export { BrowserWebSocketTransport } from './transport/index.js';
export type { BrowserWebSocketFactory, BrowserWebSocketLike } from './transport/index.js';
export { BrowserUserAgent } from './browser-user-agent.js';
export type {
  BrowserUserAgentOptions,
  BrowserUserAgentEventMap,
} from './browser-user-agent.js';
// The v0.5 browser media surface is public from the root too. Values overlap
// with the `sip-worker/media` subpath; types carry the composite surface that
// `BrowserUserAgentOptions` and the media facade reference.
export {
  createBrowserMediaEnvironment,
  MAX_MEDIA_TIMEOUT_MS,
  MEDIA_CODECS,
  DEFAULT_ICE_GATHERING_TIMEOUT_MS,
  DEFAULT_MEDIA_OPERATION_TIMEOUT_MS,
  validateBrowserMediaOptions,
  BrowserMedia,
} from './media/index.js';
export {
  // BrowserMedia is a value (class) and a type; the class export above covers the
  // type side. Re-declaring `export type { BrowserMedia }` would collide.
  BrowserMedia as BrowserMediaInterface,
} from './media/index.js';
export type {
  BrowserAudioDevice,
  BrowserMediaEnvironment,
  BrowserMediaEventMap,
  BrowserMediaOptions,
  MediaCodec,
  MediaSessionState,
  NormalizedMediaOptions,
  PrepareMediaOptions,
} from './media/index.js';
export { normalizeBrowserPhoneOptions } from './phone/index.js';
export { DiagnosticRecorder, MAX_CONTEXT_LENGTH } from './phone/index.js';
export type { DiagnosticRecorderOptions } from './phone/index.js';
export {
  PhoneRuntime,
  BrowserPhone,
  BrowserCall,
  OutgoingBrowserCall,
  IncomingBrowserCall,
} from './phone/index.js';
export type {
  BrowserPhoneInit,
  PhoneEnvironment,
  PhoneRuntimeCoreOptions,
} from './phone/index.js';
export {
  DEFAULT_RECONNECT_OPTIONS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  MAX_RECOVERY_TIMEOUT_MS,
  MIN_RECONNECT_ATTEMPTS,
} from './phone/index.js';
export type { OperationOptions } from './phone/index.js';
export type { DtmfOptions } from './phone/index.js';
export type {
  BrowserCallEventMap,
  BrowserPhoneEventMap,
  BrowserPhoneOptions,
  CallId,
  CallSignalingState,
  CallState,
  ConnectionState,
  DiagnosticCode,
  DiagnosticLogger,
  DiagnosticRecord,
  DiagnosticSeverity,
  DiagnosticSubsystem,
  HoldState,
  IceServerProvider,
  NormalizedBrowserPhoneOptions,
  NormalizedMediaPhoneOptions,
  ReconnectOptions,
  RegistrationState,
  RemoteIdentity,
  ResourceSnapshot,
} from './phone/index.js';
