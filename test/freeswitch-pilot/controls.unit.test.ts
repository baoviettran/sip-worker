import { describe, expect, it } from 'vitest';
import { deriveControls, type PilotFacts } from '../../examples/freeswitch-pilot/src/controls.js';

// ---------------------------------------------------------------------------
// Default facts: everything disabled / absent
// ---------------------------------------------------------------------------

function facts(overrides: Partial<PilotFacts> = {}): PilotFacts {
  return Object.freeze({
    hasPhone: false,
    connectionState: 'disconnected',
    registrationState: 'unregistered',
    callState: undefined,
    callSignalingState: 'stable',
    callDirection: undefined,
    callMuted: false,
    callLocallyHeld: false,
    hasRemoteAudioStream: false,
    operationInFlight: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveControls', () => {
  // --- No phone ---
  it('no phone: only createPhone enabled', () => {
    expect(deriveControls(facts())).toMatchObject({
      createPhone: true,
      connect: false,
      register: false,
      call: false,
      cancel: false,
      hangup: false,
      answer: false,
      reject: false,
      mute: false,
      hold: false,
      resume: false,
      restartIce: false,
      dtmf: false,
      unregister: false,
      disconnect: false,
      dispose: false,
      reset: false,
    });
  });

  // --- Connected + registered, no call ---
  it('registered idle: call, unregister, disconnect, dispose enabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
    }))).toMatchObject({
      createPhone: false,
      connect: false,
      register: false,
      unregister: true,
      disconnect: true,
      dispose: true,
      call: true,
      cancel: false,
      hangup: false,
      answer: false,
      reject: false,
      mute: false,
      hold: false,
      resume: false,
      restartIce: false,
      dtmf: false,
      reset: false,
    });
  });

  // --- Outgoing establishing ---
  it('outgoing establishing: cancel enabled, hangup disabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'establishing',
      callDirection: 'outgoing',
    }))).toMatchObject({
      cancel: true,
      hangup: false,
      call: false,
      answer: false,
      reject: false,
    });
  });

  // --- Outgoing established ---
  it('outgoing established: hangup, mute, hold, restartIce, dtmf enabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'outgoing',
    }))).toMatchObject({
      hangup: true,
      mute: true,
      hold: true,
      resume: false,
      restartIce: true,
      dtmf: true,
      cancel: false,
      answer: false,
      reject: false,
    });
  });

  // --- Incoming ringing ---
  it('incoming ringing: answer, reject enabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'new',
      callDirection: 'incoming',
    }))).toMatchObject({
      answer: true,
      reject: true,
      hangup: false,
      call: false,
      cancel: false,
    });
  });

  // --- Incoming establishing (answer in progress) ---
  it('incoming establishing: answer, reject enabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'establishing',
      callDirection: 'incoming',
    }))).toMatchObject({
      answer: true,
      reject: true,
      hangup: false,
    });
  });

  // --- Incoming established (INVALID_STATE limitation) ---
  it('incoming established: hangup disabled, incomingHangupUnsupported flag', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'incoming',
    }))).toMatchObject({
      hangup: false,
      incomingHangupUnsupported: true,
      mute: true,
      hold: true,
      dtmf: true,
      restartIce: true,
    });
  });

  // --- Locally held ---
  it('locally held: resume enabled, hold disabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'outgoing',
      callLocallyHeld: true,
    }))).toMatchObject({
      hold: false,
      resume: true,
      hangup: true,
      mute: true,
      dtmf: true,
      restartIce: true,
    });
  });

  // --- Muted ---
  it('established and muted: mute toggle available', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'outgoing',
      callMuted: true,
    }))).toMatchObject({
      mute: true,
      hangup: true,
    });
  });

  // --- Operation in flight disables mutations ---
  it('operation in flight: all mutations disabled except dispose', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'outgoing',
      operationInFlight: true,
    }))).toMatchObject({
      dispose: true,
      call: false,
      hangup: false,
      cancel: false,
      answer: false,
      reject: false,
      mute: false,
      hold: false,
      resume: false,
      restartIce: false,
      dtmf: false,
      unregister: false,
      disconnect: false,
      connect: false,
      register: false,
      createPhone: false,
      reset: false,
    });
  });

  // --- Disposed ---
  it('phone disposed: only reset enabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'disposed',
    }))).toMatchObject({
      reset: true,
      dispose: false,
      connect: false,
      createPhone: false,
    });
  });

  // --- Recovering connection ---
  it('recovering connection: phone auto-reconnecting, no manual connect', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'recovering',
      registrationState: 'unregistered',
    }))).toMatchObject({
      connect: false,
      disconnect: true,
      dispose: true,
    });
  });

  // --- Failed connection ---
  it('failed connection: dispose only', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'failed',
    }))).toMatchObject({
      dispose: true,
      connect: false,
      register: false,
      call: false,
    });
  });

  // --- Terminating call ---
  it('terminating call: all call mutations disabled', () => {
    expect(deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'terminating',
      callDirection: 'outgoing',
    }))).toMatchObject({
      hangup: false,
      cancel: false,
      mute: false,
      hold: false,
      dtmf: false,
    });
  });

  // --- Remote audio stream present ---
  it('has remote audio stream: noted in facts', () => {
    const result = deriveControls(facts({
      hasPhone: true,
      connectionState: 'connected',
      registrationState: 'registered',
      callState: 'established',
      callDirection: 'outgoing',
      hasRemoteAudioStream: true,
    }));
    expect(result.hangup).toBe(true);
  });
});
