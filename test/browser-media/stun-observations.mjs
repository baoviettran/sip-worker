// test/browser-media/stun-observations.mjs — the STUN leg's load-bearing check.
//
// The scenario's old assertion proved only that the harness's responder was
// PINGED: the gathered candidate types were console.logged and never asserted,
// so a call that gathered a server-reflexive candidate and then selected a host
// pair passed. This module turns the gathered candidates into a claim about the
// srflx candidate's PORT alone: it must be one the responder actually observed
// for a binding request, which couples it to a binding our responder really
// served. The ADDRESS is not checked here — the harness itself fabricates it
// (server.mjs maps the XOR-MAPPED-ADDRESS onto 127.0.0.2, preserving the source
// port) — so this leg does NOT cover the FreeSWITCH defect class of a fabricated
// address; that address-level guarantee lives in test/matrix-shared/stun.ts.
//
// What is deliberately NOT asserted: the selected pair type. Two same-realm
// peers always choose host/host, whatever STUN did — the same reason
// server.mjs documents its 127.0.0.2 mapping. Asserting it would be a test of
// the harness, not of the engine.

/** `candidate:<foundation> <component> <transport> <priority> <addr> <port> typ <type> …` */
export function parseCandidate(line) {
  if (typeof line !== 'string' || !line.startsWith('candidate:')) return null;
  const fields = line.split(/\s+/);
  if (fields.length < 8) return null;
  const typeIndex = fields.indexOf('typ');
  if (typeIndex === -1 || !fields[typeIndex + 1]) return null;
  const address = fields[4];
  const port = Number(fields[5]);
  if (!address || !Number.isInteger(port) || port <= 0) return null;
  return { type: fields[typeIndex + 1], address, port };
}

export function reflexivePorts(candidateLines) {
  return candidateLines
    .map(parseCandidate)
    .filter((c) => c && c.type === 'srflx')
    .map((c) => c.port);
}

/**
 * Assertion (2) of the spec's STUN contract. The two failure reasons are kept
 * distinct because they mean different things to whoever reads the CI log: an
 * empty capture is an engine-side capture problem (the documented fallback
 * applies), while an observed-but-unmatched port is a fabricated mapping.
 */
export function matchReflexiveToObservation({ candidateLines, observedPorts }) {
  const ports = reflexivePorts(candidateLines ?? []);
  if (ports.length === 0) {
    return { ok: false, matched: [], reflexivePorts: [], reason: 'no-reflexive-candidate' };
  }
  const observed = new Set(observedPorts ?? []);
  const matched = ports.filter((port) => observed.has(port));
  if (matched.length === 0) {
    return { ok: false, matched: [], reflexivePorts: ports, reason: 'no-reflexive-port-observed' };
  }
  return { ok: true, matched, reflexivePorts: ports, reason: 'ok' };
}
