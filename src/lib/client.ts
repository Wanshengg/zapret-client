import type { AppState, Settings, StrategyResult, ZapretApi } from '@/types/app'
import { readStoredTheme } from '@/lib/theme'

const names = ['Стандартная', 'ALT', 'ALT2', 'ALT3', 'ALT4', 'ALT5', 'ALT6', 'ALT7', 'ALT8', 'ALT9', 'ALT10', 'ALT11', 'ALT12', 'ALT13', 'EXP', 'FAKE TLS AUTO', 'FAKE TLS AUTO ALT', 'FAKE TLS AUTO ALT2', 'FAKE TLS AUTO ALT3', 'SIMPLE FAKE', 'SIMPLE FAKE ALT', 'SIMPLE FAKE ALT2']
const strategies = names.map((name) => ({ id: name === 'Стандартная' ? 'general.bat' : `general (${name}).bat`, name }))

function mockApi(): ZapretApi {
  let generation = 0
  let state: AppState = {
    status: 'disconnected', message: null, progress: null, busy: false, checkingUpdates: false,
    activeStrategy: null, selectedStrategy: 'general.bat', lastWorkingStrategy: null,
    version: '1.10.4', latestVersion: '1.10.4', updateAvailable: false, lastUpdateCheck: null,
    results: [], settings: { autoStrategy: true, autoUpdate: true, launchAtStartup: false, theme: readStoredTheme() },
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
        const result: StrategyResult = {
          strategy: strategy.id, strategyName: strategy.name, success, checkedAt: new Date().toISOString(),
          youtube: { ok: success || index > 0, code: success || index > 0 ? 204 : 0, latency: 420 + index * 110 },
          discord: { ok: success, code: success ? 200 : 0, latency: 510 + index * 90 },
        }
        state = { ...state, results: [result, ...state.results.filter((item) => item.strategy !== result.strategy)] }
        emit()
        if (success) {
          state = { ...state, status: 'connected', busy: false, activeStrategy: strategy.id, selectedStrategy: strategy.id, lastWorkingStrategy: strategy.id, progress: null, message: `Работает: ${strategy.name}` }
          emit(); return
        }
      }
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
    setSettings: async (settings: Partial<Settings>) => { state = { ...state, settings: { ...state.settings, ...settings } }; emit() },
    openGitHub: async () => { window.open('https://github.com/Flowseal/zapret-discord-youtube', '_blank', 'noopener,noreferrer') },
    clearHistory: async () => { state = { ...state, results: [] }; emit() },
    minimize: async () => { state = { ...state, message: 'В десктопной версии окно будет свёрнуто' }; emit() },
    close: async () => { state = { ...state, message: 'В десктопной версии окно будет закрыто' }; emit() },
  }
}

export const api: ZapretApi = window.zapret ?? mockApi()
