// test/sipp/driver/agent.unit.test.ts
import { describe, expect, it } from 'vitest';
import { errorCode, parseEnv } from './agent.js';

describe('parseEnv', () => {
  it('parses a complete env', () => {
    const env = parseEnv({
      SIPP_SCENARIO: 'register-basic',
      SIPP_VARIANT: 'success',
      SIPP_HOST: '127.0.0.1',
      SIPP_PORT: '5060',
      LOCAL_PORT: '5099',
      TRANSPORT: 'udp',
      USERNAME: 'driver',
      PASSWORD: 'x',
      FIXTURE_DIR: '/tmp/f',
      DEADLINE_MS: '15000',
    } as NodeJS.ProcessEnv);
    expect(env.scenario).toBe('register-basic');
    expect(env.sippPort).toBe(5060);
    expect(env.transport).toBe('udp');
    expect(env.deadlineMs).toBe(15000);
  });

  it('throws on a missing variable', () => {
    expect(() => parseEnv({ SIPP_SCENARIO: 'x' } as NodeJS.ProcessEnv)).toThrow(/missing env/);
  });
});

describe('errorCode', () => {
  it('uses the typed code when present', () => {
    expect(errorCode(new Error('x') as Error & { code?: unknown })).toBe('Error');
    expect(errorCode(Object.assign(new Error('rejected'), { code: 'TIMEOUT' }))).toBe('TIMEOUT');
  });
});
