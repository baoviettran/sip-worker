# Phase 1 Codec Follow-up Fixes Design

## Goal

Resolve the three remaining Phase 1 review defects without changing the public codec API.

## Design

### Stream header unfolding

The stream decoder will keep the SIP start line separate from header fields. A continuation line is valid only after a real header field; a continuation immediately after the start line returns `ParseError` and resets the decoder. This keeps stream framing aligned with `parseMessage` and prevents a disguised `Content-Length` from being treated as a zero-length body.

### Batched stream frames

`push()` will consume every complete frame already present in its buffer, regardless of the aggregate size of those valid frames. Header and body limits remain per-frame. Buffer-size rejection applies only when the remaining bytes cannot yet form a complete frame, preserving bounded incomplete state without rejecting valid multi-message batches.

### Exact Content-Length offsets

Content-Length validation will locate the first non-decimal character instead of reporting only the start of the value. Unfolding will retain a byte-offset mapping from each logical value character to its original wire byte, so parser and stream-decoder errors agree even when the invalid character appears on a continuation line.

## Error handling

All malformed-input paths continue returning `ParseResult` with `ParseError`; no parsing operation throws. Decoder failures reset buffered state as before.

## Testing

Regression tests will prove:

- an orphan continuation containing `Content-Length` is rejected and the decoder remains reusable;
- three large valid messages in one push are all emitted;
- ordinary and folded non-decimal Content-Length values report the exact offending byte in both parser and decoder.

After focused red/green cycles, the full test suite, typecheck, package build, and export checks must pass.
