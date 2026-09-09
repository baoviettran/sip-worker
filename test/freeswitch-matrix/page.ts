// test/freeswitch-matrix/page.ts — the in-page matrix step runner.
//
// Bundled by build-matrix.mjs AGAINST THE PACKED INSTALL: the entry is copied
// into a temp fixture whose node_modules holds the packed @sip-worker/core +
// sip-worker tarballs, so `new BrowserPhone` comes from the tarball bytes,
// never from packages/**/src. The bundle is loaded by index.html (server.mjs
// 503s when the artifact is absent).
//
// The page global `window.__runMatrixStep(name, args)` runs one matrix step
// against the per-run FreeSWITCH (WSS port carried in the ?wss= query
// parameter) and resolves a plain-data MatrixResult. It never returns
// credentials, SIP messages, or SDP.

import { BrowserPhone, createBrowserMediaEnvironment } from 'sip-worker';
import type { BrowserPhoneOptions, OutgoingBrowserCall } from 'sip-worker';

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

function recordWire(text: string, events: MatrixEvent[]): void {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const method = wireMethod(firstLine);
  if (method !== undefined && WIRE_METHODS.has(method)) {
    events.push({ type: 'wire', detail: method });
  }
}

class RecordingWebSocket extends WebSocket {
  private readonly events: MatrixEvent[];

  constructor(url: string | URL, protocols?: string | string[], events: MatrixEvent[] = []) {
    super(url, protocols);
    this.events = events;
    this.addEventListener('message', (e: MessageEvent) => {
      const data: unknown = e.data;
      if (typeof data === 'string') {
        recordWire(data, this.events);
      } else if (data instanceof ArrayBuffer) {
        recordWire(new TextDecoder().decode(data), this.events);
      } else if (ArrayBuffer.isView(data)) {
        recordWire(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), this.events);
      }
    });
  }

  send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === 'string') recordWire(data, this.events);
    else if (data instanceof ArrayBuffer) recordWire(new TextDecoder().decode(data), this.events);
    else if (ArrayBuffer.isView(data)) {
      recordWire(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), this.events);
    }
    super.send(data as string | Blob | ArrayBufferLike | ArrayBufferView);
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

interface StepArgs {
  user: string;
  password: string;
  /**
   * Port of the node-side STUN responder (audio step only). Chromium obfuscates
   * host ICE candidates as mDNS *.local names, which the FreeSWITCH
   * apply-candidate-acl (wan.auto) rejects outright; a STUN-learned srflx
   * candidate for 127.0.0.1 is NOT obfuscated and loopback is allowed, so the
   * offer carries a candidate FS accepts.
   */
  stunPort?: number;
}

function readWssPort(): number {
  const raw = new URLSearchParams(location.search).get('wss');
  const port = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`harness page requires a valid ?wss= FreeSWITCH WSS port (got ${JSON.stringify(raw)})`);
  }
  return port;
}

function readStepArgs(args: unknown): StepArgs {
  const a = (args ?? {}) as Partial<StepArgs>;
  if (typeof a.user !== 'string' || typeof a.password !== 'string') {
    throw new Error('matrix step args require string { user, password }');
  }
  return typeof a.stunPort === 'number' ? { user: a.user, password: a.password, stunPort: a.stunPort } : { user: a.user, password: a.password };
}

function buildPhone(
  events: MatrixEvent[],
  args: StepArgs,
  opts?: { capturePcs?: RTCPeerConnection[] },
): BrowserPhone {
  installFakeMic();
  const wssPort = readWssPort();
  const domain = '127.0.0.1';
  // When a node-side STUN responder is provided, the ICE agent gathers an
  // srflx 127.0.0.1 candidate (see StepArgs.stunPort) alongside the mDNS host
  // candidates, so the offer passes the FreeSWITCH candidate ACL.
  // iceServers is a media-level option (BrowserMediaOptions).
  const options: BrowserPhoneOptions = {
    signaling: { url: `wss://${domain}:${wssPort}/ws` },
    account: {
      registrarUri: `sip:${domain}:${wssPort}`,
      aor: `sip:${args.user}@${domain}`,
      contact: `sip:${args.user}@${domain}`,
      username: args.user,
      password: args.password,
    },
    ...(args.stunPort !== undefined
      ? { media: { iceServers: [{ urls: `stun:127.0.0.1:${args.stunPort}` }] } }
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
    factory: (url, protocols) => new RecordingWebSocket(url, protocols, events),
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
async function runRegistrationStep(name: 'register' | 'refresh', args: StepArgs): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const phone = buildPhone(events, args);
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

async function runWrongPasswordStep(args: StepArgs): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const phone = buildPhone(events, args);
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

/** register → dial 9196 → 1 s of silence (floor window) → tone → prove audio. */
async function runOutgoingAudioStep(args: StepArgs): Promise<MatrixResult> {
  const events: MatrixEvent[] = [];
  const pcs: RTCPeerConnection[] = [];
  const phone = buildPhone(events, args, { capturePcs: pcs });
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
    const call = phone.createCall('sip:9196@127.0.0.1') as OutgoingBrowserCall;
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
async function runFinishCallStep(): Promise<MatrixResult> {
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

async function runMatrixStep(name: string, args: unknown): Promise<MatrixResult> {
  const stepArgs = readStepArgs(args);
  let result: MatrixResult;
  if (name === 'register' || name === 'refresh') result = await runRegistrationStep(name, stepArgs);
  else if (name === 'wrong-password') result = await runWrongPasswordStep(stepArgs);
  else if (name === 'outgoing-audio') result = await runOutgoingAudioStep(stepArgs);
  else if (name === 'finish-call') result = await runFinishCallStep();
  else result = { ok: false, detail: `unknown matrix step '${name}'`, events: [] };
  // Playwright structured-clones the evaluate() result; spread keeps the
  // result literal so shape stays explicit, and `identity` is a plain object.
  return { ...result, result: result.result ?? null };
}

// ---------------------------------------------------------------------------
// Boot: wire the globals, the unlock button, and the build-evidence status.
// ---------------------------------------------------------------------------
const unlock = document.getElementById('unlock');
unlock?.addEventListener('click', () => {
  const ctx = new AudioContext();
  audioContexts.push(ctx);
  void ctx.resume().then(() => unlock.setAttribute('data-unlocked', '1'));
});

(window as unknown as MatrixWindow).__runMatrixStep = runMatrixStep;
(window as unknown as MatrixWindow).__matrixDispose = disposeLivePhones;
(window as unknown as MatrixWindow).__matrixRun = bridge;
bridge.booted = true;

log(
  `matrix harness ready — sip-worker ${__MATRIX_BUILD__.packageVersion} ` +
    `git ${__MATRIX_BUILD__.gitCommit.slice(0, 9)} ` +
    `tarball sha256 ${__MATRIX_BUILD__.tarballSha256.slice(0, 16)}…`,
);
