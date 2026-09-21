import { describe, it, expect } from 'vitest';
import { matchReflexiveToObservation, parseCandidate, reflexivePorts } from './stun-observations.mjs';

// A real Chromium line, one per typ, with the trailing ufrag/network fields the
// engines actually append.
const HOST = 'candidate:842163049 1 udp 1677729535 127.0.0.1 51234 typ host generation 0 ufrag aBc network-id 1';
const SRFLX = 'candidate:2504790438 1 udp 1686052607 127.0.0.2 51234 typ srflx raddr 127.0.0.1 rport 51234 generation 0 ufrag aBc network-id 1';
const RELAY = 'candidate:1234 1 udp 41885439 127.0.0.2 60000 typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag aBc network-id 1';

describe('parseCandidate', () => {
  it('reads type, address, and port regardless of trailing fields', () => {
    expect(parseCandidate(SRFLX)).toEqual({ type: 'srflx', address: '127.0.0.2', port: 51234 });
    expect(parseCandidate(HOST)?.type).toEqual('host');
    expect(parseCandidate(RELAY)?.type).toEqual('relay');
  });

  it('returns null for anything that is not a candidate line', () => {
    expect(parseCandidate('')).toBeNull();
    expect(parseCandidate('a=end-of-candidates')).toBeNull();
    expect(parseCandidate('candidate:1 1 udp 1 127.0.0.1 typ host')).toBeNull(); // no port
  });
});

describe('reflexivePorts', () => {
  it('collects only srflx ports', () => {
    expect(reflexivePorts([HOST, SRFLX, RELAY])).toEqual([51234]);
  });
});

describe('matchReflexiveToObservation', () => {
  it('accepts a reflexive candidate whose port the server observed', () => {
    const out = matchReflexiveToObservation({ candidateLines: [HOST, SRFLX], observedPorts: [51234, 51235] });
    expect(out).toEqual({ ok: true, matched: [51234], reflexivePorts: [51234], reason: 'ok' });
  });

  it('rejects a fabricated mapping — a reflexive candidate on a port the server never saw', () => {
    // This is the defect class that cost the FreeSWITCH Firefox investigation:
    // a mapping that was never observed by the responder.
    const out = matchReflexiveToObservation({ candidateLines: [HOST, SRFLX], observedPorts: [60000] });
    expect(out.ok).toBe(false);
    expect(out.reason).toEqual('no-reflexive-port-observed');
  });

  it('rejects an empty capture with its own reason, so the two failures are distinguishable', () => {
    expect(matchReflexiveToObservation({ candidateLines: [], observedPorts: [51234] }).reason).toEqual('no-reflexive-candidate');
    expect(matchReflexiveToObservation({ candidateLines: [HOST], observedPorts: [51234] }).reason).toEqual('no-reflexive-candidate');
  });
});
