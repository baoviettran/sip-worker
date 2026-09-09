// test/freeswitch-matrix/conf.ts — renders the committed conf tree into a per-run
// runtime dir: ports token-replaced, per-run wss.pem minted. Pure filesystem work
// in temp dirs; unit-tested without docker.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RenderOptions {
  sipPort?: number;
  wsPort?: number;
  wssPort?: number;
  tls?: { certPem: string };
}

export function renderConf(confDir: string, opts: RenderOptions = {}): string {
  const runtime = mkdtempSync(join(tmpdir(), 'fsconf-'));
  cpSync(confDir, runtime, { recursive: true });
  rmSync(join(runtime, 'tls'), { recursive: true, force: true });
  mkdirSync(join(runtime, 'tls'));
  if (opts.tls) writeFileSync(join(runtime, 'tls', 'wss.pem'), opts.tls.certPem, 'utf8');
  const map: Array<[RegExp, number | undefined, number]> = [
    [/__SIP_PORT__/g, opts.sipPort, 5062],
    [/__WS_PORT__/g, opts.wsPort, 5066],
    [/__WSS_PORT__/g, opts.wssPort, 7443],
  ];
  const profile = join(runtime, 'sip_profiles', 'ws-test.xml');
  if (!existsSync(profile)) {
    throw new Error(`renderConf: missing ${join(confDir, 'sip_profiles', 'ws-test.xml')}`);
  }
  let s = readFileSync(profile, 'utf8');
  for (const [re, v, def] of map) s = s.replace(re, String(v ?? def));
  const residual = s.match(/__[A-Z_]+__/);
  if (residual) {
    throw new Error(`renderConf: unresolved token ${residual[0]} in sip_profiles/ws-test.xml`);
  }
  writeFileSync(profile, s);
  return runtime;
}
