// test/sipp/driver/agent.ts
// UA-level protocol corpus driver. Runs as a child process spawned by the
// orchestrator; consumes ONLY the packed artifacts from the fixture directory
// (never packages/**/src). All waits are bounded by DEADLINE_MS; a wait timing
// out is a scenario failure, never a hang.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import dgram from 'node:dgram';
import net from 'node:net';

import type { Transport, TransportCapabilities, TransportEvent, Clock } from '@sip-worker/core/transport';
import type { LivenessStrategy } from '@sip-worker/core/reliability';
import type { WorkerMediaController } from '@sip-worker/core/media';
import type { AgentEventRecord, DriverEnv, TransportKind } from './types.js';
import { assertExpectedOutcome, EXPECTATIONS } from './assertions.js';

export const STUB_SDP = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n';

/** The error-code segment of a record detail (everything before the first ':'). */
export function errorCode(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : error.name;
}

function errorDetail(error: Error): string {
  return `${errorCode(error)}:${error.message}`;
}

export function parseEnv(source: NodeJS.ProcessEnv): DriverEnv {
  const required: Record<keyof DriverEnv, string | undefined> = {
    scenario: source.SIPP_SCENARIO,
    variant: source.SIPP_VARIANT,
    host: source.SIPP_HOST,
    sippPort: source.SIPP_PORT,
    localPort: source.LOCAL_PORT,
    transport: source.TRANSPORT,
    username: source.USERNAME,
    password: source.PASSWORD,
    fixtureDir: source.FIXTURE_DIR,
    deadlineMs: source.DEADLINE_MS,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value === undefined || value === '') throw new Error(`missing env ${key}`);
  }
  return {
    scenario: required.scenario!,
    variant: required.variant!,
    host: required.host!,
    sippPort: Number(required.sippPort),
    localPort: Number(required.localPort),
    transport: required.transport! as TransportKind,
    username: required.username!,
    password: required.password!,
    fixtureDir: required.fixtureDir!,
    deadlineMs: Number(required.deadlineMs),
  };
}

/** Load a workspace subpath entry from the fixture's node_modules via package.json exports. */
async function loadEntry(fixtureDir: string, pkgName: string, subpath = '.'): Promise<any> {
  const pkgPath = join(fixtureDir, 'node_modules', pkgName, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    module?: string;
    exports?: Record<string, { import?: string }>;
  };
  const rel = subpath === '.'
    ? pkg.module ?? pkg.exports?.['.']?.import
    : pkg.exports?.[`./${subpath}`]?.import;
  if (rel === undefined) throw new Error(`no ESM entry for ${pkgName}${subpath === '.' ? '' : `/${subpath}`}`);
  return import(pathToFileURL(join(dirname(pkgPath), rel)).href);
}

async function loadSipWorker(fixtureDir: string): Promise<{
  core: typeof import('@sip-worker/core');
  nodeTransport: typeof import('@sip-worker/node/transport');
}> {
  const core = await loadEntry(fixtureDir, '@sip-worker/core');
  const nodeTransport = await loadEntry(fixtureDir, '@sip-worker/node', 'transport');
  return { core, nodeTransport };
}

interface Ctx {
  env: DriverEnv;
  trace: AgentEventRecord[];
  record(record: Omit<AgentEventRecord, 'at'>): void;
  deadline: number;
  ua: UserAgent | null;
  pendingIncoming: Invitation | undefined;
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  bootGeneration(opts: {
    sippPort: number;
    localPort: number;
    host: string;
    username: string;
    password: string;
    initialIdentity?: { callId: string; nextCSeq: number };
  }): Promise<UserAgent>;
  dispose(agent: UserAgent): Promise<void>;
  hangup(inviter: Inviter): Promise<void>;
  waitForIncoming(): Promise<Invitation>;
}

type UserAgent = InstanceType<typeof import('@sip-worker/core').UserAgent>;
type Inviter = InstanceType<typeof import('@sip-worker/core').Inviter>;
type Invitation = InstanceType<typeof import('@sip-worker/core').Invitation>;

function traceHas(trace: readonly AgentEventRecord[], type: AgentEventRecord['type'], detail: string): boolean {
  return trace.some((r) => r.type === type && r.detail === detail);
}

async function runRegister(ctx: Ctx): Promise<void> {
  await ctx.ua!.register();
  await ctx.waitFor(() => traceHas(ctx.trace, 'registration', 'registered'), "registration 'registered'");
}

async function runRegistrationFailure(ctx: Ctx): Promise<void> {
  try {
    await ctx.ua!.register();
  } catch (error) {
    ctx.record({ type: 'error', detail: errorDetail(error as Error) });
    return;
  }
  throw new Error('registration unexpectedly succeeded');
}

async function runRefresh(ctx: Ctx): Promise<void> {
  await ctx.ua!.register();
  await ctx.waitFor(
    () => ctx.trace.filter((r) => r.type === 'transport' && r.detail === 'REGISTER').length >= 3,
    '>= 3 REGISTER wire sends',
  );
  // Cancel the refresh timer before the next cycle can send an unanswered REGISTER.
  await ctx.dispose(ctx.ua!);
  ctx.ua = null;
}

async function runOutgoingCall(ctx: Ctx): Promise<void> {
  const inviter = ctx.ua!.createOutgoingCall(`sip:sipp@${ctx.env.host}:${ctx.env.sippPort}`);
  inviter.session.on((event) => ctx.record({ type: 'call', detail: event.state }));
  await inviter.invite();
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'confirmed'), "call 'confirmed'");
  await ctx.hangup(inviter);
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'terminated'), "call 'terminated'");
}

async function runByeTimeout(ctx: Ctx): Promise<void> {
  const inviter = ctx.ua!.createOutgoingCall(`sip:sipp@${ctx.env.host}:${ctx.env.sippPort}`);
  inviter.session.on((event) => ctx.record({ type: 'call', detail: event.state }));
  await inviter.invite();
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'confirmed'), "call 'confirmed'");
  // BYE is unanswered; after Timer F (32 s) hangup() rejects with TIMEOUT and
  // failHangup reverts the session from 'terminating' back to 'confirmed'.
  await ctx.hangup(inviter);
}

async function runIncomingAnswered(ctx: Ctx): Promise<void> {
  const invitation = await ctx.waitForIncoming();
  invitation.session.on((event) => {
    console.log(`[driver] session event: ${event.state}`);
    ctx.record({ type: 'call', detail: event.state });
  });
  console.log('[driver] calling invitation.answer()');
  await invitation.answer();
  console.log('[driver] invitation.answer() resolved');
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'confirmed'), "call 'confirmed'");
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'terminated'), "call 'terminated'");
}

async function runCancelRace(ctx: Ctx): Promise<void> {
  const invitation = await ctx.waitForIncoming();
  invitation.session.on((event) => ctx.record({ type: 'call', detail: event.state }));
  // The core auto-answers CANCEL with 200 and the INVITE with 487; the
  // invitation session reaches 'terminated' without ever confirming.
  await ctx.waitFor(() => traceHas(ctx.trace, 'call', 'terminated'), "call 'terminated'");
}

async function runReconnect(ctx: Ctx): Promise<void> {
  const gen1 = ctx.ua!;
  await gen1.register();
  await ctx.waitFor(() => traceHas(ctx.trace, 'registration', 'registered'), "generation 1 'registered'");
  const identity = gen1.identity!;
  await ctx.dispose(gen1);
  ctx.ua = null;
  // SIPp tracks the peer address per call; reusing the original port ensures
  // the second 200 OK reaches gen2's socket (a new port would miss it).
  ctx.ua = await ctx.bootGeneration({
    sippPort: ctx.env.sippPort,
    localPort: ctx.env.localPort,
    host: ctx.env.host,
    username: ctx.env.username,
    password: ctx.env.password,
    initialIdentity: identity,
  });
  await ctx.ua.register();
  // Count records, not traceHas — gen1's 'registered' is already in the trace.
  await ctx.waitFor(
    () => ctx.trace.filter((r) => r.type === 'registration').length >= 2,
    'generation 2 registration record',
  );
}

/** Dispatch the per-scenario driver action. Scenario tasks add their cases here. */
export async function runScenarioAction(scenario: string, ctx: Ctx): Promise<void> {
  switch (scenario) {
    case 'register-basic':
      return runRegister(ctx);
    case 'register-auth':
      return ctx.env.variant === 'wrong-password'
        ? runRegistrationFailure(ctx)
        : runRegister(ctx);
    case 'register-refresh':
      return runRefresh(ctx);
    case 'invite-outgoing':
      return runOutgoingCall(ctx);
    case 'invite-incoming':
      return runIncomingAnswered(ctx);
    case 'cancel-race':
      return runCancelRace(ctx);
    case 'retransmissions':
      return runOutgoingCall(ctx);
    case 'bye-timeout':
      return runByeTimeout(ctx);
    case 'malformed':
      return runRegister(ctx);
    case 'reconnect':
      return runReconnect(ctx);
    default:
      throw new Error(`scenario action not wired: ${scenario}`);
  }
}

export async function main(): Promise<number> {
  const env = parseEnv(process.env);
  const deadline = Date.now() + env.deadlineMs;
  const { core, nodeTransport } = await loadSipWorker(env.fixtureDir);
  const { UserAgent } = core;
  const { NodeUdpTransport, NodeTcpTransport } = nodeTransport;

  const trace: AgentEventRecord[] = [];
  const record = (item: Omit<AgentEventRecord, 'at'>): void => {
    trace.push({ ...item, at: Date.now() });
  };

  // Decorates the real transport; observes REGISTER/INVITE wire sends into the trace.
  class CountingTransport implements Transport {
    constructor(private readonly inner: Transport) {}
    get capabilities(): TransportCapabilities { return this.inner.capabilities; }
    connect(): Promise<void> { return this.inner.connect(); }
    disconnect(): Promise<void> { return this.inner.disconnect(); }
    isConnected(): boolean { return this.inner.isConnected(); }
    subscribe(listener: (event: TransportEvent) => void): () => void { return this.inner.subscribe(listener); }
    send(data: Uint8Array): Promise<void> {
      const method = new TextDecoder().decode(data.subarray(0, 128)).split(' ')[0] ?? '';
      if (method === 'REGISTER' || method === 'INVITE') record({ type: 'transport', detail: method });
      return this.inner.send(data);
    }
  }

  // Lightweight UDP transport that accepts datagrams from any source port.
  // NodeUdpTransport.isFromConfiguredPeer rejects packets whose source port
  // doesn't match remotePort; SIPp UAC mode sends INVITEs from an ephemeral
  // port, so we need this for incoming-only scenarios.
  class LoopbackTransport implements Transport {
    readonly capabilities: TransportCapabilities = Object.freeze({
      reliable: false,
      framing: 'datagram',
      token: 'UDP',
    });
    private readonly listeners = new Set<(event: TransportEvent) => void>();
    private connected = false;

    constructor(
      private readonly socket: import('node:dgram').Socket,
      private readonly localPort: number,
      private readonly remoteHost: string,
      private readonly remotePort: number,
    ) {
      socket.on('message', (msg: Buffer, rinfo: { address: string; port: number }) => {
        const text = new TextDecoder().decode(msg);
        const lines = text.split('\r\n');
        const firstLine = lines[0] ?? '';
        const callId = lines.find((l) => l.toLowerCase().startsWith('call-id:'));
        const from = lines.find((l) => l.toLowerCase().startsWith('from:'));
        const to = lines.find((l) => l.toLowerCase().startsWith('to:'));
        const cseq = lines.find((l) => l.toLowerCase().startsWith('cseq:'));
        console.log(`[loopback-udp] ${firstLine.split(' ')[0]} from ${rinfo.address}:${rinfo.port} len=${msg.length}`);
        console.log(`  Call-ID: ${callId}`);
        console.log(`  From: ${from}`);
        console.log(`  To: ${to}`);
        console.log(`  CSeq: ${cseq}`);
        if (msg instanceof Uint8Array) {
          for (const listener of [...this.listeners]) {
            try { listener({ type: 'data', data: msg.slice() }); } catch { /* swallow */ }
          }
        }
      });
    }

    connect(): Promise<void> {
      return new Promise<void>((resolve) => {
        this.socket.bind(this.localPort, () => {
          this.connected = true;
          resolve();
        });
      });
    }

    disconnect(): Promise<void> {
      return new Promise<void>((resolve) => {
        this.connected = false;
        try { this.socket.close(() => resolve()); } catch { resolve(); }
      });
    }

    isConnected(): boolean { return this.connected; }

    subscribe(listener: (event: TransportEvent) => void): () => void {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    }

    send(data: Uint8Array): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        this.socket.send(data, this.remotePort, this.remoteHost, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    }
  }

  const noopLiveness: LivenessStrategy = { start: () => {}, stop: () => {} };
  const stubMedia = {
    createOffer: async () => STUB_SDP,
    createAnswer: async () => STUB_SDP,
    setRemote: async () => {},
    commitDirection: async () => {},
    rollbackDirection: async () => {},
    closeSession: () => {},
    unsubscribe: () => {},
    close: () => {},
    get pendingRequestCount() { return 0; },
  } as unknown as WorkerMediaController;

  const realClock: Clock = {
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
  };

  const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${what}`)); return; }
        if (predicate()) { resolve(); return; }
        realClock.setTimeout(poll, 50);
      };
      poll();
    });
  };

  let pendingIncoming: Invitation | undefined;
  const subscribe = (agent: UserAgent): void => {
    agent.on('registrationStateChanged', (e) => record({
      type: 'registration',
      detail: e.state,
      meta: { callId: e.identity.callId, nextCSeq: e.identity.nextCSeq },
    }));
    agent.on('failed', (e) => record({ type: 'error', detail: errorDetail(e.error) }));
    agent.on('incomingCall', (e) => {
      pendingIncoming = e.invitation;
      record({ type: 'incoming', detail: 'invitation' });
    });
  };

  const bootGeneration = async (opts: {
    sippPort: number;
    localPort: number;
    host: string;
    username: string;
    password: string;
    initialIdentity?: { callId: string; nextCSeq: number };
  }): Promise<UserAgent> => {
    let transport: Transport;
    if (env.transport === 'udp') {
      // SIPp UAC mode sends INVITEs from an ephemeral port, not from -p.
      // NodeUdpTransport.isFromConfiguredPeer drops packets whose source port
      // doesn't match remotePort.  For incoming-only scenarios the driver must
      // accept INVITEs from any source port, so we use LoopbackTransport.
      const needsPermissive = env.scenario === 'invite-incoming' || env.scenario === 'cancel-race';
      if (needsPermissive) {
        transport = new LoopbackTransport(
          dgram.createSocket('udp4'),
          opts.localPort,
          opts.host,
          opts.sippPort,
        );
      } else {
        transport = new NodeUdpTransport(dgram.createSocket('udp4') as unknown as import('@sip-worker/node/transport').DatagramSocketLike, {
          localPort: opts.localPort,
          remoteHost: opts.host,
          remotePort: opts.sippPort,
        });
      }
    } else {
      transport = new NodeTcpTransport(new net.Socket() as unknown as import('@sip-worker/node/transport').StreamSocketLike, { host: opts.host, port: opts.sippPort });
    }
    const counting = new CountingTransport(transport);
    const agent = new UserAgent({
      transport: counting,
      clock: realClock,
      registrarUri: `sip:sipp@${opts.host}:${opts.sippPort}`,
      aor: `sip:driver@${opts.host}`,
      contact: `sip:driver@${opts.host}:${opts.localPort}`,
      credentials: { username: opts.username, password: opts.password },
      idGenerator: { branch: () => `z9hG4bK-sipp-${Math.random().toString(36).slice(2, 12)}` },
      refreshFraction: 0.5,
      mediaController: stubMedia,
      liveness: noopLiveness,
      viaAddress: `${opts.host}:${opts.localPort}`,
      ...(opts.initialIdentity !== undefined ? { initialIdentity: opts.initialIdentity } : {}),
    });
    subscribe(agent);
    await agent.connect();
    return agent;
  };

  const dispose = async (agent: UserAgent): Promise<void> => {
    try { await agent.disconnect(); } catch { /* best-effort teardown */ }
  };

  const hangup = async (inviter: Inviter): Promise<void> => {
    try {
      await inviter.hangup();
      record({ type: 'hangup', detail: 'resolved' });
    } catch (error) {
      record({ type: 'hangup', detail: `rejected:${errorCode(error as Error)}` });
    }
  };

  const waitForIncoming = async (): Promise<Invitation> => {
    await waitFor(() => trace.some((r) => r.type === 'incoming'), 'incoming INVITE');
    if (pendingIncoming === undefined) throw new Error('incoming record present but no invitation captured');
    return pendingIncoming;
  };

  const ctx: Ctx = {
    env,
    trace,
    record,
    deadline,
    ua: null,
    pendingIncoming,
    waitFor,
    bootGeneration,
    dispose,
    hangup,
    waitForIncoming,
  };

  try {
    ctx.ua = await bootGeneration({
      sippPort: env.sippPort,
      localPort: env.localPort,
      host: env.host,
      username: env.username,
      password: env.password,
    });
    console.log(`READY ${env.localPort}`);

    await runScenarioAction(env.scenario, ctx);

    const expected = EXPECTATIONS[`${env.scenario}:${env.variant}`];
    if (expected === undefined) {
      throw new Error(`no expectation for ${env.scenario}:${env.variant}`);
    }
    const outcome = assertExpectedOutcome(trace, expected.outcome);
    printTrace(trace);
    if (!outcome.pass) {
      console.log(`VERDICT FAIL ${env.scenario}:${env.variant} — ${outcome.message}`);
      return 1;
    }
    console.log(`VERDICT PASS ${env.scenario}:${env.variant}`);
    return 0;
  } catch (error) {
    printTrace(trace);
    console.log(`VERDICT FAIL ${env.scenario}:${env.variant} — ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    if (ctx.ua !== null) await dispose(ctx.ua);
  }
}

function printTrace(trace: readonly AgentEventRecord[]): void {
  for (const item of trace) console.log(`[trace] ${JSON.stringify(item)}`);
}

// Entry point: run only when invoked directly as a child process.
if (process.argv[1] !== undefined && process.argv[1].endsWith('agent.js')) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(2);
  });
}
