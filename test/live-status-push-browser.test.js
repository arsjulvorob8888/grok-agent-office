'use strict';

// Открытая карта загорается и гаснет без перезагрузки. 1280 и 390.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-push-ui-'));
process.env.APP_PASSWORD = 'pw-push-ui';
process.env.AGENT_TOKEN = 'tok-push-ui';
process.env.AGENT_STATUS_TOKEN = 'status-push-ui';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.ACTIVITY_WINDOW_MIN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  const list = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
  return list.find((p) => fs.existsSync(p));
}

let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function postStatus(body) {
  return api('/api/agent-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer status-push-ui' },
    body: JSON.stringify(body),
  });
}

async function openPage(viewport) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__boot = 1; });
  return page;
}

async function resetIdle() {
  for (const agentId of ['army', 'trading', 'biz']) {
    const idle = await postStatus({ agentId, status: 'idle' });
    assert.equal(idle.status, 200, `${agentId} ${JSON.stringify(idle.body)}`);
  }
}

async function check(width, height) {
  await resetIdle();
  const page = await openPage({ width, height });
  try {
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="army"]');
      const dot = document.querySelector('#overlay .tag[data-id="army"] .dot');
      return fig && fig.classList.contains('act-idle') && dot && window.LiveStream && LiveStream.connected();
    }, { timeout: 10000 });

    const before = await page.$eval('#stActive', (el) => el.textContent);
    const started = Date.now();
    const posted = await postStatus({ agentId: 'army', status: 'working', doing: 'На линии' });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="army"] .fig-wrap');
      const bld = document.querySelector('#agents .agent[data-id="army"] .bld');
      const dot = document.querySelector('#overlay .tag[data-id="army"] .dot');
      const chip = document.querySelector('#roster .chip[data-id="army"] .st');
      if (!fig || !bld || !dot || !chip) return false;
      const bright = (el) => Math.abs(parseFloat(getComputedStyle(el).opacity) - 1) < 0.05
        && !/grayscale/.test(getComputedStyle(el).filter);
      return dot.classList.contains('working') && chip.classList.contains('working') && bright(fig) && bright(bld);
    }, { timeout: 5000 });
    assert.ok(Date.now() - started < 5000, `${width}: загорелось за ${Date.now() - started} мс`);
    const after = await page.$eval('#stActive', (el) => el.textContent);
    assert.equal(Number(after.split('/')[0]), Number(before.split('/')[0]) + 1, `${width} ${before} → ${after}`);
    assert.equal(await page.evaluate(() => window.__boot), 1);

    const idleAt = Date.now();
    const idle = await postStatus({ agentId: 'army', status: 'idle' });
    assert.equal(idle.status, 200);
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="army"] .fig-wrap');
      const bld = document.querySelector('#agents .agent[data-id="army"] .bld');
      const dot = document.querySelector('#overlay .tag[data-id="army"] .dot');
      if (!fig || !bld || !dot || dot.classList.contains('working')) return false;
      const figDim = (el) => parseFloat(getComputedStyle(el).opacity) < 0.8 && /grayscale/.test(getComputedStyle(el).filter);
      const bldSolid = (el) => parseFloat(getComputedStyle(el).opacity) >= 0.9 && /grayscale/.test(getComputedStyle(el).filter);
      return figDim(fig) && bldSolid(bld);
    }, { timeout: 5000 });
    assert.ok(Date.now() - idleAt < 5000, `${width}: погасло за ${Date.now() - idleAt} мс`);

    await page.evaluate(() => document.querySelector('#overlay .tag[data-id="finance"]').click());
    await page.waitForSelector('#room.open .room-seat[data-id="invest"]');
    await page.waitForSelector('#room.open .room-seat[data-id="analyst"]');
    const counter = await page.$eval('#stActive', (el) => el.textContent);
    const trading = await postStatus({ agentId: 'trading', status: 'working', doing: 'Смотрю стакан' });
    const biz = await postStatus({ agentId: 'biz', status: 'working', doing: 'Считаю юнит' });
    assert.equal(trading.status, 200, JSON.stringify(trading.body));
    assert.equal(biz.status, 200, JSON.stringify(biz.body));
    const hidden = await page.evaluate(() => ({
      tradingSeat: !!document.querySelector('#room .room-seat[data-id="trading"]'),
      bizSeat: !!document.querySelector('#room .room-seat[data-id="biz"]'),
      text: document.querySelector('#room').textContent,
    }));
    assert.equal(hidden.tradingSeat, false);
    assert.equal(hidden.bizSeat, false);
    assert.equal(/Трейдинг|Business Adviser/.test(hidden.text), false);
    const afterDeputies = await page.$eval('#stActive', (el) => el.textContent);
    assert.equal(afterDeputies, counter, `${width} архивные замы не входят в счётчик ${counter} → ${afterDeputies}`);
    assert.equal(await page.$('#agents .agent[data-id="trading"]'), null);
    assert.equal(await page.$('#agents .agent[data-id="biz"]'), null);
    assert.equal((await postStatus({ agentId: 'trading', status: 'idle' })).status, 200);
    assert.equal((await postStatus({ agentId: 'biz', status: 'idle' })).status, 200);

    await page.evaluate(() => LiveStream.suspend(true));
    const fallback = await page.evaluate(() => ({
      up: LiveStream.connected(),
      ms: LiveStream.pollMs(),
    }));
    assert.equal(fallback.up, false);
    assert.ok(fallback.ms >= 10000 && fallback.ms <= 15000, String(fallback.ms));
    const polled = Date.now();
    const late = await postStatus({ agentId: 'army', status: 'working', doing: 'Без потока' });
    assert.equal(late.status, 200);
    await page.waitForFunction(() => {
      const dot = document.querySelector('#overlay .tag[data-id="army"] .dot');
      const fig = document.querySelector('#agents .agent[data-id="army"] .fig-wrap');
      return dot && fig && dot.classList.contains('working')
        && Math.abs(parseFloat(getComputedStyle(fig).opacity) - 1) < 0.05
        && window.LiveStream && !LiveStream.connected();
    }, { timeout: 17000 });
    const spent = Date.now() - polled;
    assert.ok(spent < 17000, `${width}: опрос за ${spent} мс`);
    assert.equal(await page.evaluate(() => window.__boot), 1);
  } finally {
    await page.close();
  }
}

test('открытая страница на 1280 обновляет точку, фигуру, счётчик, замов и опрос', { timeout: 90000 }, async () => {
  await check(1280, 800);
});

test('открытая страница на 390 обновляет точку, фигуру, счётчик, замов и опрос', { timeout: 90000 }, async () => {
  await check(390, 844);
});
