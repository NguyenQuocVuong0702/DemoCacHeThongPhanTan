// Read-only browser assertions/screenshots for the fault test's visible state.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const phase = process.argv[2] || 'normal';
assert.ok(['normal','edge-3-down','recovered'].includes(phase));
assert.ok(process.env.PLAYWRIGHT_DIR, 'Set PLAYWRIGHT_DIR to a dev-only Playwright installation');
const expected = phase === 'edge-3-down' ? ['1','1','2','2','1','2'] : ['1','1','2','2','3','3'];
const leader = phase === 'edge-3-down' ? '2' : '3';
const upCount = phase === 'edge-3-down' ? 2 : 3;
const api = 'http://127.0.0.1:4000';
const deadline = Date.now() + 60000;
let sensors;
let ready = false;
while (Date.now() < deadline) {
  const [cluster, state] = await Promise.all(['/api/cluster','/api/sensors'].map(async (p) => {
    const r = await fetch(api + p, { signal: AbortSignal.timeout(5000) }); assert.ok(r.ok); return r.json();
  }));
  sensors = state.sensors;
  if (cluster.summary.leaderId === leader && cluster.summary.upNodes === upCount &&
      expected.every((owner, index) => sensors.find((s) => s.id === String(index + 1))?.assignedNodeId === owner)) { ready = true; break; }
  await delay(500);
}
assert.ok(ready, 'API did not converge to the expected screenshot scenario');
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost:8080/');
  await page.locator('.placement-card').nth(5).waitFor();
  await page.locator('.cluster-node-card').nth(2).waitFor();
  assert.equal((await page.locator('.cluster-stat--leader').innerText()).includes(`Node ${leader}`), true);
  assert.equal(await page.locator('.cluster-node-card--down').count(), 3 - upCount);
  for (let index = 0; index < 6; index++) {
    const s = sensors.find((item) => item.id === String(index + 1));
    const card = page.locator('.placement-card').filter({ has: page.getByRole('heading', { name: s.name, exact: true }) });
    assert.equal(await card.locator('.placement-path strong').innerText(), `${s.assignedNodeName} (${s.assignedNodeZone})`);
    assert.equal(await card.locator('.ant-tag').innerText(), s.assignmentStrategy);
  }
  await page.locator('.sensor-card').filter({ has: page.getByRole('heading', { name: sensors.find((s) => s.id === '5').name, exact: true }) }).click();
  await page.getByText(`Latest 50 readings from ${sensors.find((s) => s.id === '5').name}`, { exact: true }).waitFor();
  await page.locator('.recharts-line-curve').first().waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  const path = `${process.env.SCREENSHOT_PREFIX || 'docs/PHASE_B_DASHBOARD'}_${phase}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`PASS Dashboard ${phase}: leader=${leader}, UP=${upCount}, sensor-5/6=${expected[4]}/${expected[5]}, chart rendered; ${path}`);
} finally { await browser.close(); }
