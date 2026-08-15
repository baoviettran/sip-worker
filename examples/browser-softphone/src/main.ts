/**
 * Reference softphone (Task 15): a framework-free browser example consuming ONLY
 * the packed public `sip-worker` surface.
 *
 * Demonstrates the v0.7 product contract end to end:
 *   - BrowserPhone lifecycle: connect -> register -> call -> unregister -> dispose
 *   - outgoing call subtypes (start/cancel/hangup) and incoming subtypes
 *     (answer/reject), all driven through the public `createCall`/event types
 *   - call controls (mute, hold/resume, RFC 4733 DTMF) on real media
 *   - a device/audio façade: app-owned getUserMedia wrapper that commits an
 *     exact microphone device, and an app-owned <audio> whose play() runs only
 *     from a button click (autoplay-safe)
 *   - typed state/error rendering (phone, registration, call, signaling, hold,
 *     resource diagnostics) so failures surface as readable UI
 *
 * Credentials are held in memory only and never persisted. No framework or
 * runtime dependency is required.
 */

import { BrowserPhone, createBrowserMediaEnvironment } from 'sip-worker';
import type {
  BrowserCall,
  BrowserMediaEnvironment,
  BrowserPhoneOptions,
  BrowserWebSocketFactory,
  IncomingBrowserCall,
  OutgoingBrowserCall,
} from 'sip-worker';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
}

const els = {
  connectionState: mustGet<HTMLElement>('connection-state'),
  registrationState: mustGet<HTMLElement>('registration-state'),
  callState: mustGet<HTMLElement>('call-state'),
  callSignaling: mustGet<HTMLElement>('call-signaling'),
  callMuted: mustGet<HTMLElement>('call-muted'),
  callHold: mustGet<HTMLElement>('call-hold'),
  callError: mustGet<HTMLElement>('call-error'),
  lastDtmf: mustGet<HTMLElement>('last-dtmf'),
  resources: mustGet<HTMLElement>('resources'),
  deviceSelect: mustGet<HTMLSelectElement>('device-select'),
  selectedDevice: mustGet<HTMLElement>('selected-device'),
  audioState: mustGet<HTMLElement>('audio-state'),
  incomingPanel: mustGet<HTMLElement>('incoming-panel'),
  incomingRemote: mustGet<HTMLElement>('incoming-remote'),
  destination: mustGet<HTMLInputElement>('destination'),
  dtmfPad: mustGet<HTMLElement>('dtmf-pad'),
};

// App-owned <audio>: the SDK never creates one; the app wires remote audio into
// it and play() is invoked only from the "Play audio" button.
const audio = document.createElement('audio');
audio.id = 'phone-audio';
audio.autoplay = false;
document.body.appendChild(audio);

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let phone: BrowserPhone | null = null;
let currentCall: BrowserCall | undefined;
let incomingCall: IncomingBrowserCall | undefined;
let remoteAudioStream: MediaStream | undefined;
let selectedDeviceId: string | undefined;

// Last-known call facts persist after the runtime releases a terminal call, so
// the UI keeps rendering 'terminated'/'failed' instead of snapping to 'new'.
const lastKnown = {
  callState: 'new' as string,
  signaling: 'stable' as string,
  muted: 'active' as 'muted' | 'active',
  hold: 'active' as 'held' | 'active',
};
let lastError = '';
let lastDtmf = '';
let audioState: 'idle' | 'playing' | 'error' = 'idle';
let renderTimer: number | undefined;

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Media environment façade
// ---------------------------------------------------------------------------

/**
 * Wrap the SDK's real media environment so the app commits its own microphone
 * selection: once a device is chosen, every getUserMedia acquires that exact
 * device. All other mediaDevices methods and the PC/stream factories delegate
 * to the SDK environment untouched.
 */
function buildMediaEnvironment(): BrowserMediaEnvironment {
  const base = createBrowserMediaEnvironment();
  const mediaDevices = base.mediaDevices;
  return {
    mediaDevices: {
      getUserMedia: (constraints) => {
        if (selectedDeviceId === undefined) {
          return mediaDevices.getUserMedia(constraints);
        }
        const audioConstraint =
          typeof constraints?.audio === 'object' && constraints.audio !== null
            ? { ...constraints.audio, deviceId: { exact: selectedDeviceId } }
            : { deviceId: { exact: selectedDeviceId } };
        return mediaDevices.getUserMedia({ ...constraints, audio: audioConstraint });
      },
      enumerateDevices: () => mediaDevices.enumerateDevices(),
      addEventListener: ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        mediaDevices.addEventListener(type, listener, options);
      }) as MediaDevices['addEventListener'],
      removeEventListener: ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        mediaDevices.removeEventListener(type, listener, options);
      }) as MediaDevices['removeEventListener'],
    },
    createPeerConnection: (config) => base.createPeerConnection(config),
    createMediaStream: (tracks) => base.createMediaStream(tracks),
    getAudioCapabilities: () => base.getAudioCapabilities(),
  };
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

function createPhone(): BrowserPhone {
  const options: BrowserPhoneOptions = {
    signaling: {
      url: `ws://${location.host}/sip`,
      allowInsecureWebSocket: true,
    },
    account: {
      registrarUri: 'sip:example.com',
      aor: 'sip:alice@example.com',
      contact: 'sip:alice@example.com',
      username: 'alice',
      password: 'demo-secret', // in-memory only; never persisted
    },
    media: { holdDirection: 'sendonly' },
  };

  const socketFactory: BrowserWebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

  const phone = new BrowserPhone({
    options,
    factory: socketFactory,
    lifecycle: {
      isOnline: () => navigator.onLine,
      subscribe: (event, listener) => {
        window.addEventListener(event, listener);
        return () => window.removeEventListener(event, listener);
      },
    },
    mediaEnvironment: buildMediaEnvironment(),
  });

  phone.on('incomingCall', ({ call }) => {
    incomingCall = call;
    lastError = '';
    wireCall(call);
  });
  phone.on('failed', ({ error }) => {
    lastError = errorText(error);
  });

  return phone;
}

/** Subscribe to the shared call surface and render every typed event. */
function wireCall(call: BrowserCall): void {
  call.on('stateChanged', ({ state }) => {
    lastKnown.callState = state;
    if (state === 'new') lastError = '';
  });
  call.on('signalingStateChanged', ({ state }) => {
    lastKnown.signaling = state;
  });
  call.on('mutedChanged', ({ muted }) => {
    lastKnown.muted = muted ? 'muted' : 'active';
  });
  call.on('holdStateChanged', ({ state }) => {
    lastKnown.hold = state.local ? 'held' : 'active';
  });
  call.on('failed', ({ error }) => {
    lastError = errorText(error);
  });
  call.on('remoteAudio', ({ stream }) => {
    remoteAudioStream = stream;
    if (audio.srcObject === null) audio.srcObject = stream;
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleConnect(): Promise<void> {
  try {
    if (phone === null) phone = createPhone();
    lastError = '';
    await phone.connect();
    await phone.register();
  } catch (err) {
    lastError = errorText(err);
  }
  void populateDevices();
}

async function handleUnregister(): Promise<void> {
  if (phone === null) return;
  try {
    await phone.unregister();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleDispose(): Promise<void> {
  if (phone === null) return;
  try {
    await phone.dispose();
  } catch (err) {
    lastError = errorText(err);
  }
  // Stop the render loop, then draw one final truthful snapshot of the
  // released resources.
  if (renderTimer !== undefined) {
    clearInterval(renderTimer);
    renderTimer = undefined;
  }
  render();
}

async function handleCall(): Promise<void> {
  const target = els.destination.value.trim();
  if (target === '' || phone === null) return;
  if (phone.activeCall !== undefined) return; // one active call at a time
  try {
    const call = phone.createCall(target) as OutgoingBrowserCall;
    currentCall = call;
    incomingCall = undefined;
    lastKnown.callState = 'establishing';
    lastError = '';
    wireCall(call);
    await call.start();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleCancel(): Promise<void> {
  const call = currentCall;
  if (call === undefined || call.state !== 'establishing') return;
  try {
    await (call as OutgoingBrowserCall).cancel();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleHangup(): Promise<void> {
  const call = currentCall;
  if (call === undefined || call.state !== 'established') return;
  try {
    await call.hangup();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleAnswer(): Promise<void> {
  if (incomingCall === undefined) return;
  try {
    await incomingCall.answer();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleReject(): Promise<void> {
  if (incomingCall === undefined) return;
  try {
    await incomingCall.reject(486, 'Busy Here');
  } catch (err) {
    lastError = errorText(err);
  }
}

function handleMute(): void {
  if (currentCall === undefined) return;
  try {
    currentCall.setMuted(true);
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleHold(): Promise<void> {
  if (currentCall === undefined) return;
  try {
    await currentCall.hold();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleResume(): Promise<void> {
  if (currentCall === undefined) return;
  try {
    await currentCall.resume();
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handleDtmf(tones: string): Promise<void> {
  if (currentCall === undefined) return;
  try {
    await currentCall.sendDtmf(tones);
    lastDtmf = tones;
  } catch (err) {
    lastError = errorText(err);
  }
}

async function handlePlayAudio(): Promise<void> {
  try {
    if (remoteAudioStream !== undefined && audio.srcObject === null) {
      audio.srcObject = remoteAudioStream;
    }
    if (audio.srcObject === null) {
      audioState = 'error';
      return;
    }
    await audio.play();
    audioState = 'playing';
  } catch (err) {
    audioState = 'error';
    lastError = errorText(err);
  }
}

// ---------------------------------------------------------------------------
// Device selection
// ---------------------------------------------------------------------------

async function populateDevices(): Promise<void> {
  try {
    const base = createBrowserMediaEnvironment();
    const devices = await base.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    els.deviceSelect.innerHTML = '';
    for (const device of inputs) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${els.deviceSelect.options.length + 1}`;
      els.deviceSelect.appendChild(option);
    }
    if (els.deviceSelect.options.length > 0) {
      els.deviceSelect.selectedIndex = 0;
      const first = els.deviceSelect.options[0];
      selectedDeviceId = first.value;
      els.selectedDevice.textContent = first.textContent ?? '';
    }
  } catch {
    // enumeration/permission failure: leave the list empty
  }
}

els.deviceSelect.addEventListener('change', () => {
  const option = els.deviceSelect.options[els.deviceSelect.selectedIndex];
  if (option === undefined) return;
  selectedDeviceId = option.value;
  els.selectedDevice.textContent = option.textContent ?? '';
});

// ---------------------------------------------------------------------------
// DTMF pad + button wiring
// ---------------------------------------------------------------------------

for (const tone of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#']) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dtmf-key';
  button.textContent = tone;
  button.addEventListener('click', () => void handleDtmf(tone));
  els.dtmfPad.appendChild(button);
}

mustGet<HTMLButtonElement>('btn-connect').addEventListener('click', () => void handleConnect());
mustGet<HTMLButtonElement>('btn-unregister').addEventListener('click', () => void handleUnregister());
mustGet<HTMLButtonElement>('btn-dispose').addEventListener('click', () => void handleDispose());
mustGet<HTMLButtonElement>('btn-call').addEventListener('click', () => void handleCall());
mustGet<HTMLButtonElement>('btn-cancel').addEventListener('click', () => void handleCancel());
mustGet<HTMLButtonElement>('btn-hangup').addEventListener('click', () => void handleHangup());
mustGet<HTMLButtonElement>('btn-answer').addEventListener('click', () => void handleAnswer());
mustGet<HTMLButtonElement>('btn-reject').addEventListener('click', () => void handleReject());
mustGet<HTMLButtonElement>('btn-mute').addEventListener('click', () => handleMute());
mustGet<HTMLButtonElement>('btn-hold').addEventListener('click', () => void handleHold());
mustGet<HTMLButtonElement>('btn-resume').addEventListener('click', () => void handleResume());
mustGet<HTMLButtonElement>('btn-play-audio').addEventListener('click', () => void handlePlayAudio());

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function render(): void {
  if (phone === null) {
    els.connectionState.textContent = 'disconnected';
    els.registrationState.textContent = 'unregistered';
  } else {
    els.connectionState.textContent = phone.connectionState;
    els.registrationState.textContent = phone.registrationState;
  }

  const active = phone?.activeCall;
  if (active !== undefined) {
    lastKnown.callState = active.state;
    lastKnown.signaling = active.signalingState;
    lastKnown.muted = active.muted ? 'muted' : 'active';
    lastKnown.hold = active.holdState.local ? 'held' : 'active';
  }

  els.callState.textContent = lastKnown.callState;
  els.callSignaling.textContent = lastKnown.signaling;
  els.callMuted.textContent = lastKnown.muted;
  els.callHold.textContent = lastKnown.hold;
  els.callError.textContent = lastError;
  els.lastDtmf.textContent = lastDtmf;
  els.audioState.textContent = audioState;
  els.resources.textContent =
    phone === null ? '{}' : JSON.stringify(phone.diagnostics.resources());

  const incomingVisible =
    incomingCall !== undefined && (incomingCall.state === 'new' || incomingCall.state === 'establishing');
  els.incomingPanel.hidden = !incomingVisible;
  if (incomingCall !== undefined) {
    els.incomingRemote.textContent = incomingCall.remoteIdentity?.uri ?? 'incoming call';
  }
}

void populateDevices();
renderTimer = window.setInterval(render, 100);
render();
