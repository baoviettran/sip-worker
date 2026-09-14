// test/asterisk-matrix/astctl.ts — docker container control for the Asterisk
// matrix harness. Mirrors test/freeswitch-matrix/fsctl.ts: --network host so
// the loopback binds inside the container are reachable from the host (a
// published port cannot reach a container-loopback bind), a READ-ONLY /etc/
// asterisk mount, per-run minted TLS, and a health probe with a deadline.
//
// Fail-not-skip: a missing docker binary, a missing image, a failed health
// probe, or an expired deadline throws. Nothing here skips.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AST_IMAGE, RECORDINGS_MOUNT, renderAstConf } from './conf';
import { mintTls } from '../matrix-shared/mint-tls';
import { pickFreePort } from '../matrix-shared/ports';
import { AmiClient } from './ami';

export const AST_AMI_USER = 'matrix';
export const AST_AMI_SECRET = 'matrix-pass-2026';

export interface AstHandle {
  name: string;
  wssPort: number;
  amiPort: number;
  httpPort: number;
  runtimeDir: string;
  recordingsDir: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function docker(args: string[], opts: { allowFailure?: boolean } = {}): string {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  if (res.error) {
    throw new Error(`docker ${args[0]} failed: ${res.error.message} — the matrix requires a working docker CLI`);
  }
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`docker ${args.join(' ')} exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout ?? '';
}

/** Asterisk CLI via `docker exec`; throws on a non-zero exit. */
export function astExec(h: AstHandle, cmd: string): string {
  return docker(['exec', h.name, 'asterisk', '-rx', cmd]);
}

export async function startAsterisk(confDir: string): Promise<AstHandle> {
  const wssPort = await pickFreePort();
  const amiPort = await pickFreePort();
  const httpPort = await pickFreePort();
  const runtimeDir = renderAstConf(confDir, { wssPort, amiPort, httpPort, tls: mintTls() });
  const recordingsDir = mkdtempSync(join(tmpdir(), 'astrec-'));
  // MixMonitor writes as whatever uid the container runs asterisk as, which is
  // not the host uid. 0777 on the mount point is what makes the write succeed
  // without guessing that uid; the files it drops are world-readable.
  chmodSync(recordingsDir, 0o777);

  const name = `astmatrix-${process.pid}-${wssPort}`;
  docker([
    'run', '-d', '--name', name, '--network', 'host',
    '-v', `${runtimeDir}:/etc/asterisk:ro`,
    '-v', `${recordingsDir}:${RECORDINGS_MOUNT}`,
    AST_IMAGE,
  ]);

  const handle: AstHandle = { name, wssPort, amiPort, httpPort, runtimeDir, recordingsDir };
  try {
    await waitHealthy(handle);
  } catch (err) {
    // A container that never becomes healthy is still running and still holds
    // the FIXED RTP range (20102-20202) every later run binds, so leaving it
    // behind would turn one boot failure into a confusing failure of the next
    // run. `stopAsterisk` cannot do this: no handle reaches the caller.
    docker(['rm', '-f', name], { allowFailure: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(recordingsDir, { recursive: true, force: true });
    throw err;
  }
  return handle;
}

/**
 * Asterisk is up when its own CLI answers. `-rx` succeeds only once the remote
 * console socket exists, so this is a real readiness probe rather than a sleep.
 */
async function waitHealthy(h: AstHandle, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', h.name], { allowFailure: true }).trim();
    if (running === 'true') {
      const version = docker(['exec', h.name, 'asterisk', '-rx', 'core show version'], { allowFailure: true });
      if (version.includes('Asterisk')) return;
      last = version.trim();
    } else {
      last = `container not running (state=${JSON.stringify(running)})`;
    }
    await sleep(500);
  }
  const logs = docker(['logs', '--tail', '80', h.name], { allowFailure: true });
  throw new Error(`Asterisk failed to become healthy within ${timeoutMs}ms: ${last}\n${logs}`);
}

/** Recorded WAVs under the /recordings mount, sorted by filename (ascending). */
export function getRecordings(h: AstHandle): string[] {
  return readdirSync(h.recordingsDir)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => join(h.recordingsDir, f))
    .sort();
}

export async function amiFor(h: AstHandle): Promise<AmiClient> {
  return AmiClient.connect({
    host: '127.0.0.1',
    port: h.amiPort,
    username: AST_AMI_USER,
    password: AST_AMI_SECRET,
    transcriptPath: join(h.runtimeDir, `ami-${randomUUID()}.log`),
  });
}

/**
 * Originate a call TO the registered browser endpoint: `Channel: PJSIP/<user>`
 * dials the endpoint's AOR, i.e. its registered contact, so the browser sees an
 * inbound INVITE. On answer the SAME channel enters the dialplan at
 * Context/Exten and runs the echo target. `Async: true` makes the AMI *action
 * reply* immediate; the correlated OriginateResponse carries the channel's
 * Uniqueid — which is what the remote-BYE step hands to hangupChannel.
 *
 * ⚠️ DO NOT `await` THIS FUNCTION WHEN A RINGING CHANNEL MUST BE ANSWERED
 * CONCURRENTLY. It resolves only when `OriginateResponse` arrives, and for a
 * ringing channel that is the destination answering — so awaiting it before the
 * page answers deadlocks until the timeout, with an `AMI: timed out after
 * Nms waiting for OriginateResponse` that looks exactly like a delivery
 * failure. Start it, run `answer-incoming`, then await. The spec-local
 * `originateParked` in `call-inbound.spec.ts` is that shape; use it, or copy
 * its comment. (Measured the expensive way: the plan itself read this helper as
 * awaitable, and the resulting run failed 4/4 with a symptom indistinguishable
 * from risk #4 being real.)
 */
export async function originateToBrowser(
  h: AstHandle,
  o: { user: string; exten: string; timeoutMs?: number },
): Promise<{ uniqueid: string }> {
  const ami = await amiFor(h);
  try {
    const actionId = randomUUID();
    const pending = ami.waitForEvent(
      (e) => e.Event === 'OriginateResponse' && e.ActionID === actionId,
      o.timeoutMs ?? 20_000,
      `OriginateResponse for ${o.user}`,
    );
    const res = await ami.action({
      Action: 'Originate',
      Channel: `PJSIP/${o.user}`,
      Context: 'matrix',
      Exten: o.exten,
      Priority: '1',
      CallerID: 'matrix <1001>',
      Async: 'true',
      ActionID: actionId,
    });
    if (res.Response !== 'Success') throw new Error(`Originate rejected: ${JSON.stringify(res)}`);
    const ev = await pending;
    if (ev.Response !== 'Success') throw new Error(`Originate failed: ${JSON.stringify(ev)}`);
    if (!ev.Uniqueid) throw new Error(`OriginateResponse carried no Uniqueid: ${JSON.stringify(ev)}`);
    return { uniqueid: ev.Uniqueid };
  } finally {
    ami.close();
  }
}

/**
 * Hang the originated channel up — this is what puts a BYE on the wire.
 *
 * A channel that is already gone is tolerated: the AMI reply for that case on
 * this image is `{"Response":"Error","Message":"No such channel"}` (measured
 * live against the pinned digest with `Hangup, Channel: PJSIP/9999-9999`; do not
 * retype it from memory — re-measure it if the pattern is ever widened). The
 * original `/not found/i` never matched it, so the tolerance was dead code and
 * a vanished channel threw instead.
 *
 * Tolerating it does NOT make step 9 vacuous: the contract is asserted
 * downstream by `expect-remote-terminated`, which requires the BYE to have
 * reached the page and the diag chain to show established → terminated. A
 * channel that vanished without that BYE still fails there.
 */
export async function hangupChannel(h: AstHandle, uniqueid: string): Promise<void> {
  const ami = await amiFor(h);
  try {
    const res = await ami.action({ Action: 'Hangup', Channel: uniqueid });
    if (res.Response !== 'Success' && !/no such channel|not found/i.test(res.Message ?? '')) {
      throw new Error(`Hangup of ${uniqueid} failed: ${JSON.stringify(res)}`);
    }
  } finally {
    ami.close();
  }
}

/**
 * The port Asterisk has registered for a user, or undefined. Parsed from
 * `pjsip show contacts`, whose rows read (verified against this image's live
 * output, not assumed):
 *
 * `  Contact:  1000/sip:1000@127.0.0.1:43952;transport=ws;x-a e1ea21e4cf NonQual  -nan`
 *
 * Two things there differ from the row the plan predicted, neither of which
 * changes the parse: pjsip appends `;x-ast-orig-host=127.0.0.1:<wssPort>` (the
 * local transport address) to the URI, and the table TRUNCATES the URI column
 * at a fixed width — which is why the row above ends in a bare `;x-a`. The
 * status is `NonQual` rather than `Avail` because the endpoint declares no
 * `qualify_frequency`, so Asterisk never sends OPTIONS to it. The port this
 * function exists to return sits well inside the untruncated prefix, so the
 * regex reads it directly: it anchors on `@127.0.0.1:` and takes the digits
 * immediately after, before truncation can bite.
 *
 * `findContactPort`'s only job is to prove Asterisk holds a contact worth
 * routing an INVITE to, so a missing contact must not become a skipped check.
 *
 * `user` is interpolated into the pattern below, so escape it first. Unescaped,
 * a caller-supplied id containing a metacharacter breaks the matcher in the two
 * worst ways: `+1000` and `1000)` throw `SyntaxError` out of the test body, and
 * `1000.` matches some OTHER endpoint's row and returns that port — a wrong
 * contact reported as a good one. Both symptoms then surface as the caller's
 * "Asterisk has no registered contact for …", which is a wrong diagnosis. (Same
 * escape as Task 12's `countContacts`, deliberately: the two must not drift.)
 */
export function findContactPort(h: AstHandle, user: string): number | undefined {
  const out = astExec(h, 'pjsip show contacts');
  const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const line of out.split('\n')) {
    const m = new RegExp(`\\b${escaped}\\b[^\\s]*@127\\.0\\.0\\.1:(\\d+)`).exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Container logs and recordings, copied into artifacts/ before teardown so a CI
 * failure is diagnosable, then both temp dirs removed. Asterisk's console logger
 * is what `docker logs` captures (ast-conf/logger.conf), so this needs no
 * in-container file access. Logs are redacted on the way out.
 */
export async function stopAsterisk(h: AstHandle): Promise<void> {
  try {
    const artDir = join(process.cwd(), 'artifacts');
    mkdirSync(artDir, { recursive: true });
    const logs = docker(['logs', h.name], { allowFailure: true });
    writeFileSync(join(artDir, 'asterisk.log'), logs.replaceAll(AST_AMI_SECRET, '***'));
    for (const wav of getRecordings(h)) {
      copyFileSync(wav, join(artDir, basename(wav)));
    }
    for (const entry of readdirSync(h.runtimeDir)) {
      if (entry.endsWith('.log')) copyFileSync(join(h.runtimeDir, entry), join(artDir, entry));
    }
  } catch (err) {
    console.warn('[astctl] artifact collection failed:', err);
  }
  docker(['rm', '-f', h.name], { allowFailure: true });
  rmSync(h.runtimeDir, { recursive: true, force: true });
  rmSync(h.recordingsDir, { recursive: true, force: true });
}

/**
 * The next `count` DTMF digits Asterisk observed, in order.
 *
 * The predicate is deliberately DIRECTION-SPECIFIC — do not simplify it back to a
 * bare `DTMFEnd`. That is what makes the returned sequence meaningful.
 *
 * MEASURED against the pinned image: a single RFC 4733 digit raises `DTMFEnd`
 * TWICE, once with `Direction: Received` and once with `Direction: Sent`, so a
 * bare `DTMFEnd` predicate returns a DOUBLED string (an early draft of this plan
 * would have produced `1122*` for a `12*45` send) and the equality assertion then
 * fails on the wrong thing entirely. An AMI transcript of a single digit shows
 * the `Received` event and its `Sent` twin, in order.
 *
 * INFERRED, NOT MEASURED: that the `Sent` twin comes from `Echo()` re-emitting
 * the digit back down the channel. The OBSERVATION is the direction pair; the
 * CAUSE of the `Sent` event — the echo application, versus the channel driver
 * itself — was never tested, so it is recorded as the likely explanation and
 * NOT as a finding. Nothing here depends on which it is: the filter is correct
 * either way, because only the browser's inbound digit arrives as `Received`.
 */
export async function collectDtmf(ami: AmiClient, count: number, timeoutMs = 30_000): Promise<string> {
  const digits: string[] = [];
  for (let i = 0; i < count; i++) {
    const ev = await ami.waitForEvent(
      (e) => e.Event === 'DTMFEnd' && e.Direction === 'Received',
      timeoutMs,
      `DTMFEnd ${i + 1} of ${count}`,
    );
    digits.push(ev.Digit ?? '');
  }
  return digits.join('');
}
