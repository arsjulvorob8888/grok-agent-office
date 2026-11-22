'use strict';

// Кнопка «Ключ» в карточке закрывает карточку и открывает поля этого агента поверх.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-link-key-'));
process.env.APP_PASSWORD = 'pw-link-key';
process.env.AGENT_TOKEN = 'tok-link-key';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
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
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
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

async function openArmy(width, height) {
  const page = await browser.newPage();
  await page.setViewport({
    width,
    height,
    isMobile: width <= 700,
    hasTouch: width <= 700,
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
    localStorage.setItem('theme', 'day');
    localStorage.setItem('appPassword', 'pw-link-key');
  });
  await page.goto(`${base}/?agent=army`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panel.open[data-agent="army"] [data-open-key]', { timeout: 8000 });
  return page;
}

async function topAt(page, selector) {
  return page.evaluate((sel) => {
    const input = document.querySelector(sel);
    if (!input) return { missing: true };
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = input.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + Math.min(box.height / 2, 12));
    const top = document.elementFromPoint(x, y);
    const described = top ? `${top.tagName}.${top.className || ''}${top.id ? '#' + top.id : ''}` : 'null';
    return {
      missing: false,
      x,
      y,
      disabled: input.disabled,
      readOnly: input.readOnly,
      hit: top === input,
      coveredByPanel: !!(top && top.closest && top.closest('#panel')),
      described,
      value: input.value,
    };
  }, selector);
}

test('«Ключ» открывает поля агента поверх карточки на 1280 и 390', { timeout: 60000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openArmy(viewport.width, viewport.height);
    try {
      await page.click('#panel [data-open-key]');
      const row = '#servicePop:not([hidden]) #serviceFold[open] [data-direct-row][data-agent="army"].direct-row-focus';
      await page.waitForSelector(`${row} [data-direct-url]`, { timeout: 8000 });
      const url = await topAt(page, `${row} [data-direct-url]`);
      assert.equal(url.missing, false, `${viewport.width} адрес не найден`);
      assert.equal(url.hit, true, `${viewport.width} адрес перекрыт: ${url.described}`);
      assert.equal(url.coveredByPanel, false, `${viewport.width} адрес под карточкой`);
      assert.equal(url.disabled, false, `${viewport.width} адрес нельзя править`);
      assert.equal(url.readOnly, false, `${viewport.width} адрес только для чтения`);
      await page.mouse.click(url.x, url.y);
      await page.keyboard.type('https://example.test/army');
      const urlValue = await page.$eval(`${row} [data-direct-url]`, (el) => el.value);
      assert.equal(urlValue, 'https://example.test/army', `${viewport.width} адрес не принял ввод`);

      const key = await topAt(page, `${row} [data-direct-key]`);
      assert.equal(key.hit, true, `${viewport.width} ключ перекрыт: ${key.described}`);
      assert.equal(key.coveredByPanel, false, `${viewport.width} ключ под карточкой`);
      assert.equal(key.disabled, false);
      assert.equal(key.readOnly, false);
      await page.mouse.click(key.x, key.y);
      await page.keyboard.type('secret-key');
      const keyValue = await page.$eval(`${row} [data-direct-key]`, (el) => el.value);
      assert.equal(keyValue, 'secret-key', `${viewport.width} ключ не принял ввод`);
    } finally {
      await page.close();
    }
  }
});
