const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

test('all production dependency packages are included in app.asar', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const config = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const required = new Set();
  const queue = Object.keys(manifest.dependencies || {});

  while (queue.length) {
    const name = queue.shift();
    if (required.has(name)) continue;
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `Missing lockfile entry for ${name}`);
    required.add(name);
    queue.push(...Object.keys(entry.dependencies || {}));
  }

  for (const name of required) {
    assert.ok(
      config.files.includes(`node_modules/${name}/**/*`),
      `electron-builder.yml must include node_modules/${name}/**/*`,
    );
  }
  assert.ok(required.has('pend'), 'The dependency graph must include pend');
});
