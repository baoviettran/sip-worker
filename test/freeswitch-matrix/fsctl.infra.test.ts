// test/freeswitch-matrix/fsctl.infra.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { startFreeSwitch, stopFreeSwitch, fsExec, fsSubscribeDtfm, getRecordings } from './fsctl';

const CONF = join(import.meta.dirname, 'fs-conf');

describe('fsExec drives the event socket', () => {
  it('accepts status, originate, and uuid_kill', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      const uuid = (await fsExec('create_uuid')).trim();
      const started = await fsExec(`originate {origination_uuid=${uuid}}loopback/9196/default/XML &echo()`);
      expect(started).toMatch(/\+OK/); // originate accepted
      await fsExec(`uuid_kill ${uuid}`);
      expect(await fsExec('sofia status')).toMatch(/ws-test/); // socket healthy after kill
    } finally {
      await stopFreeSwitch(handle);
    }
  });

  it('records the echo dialplan into the mounted /recordings volume', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      const uuid = (await fsExec('create_uuid')).trim();
      await fsExec(`originate {origination_uuid=${uuid}}loopback/9196/default/XML &echo()`);
      // loopback legs are answered server-side; kill turns the call, then the
      // record_session file must exist. If loopback/9196 never answers, drop this
      // assertion here — the real recording proof is the Task 6 audio spec.
      await fsExec(`uuid_kill ${uuid}`);
      const wavs = getRecordings(handle);
      expect(wavs.length).toBeGreaterThan(0);
    } finally {
      await stopFreeSwitch(handle);
    }
  });

  it('fsSubscribeDtfm parses the Content-Length-framed DTMF event stream', async () => {
    const handle = await startFreeSwitch(CONF);
    try {
      const uuid = (await fsExec('create_uuid')).trim();
      const started = await fsExec(`originate {origination_uuid=${uuid}}loopback/9196/default/XML &park()`);
      expect(started).toMatch(/\+OK/); // originate accepted
      // Subscribe for real, then drive a DTMF through the api (fsExec). The
      // event only fires when the digit is DEQUEUED by a reading application
      // (switch_channel_dequeue_dtmf is the only event-firing path —
      // switch_channel_queue_dtmf at switch_channel.c:528 merely logs
      // "RECV DTMF"), so the raw uuid_send_dtmf call would fire nothing on
      // the echo leg. Instead the tone uuid_send_dtmf generates on the echo
      // leg's (loopback/9196-b) outbound media is relayed by mod_loopback to
      // the parked A leg (loopback/9196-a), whose park loop — like echo,
      // invoked with NULL input args — dequeues the queue, and THAT fires
      // the DTMF event. The subscription must yield digit '5' parsed from
      // the Content-Length-framed body.
      const ac = new AbortController();
      const events = fsSubscribeDtfm({ signal: ac.signal });
      // Warm the lazy generator BEFORE uuid_send_dtmf fires: fsSubscribeDtfm's
      // connect/auth/subscribe body runs only on the first next(), so issue
      // that call here — the pending promise is the event sink for the digit
      // (today's un-warmed subscription passed only because park-dequeue
      // latency exceeded socket-connect time). A next() that loses its
      // Promise.race stays pending and silently consumes the NEXT yielded
      // event, so next() is re-issued only after the previous one RESOLVED —
      // never while one is in flight.
      let pending: ReturnType<typeof events.next> = events.next();
      try {
        await new Promise((resolve) => setTimeout(resolve, 2_000)); // let the call settle
        const channels = (await fsExec('show channels')).split('\n');
        const echoLeg = channels
          .filter((l) => /^[0-9a-f]{8}-/.test(l))
          .map((l) => l.split(',')[0])
          .find((u) => u && u !== uuid);
        expect(echoLeg, 'loopback echo leg (loopback/9196-b) not found in show channels').toBeTruthy();
        await fsExec(`uuid_send_dtmf ${echoLeg} 5`);
        const deadline = Date.now() + 10_000;
        let observed: { digit: string; channel: string } | undefined;
        while (Date.now() < deadline) {
          // Race the retained pending next(); on timeout it stays in flight
          // (the finally-block abort ends it) and is never re-issued.
          const next = await Promise.race([
            pending,
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), deadline - Date.now())),
          ]);
          if (next === 'timeout') break;
          if (next.done) throw new Error('fsSubscribeDtfm ended unexpectedly');
          if (next.value.digit === '5') {
            observed = next.value;
            break;
          }
          pending = events.next(); // previous next() resolved; safe to re-issue
        }
        expect(observed, 'no DTMF event for digit 5 within 10 s').toBeDefined();
        expect(observed!.channel).toContain('9196');
      } finally {
        // Abort-based teardown: a pending events.next() raced against the
        // deadline must never block cleanup (see fsSubscribeDtfm docstring).
        ac.abort();
      }
      await fsExec(`uuid_kill ${uuid}`);
    } finally {
      await stopFreeSwitch(handle);
    }
  });
});
