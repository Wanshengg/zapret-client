const { app, BrowserWindow, ipcMain, shell, Notification, nativeTheme } = require('electron');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { Updater } = require('./updater.cjs');
const { ZapretEngine, listStrategies } = require('./engine.cjs');

let window;
let store;
let updater;
let engine;
let busy = false;
let status = 'disconnected';
let message = null;
let progress = null;
let checkingUpdates = false;
let latest = null;
let strategies = [];

const dataDir = process.env.ZAPRET_CLIENT_DATA || (app.isPackaged
  ? 'C:\\ProgramData\\ZapretClient'
  : path.join(app.getPath('userData'), 'development'));

function publicState() {
  return {
    status,
    message,
    progress,
    busy,
    checkingUpdates,
    activeStrategy: engine?.child ? store?.data.selectedStrategy : null,
    selectedStrategy: store?.data.selectedStrategy ?? null,
    lastWorkingStrategy: store?.data.lastWorkingStrategy ?? null,
    bestStrategy: store?.data.bestStrategy ?? null,
    version: store?.data.version ?? null,
    latestVersion: latest?.version ?? null,
    updateAvailable: Boolean(latest && latest.version !== store?.data.version),
    lastUpdateCheck: store?.data.lastUpdateCheck ?? null,
    results: store?.data.results ?? [],
    settings: store?.data.settings ?? {},
    strategies,
    isElectron: true,
    isPackaged: app.isPackaged,
  };
}

function emit() {
  if (window && !window.isDestroyed()) window.webContents.send('state:changed', publicState());
}

async function refreshStrategies() {
  if (!store.data.version) { strategies = []; return; }
  try { strategies = await listStrategies(updater.runtimeDir); }
  catch { strategies = []; }
  if (!strategies.some((item) => item.id === store.data.selectedStrategy)) {
    store.data.selectedStrategy = strategies[0]?.id ?? null;
  }
  if (!strategies.some((item) => item.id === store.data.bestStrategy)) store.data.bestStrategy = null;
}

function notify(title, body) {
  if (Notification.isSupported() && (!window || window.isMinimized() || !window.isFocused())) {
    new Notification({ title, body }).show();
  }
}

async function installLatest() {
  if (!latest) latest = await updater.check();
  const shouldReconnect = status === 'connected' || status === 'testing';
  if (shouldReconnect) await engine.disconnect();
  status = 'preparing';
  message = `Устанавливаем конфиги ${latest.version}…`;
  emit();
  const version = await updater.install(latest);
  await refreshStrategies();
  status = 'disconnected';
  message = `Конфиги ${version} установлены`;
  emit();
  notify('Zapret Client', message);
  if (shouldReconnect) await connectInternal(null);
}

async function connectInternal(selected) {
  status = 'preparing';
  message = null;
  progress = null;
  emit();
  if (!store.data.version || (latest && latest.version !== store.data.version && store.data.settings.autoUpdate)) {
    if (!latest) latest = await updater.check();
    await installLatest();
  }
  await refreshStrategies();
  const result = await engine.connect(selected);
  if (!result) { status = 'disconnected'; progress = null; emit(); return; }
  store.data.selectedStrategy = result.strategy;
  await store.save();
  status = 'connected';
  message = `Работает: ${result.strategyName}`;
  progress = null;
  emit();
  notify('Подключение установлено', `Рабочая стратегия: ${result.strategyName}`);
}

function dpiMessage(dpi) {
  return {
    clear: 'DPI без блокировки', blocked: 'DPI: возможна блокировка', error: 'DPI: ошибка проверки',
    unsupported: 'DPI: не поддерживается', unknown: 'DPI: нет данных',
  }[dpi?.status ?? 'unknown'];
}

async function checkAllStrategiesInternal() {
  status = 'preparing';
  message = null;
  progress = null;
  await store.patch({ bestStrategy: null });
  emit();
  if (!store.data.version || (latest && latest.version !== store.data.version && store.data.settings.autoUpdate)) {
    if (!latest) latest = await updater.check();
    await installLatest();
  }
  await refreshStrategies();
  const summary = await engine.checkAll();
  if (!summary) { status = 'disconnected'; progress = null; emit(); return; }
  const best = store.data.results.find((result) => result.strategy === summary.bestStrategy);
  if (best) {
    await store.patch({
      selectedStrategy: best.strategy,
      bestStrategy: best.strategy,
      ...(best.success ? { lastWorkingStrategy: best.strategy } : {}),
    });
  }
  status = 'disconnected';
  message = best
    ? `Проверка завершена: ${summary.working}/${summary.checked} рабочих. Лучшая: ${best.strategyName} · HTTP ${best.score ?? 0}/${best.httpTotal ?? 0} · ${dpiMessage(best.dpi)} · ping ${best.avgPing ?? '—'} мс.`
    : `Проверка завершена. Рабочих стратегий: ${summary.working} из ${summary.checked}.`;
  progress = null;
  emit();
  notify('Проверка стратегий завершена', message);
}

async function exclusive(action) {
  if (busy) return;
  busy = true;
  emit();
  try { await action(); }
  catch (error) {
    status = 'disconnected';
    progress = null;
    message = error.message || 'Неизвестная ошибка';
    emit();
  } finally {
    busy = false;
    checkingUpdates = false;
    emit();
  }
}

const connect = (selected) => exclusive(() => connectInternal(selected));
const checkUpdates = (automatic = false) => exclusive(async () => {
  checkingUpdates = true;
  message = automatic ? message : 'Проверяем официальный релиз…';
  emit();
  latest = await updater.check();
  message = latest.version === store.data.version ? `Установлена последняя версия ${latest.version}` : `Доступны конфиги ${latest.version}`;
  emit();
  if (automatic && store.data.settings.autoUpdate && latest.version !== store.data.version) await installLatest();
});

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    show: false,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151a18' : '#f3f5f2',
    title: 'Zapret Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (app.isPackaged) window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else window.loadURL('http://localhost:3000');
}

app.whenReady().then(async () => {
  store = new Store(dataDir);
  await store.load();
  nativeTheme.themeSource = store.data.settings.theme;
  updater = new Updater(dataDir, store);
  engine = new ZapretEngine(updater.runtimeDir, {
    getLastWorking: () => store.data.lastWorkingStrategy,
    onResult: async (result) => { await store.addResult(result); emit(); },
    onProgress: (value) => {
      status = value.phase === 'connected' ? 'connected' : 'testing';
      progress = value;
      const item = strategies.find((strategy) => strategy.id === value.strategy);
      message = value.phase === 'testing' ? `Проверяем ${item?.name ?? value.strategy}` : null;
      emit();
    },
    onUnexpectedExit: (error) => { status = 'disconnected'; message = error; emit(); },
  });
  await refreshStrategies();
  app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtStartup });

  ipcMain.handle('app:get-state', () => publicState());
  ipcMain.handle('app:connect', (_event, selected) => connect(selected));
  ipcMain.handle('app:check-all-strategies', () => exclusive(checkAllStrategiesInternal));
  ipcMain.handle('app:disconnect', () => exclusive(async () => {
    status = 'stopping'; message = null; emit();
    await engine.disconnect();
    status = 'disconnected'; progress = null; emit();
  }));
  ipcMain.handle('app:select-strategy', async (_event, selected) => {
    if (!strategies.some((item) => item.id === selected)) return;
    await store.patch({ selectedStrategy: selected });
    emit();
  });
  ipcMain.handle('app:check-updates', () => checkUpdates(false));
  ipcMain.handle('app:install-update', () => exclusive(installLatest));
  ipcMain.handle('app:set-settings', async (_event, values) => {
    const allowed = (({ autoStrategy, autoUpdate, launchAtStartup, theme }) => ({ autoStrategy, autoUpdate, launchAtStartup, theme }))(values);
    if (allowed.theme !== undefined && !['system', 'light', 'dark'].includes(allowed.theme)) delete allowed.theme;
    await store.patchSettings(allowed);
    app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtStartup });
    nativeTheme.themeSource = store.data.settings.theme;
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151a18' : '#f3f5f2');
    emit();
  });
  ipcMain.handle('app:open-github', () => shell.openExternal('https://github.com/Flowseal/zapret-discord-youtube'));
  ipcMain.handle('app:clear-history', async () => { await store.patch({ results: [], bestStrategy: null }); emit(); });
  ipcMain.handle('window:minimize', () => window.minimize());
  ipcMain.handle('window:close', () => window.close());

  createWindow();
  setTimeout(() => { if (!busy) checkUpdates(true); }, 1800);
  setInterval(() => { if (!busy) checkUpdates(true); }, 6 * 60 * 60 * 1000).unref();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (engine) await engine.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
