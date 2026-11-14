export type ConnectionStatus = 'disconnected' | 'preparing' | 'testing' | 'connected' | 'stopping'

export interface Strategy {
  id: string
  name: string
}

export interface PingResult {
  ok: boolean
  latency: number | null
  error?: string
}

export interface ProtocolCheck {
  label: string
  ok: boolean
  code: number
  latency: number
  connectLatency?: number
  tlsLatency?: number
  error?: string
  unsupported?: boolean
}

export interface ProbeResult {
  ok: boolean
  code: number
  latency: number
  connectLatency?: number
  tlsLatency?: number
  error?: string
  checks?: ProtocolCheck[]
  ping?: PingResult
  httpOk?: number
  httpTotal?: number
}

export type DpiStatus = 'clear' | 'blocked' | 'error' | 'unsupported' | 'unknown'

export interface DpiProtocolCheck {
  label: string
  status: 'ok' | 'likely_blocked' | 'fail' | 'unsupported'
  code: number
  uploadedBytes: number
  downloadedBytes: number
  latency: number
}

export interface DpiResult {
  status: DpiStatus
  okCount: number
  total: number
  blocked: number
  errors: number
  unsupported: number
  target?: string
  provider?: string
  checks?: DpiProtocolCheck[]
}

export interface StrategyResult {
  strategy: string
  strategyName: string
  success: boolean
  checkedAt: string
  youtube?: ProbeResult
  discord?: ProbeResult
  error?: string
  score?: number
  httpTotal?: number
  pingOk?: number
  pingTotal?: number
  avgPing?: number | null
  dpi?: DpiResult
}

export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  autoStrategy: boolean
  autoUpdate: boolean
  launchAtStartup: boolean
  theme: Theme
}

export interface Progress {
  phase: string
  strategy: string
  index: number
  total: number
}

export interface AppState {
  status: ConnectionStatus
  message: string | null
  progress: Progress | null
  busy: boolean
  checkingUpdates: boolean
  activeStrategy: string | null
  selectedStrategy: string | null
  lastWorkingStrategy: string | null
  bestStrategy: string | null
  version: string | null
  latestVersion: string | null
  updateAvailable: boolean
  lastUpdateCheck: string | null
  results: StrategyResult[]
  settings: Settings
  strategies: Strategy[]
  isElectron: boolean
  isPackaged: boolean
}

export interface ZapretApi {
  getState(): Promise<AppState>
  connect(strategy?: string | null): Promise<void>
  checkAllStrategies(): Promise<void>
  disconnect(): Promise<void>
  selectStrategy(strategy: string): Promise<void>
  checkUpdates(): Promise<void>
  installUpdate(): Promise<void>
  setSettings(settings: Partial<Settings>): Promise<void>
  openGitHub(): Promise<void>
  clearHistory(): Promise<void>
  minimize(): Promise<void>
  close(): Promise<void>
  onState(callback: (state: AppState) => void): () => void
}

declare global {
  interface Window {
    zapret?: ZapretApi
  }
}
