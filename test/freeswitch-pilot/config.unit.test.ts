import { describe, expect, it } from 'vitest';
import {
  parsePilotConfig,
  safeEndpointSummary,
  toBrowserPhoneOptions,
  type PilotFormValues,
} from '../../examples/freeswitch-pilot/src/config.js';

const base: PilotFormValues = {
  wssUrl: 'wss://fs-dev.example.test:7443/ws?route=pilot#ignored',
  sipDomain: 'tenant.example.test',
  extension: '1001',
  password: 'top-secret',
  testerLabel: 'dev-freeswitch',
  relayOnly: false,
  iceServers: [],
};

describe('parsePilotConfig', () => {
  it('maps a FreeSWITCH account without a display name', () => {
    const config = parsePilotConfig(base);
    const options = toBrowserPhoneOptions(config, () => {}, 'mic-1');
    expect(options.signaling).toEqual({ url: base.wssUrl });
    expect(options.account).toEqual({
      registrarUri: 'sip:tenant.example.test',
      aor: 'sip:1001@tenant.example.test',
      contact: 'sip:1001@tenant.example.test',
      username: '1001',
      password: 'top-secret',
    });
    expect(options.media).toMatchObject({ microphoneDeviceId: 'mic-1', holdDirection: 'sendonly' });
    expect(options.account).not.toHaveProperty('displayName');
  });

  it.each(['ws://fs.test/ws', 'https://fs.test/ws', 'not-a-url'])('rejects non-WSS endpoint %s', (wssUrl) => {
    expect(() => parsePilotConfig({ ...base, wssUrl })).toThrow(/wss/i);
  });

  it('rejects URL credentials and incomplete TURN credentials', () => {
    expect(() => parsePilotConfig({ ...base, wssUrl: 'wss://user:pass@fs.test/ws' })).toThrow(/credentials/i);
    expect(() => parsePilotConfig({
      ...base,
      iceServers: [{ urls: 'turns:turn.test:5349', username: 'pilot', credential: '' }],
    })).toThrow(/together/i);
  });

  it('maps STUN, TURN, and relay-only mode', () => {
    const config = parsePilotConfig({
      ...base,
      relayOnly: true,
      iceServers: [
        { urls: 'stun:stun.test:3478', username: '', credential: '' },
        { urls: 'turns:turn.test:5349', username: 'pilot', credential: 'turn-secret' },
      ],
    });
    const options = toBrowserPhoneOptions(config, () => {});
    expect(options.media?.iceTransportPolicy).toBe('relay');
    expect(options.media?.iceServers).toHaveLength(2);
  });

  it('removes URL user info, query, and fragment from evidence summaries', () => {
    expect(safeEndpointSummary(base.wssUrl)).toBe('wss://fs-dev.example.test:7443/ws');
  });
});
