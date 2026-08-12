import { describe, expect, it } from 'vitest';
import type {
  Transport,
  TransportCapabilities,
} from '@sip-worker/core/transport';

/**
 * Per-adapter lifecycle controls for the shared transport contract.
 *
 * The five members are the only surface a concrete adapter harness exposes:
 * the transport under test, every outbound byte copy handed to the socket, and
 * three test-only lifecycle triggers (open the connection, deliver an inbound
 * message, and perform a remote close). Each concrete adapter harness maps
 * these onto its own fake socket events.
 */
export interface TransportContractHarness {
  readonly transport: Transport;
  readonly sent: readonly Uint8Array[];
  open(): void;
  deliver(data: Uint8Array): void;
  remoteClose(error?: Error): void;
}

/**
 * Registers one vitest suite running the shared behavioral contract against a
 * concrete adapter harness. The assertions are framing- and token-agnostic so
 * they hold for WebSocket (message), TCP (stream), and UDP (datagram) alike.
 */
// A complete framed SIP request: the stream decoder (TCP) emits one data event
// per message boundary, while message (WebSocket) and datagram (UDP) framings
// pass the bytes straight through. Contract tests that expect an inbound `data`
// event deliver this well-formed message; the observer-throw and disconnect
// tests that only assert lifecycle event order may deliver arbitrary bytes.
const SIP_MESSAGE = new TextEncoder().encode(
  'INVITE sip:alice@example.test SIP/2.0\r\nContent-Length: 4\r\n\r\nbody',
);

export function defineTransportContract(
  name: string,
  create: () => TransportContractHarness,
): void {
  describe(`transport contract: ${name}`, () => {
    it('freezes a truthful capabilities object', () => {
      const { transport } = create();
      const capabilities: TransportCapabilities = transport.capabilities;

      expect(Object.isFrozen(capabilities)).toBe(true);
      expect(typeof capabilities.reliable).toBe('boolean');
      expect(['datagram', 'stream', 'message']).toContain(capabilities.framing);
      expect(['UDP', 'TCP', 'WS', 'WSS']).toContain(capabilities.token);
      expect(() => Object.assign(capabilities, { reliable: false })).toThrow(TypeError);
    });

    it('returns one promise for concurrent connects and emits one connected', async () => {
      const { transport, open } = create();
      const events: string[] = [];
      transport.subscribe((event) => events.push(event.type));

      const first = transport.connect();
      const second = transport.connect();
      expect(second).toBe(first);

      open();
      await first;
      await second;

      expect(transport.isConnected()).toBe(true);
      expect(events).toEqual(['connected']);
    });

    it('copies outbound bytes before handing them to the socket', async () => {
      const { transport, sent, open } = create();
      const pending = transport.connect();
      open();
      await pending;

      const data = new Uint8Array([6, 7]);
      await transport.send(data);
      data[0] = 9;

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual(new Uint8Array([6, 7]));
      expect(sent[0]).not.toBe(data);
    });

    it('preserves the delivered bytes across framing and copies them', async () => {
      const { transport, deliver, open } = create();
      const events: Array<{ type: string; data?: Uint8Array }> = [];
      transport.subscribe((event) => events.push(event));
      const pending = transport.connect();
      open();
      await pending;

      const message = SIP_MESSAGE;
      const source = new Uint8Array(message);
      deliver(source);
      source.fill(0);

      const dataEvents = events.filter((event) => event.type === 'data' && event.data !== undefined);
      expect(dataEvents).toHaveLength(1);
      const emitted = dataEvents[0]!.data!;
      // The emitted copy reflects the delivered content, not the post-delivery
      // mutation.
      expect(emitted).not.toBe(source);
      expect(emitted).toEqual(message);
    });

    it('stops notifying an unsubscribed listener', async () => {
      const { transport, deliver, open } = create();
      const events: string[] = [];
      const unsubscribe = transport.subscribe((event) => events.push(event.type));

      const pending = transport.connect();
      unsubscribe();
      open();
      await pending;

      deliver(new Uint8Array([1]));
      expect(events).toEqual([]);
    });

    it('isolates a throwing observer from lifecycle delivery', async () => {
      const { transport, deliver, open, remoteClose } = create();
      const events: string[] = [];
      transport.subscribe(() => {
        throw new Error('observer failed');
      });
      transport.subscribe((event) => events.push(event.type));

      const pending = transport.connect();
      expect(() => open()).not.toThrow();
      await pending;
      expect(() => deliver(SIP_MESSAGE)).not.toThrow();
      expect(() => remoteClose()).not.toThrow();

      expect(events).toEqual(['connected', 'data', 'disconnected']);
    });

    it('settles disconnect only once the socket fully closes', async () => {
      const { transport, open, remoteClose } = create();
      const pending = transport.connect();
      open();
      await pending;

      let settled = false;
      const disconnected = transport.disconnect().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      remoteClose();
      await disconnected;
      expect(settled).toBe(true);
    });

    it('emits exactly one terminal disconnected event', async () => {
      const { transport, deliver, open, remoteClose } = create();
      const events: string[] = [];
      transport.subscribe((event) => events.push(event.type));
      const pending = transport.connect();
      open();
      await pending;

      remoteClose();
      remoteClose();
      deliver(new Uint8Array([1]));

      expect(transport.isConnected()).toBe(false);
      expect(events).toEqual(['connected', 'disconnected']);
    });
  });
}