const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const output = path.resolve('.verification');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });

  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Подключение', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Подключить zapret' }).click();
  await page.getByText('Работает: ALT2', { exact: true }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(output, 'connected.png'), fullPage: true });

  await page.getByRole('button', { name: 'Стратегии', exact: true }).click();
  assert.equal(await page.locator('.strategy-row').count(), 22);
  await page.locator('.strategy-row').filter({ hasText: 'general (ALT11).bat' }).click();
  await page.screenshot({ path: path.join(output, 'strategies.png'), fullPage: true });

  await page.getByRole('button', { name: 'Журнал 3', exact: true }).click();
  assert.ok(await page.locator('.history-item').count() >= 3);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const autoUpdate = page.getByRole('switch', { name: 'Автоматическое обновление' });
  await autoUpdate.click();
  assert.equal(await autoUpdate.getAttribute('aria-checked'), 'false');
  await page.getByRole('button', { name: 'Проверить сейчас' }).click();
  await page.getByText('Установлена последняя версия 1.10.4', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить zapret' }).click();
  await page.getByText('Не подключено', { exact: true }).first().waitFor();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width, `Horizontal overflow: ${JSON.stringify(dimensions)}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ok', strategies: 22, consoleErrors: errors.length, mobile: dimensions }, null, 2));
  await browser.close();
})().catch((error) => { console.error(error); process.exit(1); });
