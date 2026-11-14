import type { AppState, DpiResult, ProtocolCheck, Settings, Strategy, StrategyResult, ZapretApi } from '@/types/app'
import { readStoredTheme } from '@/lib/theme'

const names = ['Стандартная', 'ALT', 'ALT2', 'ALT3', 'ALT4', 'ALT5', 'ALT6', 'ALT7', 'ALT8', 'ALT9', 'ALT10', 'ALT11', 'ALT12', 'ALT13', 'EXP', 'FAKE TLS AUTO', 'FAKE TLS AUTO ALT', 'FAKE TLS AUTO ALT2', 'FAKE TLS AUTO ALT3', 'SIMPLE FAKE', 'SIMPLE FAKE ALT', 'SIMPLE FAKE ALT2']
const strategies = names.map((name) => ({ id: name === 'Стандартная' ? 'general.bat' : `general (${name}).bat`, name }))

function makeChecks(okCount: number, code: number, latency: number): ProtocolCheck[] {
  return ['HTTP/1.1', 'TLS 1.2', 'TLS 1.3'].map((label, index) => ({
    label, ok: index < okCount, code: index < okCount ? code : 0,
    latency: latency + index * 7, connectLatency: 12 + index * 2, tlsLatency: 28 + index * 3,
  }))
}

function makeProbe(okCount: number, code: number, latency: number, ping: number | null) {
  return {
    ok: okCount > 0, code: okCount ? code : 0, latency, checks: makeChecks(okCount, code, latency),
    ping: { ok: ping !== null, latency: ping }, httpOk: okCount, httpTotal: 3,
  }
}

function makeMockResult(strategy: Strategy, index: number, success: boolean): StrategyResult {
  const httpOk = success ? (index === 8 ? 6 : 5) : index % 3
  const youtubeOk = success ? 3 : Math.min(2, httpOk)
  const discordOk = success ? httpOk - 3 : 0
  const youtubePing = index % 5 === 0 ? null : 25 + index * 2
  const discordPing = 30 + index * 2
  const pings = [youtubePing, discordPing].filter((value): value is number => value !== null)
  const dpiStatus = index === 8 ? 'clear' : index % 4 === 0 ? 'blocked' : index % 5 === 0 ? 'unsupported' : index % 3 === 0 ? 'unknown' : 'clear'
  const dpi: DpiResult = {
    status: dpiStatus, okCount: dpiStatus === 'clear' ? 3 : 0, total: 3,
    blocked: dpiStatus === 'blocked' ? 1 : 0, errors: 0, unsupported: dpiStatus === 'unsupported' ? 3 : 0,
    target: 'cdn.example.com', provider: 'Cloudflare', checks: [],
  }
  return {
    strategy: strategy.id, strategyName: strategy.name, success, checkedAt: new Date().toISOString(),
    youtube: makeProbe(youtubeOk, 204, 38 + index, youtubePing),
    discord: makeProbe(discordOk, 200, 46 + index, discordPing),
    score: httpOk, httpTotal: 6, pingOk: pings.length, pingTotal: 2,
    avgPing: pings.length ? Math.round(pings.reduce((sum, value) => sum + value, 0) / pings.length) : null,
    dpi,
  }
}

function dpiMessage(dpi?: DpiResult) {
  return { clear: 'DPI без блокировки', blocked: 'DPI: возможна блокировка', error: 'DPI: ошибка проверки', unsupported: 'DPI: не поддерживается', unknown: 'DPI: нет данных' }[dpi?.status ?? 'unknown']
}

function mockApi(): ZapretApi {
  let generation = 0
  let state: AppState = {
    status: 'disconnected', message: null, progress: null, busy: false, checkingUpdates: false,
    activeStrategy: null, selectedStrategy: 'general.bat', lastWorkingStrategy: null, bestStrategy: null,
    version: '1.10.4', latestVersion: '1.10.4', updateAvailable: false, lastUpdateCheck: null,
    appVersion: '0.1.1', latestAppVersion: '0.1.1', appUpdateAvailable: false,
    lastAppUpdateCheck: null, checkingAppUpdates: false, appUpdateError: null,
    results: [], settings: { autoStrategy: true, autoConnect: true, autoUpdate: true, launchAtStartup: false, theme: readStoredTheme() },
    strategies, isElectron: false, isPackaged: false,
  }
  const listeners = new Set<(state: AppState) => void>()
  const emit = () => listeners.forEach((listener) => listener({ ...state }))
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    getState: async () => ({ ...state }),
    onState: (callback) => { listeners.add(callback); return () => listeners.delete(callback) },
    connect: async (selected) => {
      const current = ++generation
      state = { ...state, busy: true, status: 'preparing', message: 'Готовим оригинальные конфиги…', activeStrategy: null }
      emit(); await wait(450)
      const candidates = selected ? strategies.filter((item) => item.id === selected) : strategies.slice(0, 3)
      for (let index = 0; index < candidates.length; index++) {
        if (current !== generation) return
        const strategy = candidates[index]
        state = { ...state, status: 'testing', progress: { phase: 'testing', strategy: strategy.id, index, total: candidates.length }, message: `Проверяем ${strategy.name}` }
        emit(); await wait(650)
        const success = Boolean(selected) || index === 2
        const result = makeMockResult(strategy, strategies.indexOf(strategy), success)
        state = { ...state, results: [result, ...state.results.filter((item) => item.strategy !== result.strategy)] }
        emit()
        if (success) {
          state = { ...state, status: 'connected', busy: false, activeStrategy: strategy.id, selectedStrategy: strategy.id, lastWorkingStrategy: strategy.id, progress: null, message: `Работает: ${strategy.name}` }
          emit(); return
        }
      }
    },
    checkAllStrategies: async () => {
      const current = ++generation
      const checkedResults: StrategyResult[] = []
      state = { ...state, busy: true, status: 'preparing', message: 'Готовим проверку всех стратегий…', activeStrategy: null, bestStrategy: null }
      emit(); await wait(300)
      for (let index = 0; index < strategies.length; index++) {
        if (current !== generation) return
        const strategy = strategies[index]
        state = { ...state, status: 'testing', progress: { phase: 'testing', strategy: strategy.id, index, total: strategies.length }, message: `Проверяем ${strategy.name}` }
        emit(); await wait(350)
        const result = makeMockResult(strategy, index, index % 3 === 2)
        checkedResults.push(result)
        state = { ...state, results: [result, ...state.results.filter((item) => item.strategy !== result.strategy)] }
        emit()
      }
      if (current !== generation) return
      const dpiRank = { clear: 0, unsupported: 1, unknown: 2, error: 3, blocked: 4 }
      const best = [...checkedResults].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
        || dpiRank[a.dpi?.status ?? 'unknown'] - dpiRank[b.dpi?.status ?? 'unknown']
        || (b.pingOk ?? 0) - (a.pingOk ?? 0)
        || (a.avgPing ?? Infinity) - (b.avgPing ?? Infinity))[0]
      const working = checkedResults.filter((result) => result.success).length
      state = {
        ...state, busy: false, status: 'disconnected', progress: null,
        selectedStrategy: best?.strategy ?? state.selectedStrategy,
        bestStrategy: best?.strategy ?? null,
        lastWorkingStrategy: best?.success ? best.strategy : state.lastWorkingStrategy,
        message: best
          ? `Проверка завершена: ${working}/${checkedResults.length} рабочих. Лучшая: ${best.strategyName} · HTTP ${best.score ?? 0}/${best.httpTotal ?? 0} · ${dpiMessage(best.dpi)} · ping ${best.avgPing ?? '—'} мс.`
          : 'Проверка завершена.',
      }
      emit()
    },
    disconnect: async () => {
      ++generation; state = { ...state, busy: true, status: 'stopping', message: null }; emit(); await wait(300)
      state = { ...state, busy: false, status: 'disconnected', activeStrategy: null, progress: null }; emit()
    },
    selectStrategy: async (strategy) => { state = { ...state, selectedStrategy: strategy }; emit() },
    checkUpdates: async () => {
      state = { ...state, busy: true, checkingUpdates: true, message: 'Проверяем официальный релиз…' }; emit(); await wait(650)
      state = { ...state, busy: false, checkingUpdates: false, lastUpdateCheck: new Date().toISOString(), latestVersion: '1.10.4', updateAvailable: false, message: 'Установлена последняя версия 1.10.4' }; emit()
    },
    installUpdate: async () => { state = { ...state, updateAvailable: false, version: state.latestVersion }; emit() },
    checkAppUpdate: async () => {
      state = { ...state, checkingAppUpdates: true, appUpdateError: null, message: 'Проверяем обновление программы…' }; emit(); await wait(650)
      state = { ...state, checkingAppUpdates: false, lastAppUpdateCheck: new Date().toISOString(), latestAppVersion: state.appVersion, appUpdateAvailable: false, message: `Установлена последняя версия программы ${state.appVersion}` }; emit()
    },
    openAppUpdate: async () => { window.open('https://github.com/Wanshengg/zapret-client/releases/latest', '_blank', 'noopener,noreferrer') },
    setSettings: async (settings: Partial<Settings>) => { state = { ...state, settings: { ...state.settings, ...settings } }; emit() },
    openGitHub: async () => { window.open('https://github.com/Flowseal/zapret-discord-youtube', '_blank', 'noopener,noreferrer') },
    clearHistory: async () => { state = { ...state, results: [], bestStrategy: null }; emit() },
    minimize: async () => { state = { ...state, message: 'В десктопной версии окно будет свёрнуто' }; emit() },
    close: async () => { state = { ...state, message: 'В десктопной версии окно будет закрыто' }; emit() },
  }
}

export const api: ZapretApi = window.zapret ?? mockApi()
