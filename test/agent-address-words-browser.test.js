'use strict';

// «Свой вебхук агента» не остаётся на карточке.
// Связь в порядке — пояснение в свёрнутом «Служебном».
// Связь не в порядке — простая фраза, без слова «вебхук».
// Поля адреса и ключа в карточку не возвращаются.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const feed = require('../public/js/feed.js');

const PLAIN = 'Адрес, по которому сайт передаёт агенту ваши сообщения';
const KEY = 'fixture-address-words-key-ZZZZ';

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-words-'));
process.env.APP_PASSWORD = 'pw-words';
process.env.AGENT_TOKEN = 'tok-words';
process.env.AGENT_STATUS_TOKEN = 'status-words';
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
    '/usr/local/bin/google-chrome',
  ].find((item) => item && fs.existsSync(item));
}

const hook = http.createServer((req, res) => {
  const down = (req.url || '').includes('/down');
  res.writeHead(down ? 500 : 204);
  res.end();
});

let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
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
  await new Promise((resolve) => hook.close(resolve));
});

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('фраза адреса зависит от проверки и не говорит «вебхук»', () => {
  const ok = { id: 'dev', deliveryRoute: 'agent', linkCheck: { phase: 'ok', answeredAt: '2026-11-22T20:09:00.000Z' } };
  const down = { id: 'qa', deliveryRoute: 'agent', linkCheck: { phase: 'down' } };
  const checking = { id: 'army', deliveryRoute: 'agent', linkCheck: { phase: 'checking' } };
  assert.equal(feed.cardRouteLine(ok), '');
  assert.equal(feed.agentAddressPlain(), PLAIN);
  assert.equal(/вебхук/i.test(feed.agentAddressPlain()), false);
  assert.equal(feed.cardRouteLine(down), PLAIN);
  assert.equal(feed.cardRouteLine(checking), PLAIN);
  assert.equal(/вебхук/i.test(feed.cardRouteLine(down)), false);
  assert.equal(feed.cardRouteLine({ id: 'grok', deliveryRoute: 'env' }), 'Куда уйдёт приказ: Адрес из окружения');
  assert.equal(feed.routeLabel('agent'), 'Свой вебхук агента');
});

async function openAgent(agentId) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('appPassword', 'pw-words');
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
  });
  await page.goto(`${base}/?agent=${agentId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`#panel.open[data-agent="${agentId}"] [data-direct-card]`, { timeout: 8000 });
  return page;
}

function cardFacts() {
  const panel = document.querySelector('#panel.open');
  const card = panel ? panel.innerText : '';
  const fold = document.querySelector('#serviceFold');
  const note = document.querySelector('#serviceRouteNote');
  const fields = panel ? panel.querySelectorAll('input[type="url"], input[type="password"], [data-direct-url], [data-direct-key]') : [];
  return {
    card,
    phase: panel && panel.querySelector('[data-direct-card]') ? panel.querySelector('[data-direct-card]').dataset.phase : '',
    keyButton: !!(panel && panel.querySelector('[data-open-key]')),
    fields: fields.length,
    foldOpen: !!(fold && fold.open),
    note: note ? note.textContent.trim() : '',
    noteHidden: note ? note.hidden : true,
    visible: document.body.innerText,
  };
}

test('связь в порядке уходит в свёрнутое «Служебное», сбой остаётся простой фразой', { timeout: 60000 }, async () => {
  const origin = `http://127.0.0.1:${hook.address().port}`;
  const saved = await api('/api/agents/dev/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-words' },
    body: JSON.stringify({ url: `${origin}/dev`, key: KEY }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body && saved.body.error));
  assert.equal(JSON.stringify(saved.body).includes(KEY), false);
  const ack = await api('/api/agent-status', {
    method: 'POST',
    headers: { authorization: 'Bearer status-words' },
    body: JSON.stringify({ agentId: 'dev', status: 'idle', taskId: saved.body.linkCheck.taskId }),
  });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal(ack.body.acknowledged, true);

  const failed = await api('/api/agents/qa/delivery', {
    method: 'PUT',
    headers: { 'x-app-password': 'pw-words' },
    body: JSON.stringify({ url: `${origin}/down`, key: KEY }),
  });
  assert.equal(failed.status, 200, JSON.stringify(failed.body && failed.body.error));
  assert.equal(failed.body.linkCheck.phase, 'down');
  assert.equal(JSON.stringify(failed.body).includes(KEY), false);

  const okPage = await openAgent('dev');
  try {
    await okPage.waitForFunction(() => {
      const card = document.querySelector('#panel.open [data-direct-card]');
      return card && card.dataset.phase === 'ok';
    }, { timeout: 8000 });
    const ok = await okPage.evaluate(cardFacts);
    assert.equal(ok.phase, 'ok');
    assert.match(ok.card, /Прямая связь: работает/);
    assert.equal(ok.keyButton, false);
    assert.equal(ok.fields, 0);
    assert.equal(ok.card.includes(PLAIN), false);
    assert.equal(/вебхук/i.test(ok.card), false);
    assert.equal(/вебхук/i.test(ok.visible), false);
    assert.equal(ok.foldOpen, false);
    assert.equal(ok.noteHidden, false);
    assert.equal(ok.note, PLAIN);
    const opened = await okPage.evaluate((plain) => {
      const pop = document.querySelector('#servicePop');
      pop.hidden = false;
      const fold = document.querySelector('#serviceFold');
      const closed = fold.open === false;
      fold.open = true;
      return {
        closed,
        summary: fold.querySelector('summary').textContent.trim(),
        shown: document.body.innerText.includes(plain),
      };
    }, PLAIN);
    assert.equal(opened.closed, true);
    assert.equal(opened.summary, 'Служебное');
    assert.equal(opened.shown, true);
  } finally {
    await okPage.close();
  }

  const badPage = await openAgent('qa');
  try {
    await badPage.waitForFunction(() => {
      const card = document.querySelector('#panel.open [data-direct-card]');
      return card && card.dataset.phase === 'down';
    }, { timeout: 8000 });
    const bad = await badPage.evaluate(cardFacts);
    assert.equal(bad.phase, 'down');
    assert.equal(bad.keyButton, true);
    assert.match(bad.card, /Ключ/);
    assert.equal(bad.fields, 0);
    assert.equal(bad.card.includes(PLAIN), true);
    assert.equal(/вебхук/i.test(bad.card), false);
    assert.equal(/вебхук/i.test(bad.visible), false);
    const inputs = await badPage.evaluate(() => (
      [...document.querySelectorAll('#panel.open input')].map((el) => el.type)
    ));
    assert.deepEqual(inputs.filter((type) => type === 'url' || type === 'password'), []);
  } finally {
    await badPage.close();
  }
});
