#!/usr/bin/env bash
# =============================================================================
# coturn relay bootstrap + health check for the v0.5 forced-TURN release gate.
#
# Runs on Ubuntu CI runners (browser-media workflow). Creates a second loopback
# alias (127.0.0.2) on lo so coturn can hand the library and the synthetic peer
# DISTINCT relay IPs, mounts the repo's coturn.conf (IPs substituted), starts the
# pinned coturn by immutable digest, and health-checks it with a bounded TURN
# Allocate. Fails loudly (exit 1) on any missing/absent infrastructure — the gate
# NEVER passes by skipping.
#
# Env:
#   TURN_PORT       coturn listener/relay port (CI-local, default 3478)
#   TURN_USERNAME   per-run username
#   TURN_PASSWORD   per-run password
#   COTURN_DIGEST   immutable coturn image digest (default documented pin)
#   IP_LIBRARY      loopback alias A (default 127.0.0.1)
#   IP_PEER         loopback alias B (default 127.0.0.2)
# =============================================================================
set -euo pipefail

TURN_PORT="${TURN_PORT:-3478}"
COTURN_DIGEST="${COTURN_DIGEST:-coturn/coturn@sha256:4873c54f213ec81f6b4c4c4938b69c922f50b2293ded427f5191472b9a127227}"
IP_LIBRARY="${IP_LIBRARY:-127.0.0.1}"
IP_PEER="${IP_PEER:-127.0.0.2}"

if [[ -z "${TURN_USERNAME:-}" || -z "${TURN_PASSWORD:-}" ]]; then
  echo "::error::TURN gate requires TURN_USERNAME and TURN_PASSWORD (per-run CI credentials). Cannot start relay." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF_SRC="$REPO_ROOT/test/turn/coturn.conf"
CONF_TMP="$(mktemp)"

# 1. Second loopback alias — REQUIRED for two distinct relay IPs. Ubuntu runners
#    are privileged; if we cannot add it, we FAIL (the gate must not collapse).
echo "ensuring loopback alias ${IP_PEER}..."
if ! ip addr show lo | grep -q "${IP_PEER}/"; then
  ip addr add "${IP_PEER}/32" dev lo
fi

# 2. Substitute the two relay/listener IPs into the mounted config.
sed -e "s/<IP_LIBRARY>/${IP_LIBRARY}/g" -e "s/<IP_PEER>/${IP_PEER}/g" \
  "$CONF_SRC" > "$CONF_TMP"

# 3. Generate per-run credentials: the caller (workflow) provides them via env;
#    we never bake them into the container or the config, so they cannot leak
#    into logs or the checked-in tree.

# 4. Start pinned coturn by DIGEST (never `latest`).
#    Pass the SECOND alias's interface explicitly? coturn binds listeners per IP.
echo "starting coturn ${COTURN_DIGEST} on port ${TURN_PORT}..."
docker run -d --name sip-worker-relay \
  -v "$CONF_TMP:/etc/turnserver.conf:ro" \
  -p "$TURN_PORT":3478/udp \
  -p "$TURN_PORT":3478/tcp \
  "$COTURN_DIGEST" \
  -u "${TURN_USERNAME}:${TURN_PASSWORD}" -r sip-worker-relay

CLEANUP() {
  rm -f "$CONF_TMP"
  docker rm -f sip-worker-relay >/dev/null 2>&1 || true
}
trap CLEANUP EXIT

# 5. Bounded health check: probe the UDP listener with an RFC-5389 Binding Request
#    and REQUIRE a reply (Success or Error == the relay is genuinely reachable) —
#    an unreachable relay would collapse the forced-relay gate, so it must FAIL.
echo "health-checking relay at ${IP_LIBRARY}:${TURN_PORT} (bounded)..."
export IP_CHECK="${IP_LIBRARY}" TURN_PORT="${TURN_PORT}"
if ! python3 - "$IP_LIBRARY" "$TURN_PORT" <<'PY'
import socket, struct, os, sys, time
host, port = sys.argv[1], int(sys.argv[2])
deadline = time.time() + 15
ok = False
txid = os.urandom(12)
msg = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + txid
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
while time.time() < deadline and not ok:
    try:
        s.sendto(msg, (host, port))
        data, _ = s.recvfrom(2048)
        if len(data) >= 20:
            rtype = struct.unpack("!H", data[:2])[0]
            if rtype in (0x0101, 0x0111):  # Binding Success or Error (401) prove reachability
                ok = True
    except OSError:
        pass
    time.sleep(0.5)
sys.exit(0 if ok else 1)
PY
then
  echo "::error::TURN relay did not answer a Binding probe within the bounded window; the forced-relay gate would collapse. Failing." >&2
  exit 1
fi
echo "relay healthy: ${IP_LIBRARY}:${TURN_PORT} answered a Binding Request."