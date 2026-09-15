import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAstConf, AST_IMAGE, TOKEN_RE } from './conf';
import { mintTls } from '../matrix-shared/mint-tls';

const confDir = fileURLToPath(new URL('./ast-conf', import.meta.url));

/** Copy the committed tree to a temp dir with pjsip.conf replaced. */
function renderAstConfSource(pjsipBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'astsrc-'));
  cpSync(confDir, dir, { recursive: true });
  writeFileSync(join(dir, 'pjsip.conf'), pjsipBody);
  return dir;
}

describe('renderAstConf', () => {
  const runtime = renderAstConf(confDir, {
    wssPort: 18321, amiPort: 18322, httpPort: 18323, tls: mintTls(),
  });

  it('replaces every port token', () => {
    const http = readFileSync(join(runtime, 'http.conf'), 'utf8');
    // 18321 = wssPort, not httpPort: http.conf's tlsbindaddr IS the WSS listener
    // the browser dials, so it must match pjsip's transport bind. The plain HTTP
    // bindport is the separate, non-TLS listener.
    expect(http).toContain('tlsbindaddr=127.0.0.1:18321');
    expect(http).not.toMatch(TOKEN_RE);
    const pjsip = readFileSync(join(runtime, 'pjsip.conf'), 'utf8');
    expect(pjsip).toContain('bind=127.0.0.1:18321');
    expect(pjsip).not.toMatch(TOKEN_RE);
    const mgr = readFileSync(join(runtime, 'manager.conf'), 'utf8');
    expect(mgr).toContain('port = 18322');
    expect(mgr).not.toMatch(TOKEN_RE);
  });

  // The complementary half of the FS gate's rule (test/freeswitch-matrix/
  // matrix-integrity.test.mjs asserts committed conf has NO tokens): here the
  // committed ast-conf tree MUST carry tokens, so a hardcoded port cannot
  // sneak past review and into a shared-machine collision.
  it('the committed tree still carries the tokens it renders from', () => {
    expect(readFileSync(join(confDir, 'http.conf'), 'utf8')).toMatch(TOKEN_RE);
    expect(readFileSync(join(confDir, 'pjsip.conf'), 'utf8')).toMatch(TOKEN_RE);
    expect(readFileSync(join(confDir, 'manager.conf'), 'utf8')).toMatch(TOKEN_RE);
  });

  it('writes the TLS material, key readable by the container uid', () => {
    expect(statSync(join(runtime, 'matrix', 'cert.pem')).isFile()).toBe(true);
    // 0644, not 0600: see renderAstConf — the container's uid is not the host's.
    expect(statSync(join(runtime, 'matrix', 'key.pem')).mode & 0o777).toBe(0o644);
  });

  // The regression for the first CI run (PR #2): the infra gate died with
  // `loader.c: 'modules.conf' invalid or missing.` → `Module initialization
  // failed. ASTERISK EXITING!` because mkdtempSync's 0700 dir is not traversable
  // by the container's uid 1000 when the host uid differs — which it does on a
  // runner and does not on a developer machine (both 1000). Measured directly:
  // the same bind mount, 0700 owned by a foreign uid, exits exactly that way;
  // 0755 boots and answers `core show version`.
  it('the runtime dir is traversable by the container uid, not just by the host uid', () => {
    expect(statSync(runtime).mode & 0o777).toBe(0o755);
  });

  it('throws on a residual token rather than booting with a literal placeholder', () => {
    const bad = renderAstConfSource('[transport-wss]\ntype=transport\nprotocol=wss\nbind=127.0.0.1:__NOPE__\n');
    expect(() => renderAstConf(bad, { wssPort: 1, amiPort: 2, httpPort: 3, tls: mintTls() }))
      .toThrow(/unresolved token __NOPE__/);
  });

  it('pins the image by digest', () => {
    expect(AST_IMAGE).toBe('andrius/asterisk@sha256:5c96c8f7a17688c79452a4a2a56864b4a7570f4c4276fc353db51e38111bb9c3');
  });
});
