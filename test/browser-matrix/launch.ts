// test/browser-matrix/launch.ts — the launch options shared by the browser-media
// three-engine suite and the v0.9 browser-matrix rows, so the two cannot drift.
//
// The four Firefox prefs below shipped under `contextOptions` TWICE (in the
// FreeSWITCH and Asterisk matrix configs): `contextOptions` is a
// BrowserContextOptions, which has no `firefoxUserPrefs` key, so the block was
// accepted and silently ignored, every pref was inert, and only the nightly —
// never the Chromium-only PR job — failed. test/matrix-shared/playwright-config-guard.mjs
// exists to catch that, and this module is passed as a VALUE
// (`launchOptions: launchOptionsFor(engine)`), never spread into
// `contextOptions`.

/**
 * `media.peerconnection.ice.loopback` is the load-bearing pref for the
 * interop matrices: it is what lets Firefox use their loopback STUN responder.
 * `media.navigator.streams.fake: false` keeps the real in-page synthetic device
 * in charge. The autoplay pair lets headless Firefox play received audio
 * without a user gesture.
 */
export function launchOptionsFor(engine: 'chromium' | 'firefox' | 'webkit') {
  if (engine === 'chromium') {
    return {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // Deterministic injected media-device adapter is used for the
        // library's getUserMedia; this flag is a belt-and-braces fallback.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    };
  }
  if (engine === 'firefox') {
    return {
      firefoxUserPrefs: {
        // Headless Firefox suspends audio without a gesture; allow it.
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.navigator.streams.fake': false,
        // The acceptance infrastructure is intentionally loopback-local. Firefox
        // otherwise filters loopback STUN/TURN candidates before SDP emission.
        'media.peerconnection.ice.loopback': true,
      },
    };
  }
  // WebKit's launch args have NO --autoplay-policy (that flag is Chromium-only
  // and webkit rejects it -> instant exit). Audio/gain is muted by default
  // policy in WebKit; the page side handles autoplay via the injected media
  // adapter, not a browser launch flag.
  return {};
}
