// test/sipp/run-scenario.mjs
// v0.9 WS2 protocol corpus orchestrator.
//
// This module currently defines the scenario table and pinned docker image;
// Task 4 appends the run logic (pack, docker spawn, driver spawn, verdict).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const SIPP_IMAGE =
  'pbertera/sipp@sha256:063e8e9c8ecf54552e8efc3c363007afbfd3cae5a0f3f037db1c2e7fa4cd0349';

export const SIPP_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SCENARIOS_DIR = join(SIPP_DIR, 'scenarios');
export const FIXTURE_DIR = join(SIPP_DIR, 'fixtures');
export const DRIVER_ENTRY = join(SIPP_DIR, 'driver', 'dist', 'agent.js');

// One entry per scenario. `runs` enumerates the docker runs for that scenario
// (variants share the same driver action; the driver picks the expected outcome
// from EXPECTATIONS["<scenario>:<variant>"]). `xml` is relative to SCENARIOS_DIR.
export const SCENARIOS = {
  'register-basic': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'register-basic.xml', password: 'unused' }],
    deadlineMs: 10_000,
  },
  'register-auth': {
    role: 'uas',
    runs: [
      { variant: 'success', transport: 'udp', xml: 'register-auth.xml', password: 'correct-password' },
      { variant: 'wrong-password', transport: 'udp', xml: 'register-auth-fail.xml', password: 'definitely-wrong' },
    ],
    deadlineMs: 15_000,
  },
  'register-refresh': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'register-refresh.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'invite-outgoing': {
    role: 'uas',
    runs: [
      { variant: 'udp', transport: 'udp', xml: 'invite-outgoing.xml', password: 'unused' },
      { variant: 'tcp', transport: 'tcp', xml: 'invite-outgoing.xml', password: 'unused' },
    ],
    deadlineMs: 15_000,
  },
  'invite-incoming': {
    role: 'uac',
    runs: [{ variant: 'success', transport: 'udp', xml: 'invite-incoming.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'cancel-race': {
    role: 'uac',
    runs: [{ variant: 'success', transport: 'udp', xml: 'cancel-race.xml', password: 'unused' }],
    deadlineMs: 10_000,
  },
  'retransmissions': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'retransmissions.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'bye-timeout': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'bye-timeout.xml', password: 'unused' }],
    deadlineMs: 45_000,
  },
  'malformed': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'malformed.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
  'reconnect': {
    role: 'uas',
    runs: [{ variant: 'success', transport: 'udp', xml: 'reconnect.xml', password: 'unused' }],
    deadlineMs: 15_000,
  },
};

import { spawn, execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import dgram from 'node:dgram';
import net from 'node:net';
import { promisify } from 'node:util';
import { packWorkspaces } from '../package/pack-workspaces.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fail the whole run (never skip) if the pinned image is not present locally. */
async function ensureImage() {
  const inspect = await execFileAsync('docker', ['image', 'inspect', SIPP_IMAGE])
    .then(() => true)
    .catch(() => false);
  if (!inspect) {
    console.log(`[orchestrator] pulling ${SIPP_IMAGE}`);
    await execFileAsync('docker', ['pull', SIPP_IMAGE], { stdio: 'inherit' });
  }
}

/** A free ephemeral UDP loopback port (bind(0), read, close). */
async function freeUdpPort(host) {
  const socket = dgram.createSocket('udp4');
  const port = await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, host, () => resolve(socket.address().port));
  });
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** A free ephemeral TCP loopback port. */
async function freeTcpPort(host) {
  const server = net.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Poll until a TCP port accepts connections (SIPp is listening). */
async function waitForTcpPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, host);
      socket.once('connect', () => { socket.end(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`SIPp did not open TCP port ${port} within ${timeoutMs}ms`);
}

function spawnSipp({ xml, transport, sippPort, driverPort, timeoutSeconds }) {
  const args = [
    'run', '--rm', '--network', 'host',
    '-v', `${SCENARIOS_DIR}:/scenarios:ro`,
    SIPP_IMAGE,
    '-i', '127.0.0.1',
    '-p', String(sippPort),
    '-sf', `/scenarios/${xml}`,
    '-m', '1',
    '-nostdin',
    '-t', transport === 'tcp' ? 'tn' : 'un',
    '-timeout', String(timeoutSeconds),
    '-max_socket', '500',
  ];
  // UAC mode: positional destination = the driver's bound loopback address.
  if (driverPort !== undefined) args.push(`127.0.0.1:${driverPort}`);
  return spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function awaitExit(child, label) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (error) => resolve({ code: -1, out, err: `${label} spawn error: ${error.message}\n${err}` }));
  });
}

function waitForLine(child, prefix, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.stdout.off('data', onData); reject(new Error(`child did not print ${prefix} within ${timeoutMs}ms`)); }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(prefix)) { child.stdout.off('data', onData); clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
  });
}

/** Pack fresh tarballs into the fixture and install core+node there. */
async function buildFixture() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  const tarballs = await packWorkspaces(FIXTURE_DIR);
  await writeFile(
    join(FIXTURE_DIR, 'package.json'),
    JSON.stringify({ name: 'sip-worker-sipp-fixture', private: true, type: 'module' }, null, 2),
  );
  await execFileAsync('npm', [
    'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
    tarballs['@sip-worker/core'], tarballs['@sip-worker/node'],
  ], { cwd: FIXTURE_DIR });
}

async function runScenarioRun(name, run, cfg) {
  const localPort = await freeUdpPort('127.0.0.1');
  const sippPort = run.transport === 'tcp'
    ? await freeTcpPort('127.0.0.1')
    : await freeUdpPort('127.0.0.1');

  const driverEnv = {
    ...process.env,
    SIPP_SCENARIO: name,
    SIPP_VARIANT: run.variant,
    SIPP_HOST: '127.0.0.1',
    SIPP_PORT: String(sippPort),
    LOCAL_PORT: String(localPort),
    TRANSPORT: run.transport,
    USERNAME: 'driver',
    PASSWORD: run.password,
    FIXTURE_DIR,
    DEADLINE_MS: String(cfg.deadlineMs),
  };

  const spawnDriver = () => spawn(process.execPath, ['--max-old-space-size=256', DRIVER_ENTRY], {
    env: driverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timeoutSeconds = Math.ceil(cfg.deadlineMs / 1000) + 5;

  if (cfg.role === 'uac') {
    // Driver must be bound before SIPp fires INVITE/CANCEL.
    const driver = spawnDriver();
    await waitForLine(driver, 'READY', cfg.deadlineMs);
    const sipp = spawnSipp({ xml: run.xml, transport: run.transport, sippPort, driverPort: localPort, timeoutSeconds });
    const [d, s] = await Promise.all([awaitExit(driver, 'driver'), awaitExit(sipp, 'sipp')]);
    return { driver: d, sipp: s };
  }

  // UAS: SIPp must be listening before the driver connects/sends.
  const sipp = spawnSipp({ xml: run.xml, transport: run.transport, sippPort, timeoutSeconds });
  if (run.transport === 'tcp') await waitForTcpPort('127.0.0.1', sippPort, 5000);
  else await sleep(300);
  const driver = spawnDriver();
  const [d, s] = await Promise.all([awaitExit(driver, 'driver'), awaitExit(sipp, 'sipp')]);
  return { driver: d, sipp: s };
}

export async function runScenarios(filter) {
  await ensureImage();
  console.log('[orchestrator] packing workspaces into fixture');
  await buildFixture();

  let failures = 0;
  for (const [name, cfg] of Object.entries(SCENARIOS)) {
    if (filter !== undefined && name !== filter) continue;
    for (const run of cfg.runs) {
      const label = `${name}:${run.variant}`;
      console.log(`[orchestrator] running ${label}`);
      const { driver, sipp } = await runScenarioRun(name, run, cfg);
      if (driver.code === 0 && sipp.code === 0) {
        console.log(`PASS ${label}`);
        continue;
      }
      failures += 1;
      console.error(`FAIL ${label} (driver=${driver.code} sipp=${sipp.code})`);
      if (driver.code !== 0) console.error(driver.out || driver.err);
      if (sipp.code !== 0) console.error(sipp.err || sipp.out);
    }
  }
  if (failures > 0) {
    console.error(`[orchestrator] ${failures} scenario run(s) failed`);
    process.exitCode = 1;
  }
}

// Entry point.
if (process.argv[1] && process.argv[1].endsWith('run-scenario.mjs')) {
  runScenarios(process.argv[2]).catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}
