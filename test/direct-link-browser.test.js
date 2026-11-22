'use strict';

// Карточка: одна строка, без блока «Доставка». Адрес, ключ и «Проверить» — в «Служебном».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'fixture-direct-ui-key-ZZZZ';
const QA_KEY = 'fixture-direct-ui-qa-QQQQ';
const artifacts = '/opt/cursor/artifacts';
const feed = require('../public/js/feed.js');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-direct-ui-'));
process.env.APP_PASSWORD = 'pw-link';
process.env.AGENT_TOKEN = 'tok-link';
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
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].find((item) => item && fs.existsSync(item));
}

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
    hits.push({ url: req.url || '', body: parsed, headers: req.headers });
    res.writeHead(204);
    res.end();
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
  const saved = await fetch(`${base}/api/agents/dev/delivery`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-link' },
    body: JSON.stringify({ url: `${hookOrigin}/dev-hook`, key: KEY }),
  });
  assert.equal(saved.status, 200);
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  hook.close();
});

async function openPage(viewport, agent) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => {
    const text = String(err);
    if (/localStorage/i.test(text)) return;
    errors.push(text);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/fonts\.(googleapis|gstatic)|favicon|ERR_FAILED|localStorage/i.test(text)) return;
    if (/409/.test(text) && /Conflict/.test(text)) return;
    errors.push(text);
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument((preset) => {
    try {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      localStorage.setItem('theme', 'day');
      if (preset) localStorage.setItem('appPassword', preset);
      else localStorage.removeItem('appPassword');
    } catch (_) { /* кадр без хранилища */ }
  }, viewport.password || '');
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/?agent=${agent}`, { waitUntil: 'domcontentloaded' });
  page.__errors = errors;
  return page;
}

async function visibleBlob(page) {
  return page.evaluate(() => {
    const fields = [...document.querySelectorAll('input')].map((el) => `${el.type}:${el.value}`).join('\n');
    return `${document.body.innerText}\n${fields}`;
  });
}

test('в карточке одна строка, без блока «Доставка» и без пароля', { timeout: 60000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 }, 'army');
  try {
    await page.waitForFunction(() => {
      const line = document.querySelector('#panel.open[data-agent="army"] [data-direct-link]');
      return line && line.textContent === 'Сообщение уйдёт через Путина';
    }, { timeout: 8000 });
    const card = await page.evaluate(() => {
      const panel = document.querySelector('#panel');
      const line = panel.querySelector('[data-direct-link]');
      return {
        line: line ? line.textContent : '',
        count: panel.querySelectorAll('[data-direct-link]').length,
        inForm: !!panel.querySelector('#taskForm [data-direct-link]'),
        delivery: panel.querySelectorAll('[data-delivery-root], [data-delivery-kind]').length,
        password: panel.innerText.includes('Нужен пароль персонала'),
        heading: [...panel.querySelectorAll('h4')].some((el) => el.textContent.trim() === 'Доставка'),
      };
    });
    assert.equal(card.line, 'Сообщение уйдёт через Путина');
    assert.equal(card.count, 1);
    assert.equal(card.inForm, true);
    assert.equal(card.delivery, 0);
    assert.equal(card.password, false);
    assert.equal(card.heading, false);
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'direct-link-card-1280.png') });
    const dev = await openPage({ width: 1280, height: 800 }, 'dev');
    try {
      await dev.waitForFunction(() => {
        const line = document.querySelector('#panel.open[data-agent="dev"] [data-direct-link]');
        return line && line.textContent === 'Проверяю…';
      }, { timeout: 8000 });
      const quiet = await dev.evaluate(() => document.querySelector('#panel').innerText.includes('Сообщение уйдёт через Путина'));
      assert.equal(quiet, false);
    } finally {
      await dev.close();
    }
    await page.goto(`${base}/?agent=grok`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const line = document.querySelector('#panel.open[data-agent="grok"] [data-direct-link]');
      return line && line.textContent === 'Прямая связь: не подключена';
    }, { timeout: 8000 });
    const putin = await page.evaluate(() => ({
      line: document.querySelector('#panel [data-direct-link]').textContent,
      text: document.querySelector('#panel').innerText,
      delivery: document.querySelectorAll('#panel [data-delivery-root]').length,
      password: document.querySelector('#panel').innerText.includes('Нужен пароль персонала'),
    }));
    assert.equal(putin.line, 'Прямая связь: не подключена');
    assert.equal(putin.text.includes('Сообщение уйдёт через Путина'), false);
    assert.equal(putin.delivery, 0);
    assert.equal(putin.password, false);
    assert.deepEqual(page.__errors, []);
  } finally {
    await page.close();
  }
});

test('«Служебное» показывает всех, прячет ключ и проверяет адрес', { timeout: 60000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 }, 'army');
  try {
    await page.waitForSelector('#roster .chip[data-id="health"]', { timeout: 8000 });
    await page.click('#btnKey');
    await page.waitForSelector('#service.open #servicePwInput', { timeout: 8000 });
    const locked = await visibleBlob(page);
    assert.equal(locked.includes(KEY), false);
    assert.equal(locked.includes('dev-hook'), false);
    assert.match(locked, /Служебное/);
    await page.type('#servicePwInput', 'pw-link');
    await page.click('#servicePw button[type="submit"]');
    await page.waitForSelector('#service [data-direct-row][data-agent="health"]', { timeout: 8000 });
    const state = await (await fetch(`${base}/api/state`)).json();
    const expectIds = feed.serviceAgents(state.agents).map((agent) => agent.id);
    const shown = await page.$$eval('#service [data-direct-row]', (rows) => rows.map((row) => row.dataset.agent));
    assert.deepEqual(shown, expectIds);
    const roster = await page.$$eval('#roster .chip', (nodes) => nodes.map((node) => node.dataset.id));
    assert.equal(shown.includes('invest'), true);
    assert.equal(shown.includes('analyst'), true);
    assert.equal(shown.includes('trading'), false);
    assert.equal(roster.includes('invest'), false);
    assert.equal(roster.includes('trading'), false);
    const keyField = await page.$eval('#service [data-agent="dev"] [data-direct-key]', (el) => ({ type: el.type, value: el.value }));
    assert.equal(keyField.type, 'password');
    assert.equal(keyField.value, '');
    const savedNote = await page.$eval('#service [data-agent="dev"] [data-direct-saved]', (el) => el.textContent);
    assert.equal(savedNote, 'ключ сохранён');
    const openBlob = await visibleBlob(page);
    assert.equal(openBlob.includes(KEY), false);

    const before = await (await fetch(`${base}/api/state`)).json();
    const countsBefore = await page.evaluate(() => ({
      journal: document.querySelector('#jCount').textContent,
      processes: document.querySelector('#procBadge').textContent,
      active: document.querySelector('#stActive').textContent,
    }));
    const beforeHits = hits.length;
    await page.$eval('#service [data-agent="dev"] [data-direct-check]', (el) => el.scrollIntoView({ block: 'center' }));
    await page.click('#service [data-agent="dev"] [data-direct-check]');
    const started = Date.now();
    while (hits.length < beforeHits + 1 && Date.now() - started < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(hits.length, beforeHits + 1);
    assert.equal(hits[hits.length - 1].body.type, 'ping');
    assert.equal(hits[hits.length - 1].body.text, 'Проверка связи');
    assert.match(hits[hits.length - 1].body.taskId, /^ping-dev-\d+$/);
    assert.equal(hits[hits.length - 1].headers['x-webhook-key'], KEY);
    await page.$eval('#service [data-agent="army"] [data-direct-check]', (el) => el.scrollIntoView({ block: 'center' }));
    const armyHits = hits.length;
    await page.click('#service [data-agent="army"] [data-direct-check]');
    await page.waitForFunction(() => {
      const line = document.querySelector('#service [data-agent="army"] [data-direct-status]');
      return line && line.textContent === 'Сообщение уйдёт через Путина';
    }, { timeout: 8000 });
    assert.equal(hits.length, armyHits);
    const after = await (await fetch(`${base}/api/state`)).json();
    assert.equal(after.tasks.length, before.tasks.length);
    assert.equal(after.tasks.some((item) => String(item.text || '').includes('Проверка связи')), false);
    const countsAfter = await page.evaluate(() => ({
      journal: document.querySelector('#jCount').textContent,
      processes: document.querySelector('#procBadge').textContent,
      active: document.querySelector('#stActive').textContent,
      ping: document.body.innerText.includes('Проверка связи'),
    }));
    assert.equal(countsAfter.journal, countsBefore.journal);
    assert.equal(countsAfter.processes, countsBefore.processes);
    assert.equal(countsAfter.active, countsBefore.active);
    assert.equal(countsAfter.ping, false);

    await page.$eval('#service [data-agent="qa"] [data-direct-url]', (el, value) => { el.value = value; }, `${hookOrigin}/qa-hook`);
    await page.$eval('#service [data-agent="qa"] [data-direct-key]', (el, value) => { el.value = value; }, QA_KEY);
    await page.$eval('#service [data-agent="qa"] [data-direct-save]', (el) => el.scrollIntoView({ block: 'center' }));
    await page.click('#service [data-agent="qa"] [data-direct-save]');
    await page.waitForFunction(() => {
      const note = document.querySelector('#service [data-agent="qa"] [data-direct-saved]');
      return note && note.textContent === 'ключ сохранён';
    }, { timeout: 8000 });
    const qaKey = await page.$eval('#service [data-agent="qa"] [data-direct-key]', (el) => el.value);
    assert.equal(qaKey, '');
    const afterSave = await visibleBlob(page);
    assert.equal(afterSave.includes(QA_KEY), false);
    assert.equal(afterSave.includes(KEY), false);
    const read = await (await fetch(`${base}/api/agents/qa/delivery`, { headers: { 'x-app-password': 'pw-link' } })).json();
    assert.equal(JSON.stringify(read).includes(QA_KEY), false);
    assert.equal(read.keySet, true);

    const fit = await page.evaluate(() => {
      const root = document.querySelector('#service');
      const list = document.querySelector('#serviceBody');
      const rect = root.getBoundingClientRect();
      const inputs = [...root.querySelectorAll('input')].map((el) => {
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      });
      return {
        left: rect.left,
        right: rect.right,
        vw: window.innerWidth,
        scroll: list.scrollWidth - list.clientWidth,
        inputs,
      };
    });
    assert.ok(fit.left >= -1 && fit.right <= fit.vw + 1, JSON.stringify({ left: fit.left, right: fit.right, vw: fit.vw }));
    assert.ok(fit.scroll <= 1, `горизонтальная прокрутка ${fit.scroll}`);
    for (const input of fit.inputs) {
      assert.ok(input.width > 40 && input.left >= -1 && input.right <= fit.vw + 1, JSON.stringify(input));
    }
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'direct-link-1280.png') });
    assert.deepEqual(page.__errors, []);
  } finally {
    await page.close();
  }
});

test('на 390 строка и поля не вылезают за окно', { timeout: 60000 }, async () => {
  const page = await openPage({ width: 390, height: 844, password: 'pw-link' }, 'army');
  try {
    await page.waitForFunction(() => {
      const line = document.querySelector('#panel.open[data-agent="army"] [data-direct-link]');
      return line && line.textContent === 'Сообщение уйдёт через Путина';
    }, { timeout: 8000 });
    const card = await page.evaluate(() => {
      const line = document.querySelector('#panel [data-direct-link]');
      line.scrollIntoView({ block: 'center' });
      const box = line.getBoundingClientRect();
      const panel = document.querySelector('#panel').getBoundingClientRect();
      return {
        text: line.textContent,
        left: box.left,
        right: box.right,
        panelLeft: panel.left,
        panelRight: panel.right,
        delivery: document.querySelectorAll('#panel [data-delivery-root]').length,
        password: document.querySelector('#panel').innerText.includes('Нужен пароль персонала'),
        vw: window.innerWidth,
      };
    });
    assert.equal(card.text, 'Сообщение уйдёт через Путина');
    assert.equal(card.delivery, 0);
    assert.equal(card.password, false);
    assert.ok(card.left >= card.panelLeft - 1 && card.right <= card.panelRight + 1, JSON.stringify(card));
    assert.ok(card.right <= card.vw + 1, JSON.stringify(card));
    await page.screenshot({ path: path.join(artifacts, 'direct-link-card-390.png') });
    await page.click('#btnKey');
    await page.waitForSelector('#service.open [data-direct-row][data-agent="dev"]', { timeout: 8000 });
    const fit = await page.evaluate(() => {
      const root = document.querySelector('#service');
      const list = document.querySelector('#serviceBody');
      const rect = root.getBoundingClientRect();
      const inputs = [...root.querySelectorAll('input')].map((el) => {
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      });
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        vw: window.innerWidth,
        scroll: list.scrollWidth - list.clientWidth,
        inputs,
      };
    });
    assert.ok(fit.left >= -1 && fit.right <= fit.vw + 1, JSON.stringify(fit));
    assert.ok(fit.scroll <= 1, `горизонтальная прокрутка ${fit.scroll}`);
    for (const input of fit.inputs) {
      assert.ok(input.width > 40 && input.left >= fit.left - 1 && input.right <= fit.right + 1, JSON.stringify(input));
    }
    const devLine = await page.$eval('#service [data-agent="dev"] [data-direct-status]', (el) => el.textContent);
    const armyLine = await page.$eval('#service [data-agent="army"] [data-direct-status]', (el) => el.textContent);
    assert.equal(devLine, 'Проверяю…');
    assert.equal(armyLine, 'Сообщение уйдёт через Путина');
    await page.screenshot({ path: path.join(artifacts, 'direct-link-390.png') });
    assert.deepEqual(page.__errors, []);
  } finally {
    await page.close();
  }
});
