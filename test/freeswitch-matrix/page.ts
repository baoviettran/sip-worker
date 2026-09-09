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
import type { BrowserPhoneOptions } from 'sip-worker';

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
// ---------------------------------------------------------------------------
const audioContexts: AudioContext[] = [];
let fakeMicInstalled = false;
function installFakeMic(): void {
  if (fakeMicInstalled) return;
  const media = navigator.mediaDevices;
  if (!media) throw new Error('navigator.mediaDevices unavailable');
  media.getUserMedia = async (_constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const ctx = new AudioContext();
    audioContexts.push(ctx);
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
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
  return { user: a.user, password: a.password };
}

function buildPhone(
  events: MatrixEvent[],
  args: StepArgs,
): BrowserPhone {
  installFakeMic();
  const wssPort = readWssPort();
  const domain = '127.0.0.1';
  const options: BrowserPhoneOptions = {
    signaling: { url: `wss://${domain}:${wssPort}/ws` },
    account: {
      registrarUri: `sip:${domain}:${wssPort}`,
      aor: `sip:${args.user}@${domain}`,
      contact: `sip:${args.user}@${domain}`,
      username: args.user,
      password: args.password,
    },
  };
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
    mediaEnvironment: createBrowserMediaEnvironment(),
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

async function runMatrixStep(name: string, args: unknown): Promise<MatrixResult> {
  const stepArgs = readStepArgs(args);
  let result: MatrixResult;
  if (name === 'register' || name === 'refresh') result = await runRegistrationStep(name, stepArgs);
  else if (name === 'wrong-password') result = await runWrongPasswordStep(stepArgs);
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
