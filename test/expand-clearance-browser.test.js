'use strict';

// Номер агента в шапке карточки не должен заходить на кнопку «Развернуть».
// Номер стоит в заголовке: проверяем и сам номер, и строки заголовка.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-expand-'));
process.env.APP_PASSWORD = 'pw-expand';
process.env.AGENT_TOKEN = 'tok-expand';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].find((item) => item && fs.existsSync(item));
}

let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openAgent(width, height, agentId) {
  const page = await browser.newPage();
  await page.setViewport({
    width,
    height,
    isMobile: width < 700,
    hasTouch: width < 700,
    deviceScaleFactor: 1,
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('theme', 'day');
  });
  await page.goto(`${base}/?agent=${agentId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#panel.open[data-agent="${agentId}"] .dash-expand`, { timeout: 8000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
  return page;
}

test('номер в шапке карточки не пересекает «Развернуть» на 390 и 1280', { timeout: 60000 }, async () => {
  const state = await fetch(`${base}/api/state`).then((res) => res.json());
  const agents = state.agents.filter((agent) => agent && agent.number && !agent.archived && !agent.vacant);
  assert.ok(agents.some((agent) => String(agent.name || '').length > 12));
  const widths = [[390, 844], [1280, 800]];
  for (const [width, height] of widths) {
    for (const agent of agents) {
      const page = await openAgent(width, height, agent.id);
      try {
        const hit = await page.evaluate(() => {
          const button = document.querySelector('#panel.open .dash-expand');
          const number = document.querySelector('#panel.open .p-title .ord');
          const title = document.querySelector('#panel.open .p-title h2');
          if (!button || !number || !title) return { missing: true };
          const box = button.getBoundingClientRect();
          const crosses = (rect) => rect.width > 0
            && rect.height > 0
            && rect.left < box.right - 1
            && rect.right > box.left + 1
            && rect.top < box.bottom - 1
            && rect.bottom > box.top + 1;
          const range = document.createRange();
          range.selectNodeContents(number);
          const numberRects = [...range.getClientRects()];
          range.selectNodeContents(title);
          const titleRects = [...range.getClientRects()];
          return {
            missing: false,
            label: title.textContent.trim(),
            numberHit: numberRects.some(crosses) || crosses(number.getBoundingClientRect()),
            titleHit: titleRects.some(crosses),
          };
        });
        assert.equal(hit.missing, false, agent.id);
        assert.equal(hit.numberHit, false, `${width} ${hit.label}: номер на кнопке`);
        assert.equal(hit.titleHit, false, `${width} ${hit.label}: заголовок на кнопке`);
      } finally {
        await page.close();
      }
    }
  }
});
