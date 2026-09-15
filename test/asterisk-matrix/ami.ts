// test/asterisk-matrix/ami.ts — minimal AMI (Asterisk Manager Interface)
// client: the matrix's control plane. AMI frames are CRLF header blocks
// terminated by a blank line, with no length prefix, so the parser's job is to
// keep the unterminated tail until more bytes arrive. Fail-not-skip: every
// action and every waited-for event is deadline-bounded and throws on expiry.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export type AmiMessage = Record<string, string>;

export function parseAmiFrames(buf: Buffer): { frames: AmiMessage[]; rest: Buffer } {
  const frames: AmiMessage[] = [];
  const text = buf.toString('latin1');
  let start = 0;
  for (;;) {
    const sep = text.indexOf('\r\n\r\n', start);
    if (sep === -1) break;
    const frame: AmiMessage = {};
    for (const line of text.slice(start, sep).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      // Repeated keys (e.g. two Channel: lines) keep the first value rather
      // than silently overwriting it — the harness asserts on the channel it
      // originated, and an overwrite would make that assertion test nothing.
      if (!(key in frame)) frame[key] = value;
    }
    if (Object.keys(frame).length > 0) frames.push(frame);
    start = sep + 4;
  }
  return { frames, rest: Buffer.from(text.slice(start), 'latin1') };
}

export class AmiClient {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: Array<{ pred: (e: AmiMessage) => boolean; resolve: (e: AmiMessage) => void; description: string }> = [];
  private pending = new Map<string, (r: AmiMessage) => void>();
  private closed = false;
  /**
   * Every frame in and out, for the artifact the spec requires. The control
   * plane is half this matrix's evidence — the page proves what the browser
   * saw, the transcript proves what the PBX was asked to do and answered — and
   * a failure that only reproduces in CI is unreadable without it.
   */
  private transcript: string[] = [];

  private constructor(
    private readonly sock: net.Socket,
    private readonly transcriptPath?: string,
    /** Redacted out of the transcript; never hardcoded in this module. */
    private readonly secret?: string,
  ) {
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => {
      this.closed = true;
    });
  }

  static connect(o: { host: string; port: number; username: string; password: string; timeoutMs?: number; transcriptPath?: string }): Promise<AmiClient> {
    const timeoutMs = o.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: o.host, port: o.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`AMI connect to ${o.host}:${o.port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      sock.once('connect', () => {
        const client = new AmiClient(sock, o.transcriptPath, o.password);
        client
          .action({ Action: 'Login', Username: o.username, Secret: o.password }, timeoutMs)
          .then((res) => {
            clearTimeout(timer);
            if (res.Response !== 'Success') {
              sock.destroy();
              reject(new Error(`AMI login rejected: ${JSON.stringify(res)}`));
              return;
            }
            resolve(client);
          })
          .catch((e) => {
            clearTimeout(timer);
            sock.destroy();
            reject(e);
          });
      });
    });
  }

  /** Append one direction-prefixed frame to the transcript, redacting secrets. */
  private record(dir: '>' | '<', frame: AmiMessage): void {
    if (!this.transcriptPath) return;
    const line = Object.entries(frame).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    this.transcript.push(`${dir} ${frame.Action ?? frame.Event ?? 'frame'}\n${line}`);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    const { frames, rest } = parseAmiFrames(this.buf);
    this.buf = rest;
    for (const frame of frames) {
      this.record('<', frame);
      const id = frame.ActionID;
      if (id !== undefined) {
        const resolver = this.pending.get(id);
        if (resolver) {
          this.pending.delete(id);
          resolver(frame);
          continue;
        }
      }
      // Checked BEFORE any "skip frames that carry a Response header" shortcut:
      // AMI's OriginateResponse carries BOTH `Event:` and `Response:` headers,
      // so skipping on Response would swallow it and the failure would look
      // like a lost event rather than a parser bug. Task 9 pins this with a
      // regression test.
      const idx = this.waiters.findIndex((w) => w.pred(frame));
      if (idx !== -1) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(frame);
        continue;
      }
      // Unclaimed frames are kept so a fast PBX's event is not lost to a race
      // with the harness starting its wait.
      this.lastEvents.push(frame);
      if (this.lastEvents.length > 500) this.lastEvents.shift();
    }
  }

  /** Frames no waiter claimed, oldest first (bounded). */
  private lastEvents: AmiMessage[] = [];

  action(fields: AmiMessage, timeoutMs = 10_000): Promise<AmiMessage> {
    const actionId = fields.ActionID ?? randomUUID();
    const frame = { ...fields, ActionID: actionId };
    const body = Object.entries(frame).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`AMI socket closed before Action: ${fields.Action}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI Action: ${fields.Action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(actionId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.record('>', frame);
      this.sock.write(body);
    });
  }

  /** Flush the transcript to disk, redacting the AMI secret it logged in with. */
  private flushTranscript(): void {
    if (!this.transcriptPath || this.transcript.length === 0) return;
    let body = this.transcript.join('\n') + '\n';
    this.transcript = [];
    // Redact the secret the caller supplied rather than a literal, so this
    // module knows no credential and cannot leak one if the value changes.
    if (this.secret) body = body.replaceAll(this.secret, '***');
    appendFileSync(this.transcriptPath, body);
  }

  waitForEvent(pred: (e: AmiMessage) => boolean, timeoutMs: number, description: string): Promise<AmiMessage> {
    // Events that arrived before this call are still checked: a fast PBX can
    // emit the Newchannel before the harness starts waiting.
    const past = this.lastEvents.findIndex(pred);
    if (past !== -1) return Promise.resolve(this.lastEvents.splice(past, 1)[0]);
    return new Promise((resolve, reject) => {
      // The waiter object is captured so the timeout removes THIS waiter.
      // `findIndex((w) => w.resolve === resolve)` could never match: `w.resolve`
      // is the wrapper below and `resolve` is this executor's own resolve, so
      // they are different objects, `at` was always -1, and the splice was dead
      // code — a timed-out waiter stayed in the list forever. That is a live
      // hazard, not just a leak: `onData` consults `waiters` before
      // `lastEvents`, so a stale waiter CLAIMS the next frame matching its
      // predicate and resolves it into an already-rejected promise, and the
      // frame then reaches neither `lastEvents` nor any live waiter.
      const waiter = {
        pred,
        description,
        resolve: (e: AmiMessage): void => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new Error(`AMI: timed out after ${timeoutMs}ms waiting for ${description}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Every frame no waiter claimed, oldest first. */
  get events(): AmiMessage[] {
    return this.lastEvents;
  }

  close(): void {
    this.closed = true;
    this.flushTranscript();
    this.sock.destroy();
  }
}
