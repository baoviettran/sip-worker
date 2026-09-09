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

/**
 * Originate a parked call to `destination` (e.g. `sofia/ws-test/1000@127.0.0.1`)
 * and resolve the FS channel UUID (used later for uuid_kill). api commands
 * answer with an api/response body — `-ERR …` on failure, the channel UUID
 * (bare or after `+OK`) on success.
 */
export async function originateCall(destination: string): Promise<string> {
  const body = await fsExec(`originate {ignore_early_media=true}${destination} &park()`);
  if (body.startsWith('-ERR')) throw new Error(`originate -ERR: ${body}`);
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(body);
  if (!m) throw new Error(`originate returned no channel uuid: ${body}`);
  return m[1];
}

/**
 * Build an originate destination that reaches a WSS-registered client, or
 * throw when the registration is absent (fail-not-skip).
 *
 * The dial-string form (`sofia/<profile>/<user>@<domain>`) does NOT reach the
 * registration on the pinned image: the dial-string resolves to the stored
 * contact, whose URI carries no transport parameter, so FreeSWITCH dials the
 * raw URI over UDP:5060 and fails with NORMAL_TEMPORARY_FAILURE. The reliable
 * form is the direct URI with the registered client's connection port and an
 * explicit wss transport — FreeSWITCH then routes the INVITE over the client's
 * existing WebSocket. The port is observable in the registration's fs_path
 * (sofia_contact output), so it is read at runtime, never assumed.
 */
export async function resolveWssDestination(profile: string, user: string, domain: string): Promise<string> {
  const contact = await fsExec(`sofia_contact */${user}@${domain}`);
  if (!contact.startsWith('sofia/')) {
    throw new Error(`no registration for ${user}@${domain}: ${contact}`);
  }
  const m = /fs_path=sip%3A.*?%3A(\d+)/.exec(contact);
  if (!m) throw new Error(`sofia_contact output lacks fs_path port: ${contact}`);
  return `sofia/${profile}/sip:${user}@${domain}:${m[1]};transport=wss`;
}

/** One parsed `Event-Name: DTMF` event from the event socket. */
export interface DtmfObservation {
  digit: string;
  channel: string;
}

/**
 * Long-lived `event plain DTMF` subscription on the event socket (one
 * connection per call; the generator owns its socket and destroys it when the
 * consumer breaks out, return()s the generator, or aborts `opts.signal`).
 * Yields one object per `Event-Name: DTMF` frame, parsed from the
 * `DTMF-Digit:` / `Channel-Name:` headers. Fail-not-skip: the auth handshake
 * and the subscription ack are deadline-bounded (a timeout REJECTS, never
 * hangs), and a socket error surfaces as a thrown error on the awaiting
 * consumer.
 *
 * The optional AbortSignal is the teardown primitive the generator's queueing
 * semantics force on consumers: once a `next()` is in flight, a queued
 * `return()` only processes when that next() completes (an event or eof), so
 * a consumer that raced a pending next() against a deadline and then called
 * return() with no event ever arriving would hang forever and leak the
 * socket. Aborting destroys the socket; 'close' marks eof, the idle wait
 * wakes, and the pending next() resolves { done: true } within bounded time.
 *
 * Wire format (verified against the pinned image, v1.10.12): after
 * `auth <pass>\n\n` the server answers a `Content-Type: command/reply` frame
 * (`Reply-Text: +OK accepted`); the subscription command is
 * `event plain DTMF\n\n`, acknowledged by a second `command/reply`
 * (`Reply-Text: +OK event listener enabled plain`). Every DTMF event then
 * arrives as a `Content-Type: text/event-plain` frame — a header block
 * carrying `Content-Length: N`, terminated by a blank line, followed by
 * exactly N bytes of body holding the plain-text event headers
 * (`Event-Name: DTMF`, `DTMF-Digit: 5`, `Channel-Name: …`). The parser
 * therefore consumes Content-Length-framed bodies, not bare blank-line
 * frames. (Observed empirically: FreeSWITCH fires the DTMF event when the
 * channel's application dequeues the digit — switch_channel_dequeue_dtmf —
 * so a server-side test drives it with uuid_send_dtmf on a parked loopback
 * leg; uuid_send_dtmf alone only sends the digits OUT and fires nothing.)
 */
export async function* fsSubscribeDtfm(
  opts?: { signal?: AbortSignal },
): AsyncGenerator<{ digit: string; channel: string }> {
  const sock = net.connect(ES_PORT, ES_HOST);
  sock.setEncoding('utf8');
  const queue: DtmfObservation[] = [];
  const waiters: Array<() => void> = [];
  let failure: Error | undefined;
  let eof = false;
  let authAck = false;
  let subscribed = false;
  let buf = '';
  const pump = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const onAbort = (): void => {
    eof = true;
    sock.destroy();
    pump();
  };
  opts?.signal?.addEventListener('abort', onAbort, { once: true });
  sock.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const sep = buf.indexOf('\n\n');
      if (sep === -1) break; // frame headers incomplete
      const head = buf.slice(0, sep);
      const rest = buf.slice(sep + 2);
      const n = Number(/^Content-Length: (\d+)$/m.exec(head)?.[1] ?? 0);
      if (rest.length < n) break; // framed body still in flight
      const body = rest.slice(0, n);
      buf = rest.slice(n);
      const type = /^Content-Type: (.*)$/m.exec(head)?.[1] ?? '';
      if (!authAck) {
        if (type === 'auth/request') {
          sock.write(`auth ${ES_PASSWORD}\n\n`);
        } else if (type === 'command/reply') {
          const reply = /^Reply-Text: (.*)$/m.exec(head)?.[1] ?? '';
          if (reply.startsWith('+OK')) {
            authAck = true;
            sock.write('event plain DTMF\n\n');
          } else {
            failure = new Error(`event-socket auth failed: ${reply}`);
            sock.destroy();
          }
        }
        continue;
      }
      if (!subscribed) {
        if (type === 'command/reply') {
          const reply = /^Reply-Text: (.*)$/m.exec(head)?.[1] ?? '';
          if (reply.startsWith('+OK')) {
            subscribed = true;
          } else {
            failure = new Error(`event-socket DTMF subscription failed: ${reply}`);
            sock.destroy();
          }
        }
        continue;
      }
      // Live: only DTMF events are subscribed to, but parse defensively —
      // any other frame is skipped.
      if (/^Event-Name: DTMF$/m.test(body)) {
        const digit = /^DTMF-Digit: (.*)$/m.exec(body)?.[1]?.trim();
        if (digit !== undefined) {
          queue.push({
            digit,
            channel: /^Channel-Name: (.*)$/m.exec(body)?.[1]?.trim() ?? '',
          });
        }
      }
    }
    pump();
  });
  sock.on('error', (e: Error) => {
    failure = failure ?? e;
    sock.destroy();
  });
  sock.on('close', () => {
    eof = true;
    pump();
  });
  const waitUntil = (pred: () => boolean, desc: string, ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(check);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`fsSubscribeDtfm: timed out waiting for ${desc}`));
      }, ms);
      const check = (): void => {
        if (!pred()) {
          waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      check();
    });
  try {
    await waitUntil(() => authAck || failure !== undefined || eof, 'auth handshake', 5_000);
    if (failure) throw failure;
    if (eof) throw new Error('event socket closed during auth handshake');
    await waitUntil(() => subscribed || failure !== undefined || eof, 'subscription ack', 5_000);
    if (failure) throw failure;
    if (eof) throw new Error('event socket closed before the DTMF subscription ack');
    for (;;) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (failure) throw failure;
      if (eof) return;
      // Bounded idle wait (not an open-ended await): an un-resolved await
      // would prevent generator.return() from ever completing and leak the
      // socket — see the yield loop's cleanup contract above.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 250);
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort);
    sock.destroy();
  }
}

/** Recorded WAVs under the /recordings mount, sorted by filename (ascending). */
export function getRecordings(handle: FsHandle): string[] {
  return readdirSync(handle.recordDir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => join(handle.recordDir, f))
    .sort();
}
