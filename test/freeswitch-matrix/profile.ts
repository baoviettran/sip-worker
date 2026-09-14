// test/freeswitch-matrix/profile.ts — the FreeSWITCH binding of the step engine.
// Both behaviours below are load-bearing and were each found by a failing call,
// so they carry their evidence rather than looking like style choices.
import type { PbxProfile } from '../matrix-shared/steps';

export const freeSwitchProfile: PbxProfile = {
  name: 'FreeSWITCH',
  echoTarget: 'sip:9196@127.0.0.1',
  wsPath: '/ws',
  /**
   * The Contact MUST be bracketed. sofia-sip's name-addr parser routes the
   * params of an unbracketed Contact (everything after the first ';') into the
   * header-parameter list rather than the URL-parameter list, so FreeSWITCH
   * never sees `transport=wss` and sends server→client dialog requests — the ACK
   * after the page's 200 OK, and the BYE after uuid_kill — over UDP, where the
   * page never sees them. The registration Contact points at the WSS listener
   * port; wait-incoming rewrites the runtime contact to the page's own WSS
   * source port (learned from the FreeSWITCH Via rport) before the inbound
   * INVITE arrives, so the ACK reuses the page's WSS connection.
   */
  contact: ({ user, domain, wssPort }) => `<sip:${user}@${domain}:${wssPort};transport=wss>`,
  /**
   * PCMU only, for the DTMF step. FreeSWITCH's 9196 echo negotiates
   * telephone-event/48000, which the browser package cannot decode, so the DTMF
   * path is deterministic only when the codec is pinned to the 8 kHz pair.
   */
  dtmfCodecPreference: ['PCMU'],
};
