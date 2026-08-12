// Browser bundle fixture: imports and re-exports representative browser and
// core values from the installed `sip-worker` package. Bundled with esbuild
// targeting `platform: 'browser'` to prove the package builds with no Node
// polyfill or leakage.
export { BrowserWebSocketTransport, UserAgent, SipError } from 'sip-worker';
export type { UserAgentOptions, Transport } from 'sip-worker';