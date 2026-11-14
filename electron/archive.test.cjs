const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crc32 = require('buffer-crc32');
const { extractZip } = require('./archive.cjs');

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    checksum.copy(local, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.symlink ? 0x0314 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    checksum.copy(central, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.symlink ? 0xa1ff0000 : 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

test('archive extraction allows regular files and rejects traversal and symlinks', async (t) => {
  const temporary = await fs.mkdtemp(path.join(__dirname, '.archive-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  const validArchive = path.join(temporary, 'valid.zip');
  await fs.writeFile(validArchive, makeZip([
    { name: 'bin/winws.exe', data: 'core' },
    { name: 'general.bat', data: 'strategy' },
  ]));
  await extractZip(validArchive, { dir: path.join(temporary, 'valid') });
  assert.equal(await fs.readFile(path.join(temporary, 'valid', 'bin', 'winws.exe'), 'utf8'), 'core');
  assert.equal(await fs.readFile(path.join(temporary, 'valid', 'general.bat'), 'utf8'), 'strategy');

  const traversalArchive = path.join(temporary, 'traversal.zip');
  await fs.writeFile(traversalArchive, makeZip([{ name: '../escape.txt', data: 'blocked' }]));
  await assert.rejects(extractZip(traversalArchive, { dir: path.join(temporary, 'traversal') }), /relative path|Небезопасный путь/);
  await assert.rejects(fs.access(path.join(temporary, 'escape.txt')));

  const symlinkArchive = path.join(temporary, 'symlink.zip');
  await fs.writeFile(symlinkArchive, makeZip([{ name: 'link', data: 'target', symlink: true }]));
  await assert.rejects(extractZip(symlinkArchive, { dir: path.join(temporary, 'symlink') }), /Символические ссылки/);
});
