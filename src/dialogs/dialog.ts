import { Headers } from '../messages/headers.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { makeRequest } from '../messages/message.js';
import {
  MAGIC_COOKIE,
  extractTag,
  isStrictRouter,
  makeBranch,
  parseRecordRoutes,
  reverseRouteSet,
} from './header-values.js';

/** Injects volatile call data (Via branches) needed by dialog builders. */
export interface IdGenerator {
  branch(): string;
}

const DEFAULT_MAX_FORWARDS = '70';

function cseqNumber(headers: Headers): number {
  const cseq = headers.get('CSeq');
  if (cseq === undefined) return 0;
  return Number.parseInt(cseq.trim().split(/\s+/)[0] ?? '', 10);
}

function makeTopVia(branch: string): string {
  return `SIP/2.0/UDP 192.0.2.1:5060;branch=${branch}`;
}

/** Extract the Contact URI from the first Contact header (RFC 3261 12.1.1). */
function contactUri(headers: Headers): string | undefined {
  const value = headers.get('Contact');
  if (value === undefined) return undefined;
  const match = value.match(/<([^>]+)>/);
  return match?.[1];
}

/**
 * Represents a SIP dialog as seen by the UAC that sent the INVITE
 * (RFC 3261 12.1.1). Owns the 2xx ACK and in-dialog request construction
 * plus local/remote CSeq state.
 */
export class Dialog {
  private readonly idGenerator: IdGenerator;
  private readonly invCSeq: number;
  private localCSeq: number;
  private remoteCSeq: number;
  private readonly requestUri: string;
  private readonly contact: string | undefined;
  private readonly routeSetValues: readonly string[];
  private readonly fromValue: string;
  private readonly toValue: string;
  private readonly callIdValue: string;
  private readonly maxForwards: string;

  private constructor(
    idGenerator: IdGenerator,
    invCSeq: number,
    requestUri: string,
    contact: string | undefined,
    routeSetValues: readonly string[],
    fromValue: string,
    toValue: string,
    callIdValue: string,
    maxForwards: string,
  ) {
    this.idGenerator = idGenerator;
    this.invCSeq = invCSeq;
    this.localCSeq = invCSeq;
    this.remoteCSeq = 0;
    this.requestUri = requestUri;
    this.contact = contact;
    this.routeSetValues = routeSetValues;
    this.fromValue = fromValue;
    this.toValue = toValue;
    this.callIdValue = callIdValue;
    this.maxForwards = maxForwards;
  }

  /**
   * Create a UAC dialog from the INVITE request and its 2xx final response
   * (RFC 3261 12.1.1). The route set is the reversed Record-Route order.
   */
  static fromUac(
    request: SipRequestMessage,
    response: SipResponseMessage,
    idGenerator: IdGenerator,
  ): Dialog {
    const recordRoutes = parseRecordRoutes(response.headers);
    const routeSet = reverseRouteSet(recordRoutes);
    return new Dialog(
      idGenerator,
      cseqNumber(request.headers),
      request.uri,
      contactUri(response.headers),
      routeSet,
      request.headers.get('From') ?? '',
      response.headers.get('To') ?? '',
      request.headers.get('Call-ID') ?? '',
      request.headers.get('Max-Forwards') ?? DEFAULT_MAX_FORWARDS,
    );
  }

  get remoteTag(): string {
    return extractTag(this.toValue) ?? '';
  }

  get localTag(): string {
    return extractTag(this.fromValue) ?? '';
  }

  /** The remote target: the Contact URI, or the request URI when absent. */
  get remoteTarget(): string {
    return this.contact ?? this.requestUri;
  }

  get routeSet(): readonly string[] {
    return this.routeSetValues;
  }

  get callId(): string {
    return this.callIdValue;
  }

  getLocalCSeq(): number {
    return this.localCSeq;
  }

  getRemoteCSeq(): number {
    return this.remoteCSeq;
  }

  /**
   * Build the 2xx ACK for this dialog (RFC 3261 13.2.2.4). Uses the INVITE
   * numeric CSeq with method ACK and a fresh Via branch; does not mutate the
   * local CSeq.
   */
  createAck(response: SipResponseMessage): SipRequestMessage {
    const headers = new Headers();
    headers.set('Via', makeTopVia(makeBranch(this.idGenerator.branch())));
    headers.set('To', response.headers.get('To') ?? this.toValue);
    headers.set('From', this.fromValue);
    headers.set('Call-ID', this.callIdValue);
    headers.set('CSeq', `${this.invCSeq} ACK`);
    headers.set('Max-Forwards', this.maxForwards);
    this.setRoute(headers);
    return makeRequest('ACK', this.requestTarget(), headers, new Uint8Array());
  }

  /**
   * Build a new in-dialog request (BYE, etc.). Increments the local CSeq
   * exactly once before constructing the request.
   */
  createRequest(method: string): SipRequestMessage {
    this.localCSeq += 1;
    const headers = new Headers();
    headers.set('Via', makeTopVia(makeBranch(this.idGenerator.branch())));
    headers.set('To', this.toValue);
    headers.set('From', this.fromValue);
    headers.set('Call-ID', this.callIdValue);
    headers.set('CSeq', `${this.localCSeq} ${method}`);
    headers.set('Max-Forwards', this.maxForwards);
    this.setRoute(headers);
    return makeRequest(method, this.requestTarget(), headers, new Uint8Array());
  }

  /**
   * Accept an in-dialog request from the remote peer. Rejects lower/equal
   * remote CSeq values except for ACK and CANCEL, then records the new value.
   */
  receiveRequest(request: SipRequestMessage): boolean {
    if (request.method === 'ACK' || request.method === 'CANCEL') return true;
    const number = cseqNumber(request.headers);
    if (number <= this.remoteCSeq) return false;
    this.remoteCSeq = number;
    return true;
  }

  /**
   * The request URI for an in-dialog request: the first route set entry when
   * the route set is non-empty, or the remote target when empty. A single
   * strict (non-loose) first route sends the request to the remote target
   * instead (RFC 3261 12.2.1.1).
   */
  private requestTarget(): string {
    if (this.routeSetValues.length === 0) return this.remoteTarget;
    const first = this.routeSetValues[0] ?? '';
    if (isStrictRouter(first)) return this.remoteTarget;
    return first;
  }

  /**
   * Populate the Route header for an in-dialog request. The first route set
   * entry becomes the request URI, so the remaining entries go in Route. A
   * strict (non-loose) first router cannot resolve the target itself, so the
   * whole route set is kept in Route with the remote target appended as the
   * last value (RFC 3261 12.2.1.1).
   */
  private setRoute(headers: Headers): void {
    if (this.routeSetValues.length === 0) return;
    const first = this.routeSetValues[0] ?? '';
    if (isStrictRouter(first)) {
      const route = [...this.routeSetValues, this.remoteTarget].join(', ');
      headers.set('Route', route);
      return;
    }
    const route = this.routeSetValues.slice(1).join(', ');
    if (route !== '') headers.set('Route', route);
  }
}

export { MAGIC_COOKIE }; // re-export for convenience alongside dialog builders
