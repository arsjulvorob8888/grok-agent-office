'use strict';

// Спящее здание остаётся непрозрачным: полупрозрачный корпус читался как пустая рамка.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-sleep-'));
process.env.APP_PASSWORD = 'pw-sleep';
process.env.AGENT_TOKEN = 'tok-sleep';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
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
    '/usr/bin/chromium',
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

test('у спящих зданий корпус непрозрачный, без тёмного цоколя-рамки, на 1280 и 390', { timeout: 90000 }, async () => {
  for (const theme of ['day', 'night']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage();
      try {
        await page.setViewport({
          width: viewport.width,
          height: viewport.height,
          isMobile: viewport.width <= 700,
          hasTouch: viewport.width <= 700,
          deviceScaleFactor: 1,
        });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const url = req.url();
          if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
          else req.continue();
        });
        await page.evaluateOnNewDocument(() => {
          localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
        });
        await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#agents .agent.act-idle .bld', { timeout: 8000 });
        const look = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('#agents .agent.act-idle .bld, #agents .agent.sleep .bld')].map((bld) => {
            const agent = bld.closest('.agent');
            const style = getComputedStyle(bld);
            return {
              id: agent && agent.dataset.id,
              opacity: Number(style.opacity),
              filter: style.filter,
            };
          });
          const plinth = [...document.querySelectorAll('#agents .bld rect')].filter((el) => {
            const box = el.getBBox();
            const fill = String(el.getAttribute('fill') || '').toLowerCase();
            return box.height <= 6 && box.width >= 100 && (fill === '#1a3a5c' || fill === '#0e2438');
          }).length;
          return { rows, plinth, theme: document.body.classList.contains('night') ? 'night' : 'day' };
        });
        assert.equal(look.theme, theme);
        assert.ok(look.rows.length >= 8, `${theme} ${viewport.width}: зданий ${look.rows.length}`);
        for (const row of look.rows) {
          assert.ok(row.opacity >= 0.9, `${theme} ${viewport.width} ${row.id} opacity ${row.opacity}`);
          assert.match(row.filter, /grayscale/, `${theme} ${row.id}`);
        }
        assert.equal(look.plinth, 0, `${theme} ${viewport.width}`);
        const ids = look.rows.map((row) => row.id);
        assert.ok(ids.includes('finance') && ids.includes('social') && ids.includes('health'), ids.join(','));
      } finally {
        await page.close();
      }
    }
  }
});
