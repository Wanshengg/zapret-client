const test = require('node:test');
const assert = require('node:assert/strict');
const { githubLatestApp, isNewerVersion } = require('./app-updater.cjs');

test('application versions are compared using semver rules', () => {
  assert.equal(isNewerVersion('v0.2.0', '0.1.9'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-beta.2'), true);
  assert.equal(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(isNewerVersion('1.0.0-beta.2', '1.0.0'), false);
  assert.equal(isNewerVersion('not-a-version', '0.1.0'), false);
});

test('latest application release exposes update state and installer', async () => {
  const release = await githubLatestApp('0.1.0', async () => ({
    ok: true,
    json: async () => ({
      tag_name: 'v0.2.0',
      html_url: 'https://example.com/release',
      body: 'Changes',
      published_at: '2026-11-14T00:00:00Z',
      assets: [
        { name: 'latest.yml', browser_download_url: 'https://example.com/latest.yml' },
        { name: 'Zapret Client Setup 0.2.0.exe', browser_download_url: 'https://example.com/setup.exe' },
      ],
    }),
  }));
  assert.equal(release.version, '0.2.0');
  assert.equal(release.available, true);
  assert.equal(release.downloadUrl, 'https://example.com/setup.exe');
});

test('current application release does not offer an update', async () => {
  const release = await githubLatestApp('0.2.0', async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v0.2.0', html_url: 'https://example.com/release', assets: [] }),
  }));
  assert.equal(release.available, false);
  assert.equal(release.downloadUrl, 'https://example.com/release');
});
