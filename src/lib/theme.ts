import type { Theme } from '@/types/app'

const STORAGE_KEY = 'zapret-client-theme'

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch { /* Storage can be unavailable in restricted preview contexts. */ }
  return 'system'
}

export function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themePreference = theme
  try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* The Electron store remains authoritative. */ }
}
