import { Headers } from '../../src/messages/headers.js';
import { makeResponse } from '../../src/messages/message.js';
import { parseMessage } from '../../src/messages/parser.js';
import type { FakeTransport } from './fake-transport.js';

/**
 * Mock SIP server for integration testing.
 * Handles REGISTER, INVITE, and call flow scenarios.
 */
export class MockSipServer {
  private registerRequests: any[] = [];
  private inviteRequest: any | undefined;

  /**
   * Handle REGISTER request and send 401 challenge + 200 OK on retry.
   */
  async handleRegister(transport: FakeTransport): Promise<void> {
    // Wait for first REGISTER request
    const req1 = await this.waitForRequest(transport, 'REGISTER', 0);
    this.registerRequests.push(req1);

    // Send 401 challenge
    const challenge = this.createChallenge(req1);
    transport.emitData(this.serializeMessage(challenge));

    // Wait for authenticated REGISTER (second one)
    const req2 = await this.waitForRequest(transport, 'REGISTER', 1);
    this.registerRequests.push(req2);

    // Send 200 OK
    const ok = this.createRegisterOk(req2);
    transport.emitData(this.serializeMessage(ok));
  }

  /**
   * Send 180 Ringing response for the current INVITE.
   */
  async sendRinging(transport: FakeTransport): Promise<void> {
    const req = await this.waitForRequest(transport, 'INVITE', 0);
    this.inviteRequest = req;
    const ringing = this.createRinging(req);
    transport.emitData(this.serializeMessage(ringing));
  }

  /**
   * Send 200 OK with SDP for the current INVITE.
   */
  async send200Ok(transport: FakeTransport): Promise<void> {
    if (!this.inviteRequest) {
      this.inviteRequest = await this.waitForRequest(transport, 'INVITE', 0);
    }
    const ok = this.create200Ok(this.inviteRequest);
    transport.emitData(this.serializeMessage(ok));
  }

  /**
   * Send 200 OK for BYE request.
   */
  async sendBye200(transport: FakeTransport): Promise<void> {
    const req = await this.waitForRequest(transport, 'BYE', 0);
    const ok = this.createByeOk(req);
    transport.emitData(this.serializeMessage(ok));
  }

  private async waitForRequest(transport: FakeTransport, method: string, index: number): Promise<any> {
    while (true) {
      let found = 0;
      for (const bytes of transport.sent) {
        const parsed = parseMessage(bytes);
        if (parsed.ok && parsed.value.kind === 'request' && parsed.value.method === method) {
          if (found === index) return parsed.value;
          found++;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  }

  private echoHeaders(request: any): Headers {
    const headers = new Headers();
    headers.set('Via', request.headers.get('Via') ?? '');
    headers.set('From', request.headers.get('From') ?? '');
    headers.set('To', request.headers.get('To') ?? '');
    headers.set('Call-ID', request.headers.get('Call-ID') ?? '');
    headers.set('CSeq', request.headers.get('CSeq') ?? '');
    return headers;
  }

  private createChallenge(request: any) {
    const headers = this.echoHeaders(request);
    headers.set('WWW-Authenticate', 'Digest realm="example.com", nonce="abc123", algorithm=MD5, qop="auth"');
    return makeResponse(401, 'Unauthorized', headers);
  }

  private createRegisterOk(request: any) {
    const headers = this.echoHeaders(request);
    headers.set('To', (request.headers.get('To') ?? '') + ';tag=server-tag');
    headers.set('Contact', (request.headers.get('Contact') ?? '') + ';expires=3600');
    headers.set('Expires', '3600');
    return makeResponse(200, 'OK', headers);
  }

  private createRinging(request: any) {
    const headers = this.echoHeaders(request);
    headers.set('To', (request.headers.get('To') ?? '') + ';tag=remote-tag');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    return makeResponse(180, 'Ringing', headers);
  }

  private create200Ok(request: any) {
    const headers = this.echoHeaders(request);
    headers.set('To', (request.headers.get('To') ?? '') + ';tag=remote-tag');
    headers.set('Contact', '<sip:bob@192.0.2.2:5060>');
    headers.set('Content-Type', 'application/sdp');
    const body = new TextEncoder().encode('v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\n');
    return makeResponse(200, 'OK', headers, body);
  }

  private createByeOk(request: any) {
    const headers = this.echoHeaders(request);
    return makeResponse(200, 'OK', headers);
  }

  private serializeMessage(msg: any): Uint8Array {
    const lines: string[] = [];
    if (msg.kind === 'request') {
      lines.push(`${msg.method} ${msg.uri} SIP/2.0`);
    } else {
      lines.push(`SIP/2.0 ${msg.statusCode} ${msg.reasonPhrase}`);
    }
    for (const [name, value] of msg.headers.entries()) {
      lines.push(`${name}: ${value}`);
    }
    lines.push('');
    const headerPart = lines.join('\r\n');
    const bodyPart = msg.body ? new TextDecoder().decode(msg.body) : '';
    return new TextEncoder().encode(headerPart + '\r\n' + bodyPart);
  }
}
