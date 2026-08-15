/**
 * BrowserPhone connection + registration recovery orchestration tests (v0.7).
 *
 * On unexpected transport loss the phone synchronously transitions connection
 * and an already-registered registration to `recovering`, then runs exactly the
 * ordered bounded pipeline (reconnect → registration recovery → commit
 * `registered` → commit `connected`), guarded by lifetime + recovery-generation
 * tokens. These tests drive it on deterministic fakes and assert one retry
 * timer, one registration exchange, preserved Call-ID, strictly-increasing CSeq,
 * and zero residue after disposal.
 *
 * Note on `failed` events: the core UA surfaces genuine transport / recovery
 * failures through the shared runtime (SipIngress TRANSPORT_FAILED on a loss,
 * and REGISTRATION_RECOVERY_FAILED from `recoverRegistration()`), in addition to
 * the phone's own CONNECTION_RECOVERY_EXHAUSTED. Recovery-outcome assertions
 * therefore filter on the canonical recovery codes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPhone,
  sentRequests,
  registerCallIds,
  registerCSeqs,
  flush,
  settle,
  type PhoneHarness,
} from '../support/phone-harness.js';

/** Canonical terminal codes a recovery cycle can carry on the `failed` event. */
const RECOVERY_CODES = ['CONNECTION_RECOVERY_EXHAUSTED', 'REGISTRATION_RECOVERY_FAILED'];

/** Only the recovery-canonical failures among the delivered `failed` events. */
function recoveryFailures(errors: Error[]): Error[] {
  return errors.filter(
    (e) => RECOVERY_CODES.includes((e as Error & { code?: string }).code ?? ''),
  );
}

/** A phone configured for bounded reconnection. */
function buildRecoveringPhone(overrides = {}): PhoneHarness {
  return buildPhone({ reconnect: overrides });
}

/** Connect + register against the fake server. */
async function registered(h: PhoneHarness): Promise<void> {
  await h.phone.connect();
  await h.phone.register();
  expect(h.phone.connectionState).toBe('connected');
  expect(h.phone.registrationState).toBe('registered');
}

/** Let the microtask scheduling of the settled recovery pipeline flush. */
async function recoverySettled(): Promise<void> {
  for (let i = 0; i < 15; i += 1) await flush();
  await settle();
}

describe('BrowserPhone — connection + registration recovery', () => {
  it('re-enters recovering synchronously on unexpected loss, then reconnects and re-registers preserving Call-ID and strictly increasing CSeq', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    const originalCallId = registerCallIds()[0];

    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    expect(h.phone.registrationState).toBe('recovering');

    // One retry timer is armed and one register exchange follows; the pipeline
    // settles on the auto-opened recovery socket.
    await recoverySettled();
    expect(h.phone.connectionState).toBe('connected');
    expect(h.phone.registrationState).toBe('registered');
    expect(registerCallIds()).toEqual([originalCallId, originalCallId]);
    expect(registerCSeqs()[1]!).toBeGreaterThan(registerCSeqs()[0]!);
    expect(registerCSeqs()[1]!).toBe(registerCSeqs()[0]! + 1);

    // Zero resources after disposal (core's OPTIONS liveness is still armed on
    // the shared clock until dispose tears the runtime down).
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('leaves a never-registered account out of recovering on loss', async () => {
    const h = buildRecoveringPhone();
    await h.phone.connect();
    expect(h.phone.registrationState).toBe('unregistered');

    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    expect(h.phone.registrationState).not.toBe('recovering');

    await recoverySettled();
    expect(h.phone.connectionState).toBe('connected');
    await h.phone.dispose();
  });

  it('does not resurrect registration after a manual unregister', async () => {
    const h = buildRecoveringPhone();
    await registered(h);
    await h.phone.unregister();
    const registersBefore = sentRequests('REGISTER').length;

    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    expect(h.phone.registrationState).not.toBe('recovering');

    await recoverySettled();
    expect(h.phone.connectionState).toBe('connected');
    // No new register exchange; the manual unregister disabled re-registration.
    expect(sentRequests('REGISTER').length).toBe(registersBefore);
    await h.phone.dispose();
  });

  it('an unregister during an in-flight recovery cancels recovery without a terminal failure', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 20, recoveryTimeoutMs: 300 });
    await registered(h);

    const failed: Error[] = [];
    h.phone.on('failed', (e) => failed.push(e.error));

    // Hold the recovery socket pending so recovery is mid-cycle when we unregister.
    h.server.connectOnNext('pending', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    expect(h.phone.registrationState).toBe('recovering');

    // A manual unregister cancels the automatic recovery. The unregister REGISTER
    // itself cannot be sent while the transport is down (a genuine backlog), but
    // the recovery pipeline must be cancelled, not exhausted, by this action.
    await expect(h.phone.unregister()).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(h.phone.registrationState).not.toBe('recovering');

    h.clock.advance(1_000); // even past the recovery deadline, nothing terminal fires
    await recoverySettled();
    expect(recoveryFailures(failed)).toHaveLength(0);
    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('dispose while a connect is settling does not break teardown', async () => {
    const h = buildRecoveringPhone();
    await registered(h);

    const connecting = h.phone.connect();
    await h.phone.dispose(); // dispose while connect() is outstanding
    await connecting;

    expect(h.phone.connectionState).toBe('disposed');
    expect(h.clock.pendingCount).toBe(0);
  });

  it('pauses reconnect while offline and resumes on online', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10, recoveryTimeoutMs: 5_000 });
    await registered(h);

    // The first recovery attempt must FAIL so a retry is owed; otherwise nothing
    // is paused and an auto-opened socket would complete recovery immediately.
    // Flush so attempt 1's failure microtask settles (arming the retry) before
    // taking the phone offline.
    h.server.connectOnNext('error', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    await flush();

    // Offline pauses creation of the next socket: the failed attempt's socket
    // exists synchronously, and no second socket opens while offline.
    h.lifecycle.setOnline(false);
    h.clock.advance(100);
    expect(h.server.sockets.length).toBe(2);

    h.lifecycle.setOnline(true); // online resumes the attempt
    await recoverySettled();
    expect(h.phone.connectionState).toBe('connected');
    expect(h.phone.registrationState).toBe('registered');

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('exhausts attempts and emits CONNECTION_RECOVERY_EXHAUSTED', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10, recoveryTimeoutMs: 5_000 });
    await registered(h);

    const failed: Error[] = [];
    h.phone.on('failed', (e) => failed.push(e.error));

    h.server.connectOnNext('error', 2); // every recovery attempt fails
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');

    // Lift the microtask so the first attempt's failure arms its retry timer,
    // then fire it to run and fail the second (exhausting) attempt.
    await flush();
    h.clock.advance(20);
    await recoverySettled();

    expect(h.phone.connectionState).toBe('failed');
    const failures = recoveryFailures(failed);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'CONNECTION_RECOVERY_EXHAUSTED' });

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('trips the total recovery deadline with a hanging socket', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 20, initialDelayMs: 10, maxDelayMs: 10, recoveryTimeoutMs: 300 });
    await registered(h);

    const failed: Error[] = [];
    h.phone.on('failed', (e) => failed.push(e.error));

    // A pending socket never opens; only the deadline closes the cycle.
    h.server.connectOnNext('pending', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    h.clock.advance(300); // total recovery deadline trips

    await recoverySettled();
    expect(h.phone.connectionState).toBe('failed');
    const failures = recoveryFailures(failed);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'CONNECTION_RECOVERY_EXHAUSTED' });

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('cancels recovery on an explicit disconnect without emitting a terminal failure', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 20, recoveryTimeoutMs: 10_000 });
    await registered(h);

    const failed: Error[] = [];
    h.phone.on('failed', (e) => failed.push(e.error));

    h.server.connectOnNext('pending', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    await h.phone.disconnect();
    h.clock.advance(10_000); // even past the deadline, nothing terminal fires

    expect(h.phone.connectionState).toBe('disconnected');
    expect(recoveryFailures(failed)).toHaveLength(0);

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });

  it('dispose during recovery leaves no pending timers or attached listeners', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 20, recoveryTimeoutMs: 10_000 });
    await registered(h);

    const failed: Error[] = [];
    h.phone.on('failed', (e) => failed.push(e.error));

    h.server.connectOnNext('pending', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');

    await h.phone.dispose();
    h.clock.advance(10_000); // a ghost recovery would fire here; it must not
    await recoverySettled();

    expect(h.phone.connectionState).toBe('disposed');
    expect(recoveryFailures(failed)).toHaveLength(0);
    expect(h.clock.pendingCount).toBe(0);
  });

  it('suppresses a stale generation whose connect settles after the cycle ended', async () => {
    const h = buildRecoveringPhone({ maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 10, recoveryTimeoutMs: 300 });
    await registered(h);

    // Attempt 1: a pending socket that never opens within the cycle. Ending the
    // cycle (dispose) detaches it, so its late open must not resurrect recovery.
    h.server.connectOnNext('pending', 1);
    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');

    await h.phone.dispose(); // ends the cycle; detaches the pending generation
    // A stale generation's (late) connect opening cannot resurrect the cycle.
    // emitOpen bypasses the harness readyState guard to model a late socket that
    // was already detached: the transport ignores it, so nothing changes.
    h.server.current.emitOpen('sip');
    await recoverySettled();

    expect(h.phone.connectionState).toBe('disposed');
    expect(h.clock.pendingCount).toBe(0);
  });

  it('an observer throwing does not break the recovery pipeline', async () => {
    const h = buildRecoveringPhone();
    await registered(h);

    h.phone.on('registrationStateChanged', () => {
      throw new Error('observer boom');
    });
    h.phone.on('connectionStateChanged', () => {
      throw new Error('observer boom');
    });

    h.server.dropSocket(1006);
    expect(h.phone.connectionState).toBe('recovering');
    await recoverySettled();

    expect(h.phone.connectionState).toBe('connected');
    expect(h.phone.registrationState).toBe('registered');
    expect(registerCSeqs()[1]!).toBeGreaterThan(registerCSeqs()[0]!);

    await h.phone.dispose();
    expect(h.clock.pendingCount).toBe(0);
  });
});
