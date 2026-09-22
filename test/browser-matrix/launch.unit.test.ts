// test/browser-matrix/launch.unit.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchOptionsFor } from './launch';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('launchOptionsFor', () => {
  it('carries the three Chromium media flags', () => {
    expect(launchOptionsFor('chromium')).toEqual({
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
  });

  it('carries exactly the four Firefox prefs, as LAUNCH options', () => {
    expect(launchOptionsFor('firefox')).toEqual({
      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.navigator.streams.fake': false,
        'media.peerconnection.ice.loopback': true,
      },
    });
  });

  it('gives WebKit no launch options at all', () => {
    // WebKit rejects Chromium's --autoplay-policy (instant exit) and has no
    // pref surface here; the page side handles autoplay.
    expect(launchOptionsFor('webkit')).toEqual({});
  });
});

describe('the two configs share this module', () => {
  it('leaves no literal firefoxUserPrefs in either config, so the two cannot drift', () => {
    for (const rel of ['playwright.config.ts', 'test/browser-matrix/playwright.config.ts']) {
      // The row config is added by the next task; the rule arms itself then.
      if (!existsSync(`${repoRoot}/${rel}`)) continue;
      const source = readFileSync(`${repoRoot}/${rel}`, 'utf8');
      expect(source, `${rel} must import the shared launch module`).toMatch(/launchOptionsFor\(/);
      expect(source, `${rel} must not re-declare firefoxUserPrefs`).not.toMatch(/firefoxUserPrefs\s*:/);
    }
  });
});
