const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function naturalName(filename) {
  return filename.replace(/^general\s*/i, '').replace(/\.bat$/i, '').replace(/[()]/g, '').trim() || 'Стандартная';
}

function tokenize(command) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of command.trim()) {
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (/\s/.test(char) && !quoted) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (quoted) throw new Error('Незакрытая кавычка в аргументах стратегии');
  if (started) tokens.push(current);
  return tokens;
}

function parseStrategy(source, runtimeDir, gameFilter = { tcp: '12', udp: '12' }) {
  const command = source
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .replace(/\^\n/g, ' ')
    .split('\n')
    .find((line) => /^\s*start\s+"zapret:.*winws\.exe"/i.test(line));

  if (!command) throw new Error('В BAT-файле не найдена команда запуска winws.exe');
  const match = command.match(/winws\.exe"\s+(.+)$/i);
  if (!match) throw new Error('Не удалось прочитать аргументы стратегии');

  const bin = path.join(runtimeDir, 'bin') + path.sep;
  const lists = path.join(runtimeDir, 'lists') + path.sep;
  const expanded = match[1]
    .replaceAll('%BIN%', bin)
    .replaceAll('%LISTS%', lists)
    .replaceAll('%GameFilterTCP%', gameFilter.tcp)
    .replaceAll('%GameFilterUDP%', gameFilter.udp);

  if (/%[A-Za-z][A-Za-z0-9_]*%/.test(expanded)) {
    throw new Error('Стратегия содержит неподдерживаемую переменную окружения');
  }
  return tokenize(expanded);
}

async function readGameFilter(runtimeDir) {
  const fallback = { tcp: '12', udp: '12' };
  try {
    const content = await fs.readFile(path.join(runtimeDir, 'utils', 'game_filter.enabled'), 'utf8');
    const mode = content.match(/^mode=(.*)$/mi)?.[1]?.trim().toLowerCase();
    const tcp = content.match(/^tcp=(.*)$/mi)?.[1]?.trim() || '1024-65535';
    const udp = content.match(/^udp=(.*)$/mi)?.[1]?.trim() || '1024-65535';
    if (mode === 'all') return { tcp, udp };
    if (mode === 'tcp') return { tcp, udp: '12' };
    if (mode === 'udp') return { tcp: '12', udp };
  } catch { /* Game filter is optional. */ }
  return fallback;
}

async function listStrategies(runtimeDir) {
  const entries = await fs.readdir(runtimeDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^general.*\.bat$/i.test(entry.name))
    .map((entry) => ({ id: entry.name, name: naturalName(entry.name) }))
    .sort((a, b) => {
      if (a.id === 'general.bat') return -1;
      if (b.id === 'general.bat') return 1;
      return a.name.localeCompare(b.name, 'ru', { numeric: true });
    });
}

async function ensureUserLists(runtimeDir) {
  const lists = path.join(runtimeDir, 'lists');
  const defaults = {
    'ipset-exclude-user.txt': '203.0.113.113/32\r\n',
    'list-general-user.txt': '# Never leave this file empty\r\ndomain.example.abc\r\n',
    'list-exclude-user.txt': 'domain.example.abc\r\n',
  };
  for (const [name, content] of Object.entries(defaults)) {
    try { await fs.access(path.join(lists, name)); }
    catch { await fs.writeFile(path.join(lists, name), content); }
  }
}

function isProbeSuccessful(code, expectedCode) {
  return expectedCode === undefined ? code >= 200 && code < 400 : code === expectedCode;
}

async function probe(url, timeout = 7000, expectedCode) {
  const started = Date.now();
  try {
    const { stdout } = await exec('curl.exe', [
      '-L', '-sS', '-o', 'NUL', '-w', '%{http_code}',
      '--connect-timeout', '3', '--max-time', String(Math.ceil(timeout / 1000)), url,
    ], { windowsHide: true, timeout: timeout + 1500 });
    const code = Number(stdout.trim());
    return { ok: isProbeSuccessful(code, expectedCode), code, latency: Date.now() - started };
  } catch (error) {
    return { ok: false, code: 0, latency: Date.now() - started, error: error.message };
  }
}

class ZapretEngine {
  constructor(runtimeDir, hooks, dependencies = {}) {
    this.runtimeDir = runtimeDir;
    this.hooks = hooks;
    this.spawn = dependencies.spawn ?? spawn;
    this.exec = dependencies.exec ?? exec;
    this.sleep = dependencies.sleep ?? sleep;
    this.probe = dependencies.probe ?? probe;
    this.child = null;
    this.generation = 0;
    this.testing = false;
  }

  async startProcess(strategy) {
    const source = await fs.readFile(path.join(this.runtimeDir, strategy), 'utf8');
    const args = parseStrategy(source, this.runtimeDir, await readGameFilter(this.runtimeDir));
    const executable = path.join(this.runtimeDir, 'bin', 'winws.exe');
    const child = this.spawn(executable, args, {
      cwd: path.join(this.runtimeDir, 'bin'),
      windowsHide: true,
      stdio: 'ignore',
    });
    this.child = child;
    const generation = this.generation;
    let spawnError = null;
    child.on('error', (error) => { spawnError = error; });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.testing && generation === this.generation) {
        const reason = code === 0
          ? 'winws.exe самостоятельно остановился'
          : code === null
            ? 'winws.exe был завершён внешним процессом'
            : `winws.exe завершился с кодом ${code}`;
        this.hooks.onUnexpectedExit?.(reason);
      }
    });
    await this.sleep(1100);
    if (spawnError) throw new Error(`Не удалось запустить winws.exe: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`winws.exe завершился с кодом ${child.exitCode}. Запустите клиент от администратора и закройте другие копии zapret.`);
    return child;
  }

  async stopProcess() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }

  async connect(selectedStrategy) {
    const generation = ++this.generation;
    this.testing = true;
    await this.stopProcess();
    await ensureUserLists(this.runtimeDir);
    try { await this.exec('netsh', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], { windowsHide: true, timeout: 5000 }); }
    catch { /* Only strategies using TCP timestamps need this setting. */ }

    const strategies = await listStrategies(this.runtimeDir);
    const lastWorking = this.hooks.getLastWorking?.();
    const ordered = selectedStrategy
      ? strategies.filter((item) => item.id === selectedStrategy)
      : [...strategies].sort((a, b) => Number(b.id === lastWorking) - Number(a.id === lastWorking));
    if (!ordered.length) throw new Error(selectedStrategy ? 'Выбранная стратегия не найдена' : 'В релизе нет стратегий');

    for (let index = 0; index < ordered.length; index++) {
      if (generation !== this.generation) return null;
      const strategy = ordered[index];
      this.hooks.onProgress?.({ phase: 'testing', strategy: strategy.id, index, total: ordered.length });
      try {
        await this.startProcess(strategy.id);
        if (generation !== this.generation) return null;
        const [youtube, discord] = await Promise.all([
          this.probe('https://www.youtube.com/generate_204', 7000, 204),
          this.probe('https://discord.com/api/v10/gateway', 7000, 200),
        ]);
        if (generation !== this.generation) return null;
        const result = {
          strategy: strategy.id,
          strategyName: strategy.name,
          success: youtube.ok && discord.ok,
          checkedAt: new Date().toISOString(),
          youtube,
          discord,
        };
        await this.hooks.onResult?.(result);
        if (generation !== this.generation) return null;
        if (result.success) {
          this.testing = false;
          this.hooks.onProgress?.({ phase: 'connected', strategy: strategy.id, index, total: ordered.length });
          return result;
        }
      } catch (error) {
        if (generation !== this.generation) return null;
        await this.hooks.onResult?.({
          strategy: strategy.id,
          strategyName: strategy.name,
          success: false,
          checkedAt: new Date().toISOString(),
          error: error.message,
        });
      }
      await this.stopProcess();
    }
    this.testing = false;
    throw new Error('Ни одна стратегия не прошла проверку YouTube и Discord. Проверьте Secure DNS и попробуйте позже.');
  }

  async disconnect() {
    ++this.generation;
    this.testing = false;
    await this.stopProcess();
  }
}

module.exports = { ZapretEngine, listStrategies, naturalName, parseStrategy, tokenize, probe, isProbeSuccessful };
