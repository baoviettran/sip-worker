/** Browser WebRTC media API. */
export { mapBrowserMediaError, createBrowserMediaEnvironment } from './error-mapper.js';
export { MediaDeviceManager } from './device-manager.js';
export { applyAudioCodecPolicy } from './codec-policy.js';
export type { AudioCodecPolicyTarget } from './codec-policy.js';
export { WebRtcMediaSession } from './session.js';
export type { WebRtcMediaSessionDeps } from './session.js';
export { createMediaPortPair } from './port-pair.js';
export type { MediaPortPair } from './port-pair.js';
export { WebRtcMediaManager } from './media-manager.js';
export type { WebRtcMediaManagerDeps, MediaManagerClock } from './media-manager.js';
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