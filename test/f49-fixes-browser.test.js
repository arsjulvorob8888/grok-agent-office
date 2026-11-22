'use strict';

// F49-1: строка журнала на карте не выше 40px. Замы: в панели район родителя.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-f49-'));
process.env.APP_PASSWORD = 'pw-f49';
process.env.AGENT_TOKEN = 'tok-f49';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

const MARKER = 'СТРОКА-ЖУРНАЛА проверка высоты и подробностей на узкой карте';
const PARENT_DISTRICT = 'Китай-город · Ильинка';
const DEPUTIES = [
  ['invest', '7.1'],
  ['analyst', '7.2'],
  ['temshik', '7.3'],
];

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
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

async function openPage(viewport, extra = {}) {
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
    errors.push(text);
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      localStorage.removeItem('journal');
    } catch (_) { /* кадр без хранилища */ }
  });
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width <= 700,
    hasTouch: viewport.width <= 700,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}${extra.path || '/?theme=day'}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btnJournal', { timeout: 8000 });
  page.__errors = errors;
  return page;
}

function rowProbe() {
  const list = document.querySelector('#jList');
  const quest = [...document.querySelectorAll('#jList > .quest')].find((node) => node.textContent.includes('СТРОКА-ЖУРНАЛА'));
  if (!list || !quest) return null;
  const who = quest.querySelector('.q-who');
  const when = quest.querySelector('.q-when');
  const badge = quest.querySelector('.badge');
  const title = quest.querySelector('.qt');
  const box = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      height: rect.height,
      width: rect.width,
      display: style.display,
      visibility: style.visibility,
      overflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  };
  const questRect = quest.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  const sameLine = (a, b) => !!(a && b && a.top < b.bottom - 1 && b.top < a.bottom - 1);
  return {
    height: questRect.height,
    open: quest.classList.contains('open'),
    visible: (quest.innerText || '').replace(/\s+/g, ' ').trim(),
    who: box(who),
    when: box(when),
    badge: box(badge),
    title: box(title),
    line: sameLine(box(who), box(when)) && sameLine(box(when), box(badge)) && sameLine(box(who), box(badge)),
    insideList: questRect.left >= listRect.left - 1
      && questRect.right <= listRect.right + 1
      && quest.scrollWidth <= quest.clientWidth + 1
      && (!who || who.getBoundingClientRect().right <= questRect.right + 1)
      && (!when || when.getBoundingClientRect().right <= questRect.right + 1)
      && (!badge || badge.getBoundingClientRect().right <= questRect.right + 1),
    insideView: questRect.left >= -1 && questRect.right <= window.innerWidth + 1,
    btn: (document.querySelector('#btnJournal') || {}).getAttribute
      ? document.querySelector('#btnJournal').getAttribute('aria-label')
      : '',
  };
}

test('строка журнала на 1280 и 390 не выше 40px: кому, время, статус, клик открывает подробности', { timeout: 60000 }, async () => {
  const quiet = await openPage({ width: 1280, height: 800 });
  try {
    const folded = await quiet.evaluate(() => {
      const journal = document.querySelector('#journal');
      const style = getComputedStyle(journal);
      const rect = journal.getBoundingClientRect();
      const shown = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      return {
        shown,
        collapsed: journal.classList.contains('collapsed'),
        rows: document.querySelectorAll('#jList > .quest').length,
        btn: document.querySelector('#btnJournal').getAttribute('aria-label'),
      };
    });
    assert.equal(folded.rows, 0);
    assert.equal(folded.shown, false);
    assert.equal(folded.collapsed, true);
    assert.equal(folded.btn, 'Журнал заданий');
    assert.deepEqual(quiet.__errors, []);
  } finally {
    await quiet.close();
  }

  const created = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-f49' },
    body: JSON.stringify({ agent: 'health', text: MARKER, fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openPage(viewport);
    try {
      if (viewport.width <= 900) {
        await page.click('#btnJournal');
        await page.waitForSelector('#journal.mobile-open .quest', { timeout: 8000 });
      } else {
        await page.waitForSelector('#jList > .quest', { timeout: 8000 });
      }
      await page.waitForFunction(() => {
        return [...document.querySelectorAll('#jList > .quest')].some((node) => node.textContent.includes('СТРОКА-ЖУРНАЛА'));
      }, { timeout: 8000 });
      const before = await page.evaluate(rowProbe);
      assert.ok(before, 'строка журнала не найдена');
      assert.ok(before.height > 0 && before.height <= 40, `высота ${before.height}px на ${viewport.width}`);
      assert.equal(before.line, true, JSON.stringify(before));
      assert.equal(before.open, false);
      assert.match(before.who.text, /Путин/);
      assert.match(before.who.text, /Здоровье/);
      assert.match(before.when.text, /\d{2}:\d{2}\s*МСК/);
      assert.ok(before.badge.text.length > 0, JSON.stringify(before.badge));
      assert.equal(before.visible.includes(MARKER), false, before.visible);
      assert.equal(before.visible.includes(before.who.text), true);
      assert.equal(before.visible.includes(before.when.text), true);
      assert.equal(before.visible.includes(before.badge.text), true);
      assert.equal(before.title && (before.title.display === 'none' || before.title.height < 1), true);
      assert.equal(before.insideList, true, JSON.stringify(before));
      assert.equal(before.insideView, true, JSON.stringify(before));
      assert.equal(before.who.overflow, 'ellipsis');
      assert.equal(before.who.whiteSpace, 'nowrap');
      assert.equal(before.when.whiteSpace, 'nowrap');
      assert.equal(before.badge.whiteSpace, 'nowrap');
      if (viewport.width === 390) {
        assert.ok(before.who.scrollWidth > before.who.clientWidth + 1, JSON.stringify(before.who));
      }
      assert.equal(before.btn, 'Журнал заданий');

      await page.click('#jList > .quest');
      await page.waitForFunction(() => {
        const quest = [...document.querySelectorAll('#jList > .quest')].find((node) => node.textContent.includes('СТРОКА-ЖУРНАЛА'));
        if (!quest || !quest.classList.contains('open')) return false;
        const title = quest.querySelector('.qt');
        if (!title) return false;
        const style = getComputedStyle(title);
        const rect = title.getBoundingClientRect();
        return style.display !== 'none' && rect.height > 4 && title.textContent.includes('СТРОКА-ЖУРНАЛА');
      }, { timeout: 4000 });
      const after = await page.evaluate(rowProbe);
      assert.equal(after.open, true);
      assert.match(after.visible, /СТРОКА-ЖУРНАЛА/);
      assert.equal(after.title.display === 'none' || after.title.height < 1, false);
      assert.match(after.who.text, /Путин/);
      assert.match(after.when.text, /МСК/);
      assert.ok(after.badge.text.length > 0);
      assert.equal(after.insideList, true, JSON.stringify({ who: after.who, title: after.title, inside: after.insideList }));
      assert.equal(after.insideView, true);
      assert.deepEqual(page.__errors, []);
    } finally {
      await page.close();
    }
  }
});

test('у замов 7.1, 7.2 и 7.3 в панели район родителя', { timeout: 40000 }, async () => {
  const state = await api('/api/state');
  assert.equal(state.status, 200);
  const byId = new Map(state.body.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get('finance').district, PARENT_DISTRICT);
  assert.equal(byId.get('finance').number, '7');
  assert.equal(state.body.agents.some((agent) => agent.number === '6'), false);
  const page = await openPage({ width: 1280, height: 800 });
  try {
    for (const [id, number] of DEPUTIES) {
      const agent = byId.get(id);
      assert.equal(agent.parentId, 'finance', id);
      assert.equal(agent.number, number, id);
      await page.goto(`${base}/?theme=day&agent=${id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`#panel.open[data-agent="${id}"] .p-title .kicker`, { timeout: 8000 });
      const ui = await page.evaluate((agentId) => {
        const panel = document.querySelector(`#panel.open[data-agent="${agentId}"]`);
        const text = (sel) => {
          const el = panel && panel.querySelector(sel);
          return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        };
        return { kicker: text('.p-title .kicker'), title: text('h2') };
      }, id);
      assert.equal(ui.kicker, PARENT_DISTRICT, `${id}: ${ui.kicker}`);
      assert.equal(ui.kicker.includes('Замоскворечье'), false, id);
      assert.match(ui.title, new RegExp(`^${number.replace('.', '\\.')}\\s`), `${id}: ${ui.title}`);
    }
    assert.deepEqual(page.__errors, []);
  } finally {
    await page.close();
  }
});
