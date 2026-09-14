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
