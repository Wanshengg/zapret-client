const { app, BrowserWindow, ipcMain, shell, Notification, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { Updater } = require('./updater.cjs');
const { githubLatestApp } = require('./app-updater.cjs');
const { ZapretEngine, listStrategies } = require('./engine.cjs');

let window;
let tray;
let store;
let updater;
let engine;
let busy = false;
let status = 'disconnected';
let message = null;
let progress = null;
let checkingUpdates = false;
let checkingAppUpdates = false;
let latest = null;
let latestApp = null;
let lastAppUpdateCheck = null;
let appUpdateError = null;
let strategies = [];
let isQuitting = false;
let trayHintShown = false;

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
    checkingAppUpdates,
    activeStrategy: engine?.child ? store?.data.selectedStrategy : null,
    selectedStrategy: store?.data.selectedStrategy ?? null,
    lastWorkingStrategy: store?.data.lastWorkingStrategy ?? null,
    bestStrategy: store?.data.bestStrategy ?? null,
    version: store?.data.version ?? null,
    latestVersion: latest?.version ?? null,
    updateAvailable: Boolean(latest && latest.version !== store?.data.version),
    lastUpdateCheck: store?.data.lastUpdateCheck ?? null,
    appVersion: app.getVersion(),
    latestAppVersion: latestApp?.version ?? null,
    appUpdateAvailable: Boolean(latestApp?.available),
    lastAppUpdateCheck,
    appUpdateError,
    results: store?.data.results ?? [],
    settings: store?.data.settings ?? {},
    strategies,
    isElectron: true,
    isPackaged: app.isPackaged,
  };
}

function trayStatus() {
  return {
    connected: 'подключено', disconnected: 'не подключено', preparing: 'подготовка',
    testing: 'подбор стратегии', stopping: 'отключение',
  }[status] ?? status;
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`Zapret Client — ${trayStatus()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Zapret Client', click: showWindow },
    { type: 'separator' },
    { label: 'Подключить', enabled: !busy && status === 'disconnected', click: () => connect(preferredStrategy()) },
    { label: 'Отключить', enabled: !busy && status === 'connected', click: () => disconnect() },
    { type: 'separator' },
    { label: 'Выход', click: () => quitApp() },
  ]));
}

function emit() {
  if (window && !window.isDestroyed()) window.webContents.send('state:changed', publicState());
  updateTray();
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
  const windowHidden = !window || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !window.isFocused();
  if (Notification.isSupported() && windowHidden) new Notification({ title, body }).show();
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

function preferredStrategy() {
  return store.data.settings.autoStrategy ? null : store.data.selectedStrategy;
}

const connect = (selected) => exclusive(() => connectInternal(selected));
const disconnect = () => exclusive(async () => {
  status = 'stopping'; message = null; emit();
  await engine.disconnect();
  status = 'disconnected'; progress = null; emit();
});
const checkUpdates = (automatic = false) => exclusive(async () => {
  checkingUpdates = true;
  message = automatic ? message : 'Проверяем официальный релиз…';
  emit();
  latest = await updater.check();
  message = latest.version === store.data.version ? `Установлена последняя версия ${latest.version}` : `Доступны конфиги ${latest.version}`;
  emit();
  if (automatic && store.data.settings.autoUpdate && latest.version !== store.data.version) await installLatest();
});

async function checkAppUpdates(automatic = false) {
  if (checkingAppUpdates) return;
  checkingAppUpdates = true;
  appUpdateError = null;
  if (!automatic) message = 'Проверяем обновление программы…';
  emit();
  try {
    const previousVersion = latestApp?.version;
    latestApp = await githubLatestApp(app.getVersion());
    lastAppUpdateCheck = new Date().toISOString();
    if (!automatic) {
      message = latestApp.available
        ? `Доступна новая версия программы ${latestApp.version}`
        : `Установлена последняя версия программы ${app.getVersion()}`;
    }
    if (latestApp.available && previousVersion !== latestApp.version) {
      notify('Доступно обновление Zapret Client', `Версия ${latestApp.version} доступна для загрузки.`);
    }
  } catch (error) {
    appUpdateError = error.message || 'Не удалось проверить обновление программы';
    if (!automatic) message = appUpdateError;
  } finally {
    checkingAppUpdates = false;
    emit();
  }
}

function showWindow() {
  if (!window || window.isDestroyed()) { createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function hideWindowToTray() {
  if (!window || window.isDestroyed()) return;
  window.hide();
  if (!trayHintShown) {
    trayHintShown = true;
    notify('Zapret Client продолжает работать', 'Окно можно открыть через значок в системном трее. Для полного выхода используйте меню значка.');
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  updateTray();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    show: false,
    frame: false,
    icon: path.join(__dirname, 'tray-icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151a18' : '#f3f5f2',
    title: 'Zapret Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => { if (!isQuitting) window.show(); });
  window.on('minimize', (event) => { event.preventDefault(); hideWindowToTray(); });
  window.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); hideWindowToTray(); }
  });
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (app.isPackaged) window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else window.loadURL('http://localhost:3000');
}

async function runStartupTasks() {
  void checkAppUpdates(true);
  await checkUpdates(true);
  if (store.data.settings.autoConnect && !busy && status === 'disconnected') await connect(preferredStrategy());
}

async function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  try { await engine?.disconnect(); }
  catch { /* Continue quitting even if winws has already stopped. */ }
  finally { app.quit(); }
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
  ipcMain.handle('app:disconnect', () => disconnect());
  ipcMain.handle('app:select-strategy', async (_event, selected) => {
    if (!strategies.some((item) => item.id === selected)) return;
    await store.patch({ selectedStrategy: selected });
    emit();
  });
  ipcMain.handle('app:check-updates', () => checkUpdates(false));
  ipcMain.handle('app:install-update', () => exclusive(installLatest));
  ipcMain.handle('app:check-app-update', () => checkAppUpdates(false));
  ipcMain.handle('app:open-app-update', async () => {
    if (!latestApp) await checkAppUpdates(false);
    await shell.openExternal(latestApp?.downloadUrl ?? 'https://github.com/Wanshengg/zapret-client/releases/latest');
  });
  ipcMain.handle('app:set-settings', async (_event, values) => {
    const allowed = (({ autoStrategy, autoConnect, autoUpdate, launchAtStartup, theme }) => ({ autoStrategy, autoConnect, autoUpdate, launchAtStartup, theme }))(values);
    if (allowed.theme !== undefined && !['system', 'light', 'dark'].includes(allowed.theme)) delete allowed.theme;
    await store.patchSettings(allowed);
    app.setLoginItemSettings({ openAtLogin: store.data.settings.launchAtStartup });
    nativeTheme.themeSource = store.data.settings.theme;
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151a18' : '#f3f5f2');
    emit();
  });
  ipcMain.handle('app:open-github', () => shell.openExternal('https://github.com/Flowseal/zapret-discord-youtube'));
  ipcMain.handle('app:clear-history', async () => { await store.patch({ results: [], bestStrategy: null }); emit(); });
  ipcMain.handle('window:minimize', () => hideWindowToTray());
  ipcMain.handle('window:close', () => window.close());

  createTray();
  createWindow();
  setTimeout(() => { void runStartupTasks(); }, 1200);
  setInterval(() => {
    void checkAppUpdates(true);
    if (!busy) void checkUpdates(true);
  }, 6 * 60 * 60 * 1000).unref();
  app.on('activate', showWindow);
});

app.on('before-quit', (event) => {
  if (!isQuitting) { event.preventDefault(); void quitApp(); }
});
