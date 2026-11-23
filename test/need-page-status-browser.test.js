'use strict';

// Страница нужды берёт закрытость из того же поля, что список «Нужно от вас».
// У открытой на экране «Ждёт». У закрытой — нет, и нет кнопки «Да».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-need-page-'));
process.env.APP_PASSWORD = 'pw-need-page';
process.env.AGENT_TOKEN = 'tok-need-page';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_URL = '';
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
    '/usr/local/bin/google-chrome',
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

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function openNeed(id) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('appPassword', 'pw-need-page');
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
  });
  await page.goto(`${base}/needs/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const title = document.querySelector('#needTitle');
    return title && title.textContent.trim().length > 0;
  }, { timeout: 8000 });
  return page;
}

function pageFacts() {
  const yes = document.querySelector('#needYes');
  const yesBox = yes ? yes.getBoundingClientRect() : null;
  const form = document.querySelector('#needAnswerForm');
  const yesShown = !!(yes && yesBox && yesBox.width > 1 && yesBox.height > 1 && !yes.closest('[hidden]'));
  return {
    who: (document.querySelector('#needWho') || {}).textContent || '',
    page: (document.querySelector('#needPage') || {}).innerText || '',
    formHidden: !form || form.hidden,
    yesShown,
  };
}

test('у закрытой нужды на странице нет «Ждёт», у открытой оно есть', { timeout: 45000 }, async () => {
  const created = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-need-page' },
    body: JSON.stringify({
      what: 'Открытый вопрос про дату',
      where: 'Штаб',
      fromAgentId: 'finance',
      urgency: 'normal',
      answerMode: 'yesno',
      answerable: true,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body && created.body.error));
  assert.equal(created.body.closedAt, null);

  const openPage = await openNeed(created.body.id);
  try {
    await openPage.waitForFunction(() => /Ждёт/.test(document.querySelector('#needWho')?.textContent || ''), { timeout: 8000 });
    const open = await openPage.evaluate(pageFacts);
    assert.match(open.who, /Ждёт/);
    assert.equal(open.yesShown, true);
  } finally {
    await openPage.close();
  }

  const closed = await api(`/api/needs/${encodeURIComponent(created.body.id)}/close`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-need-page' },
    body: '{}',
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body && closed.body.error));
  assert.ok(closed.body.closedAt);

  const closedPage = await openNeed(created.body.id);
  try {
    await closedPage.waitForFunction(() => {
      const who = document.querySelector('#needWho')?.textContent || '';
      return who.length > 0 && !/Ждёт/.test(who);
    }, { timeout: 8000 });
    const view = await closedPage.evaluate(pageFacts);
    assert.equal(/Ждёт/.test(view.page), false);
    assert.match(view.who, /Решена|Закрыта/);
    assert.match(view.who, /МСК/);
    assert.equal(view.formHidden, true);
    assert.equal(view.yesShown, false);
  } finally {
    await closedPage.close();
  }

  const fixture = await api('/api/needs/need-test-qa');
  if (fixture.status === 200 && fixture.body && fixture.body.closedAt) {
    const testPage = await openNeed('need-test-qa');
    try {
      await testPage.waitForFunction(() => {
        const who = document.querySelector('#needWho')?.textContent || '';
        return who.length > 0;
      }, { timeout: 8000 });
      const view = await testPage.evaluate(pageFacts);
      assert.equal(/Ждёт/.test(view.page), false, view.who);
      assert.match(view.who, /Решена|Закрыта/);
      assert.equal(view.yesShown, false);
    } finally {
      await testPage.close();
    }
  }
});
