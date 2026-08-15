// Minimal RFC 6455 WebSocket server for the packed softphone gate (Task 15).
//
// No `ws` npm package is available in this sandbox and the example fixture must
// stay dependency-free, so this module implements the handshake, frame
// parsing/encoding, ping/pong, and close handling directly on top of a Node
// `net.Socket`. Server-to-client frames are unmasked; client-to-server frames
// (the browser always masks) are unmasked after length/mask decoding. The
// `/sip` endpoint negotiates the `sip` subprotocol the library's
// `BrowserWebSocketTransport` requires; the `/relay` endpoint negotiates none.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Perform the 101 switching-protocols handshake and return a connected
 * {@link WebSocketConnection}. `onOpen(ws)` is called before any buffered `head`
 * bytes are fed, so message listeners registered there see the first frames.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ subprotocol?: string, onOpen?: (ws: WebSocketConnection) => void }} opts
 * @returns {WebSocketConnection | undefined}
 */
export function handleUpgrade(req, socket, head, opts) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key === '') {
    socket.destroy();
    return undefined;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const requested = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const chosen = opts.subprotocol !== undefined && requested.includes(opts.subprotocol)
    ? opts.subprotocol
    : undefined;

  let response = 'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`;
  if (chosen !== undefined) response += `Sec-WebSocket-Protocol: ${chosen}\r\n`;
  response += '\r\n';
  socket.write(response);

  const ws = new WebSocketConnection(socket);
  if (chosen !== undefined) ws.protocol = chosen;
  opts.onOpen?.(ws);
  if (head !== undefined && head.length > 0) ws._feed(head);
  return ws;
}

/** One connected WebSocket peer over a raw TCP socket. */
export class WebSocketConnection {
  /** @param {import('node:net').Socket} socket */
  constructor(socket) {
    this.socket = socket;
    /** Negotiated subprotocol ('' when none). */
    this.protocol = '';
    /** 1 = open, 3 = closed (subset of the browser readyState contract). */
    this.readyState = 1;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.errorListeners = new Set();
    socket.on('data', (data) => this._feed(data));
    socket.on('close', () => this._emitClose(1006, ''));
    socket.on('error', () => {});
  }

  onMessage(fn) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /** Send a text frame (SIP responses and relay JSON both ride text frames). */
  sendText(text) {
    if (this.readyState !== 1) return;
    try {
      this.socket.write(encodeFrame(Buffer.from(text, 'utf8'), 0x1));
    } catch {
      // best-effort; a dead socket surfaces via its own close event
    }
  }

  /** Graceful close: send a close frame then end the TCP socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    try {
      this.socket.end(encodeFrame(encodeClosePayload(code, reason), 0x8));
    } catch {
      // fall through to close listeners regardless
    }
    this._emitClose(code, reason);
  }

  /** Abrupt close (the recovery drop): destroy the TCP socket, no close frame. */
  destroy(code = 1006) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    try {
      this.socket.destroy();
    } catch {
      // already destroyed
    }
    this._emitClose(code, '');
  }

  /** Internal: feed bytes, decode frames, dispatch. */
  _feed(data) {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (frame === undefined) break;
      this.buffer = this.buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) {
        this.closed = true;
        this.readyState = 3;
        try {
          this.socket.end(encodeFrame(encodeClosePayload(frame.code ?? 1000, ''), 0x8));
        } catch {
          // peer already gone
        }
        this._emitClose(frame.code ?? 1000, '');
        return;
      }
      if (frame.opcode === 0x9) { // ping -> pong
        try {
          this.socket.write(encodeFrame(frame.payload, 0xA));
        } catch {
          // best-effort
        }
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) { // text / binary
        const text = frame.payload.toString('utf8');
        for (const fn of [...this.messageListeners]) {
          try {
            fn(text, frame.payload);
          } catch {
            // a listener must never break the receive loop
          }
        }
      }
    }
  }

  _emitClose(code, reason) {
    for (const fn of [...this.closeListeners]) {
      try {
        fn({ code, reason });
      } catch {
        // best-effort
      }
    }
  }
}

/** Decode one client frame from the front of `buf`, or undefined when partial. */
function decodeFrame(buf) {
  if (buf.length < 2) return undefined;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return undefined;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return undefined;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
    len = Number(big);
    offset += 8;
  }
  let maskKey;
  if (masked) {
    if (buf.length < offset + 4) return undefined;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return undefined;
  let payload = buf.subarray(offset, offset + len);
  if (masked && maskKey !== undefined) {
    const unmasked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) unmasked[i] = payload[i] ^ maskKey[i & 3];
    payload = unmasked;
  }
  return {
    opcode,
    payload,
    consumed: offset + len,
    code: opcode === 0x8 && payload.length >= 2 ? payload.readUInt16BE(0) : undefined,
  };
}

/** Encode a server frame (unmasked) with the given opcode. */
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** Payload of a close frame: 2-byte status code + UTF-8 reason. */
function encodeClosePayload(code, reason) {
  const reasonBuf = Buffer.from(String(reason ?? ''), 'utf8');
  const out = Buffer.alloc(2 + reasonBuf.length);
  out.writeUInt16BE(Number(code ?? 1000), 0);
  reasonBuf.copy(out, 2);
  return out;
}
