const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  ZapretEngine, parseStrategy, tokenize, listStrategies, isProbeSuccessful,
  parseCurlMetrics, parseDpiMetrics, selectBestResult,
} = require('./engine.cjs');

const upstream = path.join(__dirname, '..', '..', '.upstream');

async function makeRuntime(t) {
  const runtime = await fs.mkdtemp(path.join(__dirname, '.engine-test-'));
  t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  await fs.mkdir(path.join(runtime, 'lists'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'general.bat'), [
    '@echo off',
    'start "zapret: test" /min "%BIN%winws.exe" --wf-tcp=80,443 --hostlist="%LISTS%list-general.txt" --new',
  ].join('\r\n'));
  return runtime;
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
  };
  return child;
}

function fakeDependencies(child, probe) {
  return {
    spawn: () => child,
    exec: async () => ({ stdout: '', stderr: '' }),
    sleep: async () => {},
    probe: probe ?? (async (url) => ({
      ok: true,
      code: url.includes('youtube') ? 204 : 200,
      latency: 40,
      httpOk: 3,
      httpTotal: 3,
      ping: { ok: true, latency: 30 },
    })),
    getDpiTarget: async () => null,
    dpiProbe: async () => undefined,
  };
}

test('all current upstream strategies produce winws arguments', async () => {
  const strategies = await listStrategies(upstream);
  assert.ok(strategies.length >= 20, `Expected at least 20 strategies, got ${strategies.length}`);
  assert.equal(strategies[0].id, 'general.bat');
  for (const strategy of strategies) {
    const source = await fs.readFile(path.join(upstream, strategy.id), 'utf8');
    const args = parseStrategy(source, 'C:\\ProgramData\\ZapretClient\\runtime');
    assert.ok(args.length > 20, strategy.id);
    assert.ok(args.includes('--new'), strategy.id);
    assert.ok(args.every((arg) => !/%(?:BIN|LISTS|GameFilter)/.test(arg)), strategy.id);
    assert.ok(args.some((arg) => arg.includes('list-general.txt')), strategy.id);
  }
});

test('Windows quoted arguments stay intact', () => {
  assert.deepEqual(tokenize('--hostlist="C:\\a path\\list.txt" --dpi-desync=fake --new'), [
    '--hostlist=C:\\a path\\list.txt', '--dpi-desync=fake', '--new',
  ]);
});

test('unsupported variables fail closed', () => {
  const source = 'start "zapret: test" /min "%BIN%winws.exe" --wf-tcp=%UNKNOWN%';
  assert.throws(() => parseStrategy(source, 'C:\\zapret'), /неподдерживаемую переменную/);
});

test('service probes require their expected HTTP status', () => {
  assert.equal(isProbeSuccessful(204, 204), true);
  assert.equal(isProbeSuccessful(200, 204), false);
  assert.equal(isProbeSuccessful(200, 200), true);
  assert.equal(isProbeSuccessful(403, 200), false);
  assert.equal(isProbeSuccessful(404), false);
});

test('curl and DPI metrics are parsed into milliseconds and bytes', () => {
  assert.deepEqual(parseCurlMetrics('204 0.012345 0.034567 0.056789'), {
    code: 204, connectLatency: 12, tlsLatency: 35, latency: 57,
  });
  assert.deepEqual(parseDpiMetrics('206 65536 16384 5.001'), {
    code: 206, uploadedBytes: 65536, downloadedBytes: 16384, latency: 5001,
  });
  assert.equal(parseDpiMetrics(''), null);
});

function rankedResult(id, score, dpiStatus, pingOk, avgPing) {
  return {
    strategy: id,
    strategyName: id,
    success: score === 6,
    score,
    httpTotal: 6,
    pingOk,
    pingTotal: 2,
    avgPing,
    dpi: { status: dpiStatus },
    youtube: { latency: 40 },
    discord: { latency: 50 },
  };
}

test('best strategy ranks HTTP, DPI, ping availability and latency', () => {
  const slow = rankedResult('slow.bat', 6, 'clear', 2, 80);
  const fast = rankedResult('fast.bat', 6, 'clear', 2, 25);
  const blocked = rankedResult('blocked.bat', 6, 'blocked', 2, 5);
  const lessHttp = rankedResult('less-http.bat', 5, 'clear', 2, 1);
  assert.equal(selectBestResult([slow, fast, blocked, lessHttp]).strategy, 'fast.bat');
  assert.equal(selectBestResult([blocked, slow]).strategy, 'slow.bat');
  assert.equal(selectBestResult([lessHttp, blocked]).strategy, 'blocked.bat');
  const onePing = rankedResult('one-ping.bat', 6, 'clear', 1, 1);
  assert.equal(selectBestResult([onePing, slow]).strategy, 'slow.bat');
});

test('a clean unexpected winws exit is reported', async (t) => {
  const runtime = await makeRuntime(t);
  const child = fakeChild();
  const messages = [];
  const engine = new ZapretEngine(runtime, {
    onUnexpectedExit: (message) => messages.push(message),
  }, fakeDependencies(child));

  const result = await engine.connect('general.bat');
  assert.equal(result.success, true);
  child.exitCode = 0;
  child.emit('exit', 0);
  assert.equal(engine.child, null);
  assert.deepEqual(messages, ['winws.exe самостоятельно остановился']);
});

test('disconnect during service probes cancels the pending connection', async (t) => {
  const runtime = await makeRuntime(t);
  const child = fakeChild();
  const results = [];
  const messages = [];
  let releaseProbes;
  let announceProbes;
  let probeCount = 0;
  const probeResults = new Promise((resolve) => { releaseProbes = resolve; });
  const probesStarted = new Promise((resolve) => { announceProbes = resolve; });
  const engine = new ZapretEngine(runtime, {
    onResult: async (result) => { results.push(result); },
    onUnexpectedExit: (message) => messages.push(message),
  }, fakeDependencies(child, () => {
    probeCount += 1;
    if (probeCount === 2) announceProbes();
    return probeResults;
  }));

  const connecting = engine.connect('general.bat');
  await probesStarted;
  await engine.disconnect();
  releaseProbes({ ok: true, code: 200, latency: 1 });
  assert.equal(await connecting, null);
  assert.deepEqual(results, []);
  assert.deepEqual(messages, []);
});

test('full strategy check tests every config, selects the best and cleans up', async (t) => {
  const runtime = await makeRuntime(t);
  const source = await fs.readFile(path.join(runtime, 'general.bat'), 'utf8');
  await fs.writeFile(path.join(runtime, 'general (ALT).bat'), source);
  const children = [];
  const results = [];
  const progress = [];
  const dependencies = fakeDependencies(null);
  dependencies.spawn = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  dependencies.getDpiTarget = async () => ({ host: 'test.example.com', provider: 'Test' });
  dependencies.dpiProbe = async () => ({ status: 'clear', okCount: 3, total: 3, blocked: 0, errors: 0, unsupported: 0, checks: [] });
  dependencies.probe = async (url) => ({
    ok: true,
    code: url.includes('youtube') ? 204 : 200,
    latency: children.length === 1 ? 90 : 35,
    httpOk: 3,
    httpTotal: 3,
    ping: { ok: true, latency: children.length === 1 ? 80 : 25 },
  });
  const engine = new ZapretEngine(runtime, {
    onResult: async (result) => { results.push(result); },
    onProgress: (value) => { progress.push(value); },
  }, dependencies);

  const summary = await engine.checkAll();
  assert.deepEqual(summary, { checked: 2, working: 2, bestStrategy: 'general (ALT).bat' });
  assert.equal(results.length, 2);
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.exitCode === 0));
  assert.equal(engine.child, null);
  assert.equal(engine.testing, false);
  assert.ok(progress.every((item) => item.phase === 'testing'));
  assert.equal(results[0].score, 6);
  assert.equal(results[1].avgPing, 25);
  assert.ok(!(await fs.readdir(runtime)).some((name) => name.startsWith('.dpi-test-')));
});
