// Browser bundle fixture: imports and re-exports representative browser and
// core values from the installed `sip-worker` package. Bundled with esbuild
// targeting `platform: 'browser'` to prove the package builds with no Node
// polyfill or leakage. v0.5 pulls the browser media facade and its DOM types;
// v0.7 additionally pulls the BrowserPhone/BrowserCall product surface and its
// phone/recovery/diagnostic types so the bundle proves the whole v0.7 surface
// is browser-safe (no Node token, no import-time browser-global reads).
export {
  BrowserWebSocketTransport,
  BrowserUserAgent,
  BrowserPhone,
  BrowserCall,
  OutgoingBrowserCall,
  IncomingBrowserCall,
  UserAgent,
  SipError,
  MediaError,
  MEDIA_ERROR_CODES,
  DEFAULT_RECONNECT_OPTIONS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  MAX_RECOVERY_TIMEOUT_MS,
  MIN_RECONNECT_ATTEMPTS,
} from 'sip-worker';
export type {
  UserAgentOptions,
  Transport,
  BrowserUserAgentOptions,
  BrowserUserAgentEventMap,
  BrowserPhoneOptions,
  BrowserPhoneInit,
  BrowserPhoneEventMap,
  BrowserCallEventMap,
  ConnectionState,
  RegistrationState,
  CallState,
  CallSignalingState,
  HoldState,
  DiagnosticCode,
  ResourceSnapshot,
  PhoneDiagnostics,
  ReconnectOptions,
  DtmfOptions,
  IceServerProvider,
} from 'sip-worker';