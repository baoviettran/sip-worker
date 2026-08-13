/**
 * Serializable media protocol.
 *
 * The messages exchanged across the worker/main boundary are plain data
 * objects (strings only) so they survive `structuredClone`. Neither side of
 * this protocol imports Worker, window, navigator, or WebRTC — media is
 * transport/SIP-agnostic.
 */

import type { MediaErrorCode } from './errors.js';

/**
 * A fixed valid audio SDP carried by the stub. Opaque UTF-8 text to the
 * protocol; the stub replies with it for every offer/answer.
 */
export const STUB_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  'c=IN IP4 127.0.0.1',
  't=0 0',
  'm=audio 49170 RTP/AVP 0 8',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=sendrecv',
  '',
].join('\r\n');

export type MediaCommand =
  /**
   * Request a local SDP offer. `iceRestart`, when true, asks the media layer to
   * force an ICE restart on the next negotiation; omitted/false keeps the
   * current transport. Plain-data and structured-clone safe.
   */
  | { type: 'createOffer'; requestId: string; sessionId: string; iceRestart?: boolean }
  | { type: 'createAnswer'; requestId: string; sessionId: string; remoteSdp: string }
  | { type: 'setRemote'; requestId: string; sessionId: string; remoteSdp: string }
  /**
   * Fire-and-forget notification that the session is done. Carries no
   * requestId and expects no reply: the main side releases per-session state.
   * Kept plain-data/structured-clone-safe like every other command.
   */
  | { type: 'closeSession'; sessionId: string };

export type MediaReply =
  | { type: 'mediaResult'; requestId: string; sessionId: string; sdp?: string }
  /**
   * A typed failure reply. `code` is required and must be one of
   * `MEDIA_ERROR_CODES`; `message` is the only free-form text. No SDP, device,
   * ICE, or stack data crosses the boundary.
   */
  | { type: 'mediaError'; requestId: string; sessionId: string; message: string; code: MediaErrorCode };

export type MediaMessage = MediaCommand | MediaReply;

/**
 * The subset of messages that carry a `requestId` (i.e. every command except
 * the fire-and-forget `closeSession`, and every reply). Used to narrow after a
 * type check so callers can access `requestId` without a cast.
 */
export type MediaRequestMessage = Exclude<MediaCommand, { type: 'closeSession' }> | MediaReply;

/**
 * The transport boundary between the two media sides. Implemented in-memory by
 * tests and eventually by a MessageChannel/WorkerBridge; always structured-clone
 * safe in both directions.
 */
export interface MediaPort {
  postMessage(message: MediaMessage): void;
  subscribe(listener: (message: MediaMessage) => void): () => void;
}
