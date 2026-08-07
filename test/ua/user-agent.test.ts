import { describe, expect, it } from 'vitest';
import { FakeClock } from '../support/fake-clock.js';
import { FakeTransport } from '../support/fake-transport.js';
import { UserAgent } from '../../src/ua/user-agent.js';
import type { LivenessStrategy } from '../../src/reliability/index.js';
import { parseMessage } from '../../src/messages/parser.js';
import type { SipRequestMessage } from '../../src/messages/message.js';

function makeIdGenerator() {
  let n = 0;
  return { branch: () => `id-${(n += 1)}` };
}

/** Recording strategy to prove the UA drives start/stop in sync with connect/disconnect. */
class RecordingLiveness implements LivenessStrategy {
  readonly calls: Array<'start' | 'stop'> = [];
  start(): void {
    this.calls.push('start');
  }
  stop(): void {
    this.calls.push('stop');
  }
}

function setup(options: { liveness?: LivenessStrategy; intervalMs?: number } = {}) {
  const clock = new FakeClock();
  const transport = new FakeTransport({ reliable: true, framing: 'stream' });
  const idGenerator = makeIdGenerator();
  const ua = new UserAgent({
    transport,
    clock,
    registrarUri: 'sip:registrar.example.com',
    aor: 'sip:alice@example.com',
    contact: '<sip:alice@192.0.2.1:5060>',
    idGenerator,
    liveness: options.liveness,
  });
  return { clock, transport, ua, idGenerator };
}

/** All sent OPTIONS requests, parsed. */
function sentOptions(transport: FakeTransport): SipRequestMessage[] {
  const out: SipRequestMessage[] = [];
  for (const bytes of transport.sent) {
    const parsed = parseMessage(bytes);
    if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === 'OPTIONS') {
      out.push(parsed.value);
    }
  }
  return out;
}

describe('UserAgent liveness wiring', () => {
  it('starts an injected strategy on connect and stops it on disconnect', async () => {
    const liveness = new RecordingLiveness();
    const { ua } = setup({ liveness });

    await ua.connect();
    expect(liveness.calls).toEqual(['start']);

    await ua.disconnect();
    expect(liveness.calls).toEqual(['start', 'stop']);
  });

  it('defaults to OPTIONS probes when no strategy is injected and stops them on disconnect', async () => {
    const { clock, transport, ua } = setup();
    await ua.connect();

    // No immediate probe; the first fires at the configured interval (30s).
    clock.advance(29999);
    expect(sentOptions(transport)).toHaveLength(0);
    clock.advance(1);
    const probes = sentOptions(transport);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.headers.get('Via')).toMatch(/branch=z9hG4bK-/);
    expect(probes[0]!.headers.get('CSeq')).toBe('1 OPTIONS');

    // Disconnect stops the probe timer: nothing further is sent.
    const before = sentOptions(transport).length;
    await ua.disconnect();
    clock.advance(60000);
    expect(sentOptions(transport)).toHaveLength(before);
  });
});
