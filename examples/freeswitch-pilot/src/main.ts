/**
 * FreeSWITCH pilot app — browser composition root.
 *
 * Owns exactly one `BrowserPhone` and one live `BrowserCall` per page.
 * Credentials live in memory only; no storage APIs, cookies, or
 * query-config parsing are used. All mutations are gated through
 * `deriveControls()` and routed through `runOperation()`.
 *
 * @module
 */

import { BrowserPhone } from 'sip-worker';
import type {
  BrowserCall,
  BrowserPhoneOptions,
  BrowserWebSocketFactory,
  DiagnosticLogger,
  IncomingBrowserCall,
  OutgoingBrowserCall,
} from 'sip-worker';
import { parsePilotConfig, toBrowserPhoneOptions } from './config.js';
import type { PilotFormValues } from './config.js';
import { safeError } from './redaction.js';
import { EvidenceRecorder, type ScenarioId } from './evidence.js';
import { deriveControls, type PilotFacts } from './controls.js';
import { createSelectableMediaEnvironment, type SelectableMediaEnvironment } from './media.js';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
}

function mustQuery<T extends HTMLElement>(selector: string, root: Element): T {
  const el = root.querySelector(selector);
  if (el === null) throw new Error(`missing element ${selector}`);
  return el as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let phone: BrowserPhone | null = null;
let currentCall: BrowserCall | undefined;
let outgoingCall: OutgoingBrowserCall | undefined;
let incomingCall: IncomingBrowserCall | undefined;
let remoteAudioStream: MediaStream | undefined;
let callDirection: 'outgoing' | 'incoming' | undefined;
let previousActiveCall: BrowserCall | undefined;
let renderTimer: number | undefined;
let selectedMedia: SelectableMediaEnvironment | undefined;
let evidence: EvidenceRecorder | undefined;
let operationInFlight = false;

const secrets: string[] = [];

const lastKnown = {
  connectionState: 'disconnected' as string,
  registrationState: 'unregistered' as string,
  callState: 'new' as string,
  signalingState: 'stable' as string,
  mediaState: 'new' as string,
  muted: 'active' as string,
  hold: 'active' as string,
  remoteIdentity: '' as string,
};

let lastError = '';

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function collectSecrets(): string[] {
  const values: string[] = [];
  const passwordInput = mustGet<HTMLInputElement>('sip-password');
  if (passwordInput.value.length > 0) values.push(passwordInput.value);

  const iceList = mustGet<HTMLDivElement>('ice-servers');
  for (const row of iceList.children) {
    const cred = mustQuery<HTMLInputElement>('[data-field="credential"]', row);
    if (cred.value.length > 0) values.push(cred.value);
    const user = mustQuery<HTMLInputElement>('[data-field="username"]', row);
    if (user.value.length > 0) values.push(user.value);
  }
  return values;
}

function clearCredentialInputs(): void {
  const passwordInput = mustGet<HTMLInputElement>('sip-password');
  passwordInput.value = '';

  const iceList = mustGet<HTMLDivElement>('ice-servers');
  for (const row of iceList.children) {
    const cred = mustQuery<HTMLInputElement>('[data-field="credential"]', row);
    cred.value = '';
  }
}

// ---------------------------------------------------------------------------
// Read form values
// ---------------------------------------------------------------------------

function readFormValues(): PilotFormValues {
  const iceRows = mustGet<HTMLDivElement>('ice-servers');
  const iceServers: { readonly urls: string; readonly username: string; readonly credential: string }[] = [];

  for (const row of iceRows.children) {
    const urls = mustQuery<HTMLInputElement>('[data-field="urls"]', row).value;
    const username = mustQuery<HTMLInputElement>('[data-field="username"]', row).value;
    const credential = mustQuery<HTMLInputElement>('[data-field="credential"]', row).value;
    if (urls.trim().length > 0) {
      iceServers.push({ urls, username, credential });
    }
  }

  return {
    wssUrl: mustGet<HTMLInputElement>('wss-url').value,
    sipDomain: mustGet<HTMLInputElement>('sip-domain').value,
    extension: mustGet<HTMLInputElement>('extension').value,
    password: mustGet<HTMLInputElement>('sip-password').value,
    testerLabel: mustGet<HTMLInputElement>('tester-label').value,
    relayOnly: mustGet<HTMLInputElement>('relay-only').checked,
    iceServers,
  };
}

// ---------------------------------------------------------------------------
// Error text helper
// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Run operation (evidence-backed)
// ---------------------------------------------------------------------------

async function runOperation(name: string, action: () => Promise<void>): Promise<void> {
  operationInFlight = renderControls();

  try {
    await action();
    if (evidence !== undefined) {
      evidence.diagnostic('info', 'lifecycle', 'lifecycle.disposed', { connectionId: name });
    }
  } catch (err: unknown) {
    if (evidence !== undefined) {
      const safe = safeError(err as Error & { code?: string }, secrets);
      evidence.diagnostic('high', 'action', `${name}_failed`, {
        code: safe.code ?? '',
      });
    }
    lastError = errorText(err);
  } finally {
    operationInFlight = renderControls();
  }
}

// ---------------------------------------------------------------------------
// Media environment
// ---------------------------------------------------------------------------

function buildMediaEnvironment(): SelectableMediaEnvironment {
  if (selectedMedia === undefined) {
    selectedMedia = createSelectableMediaEnvironment();
  }
  return selectedMedia;
}

// ---------------------------------------------------------------------------
// Phone creation
// ---------------------------------------------------------------------------

function createPhone(): BrowserPhone {
  const formValues = readFormValues();
  const config = parsePilotConfig(formValues);
  const micId = undefined;

  secrets.length = 0;
  secrets.push(...collectSecrets());

  const logger: DiagnosticLogger = (record): void => {
    if (evidence !== undefined) {
      evidence.diagnostic(
        record.severity === 'error' || record.severity === 'warn' ? 'medium' : 'info',
        record.subsystem,
        record.code,
        record.context,
      );
    }
  };

  const options: BrowserPhoneOptions = toBrowserPhoneOptions(config, logger, micId);

  const socketFactory: BrowserWebSocketFactory = (url, protocols) => new WebSocket(url, protocols);

  const mediaEnv = buildMediaEnvironment();

  const phoneInstance = new BrowserPhone({
    options,
    factory: socketFactory,
    lifecycle: {
      isOnline: () => navigator.onLine,
      subscribe: (event: string, listener: EventListenerOrEventListenerObject) => {
        window.addEventListener(event, listener);
        return () => window.removeEventListener(event, listener);
      },
    },
    mediaEnvironment: mediaEnv.environment,
  });

  return phoneInstance;
}

// ---------------------------------------------------------------------------
// Call wiring
// ---------------------------------------------------------------------------

function wirePhoneEvents(p: BrowserPhone): void {
  p.on('connectionStateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(previous as string, state as string);
    }
  });

  p.on('registrationStateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(previous as string, state as string);
    }
  });

  p.on('incomingCall', ({ call }) => {
    callDirection = 'incoming';
    incomingCall = call;
    currentCall = call;
    wireCallEvents(call);
  });

  p.on('failed', ({ error }) => {
    if (evidence !== undefined) {
      const safe = safeError(error, secrets);
      evidence.diagnostic('high', 'phone', 'phone_failed', {
        code: safe.code ?? '',
      });
    }
    lastError = errorText(error);
  });
}

function wireCallEvents(call: BrowserCall): void {
  call.on('stateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(previous as string, state as string);
    }
    lastKnown.callState = state as string;
  });

  call.on('signalingStateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(previous as string, state as string);
    }
  });

  call.on('holdStateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(JSON.stringify(previous), JSON.stringify(state));
    }
  });

  call.on('mutedChanged', ({ previous, muted }) => {
    if (evidence !== undefined) {
      evidence.transition(String(previous), String(muted));
    }
  });

  call.on('mediaStateChanged', ({ previous, state }) => {
    if (evidence !== undefined) {
      evidence.transition(previous as string, state as string);
    }
  });

  call.on('remoteAudio', ({ stream }) => {
    remoteAudioStream = stream;
  });

  call.on('mediaFailed', ({ error }) => {
    if (evidence !== undefined) {
      const safe = safeError(error as Error & { code?: string }, secrets);
      evidence.diagnostic('high', 'media', 'media_failed', {
        code: safe.code ?? '',
      });
    }
    lastError = errorText(error);
  });

  call.on('failed', ({ error }) => {
    if (evidence !== undefined) {
      const safe = safeError(error, secrets);
      evidence.diagnostic('high', 'call', 'call_failed', {
        code: safe.code ?? '',
      });
    }
    lastError = errorText(error);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleCreatePhone(): Promise<void> {
  if (phone !== null) return;
  phone = createPhone();
  wirePhoneEvents(phone);

  evidence = new EvidenceRecorder({
    secrets,
    build: {
      commitSha: __SIP_WORKER_PILOT_BUILD__.gitCommit,
      branch: 'pilot',
      timestamp: new Date().toISOString(),
    },
    environment: {
      os: navigator.userAgent,
      browser: navigator.userAgent,
      networkCondition: navigator.onLine ? 'online' : 'offline',
    },
    resourceSnapshot: phone.diagnostics.resources(),
    runId: `pilot-${Date.now()}`,
  });

  renderControls();
}

async function handleConnect(): Promise<void> {
  if (phone === null) return;
  await runOperation('connect', () => phone!.connect());
}

async function handleRegister(): Promise<void> {
  if (phone === null) return;
  await runOperation('register', () => phone!.register());
}

async function handleCall(): Promise<void> {
  if (phone === null || phone.activeCall !== undefined) return;
  const target = mustGet<HTMLInputElement>('destination').value.trim();
  if (target === '') return;

  callDirection = 'outgoing';
  const call = phone.createCall(target) as OutgoingBrowserCall;
  outgoingCall = call;
  currentCall = call;
  wireCallEvents(call);

  await runOperation('call', () => call.start());
}

async function handleCancel(): Promise<void> {
  if (outgoingCall === undefined || outgoingCall.state !== 'establishing') return;
  await runOperation('cancel', () => outgoingCall!.cancel());
}

async function handleHangup(): Promise<void> {
  if (currentCall === undefined || currentCall.state !== 'established') return;
  await runOperation('hangup', () => currentCall!.hangup());
}

async function handleAnswer(): Promise<void> {
  if (incomingCall === undefined) return;
  await runOperation('answer', () => incomingCall!.answer());
}

async function handleReject(): Promise<void> {
  if (incomingCall === undefined) return;
  await runOperation('reject', () => incomingCall!.reject(486, 'Busy Here'));
}

async function handleMute(): Promise<void> {
  if (currentCall === undefined) return;
  await runOperation('mute', async () => { currentCall!.setMuted(!currentCall!.muted); });
}

async function handleHold(): Promise<void> {
  if (currentCall === undefined) return;
  await runOperation('hold', () => currentCall!.hold());
}

async function handleResume(): Promise<void> {
  if (currentCall === undefined) return;
  await runOperation('resume', () => currentCall!.resume());
}

async function handleRestartIce(): Promise<void> {
  if (currentCall === undefined) return;
  await runOperation('restartIce', () => currentCall!.restartIce());
}

async function handleDtmf(tones: string): Promise<void> {
  if (currentCall === undefined) return;
  await runOperation('dtmf', () => currentCall!.sendDtmf(tones));
}

async function handleUnregister(): Promise<void> {
  if (phone === null) return;
  await runOperation('unregister', () => phone!.unregister());
}

async function handleDisconnect(): Promise<void> {
  if (phone === null) return;
  await runOperation('disconnect', () => phone!.disconnect());
}

async function handleDispose(): Promise<void> {
  if (phone === null) return;

  // Stop the render loop first
  if (renderTimer !== undefined) {
    clearInterval(renderTimer);
    renderTimer = undefined;
  }

  await runOperation('dispose', () => phone!.dispose());

  // Capture final snapshot, finalize evidence, clear credentials, render once
  if (evidence !== undefined) {
    const report = evidence.toJson();
    const preview = mustGet<HTMLElement>('evidence-preview');
    preview.textContent = report;
  }

  clearCredentialInputs();
  render();
}

function handleReset(): void {
  phone = null;
  currentCall = undefined;
  outgoingCall = undefined;
  incomingCall = undefined;
  remoteAudioStream = undefined;
  callDirection = undefined;
  selectedMedia = undefined;
  evidence = undefined;
  operationInFlight = false;
  secrets.length = 0;

  lastKnown.connectionState = 'disconnected';
  lastKnown.registrationState = 'unregistered';
  lastKnown.callState = 'new';
  lastKnown.signalingState = 'stable';
  lastKnown.mediaState = 'new';
  lastKnown.muted = 'active';
  lastKnown.hold = 'active';
  lastKnown.remoteIdentity = '';
  lastError = '';

  clearCredentialInputs();

  // Restart render loop
  renderTimer = window.setInterval(render, 250);
  render();
}

// ---------------------------------------------------------------------------
// Play audio
// ---------------------------------------------------------------------------

async function handlePlayAudio(): Promise<void> {
  const audio = mustGet<HTMLAudioElement>('phone-audio');
  if (remoteAudioStream !== undefined && audio.srcObject === null) {
    audio.srcObject = remoteAudioStream;
  }
  if (audio.srcObject === null) return;
  await audio.play();
}

// ---------------------------------------------------------------------------
// Evidence: copy and download
// ---------------------------------------------------------------------------

async function handleCopyEvidence(): Promise<void> {
  if (evidence === undefined) return;
  const json = evidence.toJson();
  await navigator.clipboard.writeText(json);
}

function handleDownloadEvidence(): void {
  if (evidence === undefined) return;
  const json = evidence.toJson();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pilot-evidence-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// ICE server rows
// ---------------------------------------------------------------------------

function addIceServerRow(): void {
  const container = mustGet<HTMLDivElement>('ice-servers');
  const row = document.createElement('div');
  row.className = 'ice-server-entry';

  const urlsInput = document.createElement('input');
  urlsInput.type = 'text';
  urlsInput.setAttribute('data-field', 'urls');
  urlsInput.placeholder = 'stun:stun.example.test:3478';

  const userInput = document.createElement('input');
  userInput.type = 'text';
  userInput.setAttribute('data-field', 'username');
  userInput.placeholder = 'Username';

  const credInput = document.createElement('input');
  credInput.type = 'password';
  credInput.setAttribute('data-field', 'credential');
  credInput.setAttribute('data-secret', 'true');
  credInput.placeholder = 'Credential';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(urlsInput);
  row.appendChild(userInput);
  row.appendChild(credInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

// ---------------------------------------------------------------------------
// DTMF pad
// ---------------------------------------------------------------------------

function buildDtmfPad(): void {
  const pad = mustGet<HTMLElement>('dtmf-pad');
  for (const tone of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dtmf-key';
    btn.textContent = tone;
    btn.addEventListener('click', () => void handleDtmf(tone));
    pad.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Scenario checklist
// ---------------------------------------------------------------------------

function syncScenarios(): void {
  if (evidence === undefined) return;
  const selects = document.querySelectorAll<HTMLSelectElement>('[data-scenario]');
  for (const select of selects) {
    const id = select.getAttribute('data-scenario') as ScenarioId | null;
    if (id === null) continue;
    const value = select.value;
    if (value === 'pass' || value === 'fail' || value === 'blocked') {
      evidence.setScenario(id, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Control state derivation
// ---------------------------------------------------------------------------

function gatherFacts(): PilotFacts {
  return {
    hasPhone: phone !== null,
    connectionState: phone === null ? 'disconnected' : phone.connectionState,
    registrationState: phone === null ? 'unregistered' : phone.registrationState,
    callState: currentCall?.state,
    callSignalingState: currentCall?.signalingState ?? 'stable',
    callDirection,
    callMuted: currentCall?.muted ?? false,
    callLocallyHeld: currentCall?.holdState.local ?? false,
    hasRemoteAudioStream: remoteAudioStream !== undefined,
    operationInFlight,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderControls(): boolean {
  const facts = gatherFacts();
  const controls = deriveControls(facts);

  mustGet<HTMLButtonElement>('create-phone').disabled = !controls.createPhone;
  mustGet<HTMLButtonElement>('connect').disabled = !controls.connect;
  mustGet<HTMLButtonElement>('register').disabled = !controls.register;
  mustGet<HTMLButtonElement>('call').disabled = !controls.call;
  mustGet<HTMLButtonElement>('cancel').disabled = !controls.cancel;
  const hangupBtn = mustGet<HTMLButtonElement>('hangup');
  hangupBtn.disabled = !controls.hangup;
  if (controls.incomingHangupUnsupported) {
    hangupBtn.title = 'Incoming established calls cannot be locally hung up (INVALID_STATE)';
  } else {
    hangupBtn.title = '';
  }
  const hangupNote = document.getElementById('hangup-note');
  if (hangupNote !== null) {
    hangupNote.textContent = controls.incomingHangupUnsupported
      ? 'Local hangup unsupported on established incoming calls (INVALID_STATE)'
      : '';
    hangupNote.hidden = !controls.incomingHangupUnsupported;
  }
  mustGet<HTMLButtonElement>('answer').disabled = !controls.answer;
  mustGet<HTMLButtonElement>('reject').disabled = !controls.reject;
  mustGet<HTMLButtonElement>('mute-toggle').disabled = !controls.mute;
  mustGet<HTMLButtonElement>('hold').disabled = !controls.hold;
  mustGet<HTMLButtonElement>('resume').disabled = !controls.resume;
  mustGet<HTMLButtonElement>('restart-ice').disabled = !controls.restartIce;
  mustGet<HTMLButtonElement>('unregister').disabled = !controls.unregister;
  mustGet<HTMLButtonElement>('disconnect').disabled = !controls.disconnect;
  mustGet<HTMLButtonElement>('dispose').disabled = !controls.dispose;
  mustGet<HTMLButtonElement>('reset').disabled = !controls.reset;

  // Mute button label
  const muteBtn = mustGet<HTMLButtonElement>('mute-toggle');
  muteBtn.textContent = currentCall?.muted ? 'Unmute' : 'Mute';

  return facts.operationInFlight;
}

function render(): void {
  // Sync scenario checkboxes
  syncScenarios();

  // Status chips
  const connectionEl = mustGet<HTMLElement>('connection-state');
  const registrationEl = mustGet<HTMLElement>('registration-state');
  const callStateEl = mustGet<HTMLElement>('call-state');
  const signalingEl = mustGet<HTMLElement>('signaling-state');
  const mediaEl = mustGet<HTMLElement>('media-state');
  const muteEl = mustGet<HTMLElement>('mute-state');
  const holdEl = mustGet<HTMLElement>('hold-state');
  const remoteEl = mustGet<HTMLElement>('remote-identity');

  if (phone === null) {
    connectionEl.textContent = 'disconnected';
    registrationEl.textContent = 'unregistered';
  } else {
    connectionEl.textContent = phone.connectionState;
    registrationEl.textContent = phone.registrationState;

    // Update last-known from active call
    const active = phone.activeCall;
    if (active !== undefined) {
      lastKnown.callState = active.state;
      lastKnown.signalingState = active.signalingState;
      lastKnown.mediaState = active.mediaState;
      lastKnown.muted = active.muted ? 'muted' : 'active';
      lastKnown.hold = active.holdState.local ? 'held' : 'active';
      if (active.remoteIdentity?.uri !== undefined) {
        lastKnown.remoteIdentity = active.remoteIdentity.uri;
      }
      previousActiveCall = active;
    } else if (previousActiveCall !== undefined) {
      // Active call transitioned to undefined — mark terminated.
      lastKnown.callState = 'terminated';
      previousActiveCall = undefined;
    }
  }

  callStateEl.textContent = lastKnown.callState;
  signalingEl.textContent = lastKnown.signalingState;
  mediaEl.textContent = lastKnown.mediaState;
  muteEl.textContent = lastKnown.muted;
  holdEl.textContent = lastKnown.hold;
  remoteEl.textContent = lastKnown.remoteIdentity || '---';

  // Error box
  const errorBox = mustGet<HTMLElement>('typed-error');
  if (lastError.length > 0) {
    errorBox.textContent = lastError;
    errorBox.hidden = false;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  // Resources
  const resourcesEl = mustGet<HTMLElement>('resources');
  resourcesEl.textContent =
    phone === null ? '{}' : JSON.stringify(phone.diagnostics.resources());

  // Event log: populated by evidence preview on dispose
  // Live rendering is deferred to keep the render loop lightweight

  // Controls
  renderControls();
}

// ---------------------------------------------------------------------------
// Audio element
// ---------------------------------------------------------------------------

function ensureAudioElement(): HTMLAudioElement {
  let audio = document.getElementById('phone-audio') as HTMLAudioElement | null;
  if (audio === null) {
    audio = document.createElement('audio');
    audio.id = 'phone-audio';
    audio.autoplay = false;
    document.body.appendChild(audio);
  }
  return audio;
}

// ---------------------------------------------------------------------------
// Button wiring
// ---------------------------------------------------------------------------

function wireButtons(): void {
  mustGet<HTMLButtonElement>('create-phone').addEventListener('click', () => void handleCreatePhone());
  mustGet<HTMLButtonElement>('connect').addEventListener('click', () => void handleConnect());
  mustGet<HTMLButtonElement>('register').addEventListener('click', () => void handleRegister());
  mustGet<HTMLButtonElement>('call').addEventListener('click', () => void handleCall());
  mustGet<HTMLButtonElement>('cancel').addEventListener('click', () => void handleCancel());
  mustGet<HTMLButtonElement>('hangup').addEventListener('click', () => void handleHangup());
  mustGet<HTMLButtonElement>('answer').addEventListener('click', () => void handleAnswer());
  mustGet<HTMLButtonElement>('reject').addEventListener('click', () => void handleReject());
  mustGet<HTMLButtonElement>('mute-toggle').addEventListener('click', () => void handleMute());
  mustGet<HTMLButtonElement>('hold').addEventListener('click', () => void handleHold());
  mustGet<HTMLButtonElement>('resume').addEventListener('click', () => void handleResume());
  mustGet<HTMLButtonElement>('restart-ice').addEventListener('click', () => void handleRestartIce());
  mustGet<HTMLButtonElement>('unregister').addEventListener('click', () => void handleUnregister());
  mustGet<HTMLButtonElement>('disconnect').addEventListener('click', () => void handleDisconnect());
  mustGet<HTMLButtonElement>('dispose').addEventListener('click', () => void handleDispose());
  mustGet<HTMLButtonElement>('reset').addEventListener('click', () => void handleReset());
  mustGet<HTMLButtonElement>('add-ice-server').addEventListener('click', () => addIceServerRow());
  mustGet<HTMLButtonElement>('copy-evidence').addEventListener('click', () => void handleCopyEvidence());
  mustGet<HTMLButtonElement>('download-evidence').addEventListener('click', () => handleDownloadEvidence());

  // Play audio button
  mustGet<HTMLButtonElement>('play-audio').addEventListener('click', () => void handlePlayAudio());

  // DTMF pad is built dynamically
  buildDtmfPad();
}

// ---------------------------------------------------------------------------
// Microphone enumeration
// ---------------------------------------------------------------------------

async function populateMicrophones(): Promise<void> {
  const select = mustGet<HTMLSelectElement>('microphone');
  try {
    const mediaEnv = buildMediaEnvironment();
    const mics = await mediaEnv.listMicrophones();
    // Clear existing options except the default
    while (select.options.length > 1) {
      select.remove(1);
    }
    for (const mic of mics) {
      const option = document.createElement('option');
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${select.options.length}`;
      select.appendChild(option);
    }
  } catch {
    // enumeration/permission failure: leave the list empty
  }

  select.addEventListener('change', () => {
    const value = select.value;
    if (selectedMedia !== undefined) {
      selectedMedia.selectMicrophone(value.length > 0 ? value : undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  ensureAudioElement();
  wireButtons();
  void populateMicrophones();
  renderTimer = window.setInterval(render, 250);
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
