// test/asterisk-matrix/profile.ts — the Asterisk binding of the step engine.
import type { PbxProfile } from '../matrix-shared/steps';

export const asteriskProfile: PbxProfile = {
  name: 'Asterisk',
  echoTarget: 'sip:600@127.0.0.1',
  wsPath: '/ws',
  /**
   * `transport=ws` — NOT `wss`, and NOT bracketed, both deliberately.
   *
   * RFC 7118 §3.1.2 registers `ws` as the transport token for WebSocket
   * signalling regardless of whether the underlying socket is ws:// or wss://,
   * and pjsip follows it. Bracketing is unnecessary: it existed on the
   * FreeSWITCH side because sofia-sip's name-addr parser misroutes an
   * unbracketed Contact's params, and pjsip parses an addr-spec URI correctly.
   *
   * This is the one profile value the 2026-09-14 probe did not confirm — it
   * stopped at the WebSocket upgrade — so it is the first thing this task
   * proves. A wrong value would not fail here: registration succeeds on the
   * inbound Request-URI regardless. It fails at Task 9 (inbound) and Task 10
   * (remote BYE), where server→client requests are misrouted exactly as the
   * FreeSWITCH profile describes. If an inbound step fails, check this line
   * before anything else.
   */
  contact: ({ user, domain, wssPort }) => `sip:${user}@${domain}:${wssPort};transport=ws`,
  /** PCMU is all the pinned image offers (spec decision 4), so the pin is a
   *  no-op here; declared anyway so the DTMF step is not silently
   *  codec-dependent if the image's codec set ever changes. */
  dtmfCodecPreference: ['PCMU'],
};
