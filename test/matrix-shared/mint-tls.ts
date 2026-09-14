// Per-run TLS minting shared by every PBX matrix: one local CA plus a leaf
// whose SAN is IP:127.0.0.1, valid for a day, written into a temp dir. NOTHING
// HERE IS EVER COMMITTED — callers copy the PEMs into a per-run runtime tree,
// and the integrity gate fails the build if a .key/.pem file appears anywhere
// in the committed matrix trees.
//
// The temp dir is intentionally not cleaned up: the harness is a test process
// that exits, and the FS leg ships the same accepted leak.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MintedTls {
  /** Leaf certificate, PEM. SAN: IP:127.0.0.1, DNS:localhost. */
  certPem: string;
  /** Leaf private key, PEM. */
  keyPem: string;
  /** `certPem` then `keyPem` — the combined file FreeSWITCH's wss.pem wants. */
  bundlePem: string;
}

export function mintTls(): MintedTls {
  const dir = mkdtempSync(join(tmpdir(), 'matrixtls-'));
  const caKey = join(dir, 'ca.key');
  const caCrt = join(dir, 'ca.crt');
  const leafKey = join(dir, 'leaf.key');
  const leafCsr = join(dir, 'leaf.csr');
  const leafCrt = join(dir, 'leaf.crt');
  const ext = join(dir, 'ext.cnf');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', caKey, '-out', caCrt,
    '-days', '1', '-nodes', '-subj', '/CN=matrix-ca'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-keyout', leafKey, '-out', leafCsr,
    '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  // macOS LibreSSL rejects -addext; use an ext file (docs/ci-browser-gate-notes.md).
  writeFileSync(ext, 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
  execFileSync('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caCrt, '-CAkey', caKey,
    '-CAcreateserial', '-out', leafCrt, '-days', '1', '-extfile', ext], { stdio: 'ignore' });
  const certPem = readFileSync(leafCrt, 'utf8');
  const keyPem = readFileSync(leafKey, 'utf8');
  return { certPem, keyPem, bundlePem: certPem + '\n' + keyPem };
}
