/**
 * In-memory media port pair for the worker/main boundary (v0.5).
 *
 * Produces two {@link MediaPort}s whose `postMessage` delivers plain-data
 * {@link MediaMessage}s to the opposite port's listeners. Delivery is
 * structured-clone-safe in both directions: the message is cloned per listener,
 * so no receiver can mutate the sender's copy or another listener's view. Each
 * message reaches a SNAPSHOT of the listeners subscribed at post time — a
 * listener added (or removed) after the post is not notified for it.
 *
 * No global `MessageChannel` or ambient channel is used; the two ports are a
 * self-contained pair, so this module (and everything built on it) stays
 * Node-free and import-safe in the browser.
 */

import type { MediaMessage, MediaPort } from '@sip-worker/core';

/** A registered listener with an idempotent active flag for unsubscribe. */
interface ListenerEntry {
  readonly notify: (message: MediaMessage) => void;
  active: boolean;
}

/**
 * One half of the pair. Holds its own incoming listener set and fan-out the
 * OTHER half's listeners when it posts, so `core.postMessage` reaches everyone
 * subscribed on `browser` and vice-versa.
 */
class PortEnd {
  /** Listeners subscribed ON this end (this is the half they registered on). */
  private readonly incoming: Set<ListenerEntry>;
  /** The half on the other end, whose listeners this half fans out to. */
  private readonly oppositeHalf: (() => Set<ListenerEntry>);
  private readonly closed: () => boolean;

  constructor(
    incoming: Set<ListenerEntry>,
    opposite: () => Set<ListenerEntry>,
    closed: () => boolean,
  ) {
    this.incoming = incoming;
    this.oppositeHalf = opposite;
    this.closed = closed;
  }

  postMessage(message: MediaMessage): void {
    if (this.closed()) return;
    // Snapshot: listeners added/removed after this point are not notified for
    // this message. Clone per listener so mutation in one cannot leak to another
    // listener or back to the sender. A throwing listener is fault-isolated so it
    // cannot abort delivery to the remaining snapshot listeners.
    for (const entry of [...this.oppositeHalf()]) {
      if (!entry.active) continue;
      try {
        entry.notify(structuredClone(message));
      } catch {
        // A listener error must not corrupt the fan-out or the sender's copy.
      }
    }
  }

  subscribe(listener: (message: MediaMessage) => void): () => void {
    const entry: ListenerEntry = { notify: listener, active: true };
    this.incoming.add(entry);
    return (): void => {
      this.incoming.delete(entry);
      entry.active = false;
    };
  }
}

/** A pair of {@link MediaPort}s that deliver into each other. */
export interface MediaPortPair {
  readonly core: MediaPort;
  readonly browser: MediaPort;
  /** Idempotently stop all delivery across both ports. Safe to call repeatedly. */
  close(): void;
}

/**
 * Build a matched core/browser {@link MediaPort} pair. Each end's `postMessage`
 * delivers a per-listener structured clone to the opposite end's listeners, and
 * `close()` idempotently stops all delivery in both directions. Uses no global
 * channel.
 */
export function createMediaPortPair(): MediaPortPair {
  let coreListeners = new Set<ListenerEntry>();
  let browserListeners = new Set<ListenerEntry>();
  let closed = false;

  const core = new PortEnd(coreListeners, () => browserListeners, () => closed);
  const browser = new PortEnd(browserListeners, () => coreListeners, () => closed);

  return {
    core,
    browser,
    close(): void {
      if (closed) return;
      closed = true;
      coreListeners = new Set();
      browserListeners = new Set();
    },
  };
}
