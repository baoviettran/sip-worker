import { describe, expect, it } from 'vitest';
import { createBrowserLifecycleEnvironment } from '../../src/recovery/index.js';
import type { BrowserLifecycleHost } from '../../src/recovery/index.js';

/** A minimal in-memory host that stands in for the DOM event surface. */
class FakeHost implements BrowserLifecycleHost {
  online = true;
  private readonly listeners = new Map<string, Set<() => void>>();

  isOnline(): boolean {
    return this.online;
  }

  subscribe(type: string, listener: () => void): () => void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.get(type)?.delete(listener);
    };
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  setOnline(value: boolean): void {
    this.online = value;
    this.emit(value ? 'online' : 'offline');
  }
}

describe('createBrowserLifecycleEnvironment', () => {
  it('exposes current connectivity from the host, read lazily', () => {
    const host = new FakeHost();
    const env = createBrowserLifecycleEnvironment(host);
    expect(env.isOnline()).toBe(true);
    host.setOnline(false);
    expect(env.isOnline()).toBe(false);
    host.setOnline(true);
    expect(env.isOnline()).toBe(true);
  });

  it('provides online subscriptions with idempotent unsubscribe', () => {
    const host = new FakeHost();
    const env = createBrowserLifecycleEnvironment(host);
    const seen: boolean[] = [];
    const unsubscribe = env.subscribeOnline(() => seen.push(true));

    host.emit('online');
    expect(seen).toEqual([true]);

    unsubscribe();
    unsubscribe(); // second call is a no-op
    host.emit('online');
    expect(seen).toEqual([true]);
  });

  it('fires offline subscriptions and detaches them independently', () => {
    const host = new FakeHost();
    const env = createBrowserLifecycleEnvironment(host);
    const offline: boolean[] = [];
    const online: boolean[] = [];
    const unsubOffline = env.subscribeOffline(() => offline.push(true));
    env.subscribeOnline(() => online.push(true));

    host.setOnline(false);
    expect(offline).toEqual([true]);
    expect(online).toEqual([]);

    unsubOffline();
    host.setOnline(true);
    expect(online).toEqual([true]);
    expect(offline).toEqual([true]);
  });

  it('delivers page-lifecycle events with idempotent unsubscribe', () => {
    const host = new FakeHost();
    const env = createBrowserLifecycleEnvironment(host);
    const pageHidden: boolean[] = [];
    const unsubscribe = env.subscribePageLifecycle(() => pageHidden.push(true));

    host.emit('pagehide');
    expect(pageHidden).toEqual([true]);

    unsubscribe();
    unsubscribe();
    host.emit('pagehide');
    expect(pageHidden).toEqual([true]);
  });

  it('keeps independent subscribers isolated', () => {
    const host = new FakeHost();
    const env = createBrowserLifecycleEnvironment(host);
    const a: boolean[] = [];
    const b: boolean[] = [];
    const unsubA = env.subscribeOnline(() => a.push(true));
    env.subscribeOnline(() => b.push(true));

    host.emit('online');
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);

    unsubA();
    host.emit('online');
    expect(a).toEqual([true]);
    expect(b).toEqual([true, true]);
  });
});
