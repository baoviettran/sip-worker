/**
 * Registrar request/state machine (RFC 3261 10).
 *
 * Owns the registration identity (stable Call-ID, strictly increasing CSeq),
 * the REGISTER request lifecycle across 401/407/423 retries, expiry-based
 * refresh scheduling, unregister (Contact `*` / Expires 0), and reconnect
 * (transport loss re-registers rather than silently dropping to unregistered).
 *
 * Every outbound attempt installs exactly one transaction-layer event listener
 * and tears it down when that attempt settles, so repeated register/unregister
 * cycles never leak listeners or timers. The refresh timer runs on the injected
 * virtual `Clock` only — never a real sleep.
 */

import { Headers, makeRequest } from '../messages/index.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { SipError } from '../errors.js';
import { extractUri, makeBranch } from '../dialogs/header-values.js';
import type { IdGenerator, AuthManager, AuthFailure } from '../auth/manager.js';
import type { TransactionLayer } from '../transactions/coordinator.js';
import type { TransactionLayerEvent } from '../transactions/types.js';
import type { Clock } from '../transport/index.js';
import type { RegistrationIdentity, RegisterState } from './registration-types.js';

export interface RegistrarOptions {
  readonly registrarUri: string;
  readonly aor: string;
  readonly credentials?: { readonly username: string; readonly password: string };
  /** Contact URI for the UA, e.g. `<sip:alice@192.0.2.1:5060>`. `'*'` unregisters. */
  readonly contact: string;
  readonly idGenerator: IdGenerator;
  readonly layer: TransactionLayer;
  readonly clock: Clock;
  readonly authManager?: AuthManager;
  /** Refresh when this fraction of the granted expiry has elapsed. Default 0.5. */
  readonly refreshFraction?: number;
  /**
   * Optional recovery identity (stable Call-ID + next CSeq) to resume, instead
   * of generating a fresh one. Used by the worker bridge so a replacement
   * generation preserves its Call-ID and never reuses a CSeq.
   */
  readonly initialIdentity?: RegistrationIdentity;
}

/** Snapshot of the registrar's externally visible state. */
export interface RegistrarStatus {
  readonly state: RegisterState;
  readonly callId: string;
  readonly nextCSeq: number;
}

/** Pull the numeric CSeq from a REGISTER, or undefined when malformed. */
function numeric(headers: Headers): number | undefined {
  const cseq = headers.get('CSeq');
  return cseq === undefined ? undefined : Number.parseInt(cseq.split(' ')[0] ?? '', 10);
}

/** Response-level or per-Contact `expires=`; prefers the matching Contact. */
function grantedExpiry(response: SipResponseMessage): number | undefined {
  const contact = response.headers.get('Contact');
  if (contact !== undefined) {
    const contactExpires = Number(contact.match(/expires=(\d+)/)?.[1] ?? NaN);
    if (Number.isFinite(contactExpires)) return contactExpires;
  }
  const responseExpires = Number(response.headers.get('Expires') ?? NaN);
  return Number.isFinite(responseExpires) ? responseExpires : undefined;
}

/** Min-Expires value, defaulting to 600 when a 423 omits it. */
function minExpiresFor(response: SipResponseMessage): number {
  const value = Number(response.headers.get('Min-Expires') ?? NaN);
  return Number.isFinite(value) ? value : 600;
}

/** Maximum REGISTER redirect hops before falling through to the generic fail (RFC 3261 10.2). */
const MAX_REDIRECTS = 5;

/**
 * Tracks registration for a single UA account. Registers/unregisters return
 * promises settling on final 2xx protocol outcomes.
 */
export class Registrar {
  private readonly layer: TransactionLayer;
  private readonly clock: Clock;
  private readonly registrarUri: string;
  private readonly aor: string;
  private readonly contact: string;
  private readonly fromTag: string;
  private readonly authManager?: AuthManager;
  private readonly credentials?: { readonly username: string; readonly password: string };
  private readonly refreshAfter: (granted: number) => number;
  private readonly identity: RegistrationIdentity;
  private branchCounter = 0;

  private redirectCount = 0;
  private redirectTarget: string | undefined;
  /**
   * requestIds whose retry budgets are in flight for the current exchange
   * (each challenged CSeq yields its own `${callId}:${cseq}`). A multi-challenge
   * exchange (e.g. 401→401→200) accumulates more than one; all are released via
   * `authManager.settle` once the exchange grants or terminally fails, keeping
   * `AuthManager.retriesByRequest` bounded across a long-lived UA.
   */
  private readonly activeRequestIds: Set<string> = new Set();

  private stateValue: RegisterState = 'unregistered';
  private refreshTimer = -1;
  private refreshMs = 0;
  private reconnectPending = false;
  private unsubscribe: (() => void) | undefined;
  private deferred: { resolve: () => void; reject: (reason: unknown) => void } | undefined;

  constructor(options: RegistrarOptions) {
    this.layer = options.layer;
    this.clock = options.clock;
    this.registrarUri = options.registrarUri;
    this.aor = options.aor;
    this.contact = options.contact;
    this.authManager = options.authManager;
    this.credentials = options.credentials;
    this.refreshAfter = (granted) => Math.max(1, Math.floor(granted * (options.refreshFraction ?? 0.5)));
    this.identity = {
      callId: options.initialIdentity?.callId ?? options.idGenerator.branch(),
      nextCSeq: options.initialIdentity?.nextCSeq ?? 1,
    };
    this.fromTag = options.idGenerator.branch();
  }

  /** Current registration state. */
  get state(): RegisterState {
    return this.stateValue;
  }

  /** Externally visible snapshot, for Plan 06 recovery / the UA event surface. */
  status(): RegistrarStatus {
    return { state: this.stateValue, callId: this.identity.callId, nextCSeq: this.identity.nextCSeq };
  }

  /**
   * Register against the registrar. Resolves only after a final 2xx has
   * established the granted expiry; rejects with `SipError` on nonrecoverable
   * finals, timeout, or transport error.
   */
  register(): Promise<void> {
    if (this.stateValue === 'registering' || this.stateValue === 'unregistering') {
      return Promise.reject(new SipError(0, 'a registration exchange is already in progress'));
    }
    this.reconnectPending = false;
    this.redirectCount = 0;
    // A 301 (permanent) redirect persists its target for the UA's life: a fresh
    // registration (initial, refresh, or reconnect) opens against that target
    // rather than the configured registrar URI. 302 is per-attempt only.
    const target = this.redirectTarget ?? this.registrarUri;
    const request = this.nextRequest(undefined, this.contact);
    return this.startExchange(target === this.registrarUri ? request : { ...request, uri: target });
  }

  /**
   * Unregister: cancel the refresh timer, then send `REGISTER` with Contact `*`
   * and `Expires: 0`. Resolves only on the 2xx.
   */
  unregister(): Promise<void> {
    if (this.stateValue === 'registering' || this.stateValue === 'unregistering') {
      return Promise.reject(new SipError(0, 'a registration exchange is already in progress'));
    }
    this.cancelRefresh();
    this.stateValue = 'unregistering';
    return this.startExchange(this.nextRequest(0, '*'));
  }

  /** UA hook: transport is up again after a loss — re-issue the registration. */
  onTransportConnected(): void {
    if (!this.reconnectPending) return;
    this.reconnectPending = false;
    void this.register();
  }

  /** UA hook: transport lost — settle any in-flight exchange, drop to unregistered, cancel refresh. */
  onTransportDisconnected(): void {
    this.teardownExchange();
    this.releaseAuthBudget();
    this.cancelRefresh();
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred !== undefined) {
      // An exchange was in flight; settle it with a rejection rather than hang.
      this.stateValue = 'failed';
      deferred.reject(new SipError(0, 'transport disconnected during a registration exchange'));
    } else if (this.stateValue !== 'unregistering') {
      this.stateValue = 'unregistered';
    }
    this.reconnectPending = true;
  }

  /**
   * Build and send-allocate the next REGISTER. Consumes exactly one CSeq slot:
   * the request carries `identity.nextCSeq`, then the counter advances, so the
   * wire sequence across initial/authenticated/423/refresh/unregister/reconnect
   * is strictly `1,2,3,…` on one stable Call-ID.
   */
  private nextRequest(expires: number | undefined, contact: string): SipRequestMessage {
    const headers = new Headers();
    const branch = makeBranch(`reg-${(this.branchCounter += 1)}`);
    headers.set('Via', `SIP/2.0/UDP 192.0.2.1:5060;branch=${branch}`);
    headers.set('Max-Forwards', '70');
    headers.set('From', `<${this.aor}>;tag=${this.fromTag}`);
    headers.set('To', `<${this.aor}>`);
    headers.set('Call-ID', this.identity.callId);
    headers.set('CSeq', `${this.identity.nextCSeq} REGISTER`);
    headers.set('Contact', contact);
    if (expires !== undefined) headers.set('Expires', String(expires));
    this.identity.nextCSeq += 1;
    return makeRequest('REGISTER', this.registrarUri, headers);
  }

  private startExchange(request: SipRequestMessage): Promise<void> {
    this.stateValue = this.stateValue === 'unregistering' ? 'unregistering' : 'registering';
    return new Promise<void>((resolve, reject) => {
      this.deferred = { resolve, reject };
      this.send(request);
    });
  }

  private send(request: SipRequestMessage): void {
    try {
      // Install the listener before sending so a response arriving synchronously
      // inside `sendRequest` (reliable transport) is still observed.
      this.attachListener(request);
      this.layer.sendRequest(request);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Install the single transaction-layer listener for one attempt. */
  private attachListener(request: SipRequestMessage): void {
    if (this.unsubscribe !== undefined) this.unsubscribe();
    this.unsubscribe = this.layer.subscribe((event: TransactionLayerEvent) => {
      switch (event.type) {
        case 'response':
          this.onResponse(request, event.response);
          break;
        case 'timeout':
        case 'transportError':
          this.fail(new SipError(0, `REGISTER ${event.type}`));
          break;
        default:
          break;
      }
    });
  }

  private onResponse(base: SipRequestMessage, response: SipResponseMessage): void {
    // Only answer responses that match this attempt's chain (same CSeq).
    if (numeric(response.headers) !== numeric(base.headers)) return;
    const code = response.statusCode;
    if (code === 401 || code === 407) {
      this.handleAuth(base, response);
    } else if (code === 423) {
      this.handleMinExpires(base, response);
    } else if (code >= 200 && code < 300) {
      this.onGranted(response);
    } else if ((code === 301 || code === 302) && this.redirectCount < MAX_REDIRECTS) {
      this.handleRedirect(base, response);
    } else if (code >= 300) {
      this.fail(new SipError(code, `REGISTER rejected with ${code}`));
    }
  }

  private handleAuth(base: SipRequestMessage, response: SipResponseMessage): void {
    if (this.authManager === undefined || this.credentials === undefined) {
      this.fail(new SipError(response.statusCode, `${response.statusCode} received but no credentials configured`));
      return;
    }
    const requestId = `${this.identity.callId}:${numeric(base.headers) ?? 0}`;
    const result = this.authManager.retry({
      requestId,
      request: base,
      response,
      credentials: this.credentials,
    });
    if (isAuthFailure(result)) {
      this.fail(result.error);
      return;
    }
    // The retry consumed one budget entry for this requestId; remember it so the
    // exchange's terminal 2xx or fail can release it via authManager.settle.
    this.activeRequestIds.add(requestId);
    // Retry is a NEW request on a NEW client transaction (new branch). Re-stamp
    // its CSeq from the single persisted counter so the wire sequence stays
    // strictly increasing on one Call-ID across every outbound REGISTER.
    result.headers.set('CSeq', `${this.identity.nextCSeq} REGISTER`);
    this.identity.nextCSeq += 1;
    this.send(result);
  }

  private handleMinExpires(base: SipRequestMessage, response: SipResponseMessage): void {
    const interval = minExpiresFor(response);
    const request = this.nextRequest(interval, base.headers.get('Contact') ?? this.contact);
    // Carry any in-progress authorization (from an earlier 401/407) forward.
    const authorization = base.headers.get('Authorization');
    const proxyAuthorization = base.headers.get('Proxy-Authorization');
    if (authorization !== undefined) request.headers.set('Authorization', authorization);
    if (proxyAuthorization !== undefined) request.headers.set('Proxy-Authorization', proxyAuthorization);
    this.send(request);
  }

  /**
   * Follow a 301/302 REGISTER redirect (RFC 3261 10.2). The retried REGISTER
   * reuses the next CSeq on the same Call-ID (so the wire sequence stays
   * strictly increasing) but targets the redirect Contact URI. 301 persists the
   * target for the UA's life; 302 is per-attempt. A redirect without a Contact
   * fails. The hop cap (`MAX_REDIRECTS`) is enforced in `onResponse`, so a
   * redirect storm falls through to the generic `>= 300` fail rather than loop.
   */
  private handleRedirect(base: SipRequestMessage, response: SipResponseMessage): void {
    const contact = extractUri(response.headers.get('Contact'));
    if (contact === undefined) {
      this.fail(new SipError(response.statusCode, 'REGISTER redirect without a Contact'));
      return;
    }
    this.redirectCount += 1;
    if (response.statusCode === 301) this.redirectTarget = contact;
    const request = this.nextRequestForTarget(contact, base);
    // Carry any in-progress authorization (from an earlier 401/407) forward.
    const authorization = base.headers.get('Authorization');
    const proxyAuthorization = base.headers.get('Proxy-Authorization');
    if (authorization !== undefined) request.headers.set('Authorization', authorization);
    if (proxyAuthorization !== undefined) request.headers.set('Proxy-Authorization', proxyAuthorization);
    this.send(request);
  }

  /**
   * Build the next REGISTER with a redirect target as the request URI. Same
   * Call-ID, next strictly-increasing CSeq, fresh branch, and the same Contact
   * header as the base request — only the request URI changes. Reuses
   * `nextRequest` for all header stamping, then spreads the result to override
   * the request URI (the field is read-only), so existing `nextRequest` callers
   * are undisturbed.
   */
  private nextRequestForTarget(target: string, base: SipRequestMessage): SipRequestMessage {
    const contact = base.headers.get('Contact') ?? this.contact;
    const expires = base.headers.get('Expires');
    const request = this.nextRequest(expires !== undefined ? Number(expires) : undefined, contact);
    // `nextRequest` stamped the registrar URI as the request URI; redirect.
    return { ...request, uri: target };
  }

  private onGranted(response: SipResponseMessage): void {
    if (this.stateValue === 'unregistering') {
      this.settle();
      this.stateValue = 'unregistered';
      return;
    }
    this.stateValue = 'registered';
    this.redirectCount = 0;
    const granted = grantedExpiry(response);
    if (granted !== undefined) this.scheduleRefresh(granted);
    this.settle();
  }

  /** Release every retry-budget entry accumulated by the active exchange. */
  private releaseAuthBudget(): void {
    if (this.activeRequestIds.size > 0 && this.authManager !== undefined) {
      for (const requestId of this.activeRequestIds) this.authManager.settle(requestId);
    }
    this.activeRequestIds.clear();
  }

  private scheduleRefresh(granted: number): void {
    this.cancelRefresh();
    this.refreshMs = this.refreshAfter(granted);
    this.refreshTimer = this.clock.setTimeout(() => {
      if (this.stateValue === 'registered') void this.register();
    }, this.refreshMs * 1000);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== -1) {
      this.clock.clearTimeout(this.refreshTimer);
      this.refreshTimer = -1;
      this.refreshMs = 0;
    }
  }

  /** Final shutdown: cancel the refresh timer and detach the exchange listener. */
  dispose(): void {
    this.teardownExchange();
    this.cancelRefresh();
  }

  private settle(): void {
    this.teardownExchange();
    this.releaseAuthBudget();
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred !== undefined) deferred.resolve();
  }

  private fail(reason: unknown): void {
    this.teardownExchange();
    this.releaseAuthBudget();
    this.cancelRefresh();
    // Always exit the exchange states: a failed unregister must not leave the
    // registrar stuck in 'unregistering' (later register/unregister calls would
    // reject with "exchange already in progress" forever). 'failed' lets the
    // UA retry with a fresh attempt.
    this.stateValue = 'failed';
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred !== undefined) deferred.reject(reason);
  }

  /** Remove the single transaction listener for the active attempt. */
  private teardownExchange(): void {
    if (this.unsubscribe !== undefined) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}

function isAuthFailure(result: SipRequestMessage | AuthFailure): result is AuthFailure {
  return (result as { type?: string }).type !== undefined;
}