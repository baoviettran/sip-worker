import { describe, it, expect } from 'vitest';
import { launchOnlyKeysUnderContextOptions } from './playwright-config-guard.mjs';

// Fixtures are whole object literals, never bare fragments: a fragment such as
// `use: { … }` is parsed as a LABELED STATEMENT, not an object, so a rule that
// looks for object properties finds nothing and an "accepts…" case passes
// vacuously. Each fixture below is therefore an initializer.

// The shape that shipped twice and failed only in the nightly: the real
// `firefoxProject` block as it stood in test/freeswitch-matrix/playwright.config.ts
// before 279c90e (identical to test/asterisk-matrix before a420a46).
const INERT_SHAPE = `
const firefoxProject = {
  name: 'firefox',
  use: {
    ...devices['Desktop Firefox'],
    contextOptions: {
      firefoxUserPrefs: {
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.navigator.streams.fake': false,
        'media.peerconnection.ice.loopback': true,
      },
    },
  },
};
`;

const APPLIED_SHAPE = `
const firefoxProject = {
  name: 'firefox',
  use: {
    ...devices['Desktop Firefox'],
    launchOptions: {
      firefoxUserPrefs: {
        'media.peerconnection.ice.loopback': true,
      },
    },
  },
};
`;

describe('launchOnlyKeysUnderContextOptions', () => {
  it('fires on the inert shape that shipped twice', () => {
    // line 7 is the `firefoxUserPrefs:` property itself — the line worth
    // pointing at in a failure message.
    expect(launchOnlyKeysUnderContextOptions(INERT_SHAPE)).toEqual([
      { key: 'firefoxUserPrefs', line: 7 },
    ]);
  });

  it('accepts the applied shape', () => {
    expect(launchOnlyKeysUnderContextOptions(APPLIED_SHAPE)).toEqual([]);
  });

  it('accepts a contextOptions block that holds only context options', () => {
    const source = `const project = { use: { contextOptions: { permissions: ['microphone'] } } };`;
    expect(launchOnlyKeysUnderContextOptions(source)).toEqual([]);
  });

  it('ignores prose: a comment naming the key does not trip the scan', () => {
    const source = `
      const project = {
        use: {
          contextOptions: {
            // firefoxUserPrefs belongs on launchOptions, not here
            permissions: ['microphone'],
          },
        },
      };
    `;
    expect(launchOnlyKeysUnderContextOptions(source)).toEqual([]);
  });

  it('reports one finding per offending block', () => {
    expect(launchOnlyKeysUnderContextOptions(INERT_SHAPE + INERT_SHAPE)).toHaveLength(2);
  });

  it('catches a quoted key name', () => {
    const source = `const project = { use: { contextOptions: { 'firefoxUserPrefs': {} } } };`;
    expect(launchOnlyKeysUnderContextOptions(source)).toHaveLength(1);
  });

  it('sees a deep block, not just a top-level one', () => {
    const source = `
      const project = {
        use: {
          contextOptions: {
            firefoxUserPrefs: { 'media.peerconnection.ice.loopback': true },
          },
        },
      };
    `;
    expect(launchOnlyKeysUnderContextOptions(source)).toEqual([
      { key: 'firefoxUserPrefs', line: 5 },
    ]);
  });

  it('does not end a block early on a brace inside a string', () => {
    const source = `
      const project = {
        use: {
          contextOptions: { locale: 'en{US}' },
          launchOptions: { firefoxUserPrefs: { 'a.b': 1 } },
        },
      };
    `;
    expect(launchOnlyKeysUnderContextOptions(source)).toEqual([]);
  });

  it('does not end a block early on an unbalanced brace inside a comment', () => {
    const source = `
      const project = {
        use: {
          contextOptions: {
            // a stray } in prose
            permissions: ['microphone'],
          },
        },
      };
    `;
    expect(launchOnlyKeysUnderContextOptions(source)).toEqual([]);
  });
});
