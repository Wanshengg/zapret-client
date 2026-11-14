const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('./store.cjs');

test('theme persists and partial settings preserve other values', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.load();
  await store.patchSettings({ theme: 'dark', autoStrategy: undefined });

  assert.equal(store.data.settings.theme, 'dark');
  assert.equal(store.data.settings.autoStrategy, true);
  assert.equal(store.data.settings.autoConnect, true);
  assert.equal(store.data.settings.autoUpdate, true);
  assert.equal(store.data.settings.launchAtStartup, false);

  const restored = new Store(directory);
  await restored.load();
  assert.equal(restored.data.settings.theme, 'dark');
  assert.equal(restored.data.settings.autoStrategy, true);
});

test('an invalid saved theme falls back to system', async (t) => {
  const directory = await fs.mkdtemp(path.join(__dirname, '.store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ settings: { theme: 'invalid' } }));
  const store = new Store(directory);
  await store.load();
  assert.equal(store.data.settings.theme, 'system');
});
