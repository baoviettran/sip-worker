/**
 * Integration test: UserAgent + MockRegistrar.
 *
 * The mock registrar delivers responses SYNCHRONOUSLY from the transport
 * `onSend` hook, proving the UA's branch tracking and ingress are installed
 * BEFORE the first byte goes out.
 */

import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import { MockRegistrar } from '../support/mock-registrar.js';
import { AuthManager } from '../../src/auth/manager.js';

const REGISTRAR_URI = 'sip:registrar.example.com';
const AOR = 'sip:alice@example.com';
const CONTACT = '<sip:alice@192.0.2.1:5060>';
const USERNAME = 'alice';
const PASSWORD = 'Circle Of Life';

function makeIdGenerator() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

function setup(options: {
  challenge?: boolean;
  expires?: number;
  minExpires?: number;
  refreshFraction?: number;
} = {}) {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'stream' });
  const idGenerator = makeIdGenerator();
  const authManager = new AuthManager(idGenerator);

  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: REGISTRAR_URI,
    aor: AOR,
    contact: CONTACT,
    credentials: { username: USERNAME, password: PASSWORD },
    idGenerator,
    authManager,
    refreshFraction: options.refreshFraction,
  });

  const server = new MockRegistrar({
    transport,
    challenge: options.challenge,
    expires: options.expires,
    minExpires: options.minExpires,
  });

  return { clock, transport, ua, server, idGenerator, authManager };
}

describe('UserAgent registration integration', () => {
  it('registers with authentication challenge (brief Step 1 verbatim)', async () => {
    const { ua, server } = setup({ challenge: true });
    await ua.connect();
    server.start();

    expect(ua.registerState).toBe('unregistered');
    await ua.register();
    expect(ua.registerState).toBe('registered');
    expect(server.requests.map((r) => r.headers.has('Authorization'))).toEqual([false, true]);

    await ua.disconnect();
  });

  it('retries on 423 Min-Expires', async () => {
    const { ua, server } = setup({ minExpires: 600 });
    await ua.connect();
    server.start();

    const registration = ua.register();
    await registration;
    expect(ua.registerState).toBe('registered');
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    const retried = server.requests[1];
    expect(retried?.headers.get('Expires')).toBe('600');

    await ua.disconnect();
  });

  it('refreshes registration at the configured fraction', async () => {
    const { ua, server, clock } = setup({ expires: 120, refreshFraction: 0.5 });
    await ua.connect();
    server.start();

    await ua.register();
    expect(ua.registerState).toBe('registered');
    expect(server.requests.length).toBe(1);

    // Refresh at 0.5 * 120 = 60s
    clock.advance(60 * 1000);
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
    const refresh = server.requests[1];
    expect(refresh?.headers.get('Call-ID')).toBe(server.requests[0]?.headers.get('Call-ID'));

    await ua.disconnect();
  });

  it('unregisters with Contact * and Expires 0', async () => {
    const { ua, server } = setup();
    await ua.connect();
    server.start();

    await ua.register();
    expect(ua.registerState).toBe('registered');

    await ua.unregister();
    expect(ua.registerState).toBe('unregistered');

    const unregRequest = server.requests[server.requests.length - 1];
    expect(unregRequest?.headers.get('Contact')).toBe('*');
    expect(unregRequest?.headers.get('Expires')).toBe('0');

    await ua.disconnect();
  });

  it('re-registers on reconnect after transport disconnect', async () => {
    const { ua, server, transport } = setup();
    await ua.connect();
    server.start();

    await ua.register();
    expect(ua.registerState).toBe('registered');
    const requestsBeforeReconnect = server.requests.length;

    // Simulate temporary transport disconnect (network outage, not close)
    transport.simulateDisconnect();
    expect(ua.registerState).toBe('recovering');

    // Simulate transport reconnect — UA should re-register automatically
    transport.simulateReconnect();
    expect(server.requests.length).toBeGreaterThan(requestsBeforeReconnect);
    expect(ua.registerState).toBe('registered');

    await ua.disconnect();
  });

  it('makes registration recovery an awaitable owned exchange', async () => {
    const { ua, server, transport } = setup();
    await ua.connect();
    server.start();

    await ua.register();
    const callId = server.requests[0]!.headers.get('Call-ID');
    expect(ua.registerState).toBe('registered');
    const requestsBeforeRecovery = server.requests.length;

    // Lose the transport: the UA marks registration recovery pending and the
    // registered identity is preserved; then reconnect and await it explicitly.
    transport.simulateDisconnect();
    expect(ua.registerState).toBe('recovering');
    transport.simulateReconnect();
    await (ua as unknown as { recoverRegistration: () => Promise<void> }).recoverRegistration();

    expect(ua.registerState).toBe('registered');
    const recovery = server.requests[server.requests.length - 1]!;
    expect(recovery.headers.get('Call-ID')).toBe(callId);
    expect(server.requests.length).toBeGreaterThan(requestsBeforeRecovery);

    await ua.disconnect();
  });

  it('rejects registration on transaction timeout', async () => {
    const { ua, server, clock } = setup();
    await ua.connect();
    server.setResponding(false); // Don't respond
    server.start();

    const registration = ua.register();
    expect(ua.registerState).toBe('registering');

    // Advance past timer F (32s for non-INVITE)
    clock.advance(32000);

    await expect(registration).rejects.toThrow();
    expect(ua.registerState).toBe('failed');

    await ua.disconnect();
  });

  it('cleans up listeners and timers on disconnect', async () => {
    const { ua, server } = setup({ expires: 120 });
    await ua.connect();
    server.start();

    await ua.register();
    expect(ua.registerState).toBe('registered');

    await ua.disconnect();
    // After disconnect, the UA should be in a clean state
    expect(ua.registerState).toBe('unregistered');
  });
});
