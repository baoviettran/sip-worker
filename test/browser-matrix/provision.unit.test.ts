// test/browser-matrix/provision.unit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ROWS } from './rows.mjs';
import { artifactUrl, extractedExecutablePath, parseVersion, provisionRow } from './provision.mjs';

const row = (id: string) => {
  const found = ROWS.find((r: { id: string }) => r.id === id);
  if (!found) throw new Error(`no such row in the table: ${id}`);
  return found;
};

/** Deps with the network, the extraction, and the binary all injected. */
function deps(over: Record<string, unknown> = {}) {
  return {
    cacheDir: '/tmp/matrix-cache',
    fetchToFile: vi.fn(async () => {}),
    extract: vi.fn(async () => {}),
    probeVersion: vi.fn(async () => 'Google Chrome 152.0.7977.82\n'),
    ...over,
  };
}

describe('artifactUrl', () => {
  it('builds the spike-verified URL for each vendor kind', () => {
    expect(artifactUrl(row('chrome-previous'))).toEqual(
      'https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.82/linux64/chrome-linux64.zip',
    );
    expect(artifactUrl(row('firefox-previous'))).toEqual(
      'https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1532/firefox-ubuntu-24.04.zip',
    );
    expect(artifactUrl(row('edge-current'))).toEqual(
      'https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/microsoft-edge-stable_153.0.4234.48-1_amd64.deb',
    );
  });

  it('refuses a kind that has no artifact to fetch', () => {
    expect(() => artifactUrl(row('chromium-current'))).toThrowError(/has no artifact URL/);
    expect(() => artifactUrl(row('safari-current'))).toThrowError(/has no artifact URL/);
  });
});

describe('extractedExecutablePath', () => {
  it('places each kind at the layout the spike confirmed', () => {
    expect(extractedExecutablePath(row('chrome-previous'), '/c')).toEqual('/c/chrome-previous/chrome-linux64/chrome');
    expect(extractedExecutablePath(row('firefox-previous'), '/c')).toEqual('/c/firefox-previous/firefox/firefox');
    expect(extractedExecutablePath(row('edge-current'), '/c')).toEqual('/c/edge-current/opt/microsoft/msedge/msedge');
  });
});

describe('parseVersion', () => {
  it('reads the version out of each vendor binary’s first line', () => {
    expect(parseVersion('Google Chrome 152.0.7977.82\n')).toEqual('152.0.7977.82');
    expect(parseVersion('Microsoft Edge 153.0.4234.48\n')).toEqual('153.0.4234.48');
    expect(parseVersion('Mozilla Firefox 151.0\n')).toEqual('151.0');
  });

  it('throws instead of returning a guess', () => {
    expect(() => parseVersion('')).toThrowError(/cannot parse a version/);
    expect(() => parseVersion('Google Chrome\nsome banner\n')).toThrowError(/cannot parse a version/);
  });
});

describe('provisionRow', () => {
  it('downloads, extracts, probes, and returns the path for a vendor row', async () => {
    const d = deps();
    const out = await provisionRow(row('chrome-previous'), d);
    expect(d.fetchToFile).toHaveBeenCalledTimes(1);
    expect(d.extract).toHaveBeenCalledTimes(1);
    expect(d.probeVersion).toHaveBeenCalledWith('/tmp/matrix-cache/chrome-previous/chrome-linux64/chrome');
    expect(out).toEqual({
      executablePath: '/tmp/matrix-cache/chrome-previous/chrome-linux64/chrome',
      observed: '152.0.7977.82',
    });
  });

  it('verifies the version BEFORE returning, naming the URL, the pin, and both versions', async () => {
    const d = deps({ probeVersion: async () => 'Google Chrome 151.0.7922.34\n' });
    await expect(provisionRow(row('chrome-previous'), d)).rejects.toThrowError(
      /row chrome-previous[\s\S]*reports 151\.0\.7922\.34, expected 152\.0\.7977\.82[\s\S]*pin 152\.0\.7977\.82[\s\S]*chrome-for-testing-public\/152\.0\.7977\.82/,
    );
  });

  it('fails hard when the download itself fails', async () => {
    const d = deps({ fetchToFile: async () => { throw new Error('HTTP 404'); } });
    await expect(provisionRow(row('firefox-previous'), d)).rejects.toThrowError(/HTTP 404/);
  });

  it('fails hard when the archive cannot be unpacked (truncated download)', async () => {
    const d = deps({ extract: async () => { throw new Error('unzip: cannot find zipfile directory'); } });
    await expect(provisionRow(row('edge-current'), d)).rejects.toThrowError(/cannot find zipfile directory/);
  });

  it('returns no path for a bundled row and downloads nothing', async () => {
    const d = deps();
    expect(await provisionRow(row('chromium-current'), d)).toEqual({ executablePath: null, observed: null });
    expect(d.fetchToFile).not.toHaveBeenCalled();
    expect(d.probeVersion).not.toHaveBeenCalled();
  });

  it('refuses to provision the runner-provisioned Safari row', async () => {
    await expect(provisionRow(row('safari-current'), deps())).rejects.toThrowError(/macOS workflow/);
  });
});
