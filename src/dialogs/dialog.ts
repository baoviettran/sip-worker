import { Headers } from '../messages/headers.js';
import type { SipRequestMessage, SipResponseMessage } from '../messages/message.js';
import { makeRequest } from '../messages/message.js';
import {
  MAGIC_COOKIE,
  extractTag,
  extractUri,
  isStrictRouter,
  makeBranch,
  makeTopVia,
  parseRecordRoutes,
  reverseRouteSet,
  type ViaConfig,
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

function routeNameAddr(uri: string): string {
  return `<${uri}>`;
}

/** Extract the Contact URI from the first Contact header (RFC 3261 12.1.1). */
function contactUri(headers: Headers): string | undefined {
  return extractUri(headers.get('Contact'));
}

function dialogId(callId: string, localTag: string, remoteTag: string): string {
  return JSON.stringify([callId, localTag, remoteTag]);
}

/** Canonical dialog identity for an incoming in-dialog request. */
export function requestDialogId(request: SipRequestMessage): string | undefined {
  const callId = request.headers.get('Call-ID');
  const localTag = extractTag(request.headers.get('To'));
  const remoteTag = extractTag(request.headers.get('From'));
  if (callId === undefined || callId === '' || localTag === undefined || remoteTag === undefined) return undefined;
  return dialogId(callId, localTag, remoteTag);
}

/**
 * Represents a SIP dialog as seen by the UAC that sent the INVITE
 * (RFC 3261 12.1.1). Owns the 2xx ACK and in-dialog request construction
 * plus local/remote CSeq state.
 */
export class Dialog {
  private readonly idGenerator: IdGenerator;
  private readonly viaConfig: ViaConfig;
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
    viaConfig: ViaConfig,
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
    this.viaConfig = viaConfig;
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
    viaConfig: ViaConfig,
  ): Dialog {
    const recordRoutes = parseRecordRoutes(response.headers);
    const routeSet = reverseRouteSet(recordRoutes);
    return new Dialog(
      idGenerator,
      viaConfig,
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

  /**
   * Create a UAS dialog from the incoming INVITE request and the 2xx response
   * (RFC 3261 12.1.1). The route set is the Record-Route wire order (not
   * reversed). The local target is the Contact URI from the request.
   */
  static fromUas(
    request: SipRequestMessage,
    response: SipResponseMessage,
    idGenerator: IdGenerator,
    viaConfig: ViaConfig,
  ): Dialog {
    const recordRoutes = parseRecordRoutes(request.headers);
    // UAS: local=To (response), remote=From (request)
    const dialog = new Dialog(
      idGenerator,
      viaConfig,
      cseqNumber(request.headers),
      contactUri(request.headers) ?? request.uri,
      contactUri(request.headers),
      recordRoutes,
      response.headers.get('To') ?? '',  // fromValue=local=To
      request.headers.get('From') ?? '', // toValue=remote=From
      request.headers.get('Call-ID') ?? '',
      request.headers.get('Max-Forwards') ?? DEFAULT_MAX_FORWARDS,
    );
    dialog.remoteCSeq = cseqNumber(request.headers);
    return dialog;
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

  get id(): string {
    return dialogId(this.callIdValue, this.localTag, this.remoteTag);
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
    headers.set('Via', makeTopVia(this.viaConfig, makeBranch(this.idGenerator.branch())));
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
    headers.set('Via', makeTopVia(this.viaConfig, makeBranch(this.idGenerator.branch())));
    headers.set('To', this.toValue);
    headers.set('From', this.fromValue);
    headers.set('Call-ID', this.callIdValue);
    headers.set('CSeq', `${this.localCSeq} ${method}`);
    headers.set('Max-Forwards', this.maxForwards);
    this.setRoute(headers);
    return makeRequest(method, this.requestTarget(), headers, new Uint8Array());
  }

  /** Validate dialog identity, request method, and a syntactically valid CSeq. */
  matchesRequest(request: SipRequestMessage): boolean {
    const cseq = request.headers.get('CSeq')?.trim().match(/^(\d+)\s+(\S+)$/);
    return requestDialogId(request) === this.id
      && cseq !== undefined
      && cseq !== null
      && cseq[2] === request.method
      && (request.method !== 'ACK' || Number.parseInt(cseq[1]!, 10) === this.invCSeq);
  }

  /** Accept an already identity-validated in-dialog request by remote CSeq. */
  receiveRequest(request: SipRequestMessage): boolean {
    if (request.method === 'ACK' || request.method === 'CANCEL') return true;
    const number = cseqNumber(request.headers);
    if (number <= this.remoteCSeq) return false;
    this.remoteCSeq = number;
    return true;
  }

  /**
   * The request URI for an in-dialog request. Loose routing uses the remote
   * target; strict routing uses the first route set entry (RFC 3261
   * 12.2.1.1). An empty route set also uses the remote target.
   */
  private requestTarget(): string {
    if (this.routeSetValues.length === 0) return this.remoteTarget;
    const first = this.routeSetValues[0] ?? '';
    if (isStrictRouter(first)) return first;
    return this.remoteTarget;
  }

  /**
   * Populate the Route header for an in-dialog request. Loose routing uses
   * the complete route set. Strict routing uses the remaining routes followed
   * by the remote target (RFC 3261 12.2.1.1).
   */
  private setRoute(headers: Headers): void {
    if (this.routeSetValues.length === 0) return;
    const first = this.routeSetValues[0] ?? '';
    if (isStrictRouter(first)) {
      const route = [...this.routeSetValues.slice(1), this.remoteTarget]
        .map(routeNameAddr)
        .join(', ');
      headers.set('Route', route);
      return;
    }
    headers.set('Route', this.routeSetValues.map(routeNameAddr).join(', '));
  }
}

export { MAGIC_COOKIE }; // re-export for convenience alongside dialog builders
