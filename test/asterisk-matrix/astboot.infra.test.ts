// test/asterisk-matrix/astboot.infra.test.ts
// Boot gate for the Asterisk matrix — retires the spec's first risk: the pinned
// image must serve a browser WebRTC call at all. Every assertion below is a
// hard failure; none of them skips.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { startAsterisk, stopAsterisk, astExec, amiFor, type AstHandle } from './astctl';
import { AST_IMAGE, RECORDINGS_MOUNT } from './conf';

const confDir = fileURLToPath(new URL('./ast-conf', import.meta.url));

/**
 * The modules the matrix provably depends on, each mapped to why. An allowlist
 * rather than a clean-log check: the image ships format_ogg_vorbis.so with a
 * missing shared library, so "no errors in the log" would fail forever and
 * invite someone to weaken the gate instead of fixing it.
 */
const REQUIRED_MODULES = [
  'chan_pjsip',                        // the PJSIP channel driver itself
  'res_pjsip',                         // the PJSIP stack
  'res_pjsip_transport_websocket',     // SIP over WebSocket — the browser's transport
  'res_http_websocket',                // the WebSocket upgrade res_pjsip rides on
  'res_pjsip_session',                 // SDP offer/answer
  'res_pjsip_sdp_rtp',                 // DTLS-SRTP over RTP
  'res_pjsip_registrar',               // REGISTER handling
  'res_pjsip_authenticator_digest',    // the digest challenge the register step asserts
  'res_pjsip_endpoint_identifier_user',// endpoint lookup by the From user
  'res_rtp_asterisk',                  // the RTP stack
  'res_srtp',                          // SRTP encryption
  'app_echo',                          // dialplan 600
  'app_mixmonitor',                    // the recording the audio proof reads
  'format_wav',                        // PCM16 WAV — what rms.ts parses
];

let h: AstHandle;

beforeAll(async () => {
  h = await startAsterisk(confDir);
}, 120_000);

afterAll(async () => {
  if (h) await stopAsterisk(h);
});

describe('Asterisk boot gate', () => {
  it('runs the image the pinned digest resolves to', () => {
    // Two different facts about the container, both of which must hold.
    //
    //  - The RESOLVED identity. Comparing `{{.Config.Image}}` (the reference
    //    astctl handed to `docker run`) with AST_IMAGE on its own never asked
    //    what the engine actually ran; it reports the run site's own input back.
    //    The container's image id against the id AST_IMAGE resolves to in the
    //    local store fails for a container running any other image.
    const runningId = execFileSync('docker', ['inspect', '-f', '{{.Image}}', h.name], { encoding: 'utf8' }).trim();
    const pinnedId = execFileSync('docker', ['image', 'inspect', '-f', '{{.Id}}', AST_IMAGE], { encoding: 'utf8' }).trim();
    // An empty or malformed read must not let the comparison below pass by
    // accident: two empty strings are equal.
    expect(runningId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runningId, `container runs ${runningId}; the pinned digest resolves to ${pinnedId}`).toBe(pinnedId);

    //  - The REFERENCE FORM. The resolved-id comparison alone cannot catch a run
    //    site edited back to a floating tag: this image's floating tag points at
    //    the same id the digest does, so the ids would still match. This half
    //    fails the moment the reference handed to `docker run` is not the pin.
    const reference = execFileSync('docker', ['inspect', '-f', '{{.Config.Image}}', h.name], { encoding: 'utf8' }).trim();
    expect(reference).toBe(AST_IMAGE);
  });

  it('reports the certified 20.7 version', () => {
    expect(astExec(h, 'core show version')).toContain('certified-20.7');
  });

  it('loads every module the matrix depends on, and not the broken one', () => {
    const loaded = astExec(h, 'module show');
    // `module show` prints "module.so  Description  Use Count  Status".
    const names = new Set(loaded.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
    const missing = REQUIRED_MODULES.filter((m) => !names.has(`${m}.so`));
    expect(missing, `modules missing from the image: ${missing.join(', ')}`).toEqual([]);
    expect(names.has('format_ogg_vorbis.so'), 'noload= in modules.conf did not take effect').toBe(false);
  });

  it('has no loader ERROR lines in the container log', () => {
    const logs = execFileSync('docker', ['logs', h.name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const errors = logs.split('\n').filter((l) => /\bERROR\b/.test(l));
    expect(errors, `Asterisk logged errors:\n${errors.join('\n')}`).toEqual([]);
  });

  it('bound the WSS transport on loopback at the rendered port', () => {
    const transports = astExec(h, 'pjsip show transports');
    expect(transports).toContain('transport-wss');
    expect(transports).toContain(`127.0.0.1:${h.wssPort}`);
  });

  it('loaded endpoint 1000 with the applied endpoint settings', () => {
    const endpoint = astExec(h, 'pjsip show endpoint 1000');
    expect(endpoint).toContain('Endpoint:  1000');
    expect(endpoint).not.toContain('Unable to find');
    expect(endpoint).toMatch(/media_encryption\s*:\s*dtls/);
    // Asterisk prints the resolved codec set parenthesised: `allow : (ulaw)`.
    expect(endpoint).toMatch(/allow\s*:\s*\(ulaw\)/);
  });

  it('mounted the committed rtp.conf with the distinct matrix range', () => {
    const rtp = execFileSync('docker', ['exec', h.name, 'cat', '/etc/asterisk/rtp.conf'], { encoding: 'utf8' });
    expect(rtp).toContain('rtpstart=20102');
    expect(rtp).toContain('rtpend=20202');
  });

  it('rendered a key the container uid can read, and a log sink it can write', () => {
    // The rendered tree is mounted over the WHOLE /etc/asterisk, so it shadows
    // the image's own sample config set. Two properties matter, and neither is
    // implied by "Asterisk answered a command":
    //  - the DTLS/WSS key must be readable by the container's asterisk uid. A
    //    0600 host-owned file is not readable from inside, which is exactly the
    //    failure the plan's Conflict 2 ruling exists to prevent — and it
    //    surfaces downstream as an opaque DTLS handshake failure, not as a boot
    //    error. `test -r` is evaluated inside the container by the uid Asterisk
    //    actually runs as, so it answers the question the host's `stat` cannot.
    //  - the log sink must exist and be non-empty, because the AMI transcript
    //    and the post-mortem log copy are built from it. A mount that starves
    //    the logger would otherwise be invisible until an artifact upload came
    //    back empty.
    // `-u asterisk`, and not a bare exec: the image sets no Config.User, so
    // `docker exec` runs as ROOT and `test -r` would pass on any mode at all —
    // a check that cannot fail is the no-op this assertion exists to avoid.
    // The daemon is launched `-U asterisk`, so the asterisk user is the uid that
    // must read this key for DTLS to work; this asks the question as that uid.
    expect(() => execFileSync('docker', ['exec', '-u', 'asterisk', h.name, 'test', '-r', '/etc/asterisk/matrix/key.pem'], { stdio: 'pipe' }))
      .not.toThrow();
    // The sink is /var/log/asterisk/messages, NOT messages.log: Asterisk writes
    // the [logfiles] key of ast-conf/logger.conf literally, with no extension
    // appended. Asserting on a `messages.log` that does not exist fails the same
    // way a starved logger would, so the path has to be the real one.
    const logSize = execFileSync('docker', ['exec', h.name, 'stat', '-c', '%s', '/var/log/asterisk/messages'], { encoding: 'utf8' });
    expect(Number(logSize.trim())).toBeGreaterThan(0);
  });

  it('answers AMI on the rendered port with the matrix credential', async () => {
    const ami = await amiFor(h);
    try {
      const res = await ami.action({ Action: 'Ping' });
      expect(res.Response).toBe('Success');
      expect(res.Ping).toBe('Pong');
    } finally {
      ami.close();
    }
  });

  it('upgrades a TLS WebSocket with the sip subprotocol', async () => {
    const result = await websocketUpgrade(h.wssPort);
    expect(result.statusLine).toContain('101');
    expect(result.subprotocol).toBe('sip');
  }, 20_000);

  it('creates the recordings mount', () => {
    expect(execFileSync('docker', ['exec', h.name, 'test', '-w', RECORDINGS_MOUNT], { encoding: 'utf8' })).toBe('');
  });
});

/**
 * Raw TLS + HTTP upgrade — deliberately NOT a WebSocket library: the point is
 * to prove the exact bytes a browser sends are accepted, including the
 * `Sec-WebSocket-Protocol: sip` header the pinned transport requires. A client
 * library that negotiates differently would hide a mismatch.
 */
function websocketUpgrade(port: number, timeoutMs = 10_000): Promise<{ statusLine: string; subprotocol: string }> {
  return new Promise((resolve, reject) => {
    const sock: TLSSocket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Protocol: sip\r\n' +
          '\r\n',
      );
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`WebSocket upgrade on 127.0.0.1:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let head = '';
    sock.on('data', (d) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      const lines = head.split('\r\n');
      const sub = lines.map((l) => /^sec-websocket-protocol:\s*(.+)$/i.exec(l)).find(Boolean);
      sock.destroy();
      resolve({ statusLine: lines[0], subprotocol: sub ? sub[1].trim() : '' });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
