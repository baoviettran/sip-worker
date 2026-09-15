// test/asterisk-matrix/conf.ts — renders the committed Asterisk config into a
// per-run runtime dir: ports token-replaced, per-run TLS written into
// matrix/. Pure filesystem work in temp dirs; unit-tested without docker.
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MintedTls } from '../matrix-shared/mint-tls';

export const AST_IMAGE =
  'andrius/asterisk@sha256:5c96c8f7a17688c79452a4a2a56864b4a7570f4c4276fc353db51e38111bb9c3';

/** Where the dialplan writes recordings, mounted from a per-run temp dir. */
export const RECORDINGS_MOUNT = '/recordings';

/**
 * Port-style token, deliberately the same expression the FreeSWITCH integrity
 * gate uses (test/freeswitch-matrix/matrix-integrity.test.mjs) so the two trees
 * cannot drift on what counts as a token. Requires uppercase letters between
 * the underscores, which excludes decorative rules like _____________.
 */
export const TOKEN_RE = /__[A-Z][A-Z_]*[A-Z]__/;

export interface RenderAstOptions {
  wssPort: number;
  amiPort: number;
  httpPort: number;
  tls: MintedTls;
}

const TOKENS: Array<[RegExp, (o: RenderAstOptions) => number]> = [
  [/__WSS_PORT__/g, (o) => o.wssPort],
  [/__AMI_PORT__/g, (o) => o.amiPort],
  [/__HTTP_PORT__/g, (o) => o.httpPort],
];

export function renderAstConf(confDir: string, opts: RenderAstOptions): string {
  const runtime = mkdtempSync(join(tmpdir(), 'astconf-'));
  cpSync(confDir, runtime, { recursive: true });
  mkdirSync(join(runtime, 'matrix'), { recursive: true });
  // mkdtempSync creates 0700, and this dir is bind-mounted read-only at
  // /etc/asterisk. The container's asterisk drops to uid 1000, so it must be able
  // to TRAVERSE this dir to read anything inside it — and on a GitHub runner the
  // host uid is not 1000, so 0700 makes every conf inside read as missing and
  // Asterisk dies at `Module initialization failed. ASTERISK EXITING!` (measured:
  // same dir, 0700 owned by a foreign uid → that exact exit; 0755 → boots and
  // answers `core show version`). It cannot reproduce on a developer machine,
  // whose uid happens to equal the container's — the same class of bug the 0644
  // key below documents, one level up.
  chmodSync(runtime, 0o755);
  // Separate files, not a combined bundle: Asterisk's http.conf tlscertfile and
  // tlsprivatekey take one PEM each, unlike FreeSWITCH's single wss.pem.
  //
  // 0644 on the key, deliberately: the container's asterisk uid is not the host
  // uid, so a 0600 host-owned key is unreadable from inside and DTLS-SRTP fails
  // with an opaque 488. This key is minted per run, lives in a host-private temp
  // dir, and never reaches a committed file — the integrity gate (Task 13)
  // enforces the part that matters.
  writeFileSync(join(runtime, 'matrix', 'cert.pem'), opts.tls.certPem, { mode: 0o644 });
  writeFileSync(join(runtime, 'matrix', 'key.pem'), opts.tls.keyPem, { mode: 0o644 });
  for (const name of readdirSync(runtime)) {
    if (!name.endsWith('.conf')) continue;
    const path = join(runtime, name);
    let text = readFileSync(path, 'utf8');
    for (const [re, pick] of TOKENS) text = text.replace(re, String(pick(opts)));
    const residual = text.match(TOKEN_RE);
    // Booting with a literal __WSS_PORT__ would leave Asterisk listening
    // nowhere useful and fail later with a confusing TLS error; fail here.
    if (residual) throw new Error(`renderAstConf: unresolved token ${residual[0]} in ${name}`);
    writeFileSync(path, text);
  }
  return runtime;
}
