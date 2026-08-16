import type {
  BrowserAudioDevice,
  BrowserMediaEnvironment,
} from '../../src/media/types.js';

type DeviceListener = (event: Event) => void;

/** The ICE username-fragment of an SDP string, or null when absent/unparseable. */
function ufragOf(sdp: string | null | undefined): string | null {
  if (typeof sdp !== 'string') return null;
  const match = sdp.match(/^a=ice-ufrag:(\S+)$/m);
  return match ? (match[1] ?? null) : null;
}

let ufragCounter = 0;
let pwdCounter = 0;

/** Deterministic fresh ICE credentials, so restarts are distinguishable. */
function nextUfrag(): string {
  return `u${(ufragCounter += 1).toString(36)}`;
}

function nextPwd(): string {
  return `p${(pwdCounter += 1).toString(36)}`;
}

/**
 * Hand-rolled fake {@link BrowserMediaEnvironment} for deterministic media
 * tests. It exposes a scriptable `mediaDevices` and records each call so later
 * tasks (session construction, devices, codecs) can drive and assert on it
 * without a real browser.
 */
export class FakeMediaEnvironment implements BrowserMediaEnvironment {
  readonly mediaDevices: Pick<MediaDevices,
    'getUserMedia' | 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>;

  readonly peerConnectionCalls: RTCConfiguration[] = [];
  readonly mediaStreamCalls: MediaStreamTrack[][] = [];
  readonly audioCapabilitiesCalls: number[] = [];

  /** Queue of results delivered to the next {@link FakeMediaEnvironment.createPeerConnection}. */
  queuedPeerConnections: RTCPeerConnection[] = [];
  /** Queue of results delivered to the next {@link FakeMediaEnvironment.createMediaStream}. */
  queuedMediaStreams: MediaStream[] = [];
  /** Value returned by {@link FakeMediaEnvironment.getAudioCapabilities}, or null to force failure. */
  audioCapabilities: RTCRtpCapabilities | null = makeDefaultCapabilities();

  /**
   * Queue of results delivered to the next {@link FakeMediaEnvironment.getUserMedia},
   * in order. Each entry is either a stream, a promise (for controlled/abort
   * tests), or a rejection thunk. Entries may be ignored by the device pre-check
   * when the configured device list has no matching input.
   */
  queuedUserMedia: Array<MediaStream | Promise<MediaStream> | (() => Promise<MediaStream>)> = [];
  /** Constraints passed to each {@link FakeMediaEnvironment.getUserMedia} call. */
  readonly getUserMediaConstraints: MediaStreamConstraints[] = [];

  private readonly listeners = new Map<string, Set<DeviceListener>>();

  constructor(devices: BrowserAudioDevice[] = []) {
    const ref = this;
    this.mediaDevices = {
      async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
        return ref.fakeGetUserMedia(constraints);
      },
      async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        return ref.fakeEnumerateDevices(devices);
      },
      addEventListener(type: string, listener: DeviceListener): void {
        ref.addListener(type, listener);
      },
      removeEventListener(type: string, listener: DeviceListener): void {
        ref.removeEventListener(type, listener);
      },
    };
  }

  /** Bridge into the shared listener set for the mediaDevices surface. */
  private addListener(type: string, listener: DeviceListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: DeviceListener): void {
    (this.listeners.get(type) ?? new Set()).delete(listener);
  }

  /** Default `getUserMedia`: deliver the next queued result or reject. */
  private async fakeGetUserMedia(
    constraints?: MediaStreamConstraints,
  ): Promise<MediaStream> {
    this.getUserMediaConstraints.push(constraints ?? {});
    const next = this.queuedUserMedia.shift();
    if (next instanceof Promise) {
      return next;
    }
    if (typeof next === 'function') {
      return next();
    }
    if (next !== undefined) {
      return next;
    }
    throw new Error('getUserMedia called with empty queuedUserMedia');
  }

  /** Default `enumerateDevices`: map the configured devices to MediaDeviceInfo shapes. */
  private fakeEnumerateDevices(devices: BrowserAudioDevice[]): MediaDeviceInfo[] {
    return devices.map((device) => ({ ...device }) as MediaDeviceInfo);
  }

  /** Emit `devicechange` to registered listeners (privacy event only). */
  emitDeviceChange(): void {
    const event = new Event('devicechange');
    for (const listener of [...(this.listeners.get('devicechange') ?? [])]) {
      listener(event);
    }
  }

  createPeerConnection(configuration: RTCConfiguration): RTCPeerConnection {
    this.peerConnectionCalls.push(configuration);
    const next = this.queuedPeerConnections.shift();
    if (next === undefined) {
      throw new Error('createPeerConnection called with empty queuedPeerConnections');
    }
    return next;
  }

  createMediaStream(tracks?: MediaStreamTrack[]): MediaStream {
    this.mediaStreamCalls.push(tracks ?? []);
    const next = this.queuedMediaStreams.shift();
    if (next === undefined) {
      throw new Error('createMediaStream called with empty queuedMediaStreams');
    }
    return next;
  }

  getAudioCapabilities(): RTCRtpCapabilities | null {
    this.audioCapabilitiesCalls.push(1);
    return this.audioCapabilities;
  }
}

/** A minimal, codec-covered capabilities object for tests that sort codes. */
function makeDefaultCapabilities(): RTCRtpCapabilities {
  return {
    codecs: [
      { mimeType: 'audio/PCMU', clockRate: 8000 },
      { mimeType: 'audio/PCMA', clockRate: 8000 },
      { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { mimeType: 'audio/telephone-event', clockRate: 8000 },
    ],
    headerExtensions: [],
  };
}

/**
 * A session test needs precise control over peer-connection events. Rather than
 * expand the shared environment further, the fake below models the full surface
 * a real `RTCPeerConnection` exposes to the media session, including
 * `setCodecPreferences`, `replaceTrack`, ICE gathering/connection states,
 * `restartIce`, remote (`ontrack`) delivery, and `close()`.
 */

/** Fake audio track with stop/replace/enabled observability. */
class FakeMediaStreamTrack {
  stopped = false;
  enabled = true;
  readonly kind: string;
  readonly id: string;
  constructor(kind: string, public readonly label = `fake-${kind}-${Math.random().toString(36).slice(2)}`) {
    this.kind = kind;
    this.id = label;
  }
  stop(): void { this.stopped = true; }
}

/** Fake stream over a caller-provided list of tracks. */
class FakeStream {
  private readonly tracks: FakeMediaStreamTrack[];
  readonly id: string;
  constructor(tracks: FakeMediaStreamTrack[] = [], hasRemote = false) {
    this.tracks = tracks;
    this.id = `stream-${hasRemote ? 'r' : 'l'}-${Math.random().toString(36).slice(2)}`;
  }
  getTracks(): FakeMediaStreamTrack[] { return [...this.tracks]; }
  getAudioTracks(): FakeMediaStreamTrack[] { return this.tracks.filter((t) => t.kind === 'audio'); }
  addTrack(track: FakeMediaStreamTrack): void { this.tracks.push(track); }
  stop(): void { for (const t of this.tracks) t.stop(); }
}

/**
 * Fake {@link RTCDTMFSender}: records `insertDTMF` calls, exposes `toneBuffer`,
 * and lets tests drive `tonechange` events deterministically. `emitToneChange`
 * models the browser firing a `tonechange` event with the given tone while
 * advancing the tone buffer.
 */
class FakeRtpDtmfSender {
  canInsertDTMF = true;
  readonly insertDTMFCalls: Array<{ tones: string; duration: number; interToneGap: number }> = [];
  toneBuffer = '';
  private readonly toneListeners = new Set<(event: { tone: string }) => void>();

  insertDTMF(tones: string, duration?: number, interToneGap?: number): void {
    this.insertDTMFCalls.push({
      tones,
      duration: duration ?? 100,
      interToneGap: interToneGap ?? 70,
    });
    this.toneBuffer = tones;
  }

  addEventListener(_type: 'tonechange', listener: (event: { tone: string }) => void): void {
    this.toneListeners.add(listener);
  }

  removeEventListener(_type: 'tonechange', listener: (event: { tone: string }) => void): void {
    this.toneListeners.delete(listener);
  }

  /** Emit a `tonechange` event; the final `''` empties the tone buffer. */
  emitToneChange(tone: string): void {
    this.toneBuffer = tone;
    for (const listener of [...this.toneListeners]) {
      listener({ tone });
    }
  }

  /** How many `tonechange` listeners are currently attached (0 after cleanup). */
  get tonechangeListenerCount(): number {
    return this.toneListeners.size;
  }
}

/** Fake sender; records replaceTrack, the attached track, and a DTMF sender. */
class FakeRtpSender {
  track: FakeMediaStreamTrack | null = null;
  readonly replaceTrackCalls: Array<MediaStreamTrack | null> = [];
  failNextReplaceTrack = false;
  readonly dtmf = new FakeRtpDtmfSender();
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.replaceTrackCalls.push(track);
    if (this.failNextReplaceTrack) {
      this.failNextReplaceTrack = false;
      throw new Error('replaceTrack failed');
    }
    this.track = (track ?? null) as unknown as FakeMediaStreamTrack;
  }

  // Convenience DTMF surface forwarding to the owned RTCDTMFSender fake, so the
  // verbatim test snippet reads `sender.insertDTMFCalls` / `sender.emitToneChange`
  // / `sender.canInsertDTMF` while the session code uses `sender.dtmf.*`.
  get insertDTMFCalls(): Array<{ tones: string; duration: number; interToneGap: number }> {
    return this.dtmf.insertDTMFCalls;
  }
  get canInsertDTMF(): boolean {
    return this.dtmf.canInsertDTMF;
  }
  set canInsertDTMF(value: boolean) {
    this.dtmf.canInsertDTMF = value;
  }
  emitToneChange(tone: string): void {
    this.dtmf.emitToneChange(tone);
  }
}

/** Fake receiver; surfaces whatever remote track the test delivers. */
class FakeRtpReceiver {
  track: FakeMediaStreamTrack | null = null;
}

/** Fake transceiver with a sender, codec preferences, and a direction. */
class FakeRtpTransceiver {
  sender: FakeRtpSender;
  readonly receiver: FakeRtpReceiver;
  direction: RTCRtpTransceiverDirection;
  setCodecPreferencesCalls: RTCRtpCodec[][] = [];
  constructor(kind: string, init?: RTCRtpTransceiverInit) {
    this.sender = new FakeRtpSender();
    this.receiver = new FakeRtpReceiver();
    this.direction = init?.direction ?? (kind === 'audio' ? 'sendrecv' : 'sendonly');
  }
  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.setCodecPreferencesCalls.push(codecs);
  }
}

/**
 * A scriptable {@link RTCPeerConnection} fake. Tests drive ICE gathering and
 * connection by calling `_completeGathering()` / `_setIceConnection()` and read
 * recorded calls to `createOffer`, `createAnswer`, `setLocal/RemoteDescription`,
 * `addTransceiver`, `restartIce`, and `close`.
 */
export class FakePeerConnection {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  /** The offerer's ufrag from the PREVIOUS remote description, so `createAnswer`
   * can tell when the offerer restarted its own credentials (RFC 8445 §9). */
  previousRemoteUfrag: string | null = null;
  iceGatheringState: RTCIceGatheringState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  closed = false;

  readonly createOfferCalls: Array<RTCOfferOptions | undefined> = [];
  readonly createAnswerCalls: number[] = [];
  readonly setLocalCalls: RTCSessionDescriptionInit[] = [];
  readonly setRemoteCalls: RTCSessionDescriptionInit[] = [];
  readonly transceivers: FakeRtpTransceiver[] = [];
  readonly restartIceCalls: number[] = [];
  /** Configurations applied via {@link FakePeerConnection.setConfiguration}. */
  readonly setConfigurationCalls: RTCConfiguration[] = [];
  /** When true, createOffer uses an iceRestart flag without calling restartIce(). */
  noRestartIceMethod = false;
  /** When true, setLocalDescription immediately marks ICE gathering complete. */
  autoCompleteIceGathering = false;

  onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null;
  oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null;
  ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => unknown) | null = null;

  private offerCounter = 0;
  private answerCounter = 0;

  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => unknown) | null = null;

  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.createOfferCalls.push(options);
    // Faithful browser model of an ICE RESTART: createOffer({iceRestart:true})
    // only signs the offer with fresh credentials — it does NOT change
    // iceGatheringState, so the state still reports the PREVIOUS
    // generation's 'complete'. The new gather begins at setLocalDescription
    // time (modeled below). A non-restart renegotiation (hold/resume) starts a
    // fresh gathering phase (browser re-runs gathering on every new local
    // description), which the library waits on as before.
    if (options?.iceRestart !== true && this.localDescription !== null) {
      this.iceGatheringState = 'new';
    }
    const previousUfrag = ufragOf(this.localDescription?.sdp);
    const restarted = options?.iceRestart === true;
    const ufrag = restarted || previousUfrag === null ? nextUfrag() : previousUfrag;
    const sdp = `v=0\no=sip-worker ${++this.offerCounter} 0 IN IP4 0.0.0.0\n` +
      `s=-\nm=audio 49170 RTP/AVP 0 8 101\n` +
      `a=ice-ufrag:${ufrag}\na=ice-pwd:${nextPwd()}\n` +
      `a=rtpmap:0 PCMU/8000\na=rtpmap:8 PCMA/8000\na=rtpmap:101 telephone-event/8000\n`;
    return { type: 'offer', sdp };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.createAnswerCalls.push(1);
    // Faithful answerer model (RFC 8445 §9): the answerer mints fresh
    // credentials only when the OFFERER restarted ITS OWN credentials — this
    // offer's ufrag differs from the offerer's previous ufrag — or when it has
    // none yet. A same-credential renegotiation (hold/resume) keeps the
    // answerer's current credentials. Comparing against the answerer's own
    // ufrag would be wrong: the two ICE agents' ufrags never match.
    const remoteUfrag = ufragOf(this.remoteDescription?.sdp);
    const localUfrag = ufragOf(this.localDescription?.sdp);
    const offererRestarted = remoteUfrag !== null
      && this.previousRemoteUfrag !== null
      && remoteUfrag !== this.previousRemoteUfrag;
    const ufrag = localUfrag === null || offererRestarted ? nextUfrag() : localUfrag;
    const sdp = `v=0\no=answer ${++this.answerCounter} 0 IN IP4 0.0.0.0\ns=-\n` +
      `m=audio 49172 RTP/AVP\n` +
      `a=ice-ufrag:${ufrag}\na=ice-pwd:${nextPwd()}\n`;
    return { type: 'answer', sdp };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('InvalidStateError');
    this.setLocalCalls.push(description);
    const previousUfrag = ufragOf(this.localDescription?.sdp);
    const nextUfrag = ufragOf(description.sdp);
    this.localDescription = description as RTCSessionDescription;
    // Applying a description with fresh ICE credentials starts the NEW gather
    // here (matching browsers, where the stale 'complete' from the previous
    // generation only turns over once the restart description is applied).
    if (previousUfrag !== null && nextUfrag !== null && nextUfrag !== previousUfrag) {
      this.iceGatheringState = 'new';
      this._emitGatheringChange();
    }
    if (this.autoCompleteIceGathering) this._completeGathering();
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('InvalidStateError');
    if (nameOf(this, 'rejectNextRemote') as boolean) {
      (this as unknown as Record<string, unknown>).rejectNextRemote = false;
      throw new Error('InvalidDescription');
    }
    this.setRemoteCalls.push(description);
    this.previousRemoteUfrag = ufragOf(this.remoteDescription?.sdp);
    this.remoteDescription = description as RTCSessionDescription;
  }

  addTransceiver(kind: string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const tr = new FakeRtpTransceiver(kind, init);
    this.transceivers.push(tr);
    return tr as unknown as RTCRtpTransceiver;
  }

  restartIce(): void {
    this.restartIceCalls.push(1);
  }

  setConfiguration(configuration: RTCConfiguration): void {
    if (this.closed) throw new Error('InvalidStateError');
    this.setConfigurationCalls.push(configuration);
  }

  _setNoRestartIce(): void {
    // Model an RTCPeerConnection that lacks restartIce by deleting the own/proto
    // members the session probes for.
    const anyThis = this as unknown as Record<string, unknown>;
    delete anyThis.restartIce;
    delete (Object.getPrototypeOf(this) as Record<string, unknown>).restartIce;
    void anyThis;
  }

  close(): void {
    this.closed = true;
    this.iceGatheringState = 'complete';
  }

  /** Declare the next setRemoteDescription call to be rejected. */
  _rejectNextRemote(): void {
    (this as unknown as Record<string, unknown>).rejectNextRemote = true;
  }

  /** Fire the gathering-state observer with the current state. */
  _emitGatheringChange(): void {
    const handler = this.onicegatheringstatechange as
      ((this: RTCPeerConnection, ev: Event) => unknown) | null;
    handler?.call(this as unknown as RTCPeerConnection, new Event('icegatheringstatechange'));
  }

  _completeGathering(): void {
    if (this.iceGatheringState === 'complete') return;
    this.iceGatheringState = 'complete';
    const local = this.localDescription;
    if (local !== null && typeof local.sdp === 'string' && !local.sdp.includes('a=candidate:')) {
      this.localDescription = {
        type: local.type,
        sdp: `${local.sdp}a=candidate:1 1 UDP 2122260223 192.0.2.10 49170 typ host\n`,
      } as RTCSessionDescription;
    }
    this._emitGatheringChange();
  }

  _setIceConnection(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    const handler = this.oniceconnectionstatechange as
      ((this: RTCPeerConnection, ev: Event) => unknown) | null;
    handler?.call(this as unknown as RTCPeerConnection, new Event('iceconnectionstatechange'));
  }

  /** Deliver a remote audio track to the session's ontrack handler. */
  _emitRemoteAudioTrack(): FakeMediaStreamTrack {
    const track = new FakeMediaStreamTrack('audio');
    const receiver = new FakeRtpReceiver();
    receiver.track = track;
    const transceiver = new FakeRtpTransceiver('audio');
    transceiver.receiver.track = track;
    const stream = new FakeStream([track], true);
    const evt = {
      track,
      receiver,
      transceiver,
      streams: [stream],
    } as unknown as RTCTrackEvent;
    const handler = this.ontrack as
      ((this: RTCPeerConnection, ev: RTCTrackEvent) => unknown) | null;
    handler?.call(this as unknown as RTCPeerConnection, evt);
    return track;
  }
}

function nameOf(_o: object, _k: string): unknown {
  return (_o as Record<string, unknown>)[_k];
}

/** Complete ICE gathering on a fake peer connection (test convenience). */
export function completeGathering(pc: FakePeerConnection): void {
  pc._completeGathering();
}

/**
 * A remote audio SDP that negotiates RFC 4733 telephone-event (the DTMF
 * capability check requires telephone-event in the current remote AND local SDP;
 * the fake's generated local offer already carries it).
 */
export const DTMF_TELEPHONE_EVENT_SDP = [
  'v=0',
  'o=remote 1 1 IN IP4 0.0.0.0',
  's=-',
  'm=audio 5004 RTP/AVP 0 8 101',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:101 telephone-event/8000',
  'a=sendrecv',
  '',
].join('\r\n');