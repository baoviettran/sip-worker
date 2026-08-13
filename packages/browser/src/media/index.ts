/** Browser WebRTC media API. */
export { mapBrowserMediaError, createBrowserMediaEnvironment } from './error-mapper.js';
export {
  MAX_MEDIA_TIMEOUT_MS,
  MEDIA_CODECS,
  DEFAULT_ICE_GATHERING_TIMEOUT_MS,
  DEFAULT_MEDIA_OPERATION_TIMEOUT_MS,
  validateBrowserMediaOptions,
} from './types.js';
export type {
  BrowserAudioDevice,
  BrowserMediaEnvironment,
  BrowserMediaEventMap,
  BrowserMediaOptions,
  MediaCodec,
  MediaSessionState,
  PrepareMediaOptions,
} from './types.js';