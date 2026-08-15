// In-page media relay (Task 15 test hook).
//
// Loaded only when the example page URL has `?relay=1` (see index.html). It
// connects a WebSocket to the fake SIP server's `/relay` endpoint and bridges
// the library's WebRTC offer/answer SDP through a `SyntheticPeer` running in
// the SAME page, so mute / hold / DTMF exercise real media between the
// library's `RTCPeerConnection` and the page's peer without a second tab or
// any cross-origin media.
//
// Protocol (JSON text frames, correlated by `id`):
//   server -> relay  { type:'offer', sdp, id }        answer the offer
//   relay  -> server { type:'answer', sdp, id }
//   server -> relay  { type:'create-offer', id }      produce a fresh offer
//   relay  -> server { type:'offer', sdp, id }
//   server -> relay  { type:'remote-answer', sdp }    apply the library's answer

const ws = new WebSocket(`ws://${location.host}/relay`);
const peer = new (await import('/synthetic-peer.js')).SyntheticPeer();

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'ready' }));
};

ws.onmessage = async (event) => {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  if (data.type === 'offer') {
    const sdp = await peer.answerOffer(data.sdp);
    ws.send(JSON.stringify({ type: 'answer', sdp, id: data.id }));
  } else if (data.type === 'create-offer') {
    const sdp = await peer.createOffer();
    ws.send(JSON.stringify({ type: 'offer', sdp, id: data.id }));
  } else if (data.type === 'remote-answer') {
    await peer.applyAnswer(data.sdp);
  }
};
