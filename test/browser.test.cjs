const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { atlas, beacon, fixture, startApp, request } = require('./helpers.cjs');

test('browser creates, closes, and clears one workspace before rendering another', { timeout: 20000 }, async (t) => {
  const { runtimeUrl } = await fixture(t);
  const { base } = await startApp(t, runtimeUrl);
  const b = await request(base, '/v1/items', {
    key: beacon.key, method: 'POST', body: { title: 'Beacon checklist' },
  });
  assert.equal(b.status, 201);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1160, height: 840 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Work items' })).toBeVisible();

  const key = page.getByLabel('Bearer key');
  await key.fill('invalid');
  await key.press('Enter');
  await expect(page.getByRole('status')).toHaveText('That key was not accepted. Check it and try again.');
  await key.fill(atlas.key);
  await key.press('Enter');
  await expect(page.getByText('No work items yet.')).toBeVisible();

  const title = page.getByLabel('Item title');
  await title.fill('Atlas brief');
  await title.press('Enter');
  const row = page.getByRole('listitem').filter({ hasText: 'Atlas brief' });
  await expect(row.getByText('Open', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Close' }).click();
  await expect(row.getByText('Closed', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Item closed', { exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);

  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await expect(page.getByText('Atlas brief', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Item closed', { exact: true })).toHaveCount(0);

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  await page.route('**/v1/items', async (route) => {
    try {
      await hold;
      await route.continue();
    } catch {
      // Closing the page cancels held requests when an assertion fails.
    }
  });
  try {
    await key.fill(beacon.key);
    await key.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Connecting…');
    await expect(page.getByText('Atlas brief', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Item closed', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByText('Beacon checklist', { exact: true })).toBeVisible();
  await expect(page.getByText('Atlas brief', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 820 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile viewport should not overflow');
  assert.deepEqual(errors, []);
});
