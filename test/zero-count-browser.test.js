'use strict';

// Бейдж со значением 0 не виден. Когда счёт больше нуля, на бейдже это число.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-zero-'));
process.env.APP_PASSWORD = 'pw-zero';
process.env.AGENT_TOKEN = 'tok-zero';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

const SELECTORS = [
  '#needsBadge',
  '#procBadge',
  '#jCount',
  '#procCount',
  '#needsCount',
  '#hCount',
  '#agentBarAwait',
  '.await-you-count',
  '.org-card .pill',
  '.order-badge',
].join(',');

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

async function openPage(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('appPassword', 'pw-zero');
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('theme', 'day');
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .chip', { timeout: 8000 });
  return page;
}

async function visibleCounts(page) {
  return page.evaluate((selectors) => {
    const shown = (el) => {
      for (let node = el; node; node = node.parentElement) {
        if (node.hidden) return false;
        if (node.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      if (el.classList.contains('hide') || el.classList.contains('is-off')) return false;
      const style = getComputedStyle(el);
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    };
    return [...document.querySelectorAll(selectors)].filter(shown).map((el) => ({
      id: el.id || '',
      cls: el.className && String(el.className).slice(0, 40),
      text: el.textContent.trim(),
    }));
  }, SELECTORS);
}

test('ноль на бейдже не виден, положительное число равно счётчику', { timeout: 60000 }, async () => {
  const before = await api('/api/state');
  assert.equal(before.status, 200);
  const openNeeds = (before.body.needs || []).filter((item) => item && !item.closedAt);
  assert.ok(openNeeds.length > 0);

  const page = await openPage(1280, 800);
  try {
    await page.waitForFunction((count) => {
      const badge = document.querySelector('#needsBadge');
      return badge && badge.textContent.trim() === String(count);
    }, { timeout: 8000 }, openNeeds.length);
    const positive = await visibleCounts(page);
    const needs = positive.find((item) => item.id === 'needsBadge');
    assert.ok(needs, 'бейдж «нужно от вас» не виден при ненулевом счёте');
    assert.equal(needs.text, String(openNeeds.length));

    for (const item of openNeeds) {
      const closed = await api(`/api/needs/${encodeURIComponent(item.id)}/close`, {
        method: 'POST',
        headers: { 'x-app-password': 'pw-zero' },
        body: '{}',
      });
      assert.equal(closed.status, 200, item.id);
    }
    await page.waitForFunction(() => document.querySelector('#needsBadge')?.textContent.trim() === '0', { timeout: 8000 });
    await page.click('#btnProcesses');
    await page.waitForSelector('#processes.open', { timeout: 4000 });
    await page.click('#btnHier');
    await page.waitForSelector('#hier.open', { timeout: 4000 });
    await page.click('#btnJournal');
    await page.waitForSelector('#journal.mobile-open, #journal:not(.map-off)', { timeout: 4000 });

    const zeros = (await visibleCounts(page)).filter((item) => item.text === '0');
    assert.deepEqual(zeros, [], `видны нули: ${JSON.stringify(zeros)}`);

    const mapZeros = await page.evaluate(() => {
      const shown = (el) => {
        for (let node = el; node; node = node.parentElement) {
          if (node.hidden) return false;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        if (el.classList.contains('hide')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 1 && rect.height >= 1 && Number(getComputedStyle(el).opacity) !== 0;
      };
      return [...document.querySelectorAll('#overlay .await-you-count, #overlay .order-badge, #roster .await-you-count')]
        .filter(shown)
        .map((el) => el.textContent.trim())
        .filter((text) => text === '0');
    });
    assert.deepEqual(mapZeros, []);

    const created = [];
    for (const text of ['Первая видимая задача', 'Вторая видимая задача']) {
      const res = await api('/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-zero' },
        body: JSON.stringify({ agent: 'army', text, fromAgentId: 'owner' }),
      });
      assert.equal(res.status, 201, JSON.stringify(res.body && res.body.error));
      created.push(res.body.id);
    }
    await page.waitForFunction(() => document.querySelector('#jCount')?.textContent.trim() === '2', { timeout: 8000 });
    const after = await visibleCounts(page);
    const journal = after.find((item) => item.id === 'jCount');
    assert.ok(journal, 'бейдж журнала не виден при двух задачах');
    assert.equal(journal.text, '2');
    assert.equal(after.some((item) => item.text === '0'), false);
    assert.equal(created.length, 2);
  } finally {
    await page.close();
  }
});
