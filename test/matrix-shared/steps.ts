// test/matrix-shared/steps.ts — the in-page matrix step engine, shared by every
// PBX matrix and parameterized by a PbxProfile (each tree supplies its own).
//
// Bundled by build-matrix.mjs AGAINST THE PACKED INSTALL: the tree's entry is
// copied into a temp fixture whose node_modules holds the packed
// @sip-worker/core + sip-worker tarballs, so `new BrowserPhone` comes from the
// tarball bytes, never from packages/**/src. The bundle is loaded by index.html
// (server.mjs 503s when the artifact is absent).
//
// The page global `window.__runMatrixStep(name, args)` runs one matrix step
// against the per-run PBX (WSS port carried in the ?wss= query parameter) and
// resolves a plain-data MatrixResult. It never returns credentials, SIP
// messages, or SDP.
//
// THIS FILE AND ./helpers.ts MUST STAY STRANGERS. Both declare a structurally
// identical MatrixEvent/MatrixResult pair — this side for the page bundle,
// helpers.ts for the Playwright side — and that duplication is load-bearing,
// not an oversight to deduplicate. helpers.ts imports @playwright/test, and
// esbuild (which builds the page bundle) does no type analysis, so an
// `import { MatrixResult } from './helpers'` appearing only in type positions
// would NOT be erased and would pull the Playwright test runner into the
// browser bundle. Keep the local declarations, and import nothing from
// ./helpers, ./mint-tls, ./ports, ./rms or any other node-side module in this
// directory: the only neighbours this file may reach are page-side modules.

import { BrowserPhone, createBrowserMediaEnvironment } from 'sip-worker';
import type {
  BrowserPhoneOptions,
  OutgoingBrowserCall,
  IncomingBrowserCall,
  DiagnosticRecord,
} from 'sip-worker';

/** Build evidence injected by build-matrix.mjs (tarball SHA-256 + provenance). */
declare const __MATRIX_BUILD__: {
  packageVersion: string;
  gitCommit: string;
  tarballSha256: string;
};

export interface MatrixEvent {
  type: string;
  detail: string;
}
export interface MatrixResult {
  ok: boolean;
  detail: string;
  errorCode?: string;
  result?: unknown;
  events: MatrixEvent[];
}

interface MatrixWindow {
  __matrixRun: { booted: boolean; errors: string[] };
  __runMatrixStep(name: string, args: unknown): Promise<MatrixResult>;
  __matrixDispose(): Promise<void>;
}

const bridge: MatrixWindow['__matrixRun'] = {
  booted: false,
  errors: [],
};

const status = document.getElementById('status');
const log = (line: string) => {
  if (status) status.textContent += '\n' + line;
};

window.addEventListener('error', (e) => {
  bridge.errors.push(String((e as ErrorEvent)?.message || (e as unknown as { error?: unknown })?.error || 'error'));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  bridge.errors.push('unhandledrejection: ' + String(r?.message ?? r));
});

// ---------------------------------------------------------------------------
// Fake mic: navigator.mediaDevices.getUserMedia returns an oscillator
// MediaStream (in-page, no OS audio device). createBrowserMediaEnvironment
// re-reads navigator.mediaDevices per call, so the override is picked up.
//
// The oscillator feeds a GainNode gate so the audio step can send a measured
// period of DIGITAL SILENCE (gain 0) before raising the 440 Hz tone: the
// silence head is what the node-side recorder floor calibrates against.
// Default level is 1 (tone), so the register/wrong-password steps are
// unchanged.
// ---------------------------------------------------------------------------
const audioContexts: AudioContext[] = [];
let fakeMicInstalled = false;
/** Desired fake-mic level: 1 = 440 Hz tone, 0 = digital silence. */
let micLevel = 1;
const micGains: Array<{ node: GainNode; ctx: AudioContext }> = [];

/** Set the fake-mic level on existing and future oscillator streams. */
function setMicTone(level: 0 | 1): void {
  micLevel = level;
  for (const g of micGains) {
    try {
      g.node.gain.setTargetAtTime(level, g.ctx.currentTime, 0.005);
    } catch {
      g.node.gain.value = level;
    }
  }
}

function installFakeMic(): void {
  if (fakeMicInstalled) return;
  const media = navigator.mediaDevices;
  if (!media) throw new Error('navigator.mediaDevices unavailable');
  media.getUserMedia = async (_constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const ctx = new AudioContext();
    audioContexts.push(ctx);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = micLevel;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    micGains.push({ node: gain, ctx });
    return dest.stream;
  };
  fakeMicInstalled = true;
}

// ---------------------------------------------------------------------------
// Wire-recording WebSocket factory: wraps the real WebSocket and records SIP
// frames starting REGISTER/INVITE/BYE/ACK/200 (both directions) into the
// running step trace as { type: 'wire', detail: <method> }.
// ---------------------------------------------------------------------------
const WIRE_METHODS = new Set(['REGISTER', 'INVITE', 'BYE', 'ACK', '200']);

function wireMethod(firstLine: string): string | undefined {
  const tokens = firstLine.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return undefined;
  // 'SIP/2.0 200 OK' -> '200'; 'REGISTER sip:...' -> 'REGISTER'
  return tokens[0] === 'SIP/2.0' ? tokens[1] : tokens[0];
}

function recordWire(text: string, events: MatrixEvent[], incoming: boolean): void {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const method = wireMethod(firstLine);
  if (method !== undefined && WIRE_METHODS.has(method)) {
    events.push({ type: 'wire', detail: method });
  }
  if (incoming) captureViaRport(text);
}
/**
 * The page's own WSS source port, as FreeSWITCH appends it to the Via of any
 * response to a REGISTER (`;received=127.0.0.1;rport=<srcPort>`). Scoping the
 * scan to REGISTER responses keeps INVITE-transaction Vias (FreeSWITCH's own
 * address) out of the capture. wait-incoming requires this value: the dialog
 * Contact rewritten below must address the page's actual WSS connection or
 * FreeSWITCH's ACK goes to a fresh (never-answered) WSS connection.
 */
let wssSourcePort: number | undefined;
function captureViaRport(text: string): void {
  if (!/CSeq: \d+ REGISTER\r?$/im.test(text)) return;
  const m = /rport=(\d+)/.exec(text);
  if (m) wssSourcePort = Number(m[1]);
}

class RecordingWebSocket extends WebSocket {
  private readonly events: MatrixEvent[];

  constructor(url: string | URL, protocols?: string | string[], events: MatrixEvent[] = []) {
    super(url, protocols);
    this.events = events;
    this.addEventListener('message', (e: MessageEvent) => {
      const data: unknown = e.data;
      if (typeof data === 'string') {
        recordWire(data, this.events, true);
      } else if (data instanceof ArrayBuffer) {
        recordWire(new TextDecoder().decode(data), this.events, true);
      } else if (ArrayBuffer.isView(data)) {
        recordWire(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), this.events, true);
      }
    });
  }

  send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') recordWire(data, this.events, false);
    else if (data instanceof ArrayBuffer) recordWire(new TextDecoder().decode(data), this.events, false);
    else if (ArrayBuffer.isView(data)) {
      recordWire(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), this.events, false);
    }
    super.send(data as string | Blob | ArrayBufferLike | ArrayBufferView);
  }

  /**
   * Sever the live WSS the way a network cut does. A page cannot destroy its
   * own TCP socket, so this mirrors the v0.7 browser-phone recovery technique
   * (its harness server dropped the socket server-side): the real socket is
   * closed (TCP teardown toward FreeSWITCH) and a synthetic close observation
   * with the abnormal code 1006 is delivered to the transport BEFORE the real
   * (clean 1000) close event can arrive. The transport detaches on the first
   * close event it sees, so the synthetic abnormal close is the one that
   * counts — and it must be abnormal: the library treats a clean close
   * (1000/1005, no error) as a manual disconnect and never arms recovery.
   */
  hardDrop(): void {
    const dropped = new CloseEvent('close', {
      code: 1006,
      reason: 'matrix hard wss drop',
      wasClean: false,
    });
    try {
      this.close();
    } catch {
      // An already-closed socket does not block the synthetic observation.
    }
    this.dispatchEvent(dropped);
  }
}

// ---------------------------------------------------------------------------
// Phone construction + page-side wait helpers (the browser-phone waitFor
// pattern: deadline-bounded polling that fails with the last observed error).
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  probe: () => boolean,
  desc: string,
  timeoutMs: number,
  lastError?: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      const last = lastError?.();
      throw new Error('waitFor(' + desc + ') timed out' + (last ? ': ' + last : ''));
    }
    await sleep(100);
  }
}

interface WantedStates {
  connectionState?: string;
  registrationState?: string;
}

async function waitState(phone: BrowserPhone, wanted: WantedStates, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () =>
      (wanted.connectionState === undefined || phone.connectionState === wanted.connectionState) &&
      (wanted.registrationState === undefined || phone.registrationState === wanted.registrationState),
    JSON.stringify(wanted),
    timeoutMs,
    () => `connection=${phone.connectionState} registration=${phone.registrationState}`,
  );
}

/** terminal registration failure fails the wait immediately (fail-not-stall). */
async function waitRegistration(phone: BrowserPhone, state: 'registered', timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () => phone.registrationState === state,
    `registration ${state}`,
    timeoutMs,
    () => {
      if (phone.registrationState === 'failed') {
        return 'registration failed (see events)';
      }
      return `registration=${phone.registrationState} connection=${phone.connectionState}`;
    },
  );
}

/**
 * A PBX's side of the matrix contract. Everything the step engine needs to know
 * about the switch under test lives here, so a new PBX is a new profile rather
 * than a fork of the engine.
 */
export interface PbxProfile {
  /** Label for log lines and failure detail ('FreeSWITCH', 'Asterisk'). */
  name: string;
  /** The PBX's echo/audio target as a full dial string. */
  echoTarget: string;
  /** WebSocket path on the signalling port. */
  wsPath: string;
  /**
   * Contact URI the page registers with. Bracket and `transport` token differ
   * per stack — see each profile for why, because both were found by a failing
   * call rather than by reading a spec.
   */
  contact: (o: { user: string; domain: string; wssPort: number }) => string;
  /** Codec pin for the DTMF step; undefined leaves the package default. */
  dtmfCodecPreference?: readonly ('opus' | 'PCMU' | 'PCMA')[];
}

interface StepArgs {
  user: string;
  password: string;
  /** Media codec preference override (dtmf step: see runDtmfStep). */
  codecPreference?: readonly ('opus' | 'PCMU' | 'PCMA')[];
  /**
   * Port of the node-side STUN responder. Consumed by any step that builds an
   * RTCPeerConnection: `buildPhone` wires it into that step's `iceServers`
   * whenever `readStepArgs` carries it through. Not an audio-step option, and
   * the callers are deliberately not listed here — the list goes stale the next
   * time a step is added.
   *
   * WHY a step needs it is per stack, and no single account covers both:
   *   - FreeSWITCH rejects the offer's mDNS-obfuscated *.local host candidates
   *     outright — sofia's apply-candidate-acl (wan.auto), 488. Account in
   *     `test/matrix-shared/stun.ts`.
   *   - Asterisk accepts the offer and the dialog reaches `established`, then NO
   *     media ever flows, because pjsip does not resolve those `.local`
   *     candidates — a silent-media failure that reads like a media/control bug
   *     rather than an ICE one. Full measurement, including which part of the
   *     causal account is hypothesis rather than observation, in
   *     `test/asterisk-matrix/audio.spec.ts`'s header.
   *
   * In both cases the STUN-learned srflx 127.0.0.1 candidate is NOT obfuscated
   * and is one the PBX can reach. Neither account is restated here.
   */
  stunPort?: number;
  /**
   * Caller-supplied RFC 4733 digit sequence for the dtmf step (added by a later
   * task; unused today). readStepArgs must carry it through rather than drop
   * the keys it does not know.
   */
  digits?: string;
}

function readWssPort(): number {
  const raw = new URLSearchParams(location.search).get('wss');
  const port = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`harness page requires a valid ?wss= port (got ${JSON.stringify(raw)})`);
  }
  return port;
}

function readStepArgs(args: unknown): StepArgs {
  const a = (args ?? {}) as Partial<StepArgs>;
  if (typeof a.user !== 'string' || typeof a.password !== 'string') {
    throw new Error('matrix step args require string { user, password }');
  }
  // A per-key spread rather than passing `a` through is deliberate:
  // page.evaluate structured-clones the argument, so an unexpected key would
  // travel silently and the step would read a value the caller never validated.
  return {
    user: a.user,
    password: a.password,
    ...(typeof a.stunPort === 'number' ? { stunPort: a.stunPort } : {}),
    ...(typeof a.digits === 'string' ? { digits: a.digits } : {}),
  };
}

function buildPhone(
  events: MatrixEvent[],
  args: StepArgs,
  profile: PbxProfile,
  opts?: {
    capturePcs?: RTCPeerConnection[];
    diagnosticsEvents?: string[];
    /** Live transport sockets, in creation order (drop-wss severs the last). */
    captureSockets?: RecordingWebSocket[];
  },
): BrowserPhone {
  installFakeMic();
  const wssPort = readWssPort();
  const domain = '127.0.0.1';
  // When a node-side STUN responder is provided, the ICE agent gathers an
  // srflx 127.0.0.1 candidate (see StepArgs.stunPort) alongside the mDNS host
  // candidates. What that fixes is per stack — sofia's candidate ACL on
  // FreeSWITCH, pjsip not resolving `.local` on Asterisk — and each stack's
  // account is recorded where it was measured, not here (StepArgs.stunPort).
  // iceServers is a media-level option (BrowserMediaOptions).
  const diagEvents = opts?.diagnosticsEvents;
  const media: BrowserPhoneOptions['media'] | undefined =
    args.stunPort !== undefined || args.codecPreference !== undefined
      ? {
          ...(args.stunPort !== undefined
            ? { iceServers: [{ urls: `stun:127.0.0.1:${args.stunPort}` }] }
            : {}),
          ...(args.codecPreference !== undefined
            ? { codecPreference: [...args.codecPreference] }
            : {}),
        }
      : undefined;
  const options: BrowserPhoneOptions = {
    signaling: { url: `wss://${domain}:${wssPort}${profile.wsPath}` },
    account: {
      registrarUri: `sip:${domain}:${wssPort}`,
      aor: `sip:${args.user}@${domain}`,
      // The Contact shape is per-stack; see the profile's `contact` for why.
      contact: profile.contact({ user: args.user, domain, wssPort }),
      username: args.user,
      password: args.password,
    },
    ...(media !== undefined ? { media } : {}),
    // Inbound steps assert the diagnostic chain (call.established →
    // call.terminated); the logger sink captures codes in emission order.
    ...(diagEvents !== undefined
      ? {
          diagnostics: {
            logger: (record: DiagnosticRecord) => {
              diagEvents.push(record.code);
            },
          },
        }
      : {}),
  };
  // The audio step needs the live RTCPeerConnection for getStats growth: wrap
  // the default media environment and capture every PC it creates. The wrap is
  // behavior-identical; steps that pass no capturePcs get the base env.
  const baseEnv = createBrowserMediaEnvironment();
  const mediaEnvironment = opts?.capturePcs
    ? {
        get mediaDevices() {
          return baseEnv.mediaDevices;
        },
        createPeerConnection: (config: RTCConfiguration) => {
          const pc = baseEnv.createPeerConnection(config);
          opts.capturePcs?.push(pc);
          return pc;
        },
        createMediaStream: (tracks?: MediaStreamTrack[]) => baseEnv.createMediaStream(tracks),
        getAudioCapabilities: () => baseEnv.getAudioCapabilities(),
      }
    : baseEnv;
  const phone = new BrowserPhone({
    options,
    factory: (url, protocols) => {
      const socket = new RecordingWebSocket(url, protocols, events);
      opts?.captureSockets?.push(socket);
      return socket;
    },
    lifecycle: {
      isOnline: () => navigator.onLine,
      subscribe: (event, listener) => {
        window.addEventListener(event, listener);
        return () => window.removeEventListener(event, listener);
      },
    },
    mediaEnvironment,
  });
  phone.on('connectionStateChanged', (e) => events.push({ type: 'connection', detail: e.state }));
  phone.on('registrationStateChanged', (e) => events.push({ type: 'registration', detail: e.state }));
  return phone;
}

interface Failure {
  message: string;
  code?: string;
}

function asFailure(error: unknown): Failure {
  const e = error as { message?: unknown; code?: unknown } | undefined;
  return {
    message: e && typeof e.message === 'string' ? e.message : String(error),
    code: e && typeof e.code === 'string' ? e.code : undefined,
  };
}

async function disposePhone(phone: BrowserPhone | undefined): Promise<void> {
  if (!phone) return;
  try {
    await phone.dispose();
  } catch {
    // best effort; dispose is idempotent and this runs in a finally chain
  }
}

async function disposeLivePhones(): Promise<void> {
  for (const phone of livePhones.splice(0)) {
    await disposePhone(phone);
  }
}

const livePhones: BrowserPhone[] = [];

/** The register/refresh steps share the happy path; refresh re-REGISTERs. */
async function runRegistrationStep(name: 'register' | 'refresh', args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const phone = buildPhone(events, args, profile);
  livePhones.push(phone);
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    if (name === 'refresh') {
      // Re-REGISTER while registered (same Call-ID, next CSeq) — the
      // before-expiry refresh, not a second initial registration.
      await phone.register();
      await waitRegistration(phone, 'registered');
    }
    const wireRegisters = events.filter((e) => e.type === 'wire' && e.detail === 'REGISTER').length;
    return {
      ok: true,
      detail: `${name}: registered (${wireRegisters} REGISTER(s) on the wire)`,
      result: { identity: (phone as unknown as { runtime: { identity?: unknown } }).runtime.identity },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `${name}: ${f.message}`, errorCode: f.code, events };
  } finally {
    await disposePhone(phone);
  }
}

async function runWrongPasswordStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const phone = buildPhone(events, args, profile);
  livePhones.push(phone);
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    let failure: unknown;
    try {
      await phone.register();
      await waitRegistration(phone, 'registered', 5_000);
      failure = new Error('register unexpectedly succeeded with a wrong password');
    } catch (error) {
      failure = error;
    }
    const f = asFailure(failure);
    // Final non-2xx after the digest retry (403 from the FreeSWITCH digest
    // check), never a 2nd-401 auth-budget path.
    return { ok: false, detail: `wrong-password: ${f.message}`, errorCode: f.code, events };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `wrong-password: ${f.message}`, errorCode: f.code, events };
  } finally {
    await disposePhone(phone);
  }
}

// ---------------------------------------------------------------------------
// Two-way audio proof (matrix step 4): tone gate, remote-energy sampler, and
// getStats packet-growth waiter. The step contract is realized across
// `outgoing-audio` (in-page energy + RTP growth) and `finish-call` (hangup
// flushes the FreeSWITCH record_session WAV); the node-side WAV RMS floor and
// recordingRms live in audio.spec.ts (parseRiffWav/maxWindowedRms).
// ---------------------------------------------------------------------------

interface RtpSnapshot {
  inbound: { packets: number; bytes: number };
  outbound: { packets: number; bytes: number };
}

interface RtpGrowth extends RtpSnapshot {
  ok: boolean;
  baseline: RtpSnapshot;
}

async function rtpSnapshot(pc: RTCPeerConnection): Promise<RtpSnapshot> {
  // Bound getStats: a hung call must read as no movement, not stall the step.
  const stats = await Promise.race([
    pc.getStats(),
    new Promise<RTCStatsReport | null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  const out: RtpSnapshot = { inbound: { packets: 0, bytes: 0 }, outbound: { packets: 0, bytes: 0 } };
  if (!stats) return out;
  stats.forEach((raw) => {
    const s = raw as RTCStats & { kind?: string; mediaType?: string; packetsReceived?: number; bytesReceived?: number; packetsSent?: number; bytesSent?: number };
    const kind = s.kind ?? s.mediaType;
    if (kind !== 'audio') return;
    if (s.type === 'inbound-rtp') {
      out.inbound.packets = Math.max(out.inbound.packets, s.packetsReceived ?? 0);
      out.inbound.bytes = Math.max(out.inbound.bytes, s.bytesReceived ?? 0);
    } else if (s.type === 'outbound-rtp') {
      out.outbound.packets = Math.max(out.outbound.packets, s.packetsSent ?? 0);
      out.outbound.bytes = Math.max(out.outbound.bytes, s.bytesSent ?? 0);
    }
  });
  return out;
}

/** Strict baseline-to-increase check in BOTH directions (packets AND bytes). */
async function waitForRtpGrowth(pc: RTCPeerConnection, timeoutMs = 15_000): Promise<RtpGrowth> {
  const baseline = await rtpSnapshot(pc);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(400);
    const s = await rtpSnapshot(pc);
    const grew =
      s.inbound.packets > baseline.inbound.packets &&
      s.inbound.bytes > baseline.inbound.bytes &&
      s.outbound.packets > baseline.outbound.packets &&
      s.outbound.bytes > baseline.outbound.bytes;
    if (grew) return { ok: true, baseline, inbound: s.inbound, outbound: s.outbound };
    if (Date.now() > deadline) return { ok: false, baseline, inbound: s.inbound, outbound: s.outbound };
  }
}

/**
 * Max-window RMS of the REMOTE audio stream over `durationMs`, via an
 * AnalyserNode pulled by a zero-gain sink (measurement without audible output).
 *
 * The stream is ALSO attached to a muted <audio> element first: Chromium's
 * headless-shell does not feed decoded WebRTC remote audio into the WebAudio
 * graph unless the stream has an element sink (the v0.7 browser gate recorded
 * this as 'null-audio-decode-sink' — see test/browser-media/synthetic-peer.ts).
 */
async function sampleRemoteEnergy(stream: MediaStream, durationMs: number): Promise<number> {
  const probe = document.createElement('audio');
  probe.muted = true;
  probe.setAttribute('playsinline', 'true');
  probe.srcObject = stream;
  const playPromise = probe.play().catch(() => undefined);
  const ctx = new AudioContext();
  audioContexts.push(ctx);
  await ctx.resume().catch(() => undefined);
  await playPromise;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  let peak = 0;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    analyser.getFloatTimeDomainData(buf);
    let acc = 0;
    for (let i = 0; i < buf.length; i++) acc += buf[i] * buf[i];
    peak = Math.max(peak, Math.sqrt(acc / buf.length));
    await sleep(25);
  }
  source.disconnect();
  analyser.disconnect();
  sink.disconnect();
  void ctx.close().catch(() => undefined);
  probe.srcObject = null;
  probe.remove();
  return peak;
}

interface AudioRun {
  phone: BrowserPhone;
  call: OutgoingBrowserCall;
  events: MatrixEvent[];
}
let audioRun: AudioRun | undefined;

/** register → dial the profile's echo target → 1 s of silence (floor window) → tone → prove audio. */
async function runOutgoingAudioStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const pcs: RTCPeerConnection[] = [];
  const phone = buildPhone(events, args, profile, { capturePcs: pcs });
  livePhones.push(phone);
  const gate = window as unknown as { __matrixAwaitFloor?: boolean; __matrixGoTone?: boolean };
  gate.__matrixAwaitFloor = false;
  gate.__matrixGoTone = false;
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    // Digital silence toward FreeSWITCH for the recorder silence floor.
    setMicTone(0);
    const call = phone.createCall(profile.echoTarget) as OutgoingBrowserCall;
    audioRun = { phone, call, events };
    let remoteStream: MediaStream | undefined;
    call.on('remoteAudio', (e) => {
      remoteStream = e.stream;
    });
    // start() settles on media-connected; the dialplan answers + starts
    // record_session before echo, so the recording begins here.
    await call.start();
    await waitFor(() => call.state === 'established', 'call established', 15_000, () => `call=${call.state}`);
    // ≥1 s of silence RTP so the recording carries a silence head for the floor.
    await sleep(1_000);
    gate.__matrixAwaitFloor = true;
    // The node side reads the partial WAV, computes the silence floor, then
    // opens the gate. 90 s cap keeps a crashed spec from hanging the page.
    await waitFor(() => gate.__matrixGoTone === true, 'floor calibration (go-tone)', 90_000);
    setMicTone(1);
    await waitFor(() => remoteStream !== undefined, 'remote audio stream', 10_000);
    const pc = pcs[pcs.length - 1];
    if (!pc) throw new Error('no RTCPeerConnection was created for the call');
    const [energy, rtp] = await Promise.all([
      sampleRemoteEnergy(remoteStream as MediaStream, 2_000),
      waitForRtpGrowth(pc, 15_000),
    ]);
    return {
      ok: true,
      detail: `outgoing-audio: established, page energy=${energy.toFixed(4)}, rtpBothWays=${rtp.ok}`,
      result: {
        energy,
        rtpBothWays: rtp.ok,
        rtp,
        callState: call.state,
        remoteTracks: (remoteStream as MediaStream).getAudioTracks().length,
      },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `outgoing-audio: ${f.message}`, errorCode: f.code, events };
  }
}

/** Hang up the live audio call (flushes the FS record_session WAV) and dispose. */
async function runFinishCallStep(profile: PbxProfile): Promise<MatrixResult> {
  const run = audioRun;
  if (!run) {
    return { ok: false, detail: 'finish-call: no outgoing-audio call is live', events: [] };
  }
  const { phone, call, events } = run;
  try {
    if (call.state !== 'terminated' && call.state !== 'failed') {
      await call.hangup();
    }
    await waitFor(
      () => call.state === 'terminated' || call.state === 'failed',
      'call terminated',
      15_000,
      () => `call=${call.state}`,
    );
    return {
      ok: true,
      detail: `finish-call: call ${call.state}, recorder flushed`,
      result: { callState: call.state },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `finish-call: ${f.message}`, errorCode: f.code, events };
  } finally {
    audioRun = undefined;
    await disposePhone(phone);
  }
}

// ---------------------------------------------------------------------------
// Hold/resume + mute/unmute (matrix steps 6 and 7): ONE persistent outgoing
// call — `hold` registers, dials the profile's echo target, establishes, and
// places the call on local hold; `resume`/`mute` mutate it; `unmute` un-mutes, proves RTP
// resumed (Task 6 sampler), and terminates the call cleanly. Every step
// returns the observed holdState/muted state, the full diagnostic trace, and
// post-action RTP-growth evidence (boolean + counters) — the spec asserts the
// control-plane contract (the holdState/diagnostic pair), not an SDP
// direction literal.
// ---------------------------------------------------------------------------
interface ControlsRun {
  phone: BrowserPhone;
  call: OutgoingBrowserCall;
  events: MatrixEvent[];
  pc: RTCPeerConnection;
  diagCodes: string[];
}
let controlsRun: ControlsRun | undefined;

function wireCount(events: MatrixEvent[], detail: string): number {
  return events.filter((e) => e.type === 'wire' && e.detail === detail).length;
}

/** Establish the persistent outgoing call and place it on local hold. */
async function runHoldStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const pcs: RTCPeerConnection[] = [];
  const diagCodes: string[] = [];
  const phone = buildPhone(events, args, profile, { capturePcs: pcs, diagnosticsEvents: diagCodes });
  livePhones.push(phone);
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    const call = phone.createCall(profile.echoTarget) as OutgoingBrowserCall;
    await call.start();
    await waitFor(() => call.state === 'established', 'call established', 15_000, () => `call=${call.state}`);
    await call.hold();
    await waitFor(
      () => call.holdState.local,
      'holdState.local=true',
      10_000,
      () => `call=${call.state} hold=${JSON.stringify(call.holdState)}`,
    );
    const pc = pcs[pcs.length - 1];
    if (!pc) throw new Error('no RTCPeerConnection was created for the call');
    // Evidence only (the spec asserts the holdState + call.hold diag pair, not
    // a media-direction literal): whether BOTH directions keep growing under
    // hold. The library's default hold direction is sendonly, so the inbound
    // echo leg is expected to pause — this boolean carries the observed
    // behavior for the report.
    const rtpUnderHold = await waitForRtpGrowth(pc, 4_000);
    controlsRun = { phone, call, events, pc, diagCodes };
    return {
      ok: true,
      detail: `hold: established + local hold (holdState=${JSON.stringify(call.holdState)})`,
      result: {
        callState: call.state,
        holdState: { local: call.holdState.local, remote: call.holdState.remote },
        muted: call.muted,
        diagCodes: [...diagCodes],
        wireInvites: wireCount(events, 'INVITE'),
        wire200s: wireCount(events, '200'),
        rtpUnderHold: {
          ok: rtpUnderHold.ok,
          baseline: rtpUnderHold.baseline,
          inbound: rtpUnderHold.inbound,
          outbound: rtpUnderHold.outbound,
        },
      },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    controlsRun = undefined;
    await disposePhone(phone);
    return { ok: false, detail: `hold: ${f.message}`, errorCode: f.code, events };
  }
}

/** Resume from local hold; prove media flows again in both directions. */
async function runResumeStep(profile: PbxProfile): Promise<MatrixResult> {
  const run = controlsRun;
  if (!run) {
    return { ok: false, detail: 'resume: no hold step has a live call', events: [] };
  }
  const { call, pc, diagCodes, events } = run;
  try {
    await call.resume();
    await waitFor(
      () => !call.holdState.local,
      'holdState.local=false',
      10_000,
      () => `call=${call.state} hold=${JSON.stringify(call.holdState)}`,
    );
    // Task 6 sampler: growth in BOTH directions (packets AND bytes) after the
    // resume re-INVITE — the ≥1 s of flow that proves echo came back.
    const rtp = await waitForRtpGrowth(pc, 15_000);
    return {
      ok: true,
      detail: `resume: hold released (holdState=${JSON.stringify(call.holdState)}), rtpResumed=${rtp.ok}`,
      result: {
        callState: call.state,
        holdState: { local: call.holdState.local, remote: call.holdState.remote },
        diagCodes: [...diagCodes],
        rtpGrowth: rtp.ok,
        rtp,
      },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `resume: ${f.message}`, errorCode: f.code, events };
  }
}

/** Mute the local mic (setMuted is synchronous; mutedChanged flips the flag). */
async function runMuteStep(profile: PbxProfile): Promise<MatrixResult> {
  const run = controlsRun;
  if (!run) {
    return { ok: false, detail: 'mute: no hold step has a live call', events: [] };
  }
  const { call, pc, diagCodes, events } = run;
  try {
    call.setMuted(true);
    await waitFor(() => call.muted, 'muted=true', 5_000, () => `muted=${call.muted}`);
    // Evidence only: a disabled local track still emits (silent) packets in
    // Chromium, so packet flow usually continues while muted — the brief
    // asserts the muted flag here, and RTP-resumes on unmute below.
    const rtpDuringMute = await waitForRtpGrowth(pc, 4_000);
    return {
      ok: true,
      detail: `mute: muted=true (rtpDuringMute=${rtpDuringMute.ok})`,
      result: {
        callState: call.state,
        muted: call.muted,
        diagCodes: [...diagCodes],
        rtpDuringMute: {
          ok: rtpDuringMute.ok,
          baseline: rtpDuringMute.baseline,
          inbound: rtpDuringMute.inbound,
          outbound: rtpDuringMute.outbound,
        },
      },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `mute: ${f.message}`, errorCode: f.code, events };
  }
}

/** Un-mute, prove RTP resumed, then terminate cleanly with the diag chain. */
async function runUnmuteStep(profile: PbxProfile): Promise<MatrixResult> {
  const run = controlsRun;
  if (!run) {
    return { ok: false, detail: 'unmute: no hold step has a live call', events: [] };
  }
  const { phone, call, pc, diagCodes, events } = run;
  try {
    call.setMuted(false);
    await waitFor(() => !call.muted, 'muted=false', 5_000, () => `muted=${call.muted}`);
    // RTP resumes after unmute (Task 6 sampler, both directions).
    const rtp = await waitForRtpGrowth(pc, 15_000);
    await call.hangup();
    await waitFor(
      () => call.state === 'terminated' || call.state === 'failed',
      'call terminated',
      15_000,
      () => `call=${call.state}`,
    );
    if (call.state === 'failed') throw new Error('call failed instead of terminating cleanly');
    assertCleanDiagChain(diagCodes);
    return {
      ok: true,
      detail: `unmute: muted=false, rtpResumed=${rtp.ok}, call ${call.state}`,
      result: {
        callState: call.state,
        muted: call.muted,
        diagCodes: [...diagCodes],
        rtpGrowth: rtp.ok,
        rtp,
      },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `unmute: ${f.message}`, errorCode: f.code, events };
  } finally {
    controlsRun = undefined;
    await disposePhone(phone);
  }
}

// ---------------------------------------------------------------------------
// DTMF (matrix step 8): `dtmf` registers, dials the profile's echo target,
// establishes, and sends RFC 4733 digit '5' through the browser's
// RTCDTMFSender (telephone-event is negotiated in the offer, so Chromium
// emits telephone-event RTP packets that the PBX's rfc2833 profile parses
// into DTMF events). The step only reports dtmfSent + the clean diag chain —
// the digit assertion is NODE-SIDE against the PBX's event-socket stream.
// ---------------------------------------------------------------------------
async function runDtmfStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const diagCodes: string[] = [];
  // The codec pin for this call is the profile's to explain — see
  // PbxProfile.dtmfCodecPreference. Same digit, same RFC 4733 transport; only
  // the codec pairing changes.
  const phone = buildPhone(events, { ...args, ...(profile.dtmfCodecPreference ? { codecPreference: [...profile.dtmfCodecPreference] } : {}) }, profile, {
    diagnosticsEvents: diagCodes,
  });
  livePhones.push(phone);
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    const call = phone.createCall(profile.echoTarget) as OutgoingBrowserCall;
    await call.start();
    await waitFor(() => call.state === 'established', 'call established', 15_000, () => `call=${call.state}`);
    // RFC 4733 requires the media path up: Chrome's RTCDTMFSender reports
    // canInsertDTMF=true only once the DTLS handshake completes, which lags
    // both the SIP established state and the ICE-connected media session
    // state. Retry the send across that window — a transient DTMF_UNSUPPORTED
    // during the handshake is expected and filtered from the diag chain below;
    // if the deadline expires the last error propagates (a failure, never a
    // hang or a skip).
    await waitFor(
      () => call.mediaState === 'connected',
      'media session connected',
      15_000,
      () => `media=${call.mediaState}`,
    );
    const sendDeadline = Date.now() + 10_000;
    for (;;) {
      try {
        await call.sendDtmf('5');
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'DTMF_UNSUPPORTED' || Date.now() > sendDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // The digit is observed NODE-SIDE by dtmf.spec.ts (see its file header:
    // the event-socket DTMF event, or — because the pinned image's echo
    // dialplan never dequeues, and the DTMF event only fires on dequeue — the
    // channel-uuid-prefixed receipt lines in the FS log). The call must still
    // be up while the spec observes, so park at the gate until the spec sets
    // __matrixDtmfGo; the 90 s cap keeps a crashed spec from hanging the page.
    const gate = window as unknown as { __matrixAwaitDtmf?: boolean; __matrixDtmfGo?: boolean };
    gate.__matrixAwaitDtmf = true;
    await waitFor(() => gate.__matrixDtmfGo === true, 'dtmf drain gate', 90_000);
    await call.hangup();
    await waitFor(
      () => call.state === 'terminated' || call.state === 'failed',
      'call terminated',
      15_000,
      () => `call=${call.state}`,
    );
    if (call.state === 'failed') throw new Error('call failed instead of terminating cleanly');
    // Any surviving call.dtmf_failed here is a transient DTMF_UNSUPPORTED
    // from the DTLS-handshake retry window above — the send itself succeeded
    // (a final failure would have thrown before this point), so it does not
    // break the clean call chain.
    assertCleanDiagChain(diagCodes.filter((c) => c !== 'call.dtmf_failed'));
    return {
      ok: true,
      detail: `dtmf: sent '5' on an established echo call, call ${call.state}, diag ${diagCodes.join('→')}`,
      result: { callState: call.state, dtmfSent: true, diagCodes: [...diagCodes] },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `dtmf: ${f.message}`, errorCode: f.code, events };
  } finally {
    await disposePhone(phone);
  }
}

// ---------------------------------------------------------------------------
// Inbound-call steps: wait-incoming registers and arms the incomingCall
// listener; answer-incoming answers the INVITE and proves establishment;
// hangup / expect-remote-terminated observe the call's termination. The
// IncomingBrowserCall cannot hang up locally yet (ownerHangup is staged for a
// later task), so the node side triggers the BYE with uuid_kill on the FS
// channel; the page steps assert the observed clean termination.
// ---------------------------------------------------------------------------
interface InboundState {
  phone: BrowserPhone;
  events: MatrixEvent[];
  /** Diagnostic codes in emission order (buildPhone diagnostics sink). */
  diagCodes: string[];
  /** Set when the phone emits incomingCall (armed in wait-incoming). */
  call: IncomingBrowserCall | undefined;
}
let inbound: InboundState | undefined;

/** Register the phone and arm the incomingCall listener; returns immediately. */
async function runWaitIncomingStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const diagCodes: string[] = [];
  const phone = buildPhone(events, args, profile, { diagnosticsEvents: diagCodes });
  livePhones.push(phone);
  const state: InboundState = { phone, events, diagCodes, call: undefined };
  // Arm BEFORE registering so the INVITE can never race the subscription.
  phone.on('incomingCall', (e) => {
    state.call = e.call;
  });
  inbound = state;
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    // FreeSWITCH routes the post-200-OK ACK (and the uuid_kill BYE) to the
    // Contact of the page's dialog messages. The dialog Contact therefore
    // must be the page's own WSS connection endpoint — 127.0.0.1:<srcPort> —
    // so the ACK reuses the accepted WSS connection instead of opening a new
    // one the page would never read. The srcPort is what FreeSWITCH echoes
    // back in the REGISTER response Via (`rport=<srcPort>`); the runtime
    // contact is rewritten before the originate can put the INVITE on the
    // wire, so the Invitation snapshots the corrected value.
    if (wssSourcePort === undefined) {
      throw new Error(`wait-incoming: no Via rport in ${profile.name} responses (cannot address the page WSS connection)`);
    }
    const runtime = (phone as unknown as { runtime?: { core?: { options?: { contact?: string } } } }).runtime;
    if (!runtime?.core?.options || typeof runtime.core.options.contact !== 'string') {
      throw new Error('wait-incoming: cannot reach runtime core contact to set the dialog address');
    }
    runtime.core.options.contact =
      `<sip:${args.user}@127.0.0.1:${wssSourcePort};transport=wss>`;
    return {
      ok: true,
      detail: `wait-incoming: registered, listening for incoming INVITE (dialog contact rport=${wssSourcePort})`,
      result: { registered: true },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    inbound = undefined;
    return { ok: false, detail: `wait-incoming: ${f.message}`, errorCode: f.code, events };
  }
}

/** Answer the inbound INVITE and prove the call establishes. */
async function runAnswerIncomingStep(profile: PbxProfile): Promise<MatrixResult> {
  const state = inbound;
  if (!state) {
    return { ok: false, detail: 'answer-incoming: no wait-incoming step is live', events: [] };
  }
  const { phone, events } = state;
  try {
    await waitFor(
      () => state.call !== undefined,
      'incoming INVITE',
      30_000,
      () => `connection=${phone.connectionState} registration=${phone.registrationState}`,
    );
    const incoming = state.call;
    if (!incoming) throw new Error('incoming INVITE not captured'); // waitFor guarantees this
    await incoming.answer();
    await waitFor(
      () => incoming.state === 'established',
      'call established',
      15_000,
      () => `call=${incoming.state} connection=${phone.connectionState}`,
    );
    return {
      ok: true,
      detail: 'answer-incoming: established',
      result: { callState: incoming.state },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `answer-incoming: ${f.message}`, errorCode: f.code, events };
  }
}

/**
 * A cleanly terminated call must show the diagnostic chain
 * `call.established` → `call.terminated` (in that order) and no diagnostic
 * from the library's severity-'error' family (DiagnosticRecorder CODE_SPECS:
 * call.failed, call.dtmf_failed, media.failed). Throws with the full trace —
 * fail-not-skip, never a softened check.
 */
function assertCleanDiagChain(diagCodes: readonly string[]): void {
  const trace = diagCodes.join(',');
  const establishedIdx = diagCodes.indexOf('call.established');
  const terminatedIdx = diagCodes.indexOf('call.terminated');
  if (establishedIdx === -1) {
    throw new Error(`diagnostic call.established missing (trace: ${trace})`);
  }
  if (terminatedIdx === -1) {
    throw new Error(`diagnostic call.terminated missing (trace: ${trace})`);
  }
  if (terminatedIdx < establishedIdx) {
    throw new Error(`call.terminated before call.established (trace: ${trace})`);
  }
  const errorCodes = diagCodes.filter((code) =>
    code === 'call.failed' || code === 'call.dtmf_failed' || code === 'media.failed');
  if (errorCodes.length > 0) {
    throw new Error(`error diagnostics on a cleanly terminated call: ${errorCodes.join(',')} (trace: ${trace})`);
  }
}

/** Observe the call terminate cleanly (the node side triggers the BYE). */
async function runHangupStep(profile: PbxProfile): Promise<MatrixResult> {
  const state = inbound;
  if (!state?.call) {
    return { ok: false, detail: 'hangup: no established inbound call is live', events: state?.events ?? [] };
  }
  const { phone, call, events, diagCodes } = state;
  try {
    await waitFor(
      () => call.state === 'terminated' || call.state === 'failed',
      'call terminated',
      20_000,
      () => `call=${call.state} connection=${phone.connectionState}`,
    );
    if (call.state === 'failed') throw new Error('call failed instead of terminating cleanly');
    assertCleanDiagChain(diagCodes);
    return {
      ok: true,
      detail: `hangup: call terminated cleanly, diag ${diagCodes.join('→')}`,
      result: { callState: call.state, diagCodes },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `hangup: ${f.message}`, errorCode: f.code, events };
  } finally {
    inbound = undefined;
    await disposePhone(phone);
  }
}

/** Assert the remote BYE terminated the call with a clean diagnostic chain. */
async function runExpectRemoteTerminatedStep(profile: PbxProfile): Promise<MatrixResult> {
  const state = inbound;
  if (!state?.call) {
    return {
      ok: false,
      detail: 'expect-remote-terminated: no established inbound call is live',
      events: state?.events ?? [],
    };
  }
  const { phone, call, events, diagCodes } = state;
  try {
    await waitFor(
      () => call.state === 'terminated' || call.state === 'failed',
      'remote BYE terminating call',
      20_000,
      () => `call=${call.state} connection=${phone.connectionState}`,
    );
    if (call.state === 'failed') throw new Error('call failed instead of clean remote termination');
    assertCleanDiagChain(diagCodes);
    return {
      ok: true,
      detail: `expect-remote-terminated: clean remote BYE, diag ${diagCodes.join('→')}`,
      result: { callState: call.state, diagCodes },
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `expect-remote-terminated: ${f.message}`, errorCode: f.code, events };
  } finally {
    inbound = undefined;
    await disposePhone(phone);
  }
}

// ---------------------------------------------------------------------------
// WSS-drop recovery (matrix step 10): register, establish an outgoing call,
// then sever the live WSS from the page (RecordingWebSocket.hardDrop — the
// synthetic 1006 observation that a network cut produces; a clean close would
// NOT arm recovery), and observe the library's bounded recovery pipeline:
// reconnect → registration.recovering → re-REGISTER → registered. The row-10
// contract asserted here is REGISTRATION RECOVERY (reconnected + registered +
// a recovery record observed + a real re-REGISTER on the wire) — NOT a
// specific call re-establishment: the call either re-establishes (cleanly
// hung up afterwards) or terminates with typed evidence, and its outcome is
// returned as data. A terminal recovery record (connection.recovery_failed /
// registration.recovery_failed) FAILS the step — fail-not-skip.
// ---------------------------------------------------------------------------
interface RecoveryStepResult {
  connectionState: string;
  registrationState: string;
  /** 'established' (re-established, then cleanly hung up) | 'terminated' | 'failed'. */
  callOutcome: string;
  diagCodes: string[];
  wireRegisters: number;
  wireRegistersAfterDrop: number;
}

async function runDropWssStep(args: StepArgs, profile: PbxProfile): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const diagCodes: string[] = [];
  const sockets: RecordingWebSocket[] = [];
  const phone = buildPhone(events, args, profile, {
    diagnosticsEvents: diagCodes,
    captureSockets: sockets,
  });
  livePhones.push(phone);
  let call: OutgoingBrowserCall | undefined;
  try {
    await phone.connect();
    await waitState(phone, { connectionState: 'connected' });
    await phone.register();
    await waitRegistration(phone, 'registered');
    // The mid-call drop the row-10 scenario describes: an established call
    // whose signaling socket is severed from under it.
    call = phone.createCall(profile.echoTarget) as OutgoingBrowserCall;
    await call.start();
    await waitFor(() => call.state === 'established', 'call established', 15_000, () => `call=${call.state}`);
    const wireRegistersBeforeDrop = wireCount(events, 'REGISTER');
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error('no live WebSocket was created for the transport');
    socket.hardDrop();
    // The abnormal-close observation arms recovery synchronously (the
    // connection transitions before any recovery I/O starts).
    await waitState(phone, { connectionState: 'recovering' }, 5_000);
    // Then the bounded pipeline must land: reconnect + re-REGISTER. The
    // library's own recovery budget is 30 s (recoveryTimeoutMs); the harness
    // deadline is 45 s — a timeout here is a failure, never a hang.
    await waitState(
      phone,
      { connectionState: 'connected', registrationState: 'registered' },
      45_000,
    );
    // Contract: a recovery record observed — registration.recovering plus at
    // least one connection.* recovery code, and NO terminal recovery record.
    if (!diagCodes.includes('registration.recovering')) {
      throw new Error(`recovery record missing: no registration.recovering (diag: ${diagCodes.join(',')})`);
    }
    const connectionRecovery = diagCodes.filter(
      (c) => c === 'connection.reconnect_attempt' || c === 'connection.reconnected',
    );
    if (connectionRecovery.length === 0) {
      throw new Error(`recovery record missing: no connection.* recovery diagnostic (diag: ${diagCodes.join(',')})`);
    }
    const terminalRecovery = diagCodes.filter(
      (c) => c === 'connection.recovery_failed' || c === 'registration.recovery_failed',
    );
    if (terminalRecovery.length > 0) {
      throw new Error(`recovery terminated: ${terminalRecovery.join(',')} (diag: ${diagCodes.join(',')})`);
    }
    // Wire evidence: the recovery re-REGISTER really crossed the new socket.
    const wireRegistersAfterDrop = wireCount(events, 'REGISTER') - wireRegistersBeforeDrop;
    if (wireRegistersAfterDrop < 1) {
      throw new Error('recovery re-REGISTER missing from the wire trace');
    }
    // Call outcome (observed, never forced into one shape): a surviving call
    // is hung up cleanly after the recovery; one the drop took with it is
    // reported as terminated/failed — a failed outcome must carry the typed
    // call.failed evidence.
    let callOutcome: string;
    if (call.state === 'established') {
      await call.hangup();
      await waitFor(
        () => call.state === 'terminated' || call.state === 'failed',
        'post-recovery call terminated',
        20_000,
        () => `call=${call.state} connection=${phone.connectionState}`,
      );
      if (call.state === 'failed') throw new Error('post-recovery hangup failed instead of terminating cleanly');
      callOutcome = 'established';
    } else {
      callOutcome = call.state;
      if (callOutcome === 'failed' && !diagCodes.includes('call.failed')) {
        throw new Error(`call failed without typed call.failed evidence (diag: ${diagCodes.join(',')})`);
      }
    }
    return {
      ok: true,
      detail: `drop-wss: reconnected + re-registered (diag ${diagCodes.join('→')}), call outcome ${callOutcome}`,
      result: {
        connectionState: phone.connectionState,
        registrationState: phone.registrationState,
        callOutcome,
        diagCodes: [...diagCodes],
        wireRegisters: wireCount(events, 'REGISTER'),
        wireRegistersAfterDrop,
      } satisfies RecoveryStepResult,
      events,
    };
  } catch (error) {
    const f = asFailure(error);
    return { ok: false, detail: `drop-wss: ${f.message}`, errorCode: f.code, events };
  } finally {
    await disposePhone(phone);
  }
}

export async function runMatrixStep(profile: PbxProfile, name: string, args: unknown): Promise<MatrixResult> {
  const stepArgs = readStepArgs(args);
  let result: MatrixResult;
  if (name === 'register' || name === 'refresh') result = await runRegistrationStep(name, stepArgs, profile);
  else if (name === 'wrong-password') result = await runWrongPasswordStep(stepArgs, profile);
  else if (name === 'outgoing-audio') result = await runOutgoingAudioStep(stepArgs, profile);
  else if (name === 'finish-call') result = await runFinishCallStep(profile);
  else if (name === 'hold') result = await runHoldStep(stepArgs, profile);
  else if (name === 'resume') result = await runResumeStep(profile);
  else if (name === 'mute') result = await runMuteStep(profile);
  else if (name === 'unmute') result = await runUnmuteStep(profile);
  else if (name === 'wait-incoming') result = await runWaitIncomingStep(stepArgs, profile);
  else if (name === 'answer-incoming') result = await runAnswerIncomingStep(profile);
  else if (name === 'hangup') result = await runHangupStep(profile);
  else if (name === 'dtmf') result = await runDtmfStep(stepArgs, profile);
  else if (name === 'expect-remote-terminated') result = await runExpectRemoteTerminatedStep(profile);
  else if (name === 'drop-wss') result = await runDropWssStep(stepArgs, profile);
  else result = { ok: false, detail: `unknown matrix step '${name}'`, events: [] };
  // Playwright structured-clones the evaluate() result; spread keeps the
  // result literal so shape stays explicit, and `identity` is a plain object.
  return { ...result, result: result.result ?? null };
}

// ---------------------------------------------------------------------------
// Boot: wire the globals, the unlock button, and the build-evidence status.
// ---------------------------------------------------------------------------
export function bootMatrixPage(profile: PbxProfile): void {
  const unlock = document.getElementById('unlock');
  unlock?.addEventListener('click', () => {
    const ctx = new AudioContext();
    audioContexts.push(ctx);
    void ctx.resume().then(() => unlock.setAttribute('data-unlocked', '1'));
  });

  (window as unknown as MatrixWindow).__runMatrixStep = (name: string, args: unknown) =>
    runMatrixStep(profile, name, args);
  (window as unknown as MatrixWindow).__matrixDispose = disposeLivePhones;
  (window as unknown as MatrixWindow).__matrixRun = bridge;
  bridge.booted = true;

  // The run record's provenance (acceptance criterion 8): package version,
  // tarball hash, git commit, the image under test, and the browser build.
  const image = new URLSearchParams(location.search).get('image');
  log(
    `matrix harness ready (${profile.name}) — sip-worker ${__MATRIX_BUILD__.packageVersion} ` +
      `git ${__MATRIX_BUILD__.gitCommit.slice(0, 9)} ` +
      `tarball sha256 ${__MATRIX_BUILD__.tarballSha256.slice(0, 16)}…` +
      `${image ? ` image ${image}` : ''} browser ${navigator.userAgent}`,
  );
}
