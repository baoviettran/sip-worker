/**
 * Serializable media protocol.
 *
 * The messages exchanged across the worker/main boundary are plain data
 * objects (strings only) so they survive `structuredClone`. Neither side of
 * this protocol imports Worker, window, navigator, or WebRTC — media is
 * transport/SIP-agnostic.
 */

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
  | { type: 'createOffer'; requestId: string; sessionId: string }
  | { type: 'createAnswer'; requestId: string; sessionId: string; remoteSdp: string }
  | { type: 'setRemote'; requestId: string; sessionId: string; remoteSdp: string };

export type MediaReply =
  | { type: 'mediaResult'; requestId: string; sessionId: string; sdp?: string }
  | { type: 'mediaError'; requestId: string; sessionId: string; message: string };

export type MediaMessage = MediaCommand | MediaReply;

/**
 * The transport boundary between the two media sides. Implemented in-memory by
 * tests and eventually by a MessageChannel/WorkerBridge; always structured-clone
 * safe in both directions.
 */
export interface MediaPort {
  postMessage(message: MediaMessage): void;
  subscribe(listener: (message: MediaMessage) => void): () => void;
}
