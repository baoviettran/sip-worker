// test/asterisk-matrix/profile.ts — the Asterisk binding of the step engine.
import type { PbxProfile } from '../matrix-shared/steps';

export const asteriskProfile: PbxProfile = {
  name: 'Asterisk',
  echoTarget: 'sip:600@127.0.0.1',
  wsPath: '/ws',
  /**
   * `transport=ws` — lowercase, NOT `wss`, and NOT bracketed, all deliberately.
   *
   * RFC 7118 §5.2 (SIP URI Transport Parameter) defines lowercase `ws` as the
   * parameter value for "a SIP URI to be contacted using the SIP WebSocket
   * subprotocol as transport" — a single value for the URIs this package
   * emits, whatever the underlying socket is. §5.1 (Via Transport Parameter)
   * is the section that separates uppercase `WS` from `WSS`, and it governs
   * Via, not SIP URIs; pjsip follows §5.2 for the Contact. (An earlier draft
   * of this comment cited §3.1.2, which does not exist: RFC 7118 §3 has no
   * subsections.)
   *
   * Bracketing is unnecessary: it existed on the FreeSWITCH side because
   * sofia-sip's name-addr parser misroutes an unbracketed Contact's params,
   * and pjsip parses an addr-spec URI correctly.
   *
   * This is the one profile value the 2026-09-14 probe did not confirm — it
   * stopped at the WebSocket upgrade — so it is the first thing this task
   * proves. A wrong value would not fail here: registration succeeds on the
   * inbound Request-URI regardless. It fails at Task 9 (inbound) and Task 10
   * (remote BYE), where server→client requests are misrouted exactly as the
   * FreeSWITCH profile describes. If an inbound step fails, check this line
   * before anything else — and §5.2 is a second reason Task 9 should suspect
   * `steps.ts:1053-1054` first: the bracketed `transport=wss` literal that
   * rewrite writes into a Contact URI contradicts §5.2's lowercase `ws`.
   */
  contact: ({ user, domain, wssPort }) => `sip:${user}@${domain}:${wssPort};transport=ws`,
  /** PCMU is all the pinned image offers (spec decision 4), so the pin is a
   *  no-op here; declared anyway so the DTMF step is not silently
   *  codec-dependent if the image's codec set ever changes. */
  dtmfCodecPreference: ['PCMU'],
};
