import { useEffect, useMemo, useState } from 'react'
import {
  Activity, Check, CheckCircle2, ChevronRight, Circle, Download,
  ExternalLink, Github, History, ListChecks, LoaderCircle, Minus, Power,
  RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, Wifi, X, Zap,
} from 'lucide-react'
import { api } from '@/lib/client'
import type { AppState, Settings } from '@/types/app'
import './App.css'

type Page = 'connection' | 'strategies' | 'history' | 'settings'

const pageMeta: Record<Page, { title: string; subtitle: string }> = {
  connection: { title: 'Подключение', subtitle: 'YouTube и Discord — без ручного запуска скриптов' },
  strategies: { title: 'Стратегии', subtitle: 'Оригинальные конфиги из релиза Flowseal' },
  history: { title: 'Журнал проверок', subtitle: 'Реальные HTTPS-запросы к YouTube и Discord' },
  settings: { title: 'Настройки', subtitle: 'Обновления, автоподбор и запуск приложения' },
}

const statusText = {
  disconnected: 'Не подключено', preparing: 'Подготовка', testing: 'Подбор стратегии',
  connected: 'Подключено', stopping: 'Отключение',
}

function formatTime(value: string | null) {
  if (!value) return 'Ещё не проверялось'
  return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <button type="button" className={`toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span /></button>
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [page, setPage] = useState<Page>('connection')

  useEffect(() => {
    let mounted = true
    api.getState().then((value) => { if (mounted) setState(value) })
    const unsubscribe = api.onState((value) => { if (mounted) setState(value) })
    return () => { mounted = false; unsubscribe() }
  }, [])

  const strategyName = useMemo(() => {
    const id = state?.activeStrategy || state?.lastWorkingStrategy
    return state?.strategies.find((item) => item.id === id)?.name ?? 'Не выбрана'
  }, [state])

  if (!state) return <div className="boot"><Zap size={26} /><span>Запускаем Zapret Client…</span></div>

  const connected = state.status === 'connected'
  const working = state.busy || state.status === 'testing' || state.status === 'preparing'
  const selectPage = (next: Page) => setPage(next)
  const updateSetting = (key: keyof Settings) => api.setSettings({ [key]: !state.settings[key] })

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar-brand"><span className="mini-mark"><Zap size={13} fill="currentColor" /></span>Zapret Client</div>
        <div className="titlebar-center">WINDOWS · {state.version ? `CONFIGS ${state.version}` : 'CONFIGS NOT INSTALLED'}</div>
        {state.isElectron && <div className="window-controls">
          <button aria-label="Свернуть" onClick={() => api.minimize()}><Minus size={15} /></button>
          <button aria-label="Закрыть" className="window-close" onClick={() => api.close()}><X size={15} /></button>
        </div>}
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="brand"><span className="brand-mark"><Zap size={23} fill="currentColor" /></span><div><strong>zapret</strong><span>client</span></div></div>
          <nav className="navigation" aria-label="Основная навигация">
            {([
              ['connection', Wifi, 'Подключение'], ['strategies', ListChecks, 'Стратегии'],
              ['history', History, 'Журнал'], ['settings', Settings2, 'Настройки'],
            ] as const).map(([id, Icon, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => selectPage(id)}><Icon size={18} /><span>{label}</span>{id === 'history' && state.results.length > 0 && <b>{state.results.length}</b>}</button>)}
          </nav>
          <div className="sidebar-bottom">
            <div className="source-note"><ShieldCheck size={17} /><span>Оригинальное ядро<br />и конфиги Flowseal</span></div>
            <button className="github-link" onClick={() => api.openGitHub()}><Github size={16} />GitHub проекта<ExternalLink size={12} /></button>
          </div>
        </aside>

        <main className="main-content">
          <div className="page-heading">
            <div><h1>{pageMeta[page].title}</h1><p>{pageMeta[page].subtitle}</p></div>
            <div className={`connection-chip ${connected ? 'online' : ''}`}><span />{statusText[state.status]}</div>
          </div>

          {page === 'connection' && <section className="connection-layout">
            <div className="connect-zone">
              <div className="connect-copy"><span className="section-label">ОДНА КНОПКА</span><h2>{connected ? 'Соединение работает' : 'Всё остальное — мы сделаем сами'}</h2><p>{connected ? 'Клиент проверил доступность сервисов и оставил рабочую стратегию включённой.' : 'Загрузим свежие конфиги, проверим стратегии и включим первую рабочую.'}</p></div>
              <div className={`power-wrap ${working ? 'is-working' : ''} ${connected ? 'is-connected' : ''}`}>
                <div className="orbit orbit-one" /><div className="orbit orbit-two" />
                <button className="power-button" disabled={working || state.status === 'stopping'} onClick={() => connected ? api.disconnect() : api.connect(state.settings.autoStrategy ? null : state.selectedStrategy)} aria-label={connected ? 'Отключить zapret' : 'Подключить zapret'}>
                  {working ? <LoaderCircle className="spin" size={42} /> : <Power size={44} strokeWidth={1.7} />}
                </button>
              </div>
              <div className="connect-status"><strong>{statusText[state.status]}</strong><span>{state.progress ? `${state.progress.index + 1} / ${state.progress.total}` : connected ? strategyName : 'Нажмите, чтобы начать'}</span></div>
              {state.progress && <div className="progress-track"><span style={{ width: `${((state.progress.index + 1) / state.progress.total) * 100}%` }} /></div>}
            </div>

            <div className="connection-details">
              <span className="section-label light">ТЕКУЩЕЕ СОСТОЯНИЕ</span>
              <div className="active-strategy"><span className="strategy-icon"><SlidersHorizontal size={20} /></span><div><small>{connected ? 'Рабочая стратегия' : 'Последняя рабочая'}</small><strong>{strategyName}</strong></div></div>
              <div className="detail-rows">
                <div><span>Версия конфигов</span><strong>{state.version ?? 'Загрузится автоматически'}</strong></div>
                <div><span>Проверка обновлений</span><strong>{formatTime(state.lastUpdateCheck)}</strong></div>
                <div><span>Режим выбора</span><strong>{state.settings.autoStrategy ? 'Автоматический' : 'Вручную'}</strong></div>
              </div>
              <div className="verified-note"><CheckCircle2 size={18} /><p><strong>Не просто процесс запущен</strong><span>Проверяем HTTPS-доступ к YouTube и Discord.</span></p></div>
            </div>
          </section>}

          {page === 'strategies' && <section className="page-section">
            <div className="section-toolbar"><div><strong>{state.strategies.length || '—'} стратегий</strong><span>{state.settings.autoStrategy ? 'Автоподбор начнётся с последней рабочей' : 'Будет запущена только выбранная стратегия'}</span></div><button className="button primary" disabled={working || !state.selectedStrategy} onClick={() => api.connect(state.selectedStrategy)}><Power size={16} />Проверить и подключить</button></div>
            <div className="strategy-table">
              <div className="strategy-table-head"><span>Стратегия</span><span>YouTube</span><span>Discord</span><span>Результат</span></div>
              {state.strategies.length === 0 && <div className="empty-state"><Download size={24} /><strong>Конфиги ещё не загружены</strong><span>Подключитесь — клиент скачает последний официальный релиз.</span></div>}
              {state.strategies.map((strategy) => {
                const result = state.results.find((item) => item.strategy === strategy.id)
                const selected = state.selectedStrategy === strategy.id
                return <button className={`strategy-row ${selected ? 'selected' : ''}`} key={strategy.id} onClick={() => api.selectStrategy(strategy.id)}>
                  <span className="strategy-name"><i>{selected && <Check size={12} />}</i><span><strong>{strategy.name}</strong><small>{strategy.id}</small></span></span>
                  <ProbeCell ok={result?.youtube?.ok} code={result?.youtube?.code} /><ProbeCell ok={result?.discord?.ok} code={result?.discord?.code} />
                  <span>{result ? <b className={`result-badge ${result.success ? 'success' : 'failed'}`}>{result.success ? 'Работает' : 'Не подошла'}</b> : <b className="result-badge">Не проверена</b>}</span>
                </button>
              })}
            </div>
          </section>}

          {page === 'history' && <section className="page-section">
            <div className="section-toolbar"><div><strong>Результаты последней проверки</strong><span>HTTP-код и время ответа сохраняются локально</span></div><button className="button secondary" disabled={!state.results.length} onClick={() => api.clearHistory()}>Очистить журнал</button></div>
            {state.results.length === 0 ? <div className="empty-state large"><Activity size={28} /><strong>Здесь появятся результаты</strong><span>После подключения вы увидите, какие стратегии сработали.</span></div> : <div className="history-list">{state.results.map((result) => <article className="history-item" key={result.strategy}>
              <div className="history-top"><div className={`history-status ${result.success ? 'success' : ''}`}>{result.success ? <CheckCircle2 size={18} /> : <Circle size={16} />}<strong>{result.strategyName}</strong></div><time>{formatTime(result.checkedAt)}</time></div>
              <div className="history-probes"><ProbeDetail name="YouTube" probe={result.youtube} /><ProbeDetail name="Discord" probe={result.discord} /></div>
              {result.error && <p className="error-text">{result.error}</p>}
            </article>)}</div>}
          </section>}

          {page === 'settings' && <section className="settings-layout">
            <div className="settings-group"><span className="section-label">ПОВЕДЕНИЕ</span>
              <SettingRow title="Автоматически подбирать стратегию" text="Сначала проверяем последнюю рабочую, затем остальные"><Toggle label="Автоматический подбор" checked={state.settings.autoStrategy} onChange={() => updateSetting('autoStrategy')} /></SettingRow>
              <SettingRow title="Обновлять конфиги автоматически" text="Каждые 6 часов проверяем официальный релиз GitHub"><Toggle label="Автоматическое обновление" checked={state.settings.autoUpdate} onChange={() => updateSetting('autoUpdate')} /></SettingRow>
              <SettingRow title="Запускать клиент вместе с Windows" text="Подключение после запуска остаётся под вашим контролем"><Toggle label="Автозапуск" checked={state.settings.launchAtStartup} onChange={() => updateSetting('launchAtStartup')} /></SettingRow>
            </div>
            <div className="update-panel"><div><span className="section-label">ОБНОВЛЕНИЕ КОНФИГОВ</span><h3>{state.updateAvailable ? `Доступна версия ${state.latestVersion}` : `Установлена ${state.version ?? '—'}`}</h3><p>Последняя проверка: {formatTime(state.lastUpdateCheck)}</p></div>
              {state.updateAvailable ? <button className="button primary" disabled={state.busy} onClick={() => api.installUpdate()}><Download size={16} />Установить обновление</button> : <button className="button secondary" disabled={state.busy} onClick={() => api.checkUpdates()}><RefreshCw size={16} className={state.checkingUpdates ? 'spin' : ''} />Проверить сейчас</button>}
              <small><ShieldCheck size={14} />ZIP скачивается только из официального релиза. SHA-256 сверяется до установки.</small>
            </div>
          </section>}

          {!state.isElectron && <div className="browser-note">Предпросмотр интерфейса: сетевой движок доступен в Windows-приложении.</div>}
          {state.message && <div className={`message ${state.status === 'disconnected' && !state.busy ? 'attention' : ''}`} role="status"><Activity size={15} /><span>{state.message}</span>{page !== 'connection' && <button aria-label="Показать подключение" onClick={() => setPage('connection')}><ChevronRight size={15} /></button>}</div>}
        </main>
      </div>
    </div>
  )
}

function ProbeCell({ ok, code }: { ok?: boolean; code?: number }) {
  return <span className={`probe-cell ${ok === undefined ? '' : ok ? 'ok' : 'fail'}`}>{ok === undefined ? '—' : ok ? <Check size={14} /> : <X size={14} />}{code ? `${code}` : ok === undefined ? '' : 'ошибка'}</span>
}

function ProbeDetail({ name, probe }: { name: string; probe?: { ok: boolean; code: number; latency: number } }) {
  return <div><span>{name}</span><strong className={probe?.ok ? 'text-success' : 'text-failed'}>{probe?.ok ? 'Доступен' : 'Нет ответа'}</strong><small>{probe ? `${probe.code || '—'} · ${probe.latency} мс` : 'Запуск не удался'}</small></div>
}

function SettingRow({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{text}</p></div>{children}</div>
}

export default App
