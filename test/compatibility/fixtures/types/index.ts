// Combined TypeScript fixture: compiles against the INSTALLED tarballs of all
// three packages so each package's .d.ts/.d.cts resolves AND the cross-package
// type surface (browser/node re-exporting core) lines up.
import {
  SipError as CoreError,
  TransportError as CoreTransportError,
  type Transport,
  type UserAgentOptions,
  type IdGenerator,
} from '@sip-worker/core';
import { SipError as BrowserError, UserAgent, AuthManager } from 'sip-worker';
import {
  NodeUdpTransport,
  NodeWebSocketTransport,
  type DatagramSocketLike,
  type NodeWebSocketLike,
} from '@sip-worker/node';

// ---- cross-package identity at the type level ----
const browserError: typeof CoreError = BrowserError;
void browserError;
const coreTransportError: typeof CoreTransportError = CoreTransportError;
void coreTransportError;

void new NodeUdpTransport(
  null as unknown as DatagramSocketLike,
  {
    localPort: 5060,
    remoteHost: '192.0.2.10',
    remotePort: 5060,
  },
);
void new NodeWebSocketTransport(null as unknown as NodeWebSocketLike);

declare const transport: Transport;
declare const idGenerator: IdGenerator;
const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
const uaOptions: UserAgentOptions = {
  transport,
  clock,
  registrarUri: 'sip:example.test',
  aor: 'sip:alice@example.test',
  contact: 'sip:alice@example.test',
  idGenerator,
  authManager: new AuthManager(idGenerator),
};
void new UserAgent(uaOptions);

// ---- observed node errors are typed as core TransportError ----
declare const observed: CoreTransportError;
void observed;

export {};