import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as reliability from '../src/reliability/index.js';

describe('@sip-worker/core surface', () => {
  it('retains signaling roots and excludes concrete environment adapters', () => {
    expect(core.UserAgent).toBeTypeOf('function');
    expect(core.TransportError).toBeTypeOf('function');
    expect(core.OptionsLiveness).toBeTypeOf('function');
    expect('BrowserWebSocketTransport' in core).toBe(false);
    expect('NodeUdpTransport' in core).toBe(false);
    expect('NodeWebSocketLiveness' in reliability).toBe(false);
  });
});
