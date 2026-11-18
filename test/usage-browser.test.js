'use strict';

// Виджет «Лимит Grok» в шапке: пусто, 80, 95, ширина 390.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p) => p && fs.existsSync(p));

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* зависимости нет */ }

if (!CHROME || !puppeteer) {
  test('виджет лимита Grok в шапке', { skip: CHROME ? 'нет puppeteer-core' : 'Chrome не найден' }, () => {});
} else {
  let browser;
  let server;
  let base;

  before(async () => {
    process.env.UPLOAD_DIR = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'kremlin-usage-ui-'));
    process.env.APP_PASSWORD = 'pw-usage-ui';
    process.env.AGENT_TOKEN = 'tok-usage-ui';
    process.env.AGENT_STATUS_TOKEN = 'status-usage-ui';
    process.env.PUBLIC_URL = 'http://127.0.0.1';
    delete process.env.KREMLIN_WEBHOOK_URL;
    delete process.env.GROK_WEBHOOK_URL;
    delete process.env.PORYADOK_INGEST_TOKEN;
    const { app } = require('../server.js');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function postUsage(body) {
    const res = await fetch(`${base}/api/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-usage-ui' },
      body: JSON.stringify({
        plan: 'Super',
        used: body.usedPct,
        limit: 100,
        resetsAt: '2026-11-18T21:00:00.000Z',
        source: 'grok',
        ...body,
      }),
    });
    assert.equal(res.status, 200);
  }

  async function openAt(width, height) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(`${base}/?theme=day`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#grokUsage');
    return { page, errors };
  }

  async function boxOf(page) {
    return page.evaluate(() => {
      const hud = document.querySelector('.hud');
      const usage = document.querySelector('#grokUsage');
      const banner = document.querySelector('#usageBanner');
      const meter = document.querySelector('#usageMeter');
      const u = usage.getBoundingClientRect();
      const h = hud.getBoundingClientRect();
      return {
        level: usage.dataset.level,
        text: usage.innerText,
        bannerHidden: banner.hidden,
        bannerText: banner.textContent,
        meter: getComputedStyle(meter).backgroundColor,
        usageRight: u.right,
        usageLeft: u.left,
        usageBottom: u.bottom,
        hudBottom: h.bottom,
        hudRight: h.right,
        bannerTop: banner.getBoundingClientRect().top,
        bannerRight: banner.getBoundingClientRect().right,
        scrollWidth: usage.scrollWidth,
        clientWidth: usage.clientWidth,
        vw: window.innerWidth,
        docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
  }

  test('на 390px нет данных, жёлтый порог 80 и красный баннер 95', { timeout: 60000 }, async () => {
    const { page, errors } = await openAt(390, 844);
    try {
      const empty = await boxOf(page);
      assert.equal(empty.level, 'empty');
      assert.match(empty.text, /нет данных/);
      assert.equal(empty.bannerHidden, true);
      assert.equal(empty.docOverflow, false);
      assert.ok(empty.usageLeft >= -1 && empty.usageRight <= empty.vw + 1, 'виджет вылезает за экран');
      assert.ok(empty.usageBottom <= empty.hudBottom + 1, 'виджет не внутри шапки');
      assert.ok(empty.scrollWidth <= empty.clientWidth + 1, 'текст виджета шире блока');

      await postUsage({ usedPct: 80 });
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#grokUsage').dataset.level === 'warn');
      const warn = await boxOf(page);
      assert.equal(warn.level, 'warn');
      assert.match(warn.text, /80%/);
      assert.match(warn.text, /МСК/);
      assert.match(warn.text, /осталось/);
      assert.equal(warn.bannerHidden, true);
      assert.equal(warn.meter, 'rgb(245, 158, 11)');
      assert.equal(warn.docOverflow, false);
      assert.ok(warn.usageRight <= warn.vw + 1);

      await postUsage({ usedPct: 95 });
      await page.reload({ waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('#grokUsage').dataset.level === 'critical');
      const hot = await boxOf(page);
      assert.equal(hot.level, 'critical');
      assert.match(hot.text, /95%/);
      assert.match(hot.text, /МСК/);
      assert.equal(hot.bannerHidden, false);
      assert.match(hot.bannerText, /95%/);
      assert.match(hot.bannerText, /МСК/);
      assert.equal(hot.meter, 'rgb(224, 40, 63)');
      assert.equal(hot.docOverflow, false);
      assert.ok(hot.usageBottom <= hot.hudBottom + 1);
      assert.ok(hot.bannerTop >= hot.usageBottom - 1, 'баннер перекрывает виджет');
      assert.ok(hot.bannerRight <= hot.vw + 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
