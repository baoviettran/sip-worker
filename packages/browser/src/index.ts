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
