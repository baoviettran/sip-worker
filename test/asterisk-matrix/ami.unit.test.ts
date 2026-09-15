import { describe, it, expect } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { parseAmiFrames, AmiClient } from './ami';

describe('parseAmiFrames', () => {
  it('splits frames on a blank line and keeps a partial frame as rest', () => {
    const { frames, rest } = parseAmiFrames(
      Buffer.from('Response: Success\r\nMessage: Authentication accepted\r\n\r\nEvent: FullyBooted\r\n'),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ Response: 'Success', Message: 'Authentication accepted' });
    expect(rest.toString()).toBe('Event: FullyBooted\r\n');
  });

  it('parses repeated keys without losing the first value', () => {
    // Two Channel: headers in one frame: the first must win rather than being
    // overwritten by the second. The harness asserts on the channel it
    // originated, so a silent overwrite would make that assertion test nothing.
    const { frames } = parseAmiFrames(
      Buffer.from('Event: Newchannel\r\nChannel: PJSIP/1000-1\r\nChannel: PJSIP/1000-2\r\n\r\n'),
    );
    expect(frames[0]).toMatchObject({ Event: 'Newchannel', Channel: 'PJSIP/1000-1' });
  });
});

describe('AmiClient', () => {
  let server: Server;
  let port = 0;

  it('logs in, correlates an action by ActionID, and reads an event', async () => {
    server = createServer((sock) => {
      sock.write('Asterisk Call Manager/5.0.4\r\n');
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, rest } = parseAmiFrames(buf);
        buf = rest;
        for (const f of frames) {
          // Echo the request's own ActionID: the client generates them, so a
          // hardcoded id in the fake would never correlate (a real AMI echoes
          // the ActionID it was sent).
          if (f.Action === 'Login') sock.write(`Response: Success\r\nActionID: ${f.ActionID}\r\n\r\n`);
          else if (f.Action === 'Hangup') {
            sock.write(`Response: Success\r\nActionID: ${f.ActionID}\r\n\r\n`);
            sock.write(`Event: PeerStatus\r\nActionID: ${f.ActionID}\r\nPeer: PJSIP/1000\r\n\r\n`);
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;

    const ami = await AmiClient.connect({ host: '127.0.0.1', port, username: 'matrix', password: 'matrix-pass-2026' });
    try {
      const res = await ami.action({ Action: 'Hangup', Channel: 'PJSIP/1000-1' });
      expect(res.Response).toBe('Success');
      const ev = await ami.waitForEvent((e) => e.Event === 'PeerStatus', 2_000, 'PeerStatus');
      expect(ev.Peer).toBe('PJSIP/1000');
    } finally {
      ami.close();
    }
  }, 10_000);

  // AMI's OriginateResponse carries BOTH `Event:` and `Response:` headers. The
  // obvious frame-loop shortcut — "a frame with a Response header is a stray
  // action reply, skip it" — swallows it, and the symptom is an event that
  // never arrives rather than a parse error. This is the regression that keeps
  // onData consulting its waiters before any such skip.
  it('routes an event that also carries a Response header to its waiter', async () => {
    const server = createServer((sock) => {
      sock.write('Asterisk Call Manager/5.0.4\r\n');
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, rest } = parseAmiFrames(buf);
        buf = rest;
        for (const f of frames) {
          // Echo the request's own ActionID: the client generates them, so a
          // hardcoded id in the fake would never correlate.
          sock.write(`Response: Success\r\nActionID: ${f.ActionID}\r\n\r\n`);
          if (f.Action === 'Originate') {
            // Both headers, as a real OriginateResponse has.
            sock.write(
              `Event: OriginateResponse\r\nResponse: Success\r\nActionID: ${f.ActionID}\r\nUniqueid: 1234.5\r\n\r\n`,
            );
          }
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ami = await AmiClient.connect({ host: '127.0.0.1', port, username: 'matrix', password: 'matrix-pass-2026' });
    try {
      const pending = ami.waitForEvent((e) => e.Event === 'OriginateResponse', 3_000, 'OriginateResponse');
      await ami.action({ Action: 'Originate', Channel: 'PJSIP/1000' });
      expect((await pending).Uniqueid).toBe('1234.5');
    } finally {
      ami.close();
      server.close();
    }
  }, 10_000);

  // A timed-out waiter must be REMOVED. `onData` consults `waiters` before
  // `lastEvents`, so a stale waiter claims the next frame matching its
  // predicate and resolves it into an already-rejected promise — the frame then
  // reaches neither `lastEvents` nor any live waiter. The cleanup meant to
  // remove it compared the pushed wrapper against the executor's own `resolve`,
  // which never matched, so the splice was dead code and the waiter leaked.
  // This asserts the consequence (an unclaimed frame is retained), which is the
  // half that can actually lose evidence.
  it('removes a timed-out waiter so it cannot swallow a later matching frame', async () => {
    let conn: Socket | undefined;
    const server = createServer((sock) => {
      conn = sock;
      sock.write('Asterisk Call Manager/5.0.4\r\n');
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, rest } = parseAmiFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.Action === 'Login') sock.write(`Response: Success\r\nActionID: ${f.ActionID}\r\n\r\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const ami = await AmiClient.connect({ host: '127.0.0.1', port, username: 'matrix', password: 'matrix-pass-2026' });
    try {
      // Nothing ever sends this event, so the wait expires.
      await expect(ami.waitForEvent((e) => e.Event === 'PeerStatus', 100, 'PeerStatus')).rejects.toThrow(
        /timed out/,
      );
      // The waiter is gone, so this frame is UNCLAIMED and retained. With the
      // cleanup broken it is claimed by the stale waiter and discarded.
      conn?.write('Event: PeerStatus\r\nPeer: PJSIP/1000\r\n\r\n');
      await new Promise((r) => setTimeout(r, 50));
      expect(ami.events).toContainEqual(expect.objectContaining({ Event: 'PeerStatus' }));
    } finally {
      ami.close();
      server.close();
    }
  }, 10_000);
});
