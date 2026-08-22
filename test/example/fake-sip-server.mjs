// Fake SIP registrar/UAS/UAC + WebRTC media relay for the packed softphone gate
// (Task 15).
//
// The example must exercise the REAL packed library end-to-end, so this server
// speaks enough SIP to drive every scenario in `softphone.spec.ts`:
//
//   - REGISTER        -> 200 OK (with the response To-tag the library requires)
//   - INVITE          -> forwarded to the in-page relay peer for a real SDP
//                        answer; scriptable failure status and INVITE delay
//   - re-INVITE       -> ICE-restart answer through the relay (recovery)
//   - OPTIONS         -> 200 OK (recovery fast path)
//   - ACK / CANCEL    -> transaction reconciliation (487 on cancelled INVITE)
//   - BYE             -> 200 OK, dialog torn down
//
// The relay protocol (JSON text frames over a WS at `/relay`) bridges SDP to a
// `SyntheticPeer` running in the page, so mute / hold / DTMF operate on REAL
// WebRTC media between the library's PC and the page's peer.
//
// This module is deliberately self-contained (string-based SIP, no
// `@sip-worker/core` import) so it never depends on built `dist` — the example
// must exercise only the packed artifact, and the server itself is not part of
// that artifact.
//
// Control plane (HTTP, `/control/*`):
//   GET  /control/status           -> { relayConnected }
//   POST /control/reset            -> clear dialogs/scripts (per-test isolation)
//   POST /control/incoming-call    -> server-originated INVITE (caller role)
//   POST /control/remote-bye       -> BYE on the established dialog
//   POST /control/next-invite-status {status} -> INVITE fails with that status
//   POST /control/delay-invite-ms  {ms}       -> hold INVITE for N ms (CANCEL)
//   POST /control/drop-socket      -> abrupt WSS destroy (recovery 1006)

import { handleUpgrade } from './websocket-server.mjs';

const HOST = '127.0.0.1';
const PORT = 4200;

/** A SipFakeServer is created per `build-softphone.mjs` run and attached to the
 * single HTTP server that also serves the built example artifacts. */
export class SipFakeServer {
  constructor({ aor = 'sip:alice@example.com' } = {}) {
    this.aor = aor;
    this.sipSocket = null;
    this.relay = null;
    this.relayConnected = false;
    this.dialogs = new Map();
    this.pendingInvites = new Map();
    this.nextInviteStatus = null;
    this.delayInviteMs = 0;
    this.seq = 0;
    this.relaySeq = 0;
    this.relayPending = new Map();
  }

  /** Route a WebSocket upgrade (the HTTP server's `upgrade` event). */
  handleUpgrade(req, socket, head) {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/sip') {
      handleUpgrade(req, socket, head, {
        subprotocol: 'sip',
        onOpen: (ws) => this._onSipOpen(ws),
      });
      return;
    }
    if (path === '/relay') {
      handleUpgrade(req, socket, head, {
        onOpen: (ws) => this._onRelayOpen(ws),
      });
      return;
    }
    socket.destroy();
  }

  /** Handle `/control/*` HTTP routes. */
  async handleControl(req, res) {
    const url = new URL(req.url ?? '', `http://${HOST}:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const send = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    if (method === 'GET' && path === '/control/status') {
      send(200, { relayConnected: this.relayConnected });
      return;
    }

    if (method === 'POST' && path === '/control/reset') {
      this.reset();
      send(200, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/control/incoming-call') {
      try {
        await this._incomingCall();
        send(200, { ok: true });
      } catch (err) {
        send(503, { ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

    if (method === 'POST' && path === '/control/remote-bye') {
      const result = this._remoteBye();
      send(result.ok ? 200 : 404, result);
      return;
    }

    if (method === 'POST' && path === '/control/next-invite-status') {
      const data = await this._readJson(req);
      this.nextInviteStatus = { status: Number(data?.status ?? 486) };
      send(200, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/control/delay-invite-ms') {
      const data = await this._readJson(req);
      this.delayInviteMs = Number(data?.ms ?? 0);
      send(200, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/control/drop-socket') {
      if (this.sipSocket) this.sipSocket.destroy();
      send(200, { ok: true });
      return;
    }

    send(404, { ok: false, error: `unknown control endpoint ${method} ${path}` });
  }

  reset() {
    for (const pending of this.pendingInvites.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingInvites.clear();
    this.dialogs.clear();
    this.nextInviteStatus = null;
    this.delayInviteMs = 0;
  }

  // -- SIP socket -----------------------------------------------------------

  _onSipOpen(ws) {
    this.sipSocket = ws;
    ws.onMessage((text) => this._onSipText(ws, text));
    ws.onClose(() => {
      if (this.sipSocket === ws) this.sipSocket = null;
    });
  }

  _onSipText(socket, text) {
    let msg;
    try {
      msg = parseMessage(text);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.isRequest) this._onRequest(socket, msg);
    else this._onResponse(msg);
  }

  _onRequest(socket, msg) {
    switch (msg.method) {
      case 'REGISTER': return this._onRegister(socket, msg);
      case 'INVITE': return this._onInvite(socket, msg).catch(() => this._respond(socket, msg, 500, 'Server Internal Error'));
      case 'ACK': return this._onAck(msg);
      case 'CANCEL': return this._onCancel(socket, msg);
      case 'BYE': return this._onBye(socket, msg);
      case 'OPTIONS': return this._onOptions(socket, msg);
      default: this._respond(socket, msg, 200, 'OK');
    }
  }

  _onRegister(socket, msg) {
    const contact = msg.header('contact') || `<${this.aor}>`;
    this._respond(socket, msg, 200, 'OK', { contact, toTag: 'reg-tag' });
  }

  async _onInvite(socket, msg) {
    const callId = msg.header('call-id');
    const existing = this.dialogs.get(callId);

    if (existing && existing.acked) {
      // re-INVITE (recovery ICE restart) inside an established dialog.
      try {
        const answerSdp = await this._relayAnswer(msg.body);
        this._respond(socket, msg, 200, 'OK', {
          contentType: 'application/sdp',
          body: answerSdp,
          contact: `<${existing.remoteUri}>`,
        });
      } catch (err) {
        this._respond(socket, msg, 500, 'Server Internal Error');
      }
      return;
    }

    if (this.nextInviteStatus) {
      const { status } = this.nextInviteStatus;
      this.nextInviteStatus = null;
      this._respond(socket, msg, status, reasonPhrase(status));
      return;
    }

    if (this.delayInviteMs > 0) {
      const ms = this.delayInviteMs;
      this.delayInviteMs = 0;
      const timer = setTimeout(() => {
        if (!this.pendingInvites.has(callId)) return;
        this.pendingInvites.delete(callId);
        this._completeOutgoingInvite(socket, msg).catch(() => {});
      }, ms);
      this.pendingInvites.set(callId, { socket, msg, timer });
      return;
    }

    await this._completeOutgoingInvite(socket, msg);
  }

  async _completeOutgoingInvite(socket, msg) {
    const callId = msg.header('call-id');
    const from = parseNameAddr(msg.header('from'));
    const to = parseNameAddr(msg.header('to'));
    const cseqNum = Number((msg.header('cseq') ?? '1 INVITE').split(' ')[0]) || 1;
    try {
      const answerSdp = await this._relayAnswer(msg.body);
      this.dialogs.set(callId, {
        direction: 'outgoing',
        callId,
        phoneUri: from.uri,
        phoneTag: from.tag,
        remoteUri: to.uri,
        remoteTag: 'server-tag',
        acked: true,
        cseq: cseqNum,
      });
      this._respond(socket, msg, 200, 'OK', {
        contentType: 'application/sdp',
        body: answerSdp,
        contact: `<${to.uri}>`,
        toTag: 'server-tag',
      });
    } catch (err) {
      this._respond(socket, msg, 500, 'Server Internal Error');
    }
  }

  _onAck(msg) {
    const dialog = this.dialogs.get(msg.header('call-id'));
    if (dialog) dialog.acked = true;
  }

  _onCancel(socket, msg) {
    this._respond(socket, msg, 200, 'OK');
    const pending = this.pendingInvites.get(msg.header('call-id'));
    if (pending) {
      this.pendingInvites.delete(pending.callId);
      if (pending.timer) clearTimeout(pending.timer);
      // Reconcile the pending INVITE transaction with a 487 so the phone's
      // transaction layer settles cleanly.
      this._respond(socket, pending.msg, 487, 'Request Terminated');
    }
  }

  _onBye(socket, msg) {
    this._respond(socket, msg, 200, 'OK');
    const dialog = this.dialogs.get(msg.header('call-id'));
    if (dialog) {
      dialog.ended = true;
      this.dialogs.delete(dialog.callId);
    }
  }

  _onOptions(socket, msg) {
    this._respond(socket, msg, 200, 'OK');
  }

  _onResponse(msg) {
    const callId = msg.header('call-id');
    const dialog = this.dialogs.get(callId);
    if (!dialog) return;
    const cseqMethod = (msg.header('cseq') ?? '').split(' ')[1];

    if (dialog.direction === 'incoming') {
      if (msg.statusCode === 200 && cseqMethod === 'INVITE') {
        const to = parseNameAddr(msg.header('to'));
        dialog.phoneTag = to.tag;
        dialog.acked = true;
        if (msg.body) {
          this._askRelay({ type: 'remote-answer', sdp: msg.body }).catch(() => {});
        }
        this.sipSocket?.sendText(this._ackRequest(dialog));
      } else if (msg.statusCode >= 300 && cseqMethod === 'INVITE') {
        this.sipSocket?.sendText(this._ackRequest(dialog));
        this.dialogs.delete(callId);
      } else if (msg.statusCode === 200 && cseqMethod === 'BYE') {
        this.dialogs.delete(callId);
      }
      return;
    }

    if (msg.statusCode === 200 && cseqMethod === 'BYE') {
      dialog.ended = true;
      this.dialogs.delete(callId);
    }
  }

  // -- Outgoing (server-originated) requests --------------------------------

  async _incomingCall() {
    if (!this.relay) throw new Error('relay not connected');
    const offered = await this._askRelay({ type: 'create-offer' });
    if (offered.type !== 'offer' || !offered.sdp) throw new Error('relay did not produce an offer');
    if (!this.sipSocket) throw new Error('phone not connected');

    const callId = `incoming-${Date.now()}-${this.seq++}`;
    const phoneUri = this.aor;
    const remoteUri = 'sip:caller@example.com';
    const remoteTag = `caller-${this.seq++}`;
    this.sipSocket.sendText(buildRequest({
      method: 'INVITE',
      uri: phoneUri,
      branch: this._branch(),
      from: remoteUri,
      fromTag: remoteTag,
      to: phoneUri,
      callId,
      cseqNum: 1,
      cseqMethod: 'INVITE',
      contact: remoteUri,
      contentType: 'application/sdp',
      body: offered.sdp,
    }));
    this.dialogs.set(callId, {
      direction: 'incoming',
      callId,
      phoneUri,
      phoneTag: undefined,
      remoteUri,
      remoteTag,
      acked: false,
      cseq: 1,
    });
  }

  _remoteBye() {
    const dialog = [...this.dialogs.values()].find((d) => !d.ended && d.phoneTag);
    if (!dialog) return { ok: false, error: 'no established dialog' };
    dialog.ended = true;
    this.sipSocket?.sendText(buildRequest({
      method: 'BYE',
      uri: dialog.phoneUri,
      branch: this._branch(),
      from: dialog.remoteUri,
      fromTag: dialog.remoteTag,
      to: dialog.phoneUri,
      toTag: dialog.phoneTag,
      callId: dialog.callId,
      cseqNum: dialog.cseq + 1,
      cseqMethod: 'BYE',
    }));
    this.dialogs.delete(dialog.callId);
    return { ok: true };
  }

  _ackRequest(dialog) {
    return buildRequest({
      method: 'ACK',
      uri: dialog.phoneUri,
      branch: this._branch(),
      from: dialog.remoteUri,
      fromTag: dialog.remoteTag,
      to: dialog.phoneUri,
      toTag: dialog.phoneTag,
      callId: dialog.callId,
      cseqNum: dialog.cseq,
      cseqMethod: 'ACK',
    });
  }

  _branch() {
    return `z9hG4bK-fake-${this.seq++}`;
  }

  // -- Relay ----------------------------------------------------------------

  _onRelayOpen(ws) {
    this.relay = ws;
    this.relayConnected = true;
    ws.onMessage((text) => {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      const pending = this.relayPending.get(data.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.relayPending.delete(data.id);
        pending.resolve(data);
      }
    });
    ws.onClose(() => {
      if (this.relay === ws) {
        this.relay = null;
        this.relayConnected = false;
      }
    });
  }

  _askRelay(payload) {
    return new Promise((resolve, reject) => {
      if (!this.relay) {
        reject(new Error('relay not connected'));
        return;
      }
      const id = `r${this.relaySeq++}`;
      const timer = setTimeout(() => {
        this.relayPending.delete(id);
        reject(new Error('relay response timed out'));
      }, 15_000);
      this.relayPending.set(id, { resolve, reject, timer });
      this.relay.sendText(JSON.stringify({ ...payload, id }));
    });
  }

  async _relayAnswer(sdp) {
    const res = await this._askRelay({ type: 'offer', sdp });
    if (res.type !== 'answer' || !res.sdp) throw new Error('relay did not produce an answer');
    return res.sdp;
  }

  // -- Response plumbing ----------------------------------------------------

  _respond(socket, msg, statusCode, reason, extras = {}) {
    const toRaw = extras.to ?? msg.header('to');
    const to = hasTag(toRaw)
      ? toRaw
      : addTag(toRaw, extras.toTag ?? 'server-tag');
    socket.sendText(buildResponse({
      statusCode,
      reason,
      viaValues: msg.viaValues,
      from: msg.header('from'),
      to,
      callId: msg.header('call-id'),
      cseqNum: (msg.header('cseq') ?? '1').split(' ')[0],
      cseqMethod: (msg.header('cseq') ?? '1').split(' ')[1],
      contact: extras.contact,
      contentType: extras.contentType,
      body: extras.body ?? '',
    }));
  }

  _readJson(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        if (!data) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }
}

// -- SIP message model -------------------------------------------------------

/**
 * Parse a SIP message. Returns `{ isRequest, method, uri, statusCode, reason,
 * headers (Map lower -> string), viaValues (string[]), body }`.
 */
export function parseMessage(text) {
  if (typeof text !== 'string' || text === '') return null;
  const lines = text.split('\r\n');
  const startLine = lines[0] ?? '';
  const headers = new Map();
  const viaValues = [];
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') {
      i += 1;
      break;
    }
    if (/^[ \t]/.test(line)) {
      const last = [...headers.keys()].pop();
      if (last) headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const lower = name.toLowerCase();
    if (lower === 'via') {
      viaValues.push(value);
      continue;
    }
    if (headers.has(lower)) {
      headers.set(lower, `${headers.get(lower)}, ${value}`);
    } else {
      headers.set(lower, value);
    }
  }
  const body = lines.slice(i).join('\r\n');

  if (startLine.startsWith('SIP/2.0 ')) {
    const [, statusCode, reason = ''] = startLine.split(/^SIP\/2\.0\s+(\d{3})\s?(.*)$/);
    return {
      isRequest: false,
      statusCode: Number(statusCode),
      reason: reason.trim(),
      header: (name) => headers.get(name.toLowerCase()),
      headers,
      viaValues,
      body,
    };
  }

  const match = startLine.match(/^(\S+)\s+(\S+)\s+SIP\/2\.0$/);
  if (!match) return null;
  return {
    isRequest: true,
    method: match[1],
    uri: match[2],
    header: (name) => headers.get(name.toLowerCase()),
    headers,
    viaValues,
    body,
  };
}

/** Build a SIP request (server-originated: incoming INVITE, BYE, ACK). */
export function buildRequest({
  method, uri, branch, from, fromTag, to, toTag, callId, cseqNum, cseqMethod,
  contact, contentType, body,
}) {
  let msg = `${method} ${uri} SIP/2.0\r\n`;
  msg += `Via: SIP/2.0/WS ${HOST}:${PORT};branch=${branch}\r\n`;
  msg += 'Max-Forwards: 70\r\n';
  msg += `From: <${from}>;tag=${fromTag}\r\n`;
  msg += toTag ? `To: <${to}>;tag=${toTag}\r\n` : `To: <${to}>\r\n`;
  msg += `Call-ID: ${callId}\r\n`;
  msg += `CSeq: ${cseqNum} ${cseqMethod}\r\n`;
  if (contact) msg += `Contact: <${contact}>\r\n`;
  if (contentType) msg += `Content-Type: ${contentType}\r\n`;
  msg += `Content-Length: ${Buffer.byteLength(body ?? '')}\r\n\r\n`;
  msg += body ?? '';
  return msg;
}

/** Build a SIP response to a parsed request. */
export function buildResponse({
  statusCode, reason, viaValues, from, to, callId, cseqNum, cseqMethod,
  contact, contentType, body,
}) {
  let msg = `SIP/2.0 ${statusCode} ${reason}\r\n`;
  for (const v of viaValues) msg += `Via: ${v}\r\n`;
  msg += `From: ${from}\r\n`;
  msg += `To: ${to}\r\n`;
  msg += `Call-ID: ${callId}\r\n`;
  msg += `CSeq: ${cseqNum} ${cseqMethod}\r\n`;
  if (contact) msg += `Contact: ${contact}\r\n`;
  if (contentType) msg += `Content-Type: ${contentType}\r\n`;
  msg += `Content-Length: ${Buffer.byteLength(body ?? '')}\r\n\r\n`;
  msg += body ?? '';
  return msg;
}

// -- Header helpers ----------------------------------------------------------

/** `Display Name <sip:uri;params>;tag=x` -> `{ uri, tag, display }`. */
export function parseNameAddr(value) {
  const tagMatch = value.match(/;tag=([^;>,\s]+)/);
  const tag = tagMatch ? tagMatch[1] : undefined;
  const angle = value.match(/<([^>]+)>/);
  const uri = angle ? angle[1] : value.split(';')[0].trim();
  const display = value.includes('<') ? value.slice(0, value.indexOf('<')).trim() : undefined;
  return { uri, tag, display };
}

/** True when a header value already carries a tag parameter. */
export function hasTag(value) {
  return /;tag=[^;>,\s]+/.test(value);
}

/** Append `;tag=<tag>` to a name-addr header, keeping any trailing params. */
export function addTag(value, tag) {
  const angle = value.match(/^(.*<[^>]+>)(.*)$/);
  if (angle) return `${angle[1]};tag=${tag}${angle[2]}`;
  const core = value.split(';')[0].trim();
  const rest = value.slice(core.length);
  return `${core};tag=${tag}${rest}`;
}

const REASON = {
  200: 'OK', 404: 'Not Found', 480: 'Temporarily Unavailable', 486: 'Busy Here',
  487: 'Request Terminated', 500: 'Server Internal Error', 603: 'Decline',
};

function reasonPhrase(status) {
  return REASON[status] ?? 'Failure';
}
