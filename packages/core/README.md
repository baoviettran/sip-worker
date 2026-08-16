# @sip-worker/core

Signaling-only SIP stack (RFC 3261) core package. This package is owned by the
sip-worker project and exposes the transport-agnostic protocol core.

`@sip-worker/core` is **signaling-only**: it owns the SIP protocol core and the
coded, serializable media **error/controller contract** (`MediaError`,
`MEDIA_ERROR_CODES`, `WorkerMediaController`) but fabricates no media and imports
no WebRTC. The real WebRTC audio and the browser phone surface live in the
browser `sip-worker` package. It makes no production-readiness claim. See the
migration guides for the 0.2.0 to 0.3.0 mapping:
<https://github.com/baoviettran/sip-worker/blob/main/docs/migrations/0.2-to-0.3.md>,
the
[0.3.0 to 0.5.0 guide](../docs/migrations/0.3-to-0.5.md),
and the
[0.5.0 to 0.7.0 guide](../docs/migrations/0.5-to-0.7.md).

## License

MIT
