/**
 * Browser online/offline and page-lifecycle environment seam (v0.7).
 *
 * This module must never read a browser global at import time. The browser
 * project's architecture gate forbids executable `window`/`navigator`/etc.
 * references in production source outside the single dedicated media seam, so
 * the DOM event surface is supplied through an injected host bridge. The
 * production composition root (BrowserPhone) wires the real
 * {@link BrowserLifecycleHost} lazily at construction; tests substitute an
 * in-memory host. Browser capabilities are therefore resolved only at
 * construction/operation time through an explicit environment seam, never at
 * module evaluation.
 */

/** Lazy bridge to the browser DOM online/offline and page-lifecycle events. */
export interface BrowserLifecycleHost {
  isOnline(): boolean;
  /** Subscribe to a named browser event ('online'|'offline'|'pagehide'|...). */
  subscribe(type: 'online' | 'offline' | 'pagehide', listener: () => void): () => void;
}

export interface BrowserLifecycleEnvironment {
  isOnline(): boolean;
  /** Fired when the browser reports the network is back; idempotent unsubscribe. */
  subscribeOnline(listener: () => void): () => void;
  /** Fired when the browser reports the network is gone; idempotent unsubscribe. */
  subscribeOffline(listener: () => void): () => void;
  /** Fired on a page-lifecycle transition (e.g. 'pagehide'); idempotent unsubscribe. */
  subscribePageLifecycle(listener: () => void): () => void;
}

/**
 * Create a {@link BrowserLifecycleEnvironment} bound to the given host.
 * Nothing is read at module evaluation time; connectivity is checked lazily via
 * `host.isOnline()` on each call so tests can flip the host's state.
 */
export function createBrowserLifecycleEnvironment(
  host: BrowserLifecycleHost,
): BrowserLifecycleEnvironment {
  return {
    isOnline: () => host.isOnline(),
    subscribeOnline: (listener) => {
      let active = true;
      const unsubscribe = host.subscribe('online', listener);
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    },
    subscribeOffline: (listener) => {
      let active = true;
      const unsubscribe = host.subscribe('offline', listener);
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    },
    subscribePageLifecycle: (listener) => {
      let active = true;
      const unsubscribe = host.subscribe('pagehide', listener);
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    },
  };
}
