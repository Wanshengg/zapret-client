const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { extractZip } = require('./archive.cjs');

const API_URL = 'https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest';
const USER_FILES = [
  'lists/list-general-user.txt',
  'lists/list-exclude-user.txt',
  'lists/ipset-exclude-user.txt',
  'utils/game_filter.enabled',
];

async function githubLatest() {
  const response = await fetch(API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Zapret-Client', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`GitHub вернул HTTP ${response.status}`);
  const release = await response.json();
  const asset = release.assets?.find((item) => item.name.endsWith('.zip'));
  if (!asset) throw new Error('В официальном релизе нет ZIP-архива');
  const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!digest) throw new Error('GitHub не опубликовал SHA-256 архива; обновление остановлено');
  return { version: release.tag_name, url: asset.browser_download_url, digest, notes: release.body, publishedAt: release.published_at };
}

async function copyIfExists(source, destination) {
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

class Updater {
  constructor(dataDir, store) {
    this.dataDir = dataDir;
    this.runtimeDir = path.join(dataDir, 'runtime');
    this.store = store;
    this.latest = null;
  }

  async check() {
    this.latest = await githubLatest();
    await this.store.patch({ lastUpdateCheck: new Date().toISOString() });
    return this.latest;
  }

  async install(release = this.latest) {
    if (!release) release = await this.check();
    const downloadDir = path.join(this.dataDir, 'download');
    const stagingDir = path.join(this.dataDir, 'staging');
    const backupDir = path.join(this.dataDir, 'backup');
    const archive = path.join(downloadDir, `zapret-${release.version}.zip`);
    await fs.rm(downloadDir, { recursive: true, force: true });
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(downloadDir, { recursive: true });

    try {
      const response = await fetch(release.url, {
        headers: { 'User-Agent': 'Zapret-Client' },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`Загрузка архива: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actualDigest !== release.digest) throw new Error('SHA-256 не совпал. Архив удалён, текущая версия не изменена.');
      await fs.writeFile(archive, bytes);
      await extractZip(archive, { dir: stagingDir });

      let payloadDir = stagingDir;
      try { await fs.access(path.join(payloadDir, 'bin', 'winws.exe')); }
      catch {
        const entries = await fs.readdir(stagingDir, { withFileTypes: true });
        const roots = entries.filter((entry) => entry.isDirectory());
        if (roots.length !== 1) throw new Error('Неизвестная структура ZIP-архива');
        payloadDir = path.join(stagingDir, roots[0].name);
      }
      await fs.access(path.join(payloadDir, 'bin', 'winws.exe'));
      await fs.access(path.join(payloadDir, 'general.bat'));
      for (const relative of USER_FILES) {
        await copyIfExists(path.join(this.runtimeDir, relative), path.join(payloadDir, relative));
      }
      await fs.writeFile(path.join(payloadDir, '.client-release.json'), JSON.stringify({ version: release.version, digest: release.digest, installedAt: new Date().toISOString() }, null, 2));

      await fs.rm(backupDir, { recursive: true, force: true });
      let hadRuntime = true;
      try { await fs.rename(this.runtimeDir, backupDir); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        hadRuntime = false;
      }
      try {
        try { await fs.rename(payloadDir, this.runtimeDir); }
        catch (error) {
          if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
          await fs.cp(payloadDir, this.runtimeDir, { recursive: true, errorOnExist: true });
        }
        await fs.access(path.join(this.runtimeDir, 'bin', 'winws.exe'));
      } catch (error) {
        await fs.rm(this.runtimeDir, { recursive: true, force: true });
        if (hadRuntime) await fs.rename(backupDir, this.runtimeDir);
        throw error;
      }
      await this.store.patch({ version: release.version, results: [] });
      await fs.rm(backupDir, { recursive: true, force: true });
      return release.version;
    } finally {
      await fs.rm(downloadDir, { recursive: true, force: true });
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }
}

module.exports = { Updater, githubLatest };
