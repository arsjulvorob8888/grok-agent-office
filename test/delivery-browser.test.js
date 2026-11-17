'use strict';

// Окно «Доставка»: без пароля секретов нет, с паролем ключ не показывается, проверка даёт код.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GROK_KEY = 'fixture-grok-panel-GGGG';
const PUTIN_KEY = 'fixture-putin-panel-PPPP';
const artifacts = '/opt/cursor/artifacts';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-delivery-ui-'));
process.env.APP_PASSWORD = 'pw-ui';
process.env.AGENT_TOKEN = 'tok-ui';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_HEADER = '';
process.env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  const list = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
  return list.find((item) => fs.existsSync(item));
}

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
    hits.push({ url: req.url || '', headers: req.headers, body: parsed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

let server;
let browser;
let base;
let hookOrigin;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookOrigin = `http://127.0.0.1:${hook.address().port}`;
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'x-app-password': 'pw-ui' };
  const putin = await fetch(`${base}/api/delivery/putin`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ url: 'https://example.test/putin-hook-fixture', key: PUTIN_KEY }),
  });
  assert.equal(putin.status, 200);
  const grok = await fetch(`${base}/api/agents/grok/delivery`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ url: `${hookOrigin}/grok-hook-fixture`, key: GROK_KEY }),
  });
  assert.equal(grok.status, 200);
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  fs.mkdirSync(artifacts, { recursive: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  hook.close();
});

async function openOffice(viewport) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('theme', 'day');
    localStorage.removeItem('appPassword');
  });
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/?agent=grok`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function visibleText(page) {
  return page.evaluate(() => {
    const fields = [...document.querySelectorAll('input')].map((el) => `${el.type}:${el.value}`).join('\n');
    return `${document.body.innerText}\n${fields}`;
  });
}

async function exercise(viewport, shot) {
  const page = await openOffice(viewport);
  try {
    await page.waitForSelector('[data-delivery-root][data-locked="1"]', { timeout: 8000 });
    await page.evaluate(() => {
      const button = document.querySelector('[data-delivery-root] button');
      if (button) button.scrollIntoView({ block: 'center' });
    });
    const locked = await visibleText(page);
    assert.match(locked, /Нужен пароль персонала/);
    assert.equal(locked.includes(GROK_KEY), false);
    assert.equal(locked.includes(PUTIN_KEY), false);
    assert.equal(locked.includes('grok-hook-fixture'), false);
    assert.equal(locked.includes('putin-hook-fixture'), false);
    await page.click('[data-delivery-root] button');
    await page.waitForSelector('#modal.show #pwInput', { timeout: 4000 });
    await page.type('#pwInput', 'pw-ui');
    await page.click('#pwForm button[type="submit"]');
    await page.waitForFunction(() => {
      const input = document.querySelector('section[data-delivery-kind="agent"] input[data-delivery-url="agent"]');
      return input && input.value.includes('grok-hook-fixture');
    }, { timeout: 8000 });
    const keyField = await page.$eval('section[data-delivery-kind="agent"] input[data-delivery-key="agent"]', (el) => ({
      type: el.type,
      value: el.value,
    }));
    assert.equal(keyField.type, 'password');
    assert.equal(keyField.value, '');
    const titles = await page.$$eval('[data-delivery-root] h4', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(titles, ['Общий вебхук', 'Доставка']);
    await page.waitForSelector('#panel.open .dash-expand', { timeout: 4000 });
    const alone = await page.evaluate(() => ({
      delivery: document.querySelectorAll('[data-delivery-root]').length,
      expand: document.querySelectorAll('.dash-expand').length,
      inDash: document.querySelectorAll('#agentDash [data-delivery-root]').length,
    }));
    assert.equal(alone.delivery, 1);
    assert.equal(alone.expand, 1);
    assert.equal(alone.inDash, 0);
    await page.click('#panel.open .dash-expand');
    await page.waitForSelector('#agentDash:not([hidden]) #dashTitle', { timeout: 4000 });
    const together = await page.evaluate(() => ({
      delivery: document.querySelectorAll('[data-delivery-root]').length,
      expand: document.querySelectorAll('.dash-expand').length,
      inDash: document.querySelectorAll('#agentDash [data-delivery-root]').length,
      dashText: document.querySelector('#agentDash').innerText,
    }));
    assert.equal(together.delivery, 1);
    assert.equal(together.expand, 1);
    assert.equal(together.inDash, 0);
    assert.equal(together.dashText.includes('URL вебхука'), false);
    assert.equal(together.dashText.includes('Общий вебхук'), false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#agentDash[hidden]', { timeout: 4000 });
    const opened = await visibleText(page);
    assert.match(opened, /Ключ задан, последние символы GGGG/);
    assert.match(opened, /PPPP/);
    assert.equal(opened.includes(GROK_KEY), false);
    assert.equal(opened.includes(PUTIN_KEY), false);
    const before = hits.length;
    await page.evaluate(() => {
      const button = document.querySelector('[data-delivery-test="agent"]');
      if (button) button.scrollIntoView({ block: 'center' });
    });
    await page.click('section[data-delivery-kind="agent"] [data-delivery-test="agent"]');
    await page.waitForFunction(() => {
      const msg = document.querySelector('[data-delivery-msg="agent"]');
      return msg && msg.textContent.includes('Ответ 200');
    }, { timeout: 8000 });
    assert.equal(hits.length, before + 1);
    assert.equal(hits[hits.length - 1].body.type, 'test');
    assert.equal(hits[hits.length - 1].headers['x-webhook-key'], GROK_KEY);
    const after = await visibleText(page);
    assert.equal(after.includes(GROK_KEY), false);
    await page.setViewport({
      width: viewport.width,
      height: 1400,
      isMobile: viewport.width < 700,
      hasTouch: viewport.width < 700,
      deviceScaleFactor: 1,
    });
    await page.evaluate((width) => {
      const panel = document.querySelector('#panel');
      const body = document.querySelector('#panel .p-body');
      if (panel) {
        panel.style.position = 'fixed';
        panel.style.left = '0';
        panel.style.top = '0';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = `${width}px`;
        panel.style.maxWidth = 'none';
        panel.style.height = 'auto';
        panel.style.maxHeight = 'none';
        panel.style.overflow = 'visible';
        panel.style.transform = 'none';
        panel.style.borderRadius = '0';
      }
      if (body) {
        body.style.overflow = 'visible';
        body.style.height = 'auto';
        body.style.maxHeight = 'none';
        body.style.flex = 'none';
      }
      const root = document.querySelector('[data-delivery-root]');
      if (root) root.style.padding = '8px 18px 8px';
      window.scrollTo(0, 0);
    }, Math.min(viewport.width, 440));
    const box = await page.$eval('[data-delivery-root]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    });
    const file = path.join(artifacts, shot);
    await page.screenshot({
      path: file,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    assert.ok(fs.statSync(file).size > 1000, shot);
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('appPassword', 'pw-ui');
    });
    await page.goto(`${base}/?agent=army`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel.open[data-agent="army"] [data-delivery-kind="agent"]', { timeout: 8000 });
    const kinds = await page.$$eval('#panel.open[data-agent="army"] [data-delivery-root] h4', (nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(kinds, ['Доставка']);
  } finally {
    await page.close();
  }
}

test('блок доставки на 1280 прячет ключ и показывает ответ проверки', { timeout: 60000 }, async () => {
  await exercise({ width: 1280, height: 800 }, 'delivery_desk_1280.png');
});

test('блок доставки на 390 прячет ключ и показывает ответ проверки', { timeout: 60000 }, async () => {
  await exercise({ width: 390, height: 844 }, 'delivery_phone_390.png');
});
