import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderConf } from './conf';

function fixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'confunit-'));
  writeFileSync(join(dir, 'vars.xml'), '<include><X-PRE-PROCESS cmd="set" data="domain=127.0.0.1"/>' +
    '<X-PRE-PROCESS cmd="set" data="recordings_dir=/recordings"/></include>');
  mkdirSync(join(dir, 'sip_profiles'));
  writeFileSync(join(dir, 'sip_profiles', 'ws-test.xml'),
    '<profile><settings><param name="sip-port" value="__SIP_PORT__"/>' +
    '<param name="ws-binding" value="127.0.0.1:__WS_PORT__"/>' +
    '<param name="wss-binding" value="127.0.0.1:__WSS_PORT__"/></settings></profile>');
  return dir;
}

describe('renderConf', () => {
  it('token-replaces ports into a copied runtime tree', () => {
    const out = renderConf(fixtureTree(), { sipPort: 5062, wsPort: 5066, wssPort: 7443 });
    const profile = readFileSync(join(out, 'sip_profiles', 'ws-test.xml'), 'utf8');
    expect(profile).toContain('value="5062"');
    expect(profile).toContain('127.0.0.1:5066');
    expect(profile).toContain('127.0.0.1:7443');
    expect(profile).not.toMatch(/__[A-Z_]+__/);
  });
  it('writes the minted wss.pem into the runtime tree', () => {
    const out = renderConf(fixtureTree(), { tls: { certPem: 'FAKE-PEM' } });
    expect(readFileSync(join(out, 'tls', 'wss.pem'), 'utf8')).toBe('FAKE-PEM');
  });
  it('does not mutate the committed source tree', () => {
    const src = fixtureTree();
    renderConf(src, { sipPort: 5062 });
    expect(readFileSync(join(src, 'sip_profiles', 'ws-test.xml'), 'utf8')).toContain('__SIP_PORT__');
  });
  it('throws when sip_profiles/ws-test.xml is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'confunit-'));
    mkdirSync(join(dir, 'sip_profiles'));
    expect(() => renderConf(dir)).toThrow(/renderConf: missing .+\/sip_profiles\/ws-test\.xml/);
  });
  it('throws when a residual token remains after substitution', () => {
    const dir = fixtureTree();
    writeFileSync(join(dir, 'sip_profiles', 'ws-test.xml'),
      '<profile><settings><param name="sip-port" value="__SIP_PORT__"/>' +
      '<param name="ws-binding" value="127.0.0.1:__WS_PORT__"/>' +
      '<param name="wss-binding" value="127.0.0.1:__WSS_PORT__"/>' +
      '<param name="extra" value="__BOGUS_PORT__"/></settings></profile>');
    expect(() => renderConf(dir)).toThrow(/renderConf: unresolved token __BOGUS_PORT__/);
  });
});
