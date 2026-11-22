'use strict';

// В карточке только состояние прямой связи. Адрес и ключ остаются в разделе «Ключ».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
      body: JSON.stringify({ url, key: 'fixture-card-key-SHOULD-NOT-SHOW' }),
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
  });
  await page.goto(`${base}/?theme=${theme}&agent=${agent}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#panel.open[data-agent="${agent}"] [data-direct-card]`, { timeout: 8000 });
  return page;
}

function cardState(page) {
  return page.evaluate(() => {
    const card = document.querySelector('#panel [data-direct-card]');
    const form = document.querySelector('#taskForm');
    const routes = form ? [...form.querySelectorAll('#taskRoute, [data-direct-link]')] : [];
    const link = document.querySelector('#panel [data-anchor="link"]');
    return {
      theme: document.body.classList.contains('night') ? 'night' : 'day',
      phase: card ? card.dataset.phase : '',
      text: card ? card.innerText.replace(/\s+/g, ' ').trim() : '',
      inputs: link ? link.querySelectorAll('input').length : -1,
      keyButton: !!(card && card.querySelector('[data-open-key]')),
      routes: routes.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
      formText: form ? form.innerText : '',
    };
  });
}

test('карточка показывает состояние связи и ведёт в «Ключ», без полей', { timeout: 180000 }, async () => {
  for (const theme of ['day', 'night']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const label = `${theme} ${viewport.width}`;
      const empty = await openAgent(viewport, theme, 'health');
      try {
        const state = await cardState(empty);
        assert.equal(state.theme, theme, label);
        assert.match(state.text, /Прямая связь не работает — проверьте адрес и ключ/);
        assert.equal(state.keyButton, true, label);
        assert.equal(state.inputs, 0, label);
        assert.equal(state.routes.length, 1, state.routes.join(' | '));
        assert.match(state.routes[0], /Куда уйдёт приказ/);
        assert.equal(state.formText.includes('Сообщение уйдёт через Путина'), false);
        await empty.click('#panel [data-open-key]');
        await empty.waitForSelector('#servicePop:not([hidden]) #serviceFold[open] [data-direct-row][data-agent="health"].direct-row-focus', { timeout: 8000 });
      } finally {
        await empty.close();
      }

      const red = await openAgent(viewport, theme, 'social');
      try {
        const state = await cardState(red);
        assert.equal(state.phase, 'down', label);
        assert.match(state.text, /Прямая связь не работает — проверьте адрес и ключ/);
        assert.equal(state.inputs, 0, label);
        await red.click('#panel [data-open-key]');
        await red.waitForSelector('#servicePop:not([hidden]) #serviceFold[open] [data-direct-row][data-agent="social"].direct-row-focus', { timeout: 8000 });
      } finally {
        await red.close();
      }

      const green = await openAgent(viewport, theme, 'dev');
      try {
        const state = await cardState(green);
        assert.equal(state.phase, 'ok', label);
        assert.match(state.text, /^Прямая связь: работает ✓ \(\d{2}:\d{2} МСК\)$/);
        assert.equal(state.keyButton, false, label);
        assert.equal(state.inputs, 0, label);
        assert.equal(state.routes.length, 1);
      } finally {
        await green.close();
      }
    }
  }
});
