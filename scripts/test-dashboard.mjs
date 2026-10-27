import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

if (process.env.PHASE_A_TESTING !== '1' || !process.env.PLAYWRIGHT_DIR) throw new Error('Use a dedicated test stack and set PLAYWRIGHT_DIR');
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
try {
  await page.goto('http://localhost:8080/');
  await page.getByRole('heading', { name: 'Sensor Overview', exact: true }).waitFor();
  await page.locator('.sensor-card').nth(5).waitFor();
  assert.deepEqual(await page.locator('.sensor-card h3').allTextContents(), ['sensor-1','sensor-2','sensor-3','sensor-4','sensor-5','sensor-6']);
  console.log('PASS Dashboard displays all 6 real sensors');
  for (const id of ['1','2','3','4','5','6']) {
    const response = id === '1' ? null : page.waitForResponse((r) => r.url().includes(`/api/sensors/${id}/readings?`) && r.status() === 200);
    await page.locator('.sensor-card').filter({ has: page.getByRole('heading', { name: `sensor-${id}`, exact: true }) }).click();
    await page.getByText(`Latest 50 readings from sensor-${id}`, { exact: true }).waitFor();
    if (response) assert.ok((await (await response).json()).readings.length > 0);
    await page.locator('.recharts-line-curve').first().waitFor({ state: 'visible' });
    console.log(`PASS Dashboard selects sensor-${id} and renders its real readings chart`);
  }
  await page.getByRole('button', { name: /New Rule/ }).click();
  const modal = page.getByRole('dialog');
  const ruleName = `Phase A Dashboard ${randomUUID().slice(0,8)}`;
  await modal.getByLabel('Name', { exact: true }).fill(ruleName);
  await modal.getByLabel('Threshold', { exact: true }).fill('0');
  for (const [label, value] of [['Metric', 'temperature'], ['Operator', '>'], ['Severity', 'INFO']]) {
    const control = modal.getByLabel(label, { exact: true });
    await control.focus();
    await control.press('ArrowDown');
    await control.press('Enter');
    await control.press('Tab');
    await modal.getByText(value, { exact: true }).waitFor();
  }
  const created = page.waitForResponse((r) => r.url().endsWith('/api/alert-rules') && r.request().method() === 'POST');
  await modal.getByRole('button', { name: 'Create Rule', exact: true }).click();
  const createResponse = await created; assert.equal(createResponse.status(), 201);
  const rule = await createResponse.json();
  console.log('Dashboard created rule:', JSON.stringify(rule));
  await page.getByRole('row').filter({ hasText: ruleName }).waitFor();
  const deadline = Date.now() + 20000;
  let proof = [];
  while (Date.now() < deadline) {
    proof = (await pool.query('SELECT sensor_id,processed_by_node_id,COUNT(*)::int AS alerts FROM alerts WHERE rule_id=$1 GROUP BY sensor_id,processed_by_node_id ORDER BY sensor_id', [rule.id])).rows;
    if (new Set(proof.map((r) => r.sensor_id)).size === 6) break;
    await delay(250);
  }
  assert.equal(new Set(proof.map((r) => r.sensor_id)).size, 6);
  assert.deepEqual([...new Set(proof.map((r) => r.processed_by_node_id))].sort(), ['1','2','3']);
  console.log('PASS rule created through Dashboard generates alerts on all 6 sensors / 3 nodes:', JSON.stringify(proof));
  const updated = page.waitForResponse((r) => r.url().endsWith(`/api/alert-rules/${rule.id}`) && r.request().method() === 'PATCH');
  await page.getByRole('switch', { name: `Enable ${ruleName}`, exact: true }).click();
  assert.equal((await (await updated).json()).enabled, false);
  console.log('PASS Dashboard disables the test rule; rule and evidence alerts retained');
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: 'docs/PHASE_A_DASHBOARD.png', fullPage: true });
  console.log('PASS no uncaught browser errors; screenshot saved to docs/PHASE_A_DASHBOARD.png');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-10000));
  await page.screenshot({ path: 'docs/PHASE_A_DASHBOARD_FAILURE.png', fullPage: true });
  throw error;
} finally { await browser.close(); await pool.end(); }
