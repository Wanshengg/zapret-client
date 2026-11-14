const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const output = path.resolve('.verification');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 }, colorScheme: 'light' });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });

  const assertTheme = async (theme) => {
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
  };

  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Подключение', exact: true }).waitFor();
  await assertTheme('light');
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Подключить zapret' }).click();
  await page.getByText('Работает: ALT2', { exact: true }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(output, 'connected.png'), fullPage: true });

  await page.getByRole('button', { name: 'Стратегии', exact: true }).click();
  assert.equal(await page.locator('.strategy-row').count(), 22);
  await page.locator('.strategy-row').filter({ hasText: 'general (ALT11).bat' }).click();
  await page.screenshot({ path: path.join(output, 'strategies.png'), fullPage: true });

  await page.getByRole('button', { name: 'Журнал', exact: true }).click();
  assert.ok(await page.locator('.history-item').count() >= 3);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const autoConnect = page.getByRole('switch', { name: 'Автоподключение' });
  assert.equal(await autoConnect.getAttribute('aria-checked'), 'true');
  await autoConnect.click();
  assert.equal(await autoConnect.getAttribute('aria-checked'), 'false');
  await autoConnect.click();
  const autoUpdate = page.getByRole('switch', { name: 'Автоматическое обновление' });
  await autoUpdate.click();
  assert.equal(await autoUpdate.getAttribute('aria-checked'), 'false');
  const appUpdatePanel = page.locator('.update-panel').filter({ hasText: 'ОБНОВЛЕНИЕ ПРОГРАММЫ' });
  await appUpdatePanel.getByRole('button', { name: 'Проверить сейчас' }).click();
  await page.getByText('Установлена последняя версия программы 0.1.1', { exact: true }).waitFor();
  const configUpdatePanel = page.locator('.update-panel').filter({ hasText: 'ОБНОВЛЕНИЕ КОНФИГОВ' });
  await configUpdatePanel.getByRole('button', { name: 'Проверить сейчас' }).click();
  await page.getByText('Установлена последняя версия 1.10.4', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить zapret' }).click();
  await page.getByText('Не подключено', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Тёмная', exact: true }).click();
  await assertTheme('dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('zapret-client-theme')), 'dark');
  await page.screenshot({ path: path.join(output, 'dark-settings.png'), fullPage: true });
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'dark-desktop.png'), fullPage: true });

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Подключение', exact: true }).waitFor();
  await assertTheme('dark');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Тёмная', exact: true }).getAttribute('aria-pressed'), 'true');

  await page.getByRole('button', { name: 'Светлая', exact: true }).click();
  await assertTheme('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Системная', exact: true }).click();
  await assertTheme('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await assertTheme('light');
  await page.getByRole('button', { name: 'Тёмная', exact: true }).click();
  await assertTheme('dark');

  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Horizontal overflow: ${JSON.stringify(dimensions)}`);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'dark-mobile-settings.png'), fullPage: true });
  const mobileSettings = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(mobileSettings.scrollWidth <= mobileSettings.width, `Settings overflow: ${JSON.stringify(mobileSettings)}`);

  const performance = await page.evaluate(() => ({
    requests: window.performance.getEntriesByType('resource').length,
    transferBytes: window.performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
  }));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ok', strategies: 22, consoleErrors: errors.length, mobile: dimensions, mobileSettings, performance }, null, 2));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
