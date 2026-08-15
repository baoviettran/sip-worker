// Browser bundle fixture: imports and re-exports representative browser and
// core values from the installed `sip-worker` package. Bundled with esbuild
// targeting `platform: 'browser'` to prove the package builds with no Node
// polyfill or leakage. v0.5 also pulls the browser media facade and its DOM
// types so the bundle proves the DOM-typed media surface is browser-safe.
export {
  BrowserWebSocketTransport,
  BrowserUserAgent,
  UserAgent,
  SipError,
  MediaError,
  MEDIA_ERROR_CODES,
} from 'sip-worker';
export type {
  UserAgentOptions,
  Transport,
  BrowserUserAgentOptions,
  BrowserUserAgentEventMap,
} from 'sip-worker';