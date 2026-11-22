'use strict';

// Прямая связь в карточке: поля без лишних кликов, зелёная свёрнута, ручной выбор и ключ не в DOM.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'fixture-card-key-SHOULD-NOT-SHOW';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-card-'));
process.env.APP_PASSWORD = 'pw-card';
process.env.AGENT_TOKEN = 'tok-card';
process.env.AGENT_STATUS_TOKEN = 'status-card';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
process.env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
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

const hook = http.createServer((req, res) => {
  const fail = String(req.url || '').includes('/red');
  res.writeHead(fail ? 500 : 204);
  res.end();
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
  async function save(id, url) {
    const res = await fetch(`${base}/api/agents/${id}/delivery`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-card' },
      body: JSON.stringify({ url, key: KEY }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `${id} ${JSON.stringify(body)}`);
    return body;
  }
  const green = await save('dev', `${hookOrigin}/ok`);
  const ack = await fetch(`${base}/api/agent-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer status-card' },
    body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: green.linkCheck.taskId }),
  });
  const ackBody = await ack.json();
  assert.equal(ack.status, 200, JSON.stringify(ackBody));
  assert.equal(ackBody.acknowledged, true);
  const yellow = await save('qa', `${hookOrigin}/wait`);
  assert.equal(yellow.linkCheck.phase, 'checking');
  const red = await save('social', `${hookOrigin}/red`);
  assert.equal(red.linkCheck.phase, 'down');
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => hook.close(resolve));
});

async function openAgent(viewport, theme, agent) {
  const page = await browser.newPage();
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
    localStorage.setItem('appPassword', 'pw-card');
    window.__cardLog = [];
    const note = () => {
      const el = document.querySelector('[data-direct-card]');
      if (!el) return;
      const mark = el.open ? 'open' : 'shut';
      if (window.__cardLog[window.__cardLog.length - 1] !== mark) window.__cardLog.push(mark);
    };
    const arm = () => {
      const root = document.documentElement;
      if (!root || root.dataset.cardWatch) return;
      root.dataset.cardWatch = '1';
      new MutationObserver(note).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
      const frames = () => {
        note();
        requestAnimationFrame(frames);
      };
      requestAnimationFrame(frames);
    };
    arm();
    document.addEventListener('DOMContentLoaded', arm);
  });
  await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const drop = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('directCard:')) drop.push(key);
    }
    for (const key of drop) localStorage.removeItem(key);
  });
  await page.goto(`${base}/?theme=${theme}&agent=${agent}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#panel.open[data-agent="${agent}"] [data-direct-card]`, { timeout: 8000 });
  return page;
}

function cardState(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-direct-card]');
    const summary = card.querySelector('[data-direct-summary]');
    const plain = card.querySelector('[data-direct-plain]');
    const url = card.querySelector('[data-card-url]');
    const key = card.querySelector('[data-card-key]');
    const body = card.querySelector('.direct-card-body');
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const form = document.querySelector('#taskForm');
    const routes = form ? [...form.querySelectorAll('#taskRoute, [data-direct-link], [data-direct-plain]')] : [];
    const fields = [...document.querySelectorAll('input')].map((el) => String(el.value));
    return {
      theme: document.body.classList.contains('night') ? 'night' : 'day',
      open: card.open,
      summary: summary ? summary.textContent.replace(/\s+/g, ' ').trim() : '',
      plain: plain ? plain.textContent.replace(/\s+/g, ' ').trim() : '',
      urlVisible: visible(url),
      keyVisible: visible(key),
      keyType: key ? key.type : '',
      bodyShown: !!(body && card.open && visible(body)),
      routes: routes.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
      formText: form ? form.innerText : '',
      log: window.__cardLog.slice(),
      secret: document.body.innerText.includes('SHOULD-NOT-SHOW') || fields.some((value) => value.includes('SHOULD-NOT-SHOW')),
    };
  });
}

test('прямая связь в карточке: поля, зелёная строка, выбор и один маршрут', { timeout: 180000 }, async () => {
  for (const theme of ['day', 'night']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const label = `${theme} ${viewport.width}`;
      const empty = await openAgent(viewport, theme, 'health');
      try {
        const state = await cardState(empty);
        assert.equal(state.theme, theme, label);
        assert.equal(state.open, true, label);
        assert.equal(state.urlVisible, true, label);
        assert.equal(state.keyVisible, true, label);
        assert.equal(state.keyType, 'password');
        assert.match(state.plain, /Кремль: входящие с сайта/);
        assert.equal(state.routes.length, 1, state.routes.join(' | '));
        assert.match(state.routes[0], /Куда уйдёт приказ/);
        assert.equal(state.formText.includes('Сообщение уйдёт через Путина'), false);
        assert.equal(state.secret, false);
        assert.deepEqual(state.log, ['open']);
      } finally {
        await empty.close();
      }

      const deputy = await openAgent(viewport, theme, 'temshik');
      try {
        const state = await cardState(deputy);
        assert.equal(state.open, true, `${label} зам`);
        assert.equal(state.urlVisible, true, `${label} зам`);
        assert.equal(state.keyVisible, true, `${label} зам`);
        assert.match(state.plain, /Кремль: входящие с сайта/);
      } finally {
        await deputy.close();
      }

      const yellow = await openAgent(viewport, theme, 'qa');
      try {
        const state = await cardState(yellow);
        assert.equal(state.open, true, `${label} жёлтый`);
        assert.match(state.plain, /Связь проверяется/);
        assert.match(state.plain, /ответ агента ещё не пришёл/);
      } finally {
        await yellow.close();
      }

      const red = await openAgent(viewport, theme, 'social');
      try {
        const state = await cardState(red);
        assert.equal(state.open, true, `${label} красный`);
        assert.match(state.plain, /Адрес не отвечает/);
        assert.match(state.plain, /Кремль: входящие с сайта/);
      } finally {
        await red.close();
      }

      const green = await openAgent(viewport, theme, 'dev');
      try {
        const state = await cardState(green);
        assert.equal(state.open, false, `${label} зелёный`);
        assert.match(state.summary, /^Прямая связь: работает ✓ \(\d{2}:\d{2} МСК\)$/);
        assert.equal(state.urlVisible, false, label);
        assert.equal(state.keyVisible, false, label);
        assert.equal(state.secret, false);
        assert.deepEqual(state.log, ['shut']);
        await green.click('[data-direct-summary]');
        await green.waitForFunction(() => document.querySelector('[data-direct-card]').open);
        await green.reload({ waitUntil: 'domcontentloaded' });
        await green.waitForSelector('#panel.open[data-agent="dev"] [data-direct-card]', { timeout: 8000 });
        const kept = await cardState(green);
        assert.equal(kept.open, true, `${label} ручной`);
        assert.deepEqual(kept.log, ['open']);
        await new Promise((resolve) => setTimeout(resolve, 700));
        const later = await cardState(green);
        assert.equal(later.open, true);
        assert.deepEqual(later.log, ['open']);
      } finally {
        await green.close();
      }

      const manual = await openAgent(viewport, theme, 'health');
      try {
        await manual.click('[data-direct-summary]');
        await manual.waitForFunction(() => !document.querySelector('[data-direct-card]').open);
        await manual.reload({ waitUntil: 'domcontentloaded' });
        await manual.waitForSelector('#panel.open[data-agent="health"] [data-direct-card]', { timeout: 8000 });
        const state = await cardState(manual);
        assert.equal(state.open, false, `${label} свёрнут вручную`);
        assert.deepEqual(state.log, ['shut']);
      } finally {
        await manual.close();
      }

      const savedPage = await openAgent(viewport, theme, 'poker');
      try {
        await savedPage.$eval('[data-card-url]', (el, value) => { el.value = value; }, `${hookOrigin}/poker`);
        await savedPage.$eval('[data-card-key]', (el, value) => { el.value = value; }, KEY);
        await savedPage.click('[data-card-save]');
        await savedPage.waitForFunction(() => {
          const key = document.querySelector('[data-card-key]');
          const note = document.querySelector('[data-card-saved]');
          return key && key.value === '' && note && note.textContent === 'ключ сохранён';
        }, { timeout: 8000 });
        const saved = await cardState(savedPage);
        assert.equal(saved.secret, false, label);
      } finally {
        await savedPage.close();
      }
    }
  }
});
