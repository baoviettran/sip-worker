// test/freeswitch-matrix/fsctl.ts — docker container control for the FreeSWITCH
// matrix harness plus a minimal FreeSWITCH event-socket client (status,
// originate, uuid_kill). Fail-not-skip: every wait is bounded and
// startFreeSwitch throws instead of hanging or skipping.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { renderConf } from './conf';
import { FS_IMAGE } from './materialize.mjs';

export { FS_IMAGE, renderConf };

const ES_HOST = '127.0.0.1';
const ES_PORT = 8021;
const ES_PASSWORD = 'ClueCon';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FsHandle {
  name: string;
  runtimeDir: string;
  recordDir: string;
  sipPort: number;
  wsPort: number;
  wssPort: number;
}

/** Mint a per-run local CA + leaf (SAN IP:127.0.0.1,DNS:localhost, 1-day). */
export function mintTls(): { certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fstls-'));
  const caKey = join(dir, 'ca.key'), caCrt = join(dir, 'ca.crt');
  const leafKey = join(dir, 'leaf.key'), leafCsr = join(dir, 'leaf.csr'), leafCrt = join(dir, 'leaf.crt');
  const ext = join(dir, 'ext.cnf');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', caKey, '-out', caCrt,
    '-days', '1', '-nodes', '-subj', '/CN=fs-matrix-ca'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-keyout', leafKey, '-out', leafCsr,
    '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  // macOS LibreSSL rejects -addext; use an ext file (see docs/ci-browser-gate-notes.md).
  writeFileSync(ext, 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
  execFileSync('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCrt, '-CAkey', caKey,
    '-CAcreateserial', '-out', leafCrt, '-days', '1', '-extfile', ext], { stdio: 'ignore' });
  return { certPem: readFileSync(leafCrt) + '\n' + readFileSync(leafKey) };
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startFreeSwitch(confDir: string): Promise<FsHandle> {
  const [sipPort, wsPort, wssPort] = await Promise.all([pickFreePort(), pickFreePort(), pickFreePort()]);
  const runtimeDir = renderConf(confDir, { sipPort, wsPort, wssPort, tls: mintTls() });
  const recordDir = mkdtempSync(join(tmpdir(), 'fsrec-'));
  const name = `fsmatrix-${process.pid}-${Date.now()}`;
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  const child = spawn('docker', [
    'run', '-d', '--name', name, '--network', 'host',
    '-v', `${runtimeDir}:/etc/freeswitch:ro`,
    '-v', `${recordDir}:/recordings`,
    '--health-cmd', 'fs_cli -x status',
    '--health-interval', '3s', '--health-retries', '30',
    FS_IMAGE,
  ], { stdio: 'ignore' });
  child.unref();
  const handle: FsHandle = { name, runtimeDir, recordDir, sipPort, wsPort, wssPort };
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { stdout } = spawnSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], { encoding: 'utf8' });
    const state = typeof stdout === 'string' ? stdout.trim() : undefined;
    if (state === 'healthy') return handle;
    if (state === 'unhealthy' || Date.now() > deadline) {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout.slice(-4000);
      await stopFreeSwitch(handle);
      throw new Error(`FreeSWITCH failed to become healthy (state=${state})\n${logs}`);
    }
    await sleep(1000);
  }
}

export async function stopFreeSwitch(handle: FsHandle): Promise<void> {
  spawnSync('docker', ['rm', '-f', handle.name], { stdio: 'ignore' });
}

/**
 * One short event-socket connection per api command.
 *
 * Wire format (verified against the pinned image, v1.10.12): each frame is a
 * header block terminated by a blank line. On connect the server sends
 * `Content-Type: auth/request`; after `auth <pass>\n\n` (mod_event_socket
 * flushes a command only on the blank line — a single `\n` is ignored) the
 * server answers a `Content-Type: command/reply` frame whose `Reply-Text:`
 * header carries `+OK accepted` (auth failure: `-ERR ...`). Then `api <cmd>\n\n`
 * is answered by
 * a `Content-Type: api/response` frame with `Content-Length: N` followed by
 * exactly N bytes of body — the command output; failure shows as a `-ERR ...`
 * body, not a terminal line.
 */
export function fsExec(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(ES_PORT, ES_HOST);
    let buf = '';
    let authed = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`fsExec timed out: ${cmd}`))), 10_000);
    sock.setEncoding('utf8');
    sock.on('error', (e) => done(() => reject(e)));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const sep = buf.indexOf('\n\n');
        if (sep === -1) return; // frame headers incomplete
        const head = buf.slice(0, sep);
        let rest = buf.slice(sep + 2);
        const type = /^Content-Type: (.*)$/m.exec(head)?.[1] ?? '';
        if (type === 'auth/request') {
          sock.write(`auth ${ES_PASSWORD}\n\n`);
          buf = rest;
          continue;
        }
        const replyText = /^Reply-Text: (.*)$/m.exec(head)?.[1] ?? '';
        if (type === 'command/reply') {
          buf = rest;
          if (!authed) {
            authed = true;
            if (!replyText.startsWith('+OK')) {
              return done(() => reject(new Error(`event-socket auth failed: ${replyText}`)));
            }
            sock.write(`api ${cmd}\n\n`);
          } else if (!replyText.startsWith('+OK')) {
            return done(() => reject(new Error(`fsExec -ERR: ${cmd}\n${replyText}`)));
          } else {
            return done(() => resolve(replyText.slice(4).trim()));
          }
          continue;
        }
        if (type === 'api/response') {
          const m = /^Content-Length: (\d+)$/m.exec(head);
          if (!m) return done(() => reject(new Error(`event-socket frame without Content-Length: ${head}`)));
          const n = Number(m[1]);
          if (rest.length < n) return; // body bytes still in flight
          const body = rest.slice(0, n);
          buf = rest.slice(n);
          return done(() => resolve(body.trim()));
        }
        // any other frame (text/event-plain etc.) — skip and keep parsing
        buf = rest;
      }
    });
  });
}

/** Recorded WAVs under the /recordings mount, sorted by filename (ascending). */
export function getRecordings(handle: FsHandle): string[] {
  return readdirSync(handle.recordDir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => join(handle.recordDir, f))
    .sort();
}
