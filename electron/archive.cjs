const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

function resolveEntryPath(root, fileName) {
  const destination = path.resolve(root, ...fileName.split('/'));
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Небезопасный путь в ZIP-архиве: ${fileName}`);
  }
  return destination;
}

function isSymbolicLink(entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function openReadStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function extractZip(archive, { dir }) {
  const root = path.resolve(dir);
  await fs.mkdir(root, { recursive: true });
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true, strictFileNames: true }, (error, file) => {
      if (error) reject(error);
      else resolve(file);
    });
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      reject(error);
    };

    zipfile.on('error', fail);
    zipfile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on('entry', (entry) => {
      (async () => {
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP-архив превышает безопасный размер распаковки');
        if (isSymbolicLink(entry)) throw new Error(`Символические ссылки в ZIP-архиве запрещены: ${entry.fileName}`);
        const destination = resolveEntryPath(root, entry.fileName);
        if (entry.fileName.endsWith('/')) {
          await fs.mkdir(destination, { recursive: true });
          return;
        }

        await fs.mkdir(path.dirname(destination), { recursive: true });
        const stream = await openReadStream(zipfile, entry);
        const handle = await fs.open(destination, 'wx');
        try {
          await pipeline(stream, handle.createWriteStream());
        } finally {
          await handle.close();
        }
      })().then(() => {
        if (!settled) zipfile.readEntry();
      }).catch(fail);
    });
    zipfile.readEntry();
  });
}

module.exports = { extractZip, resolveEntryPath, isSymbolicLink, MAX_UNCOMPRESSED_BYTES };
