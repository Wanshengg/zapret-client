const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DPI_SUITE_URL = 'https://hyperion-cs.github.io/dpi-checkers/ru/tcp-16-20/suite.v2.json';
const DPI_RANGE_BYTES = 64 * 1024;
const PROTOCOLS = [
  { label: 'HTTP/1.1', args: ['--http1.1'] },
  { label: 'TLS 1.2', args: ['--tlsv1.2', '--tls-max', '1.2'] },
  { label: 'TLS 1.3', args: ['--tlsv1.3', '--tls-max', '1.3'] },
];

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

function parseCurlMetrics(stdout) {
  const match = String(stdout).trim().match(/^(?<code>\d{3})\s+(?<connect>[\d.]+)\s+(?<tls>[\d.]+)\s+(?<total>[\d.]+)$/);
  if (!match?.groups) throw new Error('Не удалось прочитать метрики curl');
  return {
    code: Number(match.groups.code),
    connectLatency: Math.round(Number(match.groups.connect) * 1000),
    tlsLatency: Math.round(Number(match.groups.tls) * 1000),
    latency: Math.round(Number(match.groups.total) * 1000),
  };
}

function isUnsupportedTls(error) {
  const text = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
  return error?.code === 35 || /not supported|unsupported protocol|unsupported option|unsupported feature|schannel|TLS.*not supported/i.test(text);
}

async function probeProtocol(url, protocol, timeout, expectedCode) {
  const started = Date.now();
  try {
    const { stdout } = await exec('curl.exe', [
      '-L', '-sS', '-o', 'NUL', '-w', '%{http_code} %{time_connect} %{time_appconnect} %{time_total}',
      '--connect-timeout', '3', '--max-time', String(Math.ceil(timeout / 1000)),
      ...protocol.args, url,
    ], { windowsHide: true, timeout: timeout + 1500 });
    const metrics = parseCurlMetrics(stdout);
    return { label: protocol.label, ...metrics, ok: isProbeSuccessful(metrics.code, expectedCode) };
  } catch (error) {
    return {
      label: protocol.label, ok: false, code: 0, latency: Date.now() - started,
      connectLatency: 0, tlsLatency: 0, error: error.message, unsupported: isUnsupportedTls(error),
    };
  }
}

async function pingHost(url) {
  const host = new URL(url).hostname.replaceAll("'", "''");
  const script = `$p = New-Object System.Net.NetworkInformation.Ping; try { $r = $p.Send('${host}', 1000); @{ ok = ($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success); latency = [int]$r.RoundtripTime } | ConvertTo-Json -Compress } finally { $p.Dispose() }`;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 2500 });
    const result = JSON.parse(stdout.trim());
    return { ok: Boolean(result.ok), latency: result.ok ? Number(result.latency) : null };
  } catch (error) {
    return { ok: false, latency: null, error: error.message };
  }
}

async function probe(url, timeout = 7000, expectedCode) {
  const [checks, ping] = await Promise.all([
    Promise.all(PROTOCOLS.map((protocol) => probeProtocol(url, protocol, timeout, expectedCode))),
    pingHost(url),
  ]);
  const primary = checks[0];
  return {
    ok: checks.some((check) => check.ok),
    code: primary.code,
    latency: primary.latency,
    connectLatency: primary.connectLatency,
    tlsLatency: primary.tlsLatency,
    error: checks.some((check) => check.ok) ? undefined : primary.error,
    checks,
    ping,
    httpOk: checks.filter((check) => check.ok).length,
    httpTotal: PROTOCOLS.length,
  };
}

async function getDpiTarget() {
  const { stdout } = await exec('curl.exe', ['-L', '-sS', '--connect-timeout', '3', '--max-time', '5', DPI_SUITE_URL], { windowsHide: true, timeout: 6500 });
  const suite = JSON.parse(stdout);
  const target = Array.isArray(suite) ? suite.find((item) => typeof item.host === 'string' && item.host.length > 0) : null;
  return target ? { host: target.host, provider: target.provider || 'DPI checker' } : null;
}

function parseDpiMetrics(stdout) {
  const match = String(stdout ?? '').trim().match(/^(?<code>\d{3})\s+(?<up>\d+)\s+(?<down>\d+)\s+(?<time>[\d.]+)$/m);
  if (!match?.groups) return null;
  return {
    code: Number(match.groups.code),
    uploadedBytes: Number(match.groups.up),
    downloadedBytes: Number(match.groups.down),
    latency: Math.round(Number(match.groups.time) * 1000),
  };
}

async function probeDpiProtocol(target, payloadFile, protocol, timeoutSeconds) {
  const args = [
    '--range', `0-${DPI_RANGE_BYTES - 1}`, '-m', String(timeoutSeconds), '--connect-timeout', '3',
    '-w', '%{http_code} %{size_upload} %{size_download} %{time_total}', '-o', 'NUL',
    '-X', 'POST', '--data-binary', `@${payloadFile}`, '-sS', ...protocol.args, `https://${target.host}`,
  ];
  let error = null;
  let stdout = '';
  try {
    ({ stdout } = await exec('curl.exe', args, { windowsHide: true, timeout: timeoutSeconds * 1000 + 1500 }));
  } catch (caught) {
    error = caught;
    stdout = caught.stdout ?? '';
  }
  const metrics = parseDpiMetrics(stdout) || { code: 0, uploadedBytes: 0, downloadedBytes: 0, latency: timeoutSeconds * 1000 };
  const unsupported = error && isUnsupportedTls(error);
  const likelyBlocked = Boolean(error && metrics.uploadedBytes > 0 && metrics.downloadedBytes === 0 && metrics.latency >= timeoutSeconds * 1000);
  const status = unsupported ? 'unsupported' : likelyBlocked ? 'likely_blocked' : error ? 'fail' : 'ok';
  return { label: protocol.label, status, ...metrics };
}

async function probeDpi(target, payloadFile, timeoutSeconds = 5) {
  if (!target || !payloadFile) return { status: 'unknown', okCount: 0, total: 0, blocked: 0, errors: 0, unsupported: 0, checks: [] };
  const checks = await Promise.all(PROTOCOLS.map((protocol) => probeDpiProtocol(target, payloadFile, protocol, timeoutSeconds)));
  const okCount = checks.filter((check) => check.status === 'ok').length;
  const blocked = checks.filter((check) => check.status === 'likely_blocked').length;
  const unsupported = checks.filter((check) => check.status === 'unsupported').length;
  const errors = checks.filter((check) => check.status === 'fail').length;
  const status = blocked ? 'blocked' : okCount ? 'clear' : unsupported === checks.length ? 'unsupported' : 'error';
  return { status, okCount, total: checks.length, blocked, errors, unsupported, target: target.host, provider: target.provider, checks };
}

function buildStrategyResult(strategy, youtube, discord, dpi) {
  const probes = [youtube, discord];
  const pings = probes.map((item) => item.ping).filter((item) => item?.ok && Number.isFinite(item.latency));
  return {
    strategy: strategy.id,
    strategyName: strategy.name,
    success: youtube.ok && discord.ok,
    checkedAt: new Date().toISOString(),
    youtube,
    discord,
    score: probes.reduce((sum, item) => sum + (item.httpOk ?? (item.ok ? 1 : 0)), 0),
    httpTotal: probes.reduce((sum, item) => sum + (item.httpTotal ?? 1), 0),
    pingOk: probes.filter((item) => item.ping?.ok).length,
    pingTotal: probes.filter((item) => item.ping).length,
    avgPing: pings.length ? Math.round(pings.reduce((sum, item) => sum + item.latency, 0) / pings.length) : null,
    dpi,
  };
}

function dpiPenalty(dpi) {
  return { clear: 0, unsupported: 1, unknown: 2, error: 3, blocked: 4 }[dpi?.status ?? 'unknown'] ?? 2;
}

function averageProbeLatency(result) {
  const values = [result.youtube?.latency, result.discord?.latency].filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY;
}

function compareStrategyResults(a, b) {
  return (b.score ?? 0) - (a.score ?? 0)
    || dpiPenalty(a.dpi) - dpiPenalty(b.dpi)
    || (b.pingOk ?? 0) - (a.pingOk ?? 0)
    || (a.avgPing ?? Number.POSITIVE_INFINITY) - (b.avgPing ?? Number.POSITIVE_INFINITY)
    || averageProbeLatency(a) - averageProbeLatency(b);
}

function selectBestResult(results) {
  let best = null;
  for (const result of results) {
    if (!best || compareStrategyResults(result, best) < 0) best = result;
  }
  return best;
}

class ZapretEngine {
  constructor(runtimeDir, hooks, dependencies = {}) {
    this.runtimeDir = runtimeDir;
    this.hooks = hooks;
    this.spawn = dependencies.spawn ?? spawn;
    this.exec = dependencies.exec ?? exec;
    this.sleep = dependencies.sleep ?? sleep;
    this.probe = dependencies.probe ?? probe;
    this.getDpiTarget = dependencies.getDpiTarget ?? getDpiTarget;
    this.dpiProbe = dependencies.dpiProbe ?? probeDpi;
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
    return this.run(selectedStrategy, false);
  }

  async checkAll() {
    return this.run(null, true);
  }

  async run(selectedStrategy, checkOnly) {
    const generation = ++this.generation;
    this.testing = true;
    const results = [];
    let dpiDirectory = null;
    let dpiTarget = null;
    let dpiPayload = null;
    try {
      await this.stopProcess();
      await ensureUserLists(this.runtimeDir);
      try { await this.exec('netsh', ['interface', 'tcp', 'set', 'global', 'timestamps=enabled'], { windowsHide: true, timeout: 5000 }); }
      catch { /* Only strategies using TCP timestamps need this setting. */ }

      if (checkOnly) {
        try { dpiTarget = await this.getDpiTarget(); } catch { dpiTarget = null; }
        if (dpiTarget) {
          dpiDirectory = await fs.mkdtemp(path.join(this.runtimeDir, '.dpi-test-'));
          dpiPayload = path.join(dpiDirectory, 'payload.bin');
          await fs.writeFile(dpiPayload, randomBytes(DPI_RANGE_BYTES));
        }
      }

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
          const [youtube, discord, dpi] = await Promise.all([
            this.probe('https://www.youtube.com/generate_204', 7000, 204),
            this.probe('https://discord.com/api/v10/gateway', 7000, 200),
            checkOnly ? this.dpiProbe(dpiTarget, dpiPayload) : Promise.resolve(undefined),
          ]);
          if (generation !== this.generation) return null;
          const result = buildStrategyResult(strategy, youtube, discord, dpi);
          results.push(result);
          await this.hooks.onResult?.(result);
          if (generation !== this.generation) return null;
          if (result.success && !checkOnly) {
            this.testing = false;
            this.hooks.onProgress?.({ phase: 'connected', strategy: strategy.id, index, total: ordered.length });
            return result;
          }
        } catch (error) {
          if (generation !== this.generation) return null;
          const result = {
            strategy: strategy.id,
            strategyName: strategy.name,
            success: false,
            checkedAt: new Date().toISOString(),
            error: error.message,
            score: 0,
            httpTotal: PROTOCOLS.length * 2,
            pingOk: 0,
            pingTotal: 0,
            avgPing: null,
          };
          results.push(result);
          await this.hooks.onResult?.(result);
        }
        await this.stopProcess();
      }
      if (checkOnly) {
        const best = selectBestResult(results);
        return { checked: results.length, working: results.filter((result) => result.success).length, bestStrategy: best?.strategy ?? null };
      }
      this.testing = false;
      throw new Error('Ни одна стратегия не прошла проверку YouTube и Discord. Проверьте Secure DNS и попробуйте позже.');
    } finally {
      if (checkOnly && generation === this.generation) {
        await this.stopProcess();
        this.testing = false;
      }
      if (dpiDirectory) await fs.rm(dpiDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async disconnect() {
    ++this.generation;
    this.testing = false;
    await this.stopProcess();
  }
}

module.exports = {
  ZapretEngine, listStrategies, naturalName, parseStrategy, tokenize, probe, isProbeSuccessful,
  parseCurlMetrics, parseDpiMetrics, buildStrategyResult, compareStrategyResults, selectBestResult,
  getDpiTarget, probeDpi,
};
