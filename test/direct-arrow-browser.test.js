'use strict';

// Карта: доставленное и отвеченное без стрелки на обоих маршрутах.
// Прямое сообщение владельца не выходит из Путина и в журнале не «Путин →».
// После ответа стрелка гаснет без перезагрузки, на 1280 и на 390.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-arrow-'));
process.env.APP_PASSWORD = 'pw-arrow';
process.env.AGENT_TOKEN = 'tok-arrow';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
delete process.env.KREMLIN_WEBHOOK_HEADER;
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.GROK_WEBHOOK_HEADER = '';
process.env.WEBHOOK_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const KEY = 'fixture-arrow-key-ZZZZ';
const DIRECT_OPEN = 'ПРЯМОЕ-ОТКРЫТОЕ сообщение владельца';
const DIRECT_DONE = 'ПРЯМОЕ-ЗАКРЫТОЕ сообщение владельца';
const PUTIN_DONE = 'ПУТИН-ЗАКРЫТЫЙ приказ штаба';

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].find((item) => item && fs.existsSync(item));
}

const hook = http.createServer((_req, res) => {
  res.writeHead(204);
  res.end();
});

let server;
let office;
let browser;
let base;

const ids = {};

function call(urlPath, opts = {}) {
  return fetch(base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}

function auth(extra) {
  return { 'x-app-password': 'pw-arrow', ...(extra || {}) };
}

async function sendTask(agent, text) {
  const created = await call('/api/task', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ agent, text, fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function reply(agentId, taskId, text) {
  const sent = await call('/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-arrow' },
    body: JSON.stringify({ agentId, role: 'agent', taskId, text }),
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return sent.body;
}

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${hook.address().port}`;
  office = require('../server.js');
  server = await new Promise((resolve) => {
    const listening = office.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const putin = await call('/api/delivery/putin', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${origin}/putin`, key: KEY }),
  });
  assert.equal(putin.status, 200, JSON.stringify(putin.body));
  const poker = await call('/api/agents/poker/delivery', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ url: `${origin}/poker`, key: KEY }),
  });
  assert.equal(poker.status, 200, JSON.stringify(poker.body));

  const directOpen = await sendTask('poker', DIRECT_OPEN);
  const directDone = await sendTask('poker', DIRECT_DONE);
  await reply('poker', directDone.id, 'Прямое дошло и закрыто');
  const putinDone = await sendTask('qa', PUTIN_DONE);
  await reply('qa', putinDone.id, 'Приказ Путина закрыт');
  ids.directOpen = directOpen.id;
  ids.directDone = directDone.id;
  ids.putinDone = putinDone.id;

  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден');
  const puppeteer = require('puppeteer-core');
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

test('API: прямая доставка не подписывается Путиным, закрытые поручения не открыты', async () => {
  const state = await call('/api/state');
  const byId = new Map((state.body.tasks || []).map((item) => [item.id, item]));
  const directOpen = byId.get(ids.directOpen);
  const directDone = byId.get(ids.directDone);
  const putinDone = byId.get(ids.putinDone);
  assert.equal(directOpen.sentRoute, 'agent');
  assert.equal(directOpen.outboxStatus, 'delivered');
  assert.equal(directOpen.answeredAt ?? null, null);
  assert.equal(directOpen.status, 'отправлена агенту');
  assert.match(directOpen.routeLabel, /^Вы → /);
  assert.equal(/Путин\s*→/.test(directOpen.routeLabel), false);
  assert.equal(directDone.sentRoute, 'agent');
  assert.equal(directDone.outboxStatus, 'delivered');
  assert.ok(directDone.answeredAt);
  assert.match(directDone.routeLabel, /^Вы → /);
  assert.equal(/Путин\s*→/.test(directDone.routeLabel), false);
  assert.equal(putinDone.sentRoute, 'putin');
  assert.equal(putinDone.outboxStatus, 'delivered');
  assert.ok(putinDone.answeredAt);
  assert.equal(putinDone.status, 'отправлена Путину');
  assert.match(putinDone.routeLabel, /^Путин → /);
  const Feed = require('../public/js/feed');
  assert.equal(Feed.isOpenOrder(directDone), false);
  assert.equal(Feed.isOpenOrder(putinDone), false);
  assert.equal(Feed.isOpenOrder(directOpen), true);
  assert.equal(Feed.isDirectOwnerMessage(directOpen), true);
  assert.equal(Feed.isDirectOwnerMessage(putinDone), false);
});

async function openPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width <= 700,
    hasTouch: viewport.width <= 700,
    deviceScaleFactor: 1,
  });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000)); } catch (_) {}
  });
  await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .chip[data-id="poker"]', { timeout: 8000 });
  await page.waitForFunction(() => window.LiveStream && LiveStream.connected(), { timeout: 8000 });
  await page.waitForFunction((openText) => {
    const node = [...document.querySelectorAll('#jList .q-who')].find((item) => {
      const quest = item.closest('.quest');
      return quest && quest.textContent.includes(openText);
    });
    return !!node;
  }, { timeout: 8000 }, DIRECT_OPEN);
  return page;
}

function readMap(page) {
  return page.evaluate((known) => {
    const who = (id) => {
      const quest = document.querySelector(`#jList [data-anchor="q:${id}"]`);
      const line = quest && quest.querySelector('.q-who');
      return line ? line.textContent.replace(/\s+/g, ' ').trim() : '';
    };
    const arrows = [...document.querySelectorAll('#delegations .deleg')].map((node) => ({
      id: node.dataset.orderId || '',
      tip: node.dataset.tip || '',
    }));
    return {
      arrows,
      directOpen: who(known.directOpen),
      directDone: who(known.directDone),
      putinDone: who(known.putinDone),
      putinArrows: arrows.filter((item) => /^Путин\s*→/.test(item.tip)).map((item) => item.id),
    };
  }, ids);
}

test('на 1280 и 390 нет стрелок у закрытых поручений, прямое не от Путина', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openPage(viewport);
    try {
      const map = await readMap(page);
      const width = viewport.width;
      assert.equal(map.arrows.some((item) => item.id === ids.directDone), false, `${width} прямое закрытое`);
      assert.equal(map.arrows.some((item) => item.id === ids.putinDone), false, `${width} путин закрытое`);
      assert.equal(map.arrows.some((item) => item.id === ids.directOpen), false, `${width} прямое открытое`);
      assert.equal(map.putinArrows.includes(ids.directOpen), false, `${width} стрелка Путина на прямое`);
      assert.equal(map.putinArrows.includes(ids.directDone), false, `${width} стрелка Путина на закрытое прямое`);
      assert.match(map.directOpen, /^Вы → /, `${width} ${map.directOpen}`);
      assert.equal(/Путин\s*→/.test(map.directOpen), false, map.directOpen);
      assert.match(map.directDone, /^Вы → /, `${width} ${map.directDone}`);
      assert.equal(/Путин\s*→/.test(map.directDone), false, map.directDone);
      assert.match(map.putinDone, /^Путин → /, `${width} ${map.putinDone}`);
    } finally {
      await page.close();
    }
  }
});

test('стрелка пропадает при живом обновлении без перезагрузки на 1280 и 390', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openPage(viewport);
    const text = `ЖИВАЯ-СТРЕЛКА-${viewport.width}`;
    try {
      await page.evaluate(() => { window.__stay = 1; });
      const created = await sendTask('routines', text);
      assert.equal(created.sentRoute, 'putin');
      assert.match(created.routeLabel, /^Путин → /);
      await page.waitForFunction((id) => {
        const node = document.querySelector(`#delegations [data-order-id="${id}"]`);
        return !!(node && /^Путин\s*→/.test(node.dataset.tip || ''));
      }, { timeout: 15000 }, created.id);
      const before = await page.evaluate(() => window.__stay);
      assert.equal(before, 1);
      await reply('routines', created.id, `Ответ на ${text}`);
      await page.waitForFunction((id) => !document.querySelector(`#delegations [data-order-id="${id}"]`), { timeout: 15000 }, created.id);
      const after = await page.evaluate(() => ({
        stay: window.__stay,
        nav: performance.getEntriesByType('navigation').length,
      }));
      assert.equal(after.stay, 1, `${viewport.width} страница перезагрузилась`);
      assert.equal(after.nav, 1, `${viewport.width} лишняя навигация`);
      const left = await page.evaluate((id) => !!document.querySelector(`#delegations [data-order-id="${id}"]`), created.id);
      assert.equal(left, false, `${viewport.width} стрелка осталась`);
    } finally {
      await page.close();
    }
  }
});
