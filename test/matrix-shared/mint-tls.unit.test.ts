import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mintTls } from './mint-tls';

describe('mintTls', () => {
  const tls = mintTls();

  it('returns a leaf certificate and its key', () => {
    expect(tls.certPem).toContain('BEGIN CERTIFICATE');
    expect(tls.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(tls.bundlePem).toBe(tls.certPem + '\n' + tls.keyPem);
  });

  // The SAN is the fragile part: without IP:127.0.0.1 the browser rejects the
  // WSS certificate and every matrix step fails for an unrelated-looking reason.
  it('carries IP:127.0.0.1 and DNS:localhost in its SAN', () => {
    const text = execFileSync('openssl', ['x509', '-noout', '-text'], { input: tls.certPem }).toString();
    expect(text).toContain('IP Address:127.0.0.1');
    expect(text).toContain('DNS:localhost');
  });
});
