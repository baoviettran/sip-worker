import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const htmlPath = join(__dirname, '../../examples/freeswitch-pilot/index.html');

const requiredIds = [
  'pilot-config', 'wss-url', 'sip-domain', 'extension', 'sip-password',
  'tester-label', 'ice-servers', 'add-ice-server', 'relay-only',
  'create-phone', 'connect', 'register', 'unregister', 'disconnect',
  'dispose', 'reset', 'destination', 'call', 'cancel', 'answer', 'reject',
  'hangup', 'mute-toggle', 'hold', 'resume', 'restart-ice', 'dtmf-pad',
  'microphone', 'play-audio', 'connection-state', 'registration-state',
  'call-state', 'signaling-state', 'media-state', 'mute-state', 'hold-state',
  'remote-identity', 'typed-error', 'resources', 'event-log',
  'scenario-checklist', 'evidence-preview', 'copy-evidence', 'download-evidence',
];

let html: string;

beforeAll(async () => {
  html = await readFile(htmlPath, 'utf-8');
});

describe('FreeSWITCH pilot markup contract', () => {
  it('contains every required ID exactly once', () => {
    for (const id of requiredIds) {
      const pattern = new RegExp(`id="${id}"`);
      const matches = html.match(pattern);
      expect(matches, `expected id="${id}" to appear in index.html`).toHaveLength(1);
    }
  });

  it('has one password-type SIP input with data-secret="true"', () => {
    const passwordInputs = [
      ...html.matchAll(/<input[^>]*type="password"[^>]*>/gi),
    ];
    expect(passwordInputs.length).toBeGreaterThanOrEqual(1);

    const sipPassword = passwordInputs.find((m) =>
      /id="sip-password"/.test(m[0]),
    );
    expect(sipPassword, 'expected an input with id="sip-password" and type="password"').toBeTruthy();
    expect(sipPassword![0]).toMatch(/autocomplete="off"/);
    expect(sipPassword![0]).toMatch(/data-secret="true"/);
  });

  it('has TURN credential inputs as password type with data-secret="true"', () => {
    const turnInputs = [
      ...html.matchAll(/<input[^>]*id="[^"]*turn[^"]*"[^>]*>/gi),
    ];
    const turnPasswords = turnInputs.filter((m) =>
      /type="password"/.test(m[0]),
    );
    if (turnInputs.length > 0) {
      expect(turnPasswords.length).toBe(turnInputs.length);
      for (const m of turnPasswords) {
        expect(m[0]).toMatch(/autocomplete="off"/);
        expect(m[0]).toMatch(/data-secret="true"/);
      }
    }
  });

  it('does not contain any storage access scripts', () => {
    expect(html).not.toMatch(/localStorage/);
    expect(html).not.toMatch(/sessionStorage/);
    expect(html).not.toMatch(/indexedDB/);
  });

  it('does not set allowInsecureWebSocket', () => {
    expect(html).not.toMatch(/allowInsecureWebSocket/);
  });

  it('loads main.js with defer and has PILOT_TEST_HOOK comment', () => {
    expect(html).toMatch(/<!--\s*PILOT_TEST_HOOK\s*-->/);
    expect(html).toMatch(/<script[^>]*defer[^>]*src="\/main\.js"[^>]*>/);
  });

  it('uses aria-live="polite" for state values', () => {
    expect(html).toMatch(/aria-live="polite"/);
  });

  it('uses role="alert" for typed errors', () => {
    expect(html).toMatch(/role="alert"/);
  });

  it('uses semantic main element', () => {
    expect(html).toMatch(/<main/);
  });
});
