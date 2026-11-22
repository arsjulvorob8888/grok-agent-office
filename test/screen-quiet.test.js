'use strict';

// Инварианты экрана: тихий журнал, одна строка записи, без уровня и опыта,
// порядок нижней панели, список журнала на 390 не перекрыт.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-quiet-'));
process.env.APP_PASSWORD = 'pw-quiet';
process.env.AGENT_TOKEN = 'tok-quiet';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app, state } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].find((item) => item && fs.existsSync(item));
}

const NUMBER_ORDER = [
  'grok', 'army', 'poker', 'devops', 'dev', 'temshik', 'finance',
  'qa', 'blog', 'advisor', 'social', 'routines', 'health',
];

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
  await page.waitForSelector('#roster .chip[data-id="health"]', { timeout: 8000 });
  page.__errors = errors;
  return page;
}

function countOf(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    n += 1;
    from = at + needle.length;
  }
  return n;
}

test('журнал свёрнут и без шапки на карте, когда открытых заданий нет', { timeout: 30000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 });
  try {
    const chrome = await page.evaluate(() => {
      const journal = document.querySelector('#journal');
      const style = getComputedStyle(journal);
      const rect = journal.getBoundingClientRect();
      const open = document.querySelectorAll('#jList > .quest').length;
      const shown = style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 2
        && rect.height > 2;
      return {
        open,
        shown,
        collapsed: journal.classList.contains('collapsed'),
        head: journal.querySelector('h3') ? journal.querySelector('h3').textContent : '',
      };
    });
    assert.equal(chrome.open, 0);
    assert.equal(chrome.shown, false, 'шапка журнала видна на карте');
    assert.equal(chrome.collapsed, true);
    assert.equal(chrome.head, 'Журнал заданий');
    assert.deepEqual(page.__errors, []);
    await page.screenshot({ path: '/tmp/screen-quiet-1280-closed.png' });
  } finally {
    await page.close();
  }
});

test('в записи журнала кому, когда и статус встречаются один раз', { timeout: 30000 }, async () => {
  const created = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-quiet' },
    body: JSON.stringify({ agent: 'social', text: 'ОДНА-СТРОКА проверка журнала', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('#jList .quest')].some((node) => node.textContent.includes('ОДНА-СТРОКА'));
    }, { timeout: 8000 });
    const row = await page.evaluate(() => {
      const quest = [...document.querySelectorAll('#jList .quest')].find((node) => node.textContent.includes('ОДНА-СТРОКА'));
      const line = quest.querySelector('.qm');
      return {
        text: quest.textContent,
        line: line ? line.textContent : '',
        status: quest.querySelector('.badge') ? quest.querySelector('.badge').textContent : '',
      };
    });
    assert.match(row.text, /ОДНА-СТРОКА/);
    assert.match(row.line, /Путин\s*→/);
    assert.equal(row.text.includes('Вы →'), false);
    assert.equal(row.text.includes('Владелец →'), false);
    assert.match(row.line, /МСК/);
    assert.match(row.line, /Соцсети/);
    assert.equal(row.line.includes('ОДНА-СТРОКА'), false);
    assert.equal(countOf(row.text, 'Соцсети'), 1, row.text);
    assert.equal(countOf(row.text, 'МСК'), 1, row.text);
    assert.equal(countOf(row.text, row.status), 1, row.text);
    assert.deepEqual(page.__errors, []);
    await page.screenshot({ path: '/tmp/screen-quiet-1280-line.png' });
  } finally {
    await page.close();
  }
});

test('на экране нет уровня, опыта и «Выполнено: 0»', { timeout: 40000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 }, { path: '/?theme=day&agent=dev' });
  try {
    await page.waitForSelector('#panel.open .p-hero', { timeout: 8000 });
    await page.waitForSelector('#panel.open .dash-expand', { timeout: 8000 });
    await page.click('#panel.open .dash-expand');
    await page.waitForFunction(() => {
      const root = document.querySelector('#agentDash.open');
      if (!root) return false;
      const text = root.textContent || '';
      return text.includes('Последние активности') || text.includes('Сейчас нет задачи');
    }, { timeout: 8000 });
    const noise = await page.evaluate(() => {
      function shown(el) {
        if (!el || el.nodeType !== 1 || el.hidden) return false;
        let node = el;
        while (node && node.nodeType === 1) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          node = node.parentElement;
        }
        return [...el.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
      }
      const hits = [];
      const seen = new Set();
      for (const el of document.body.querySelectorAll('body *')) {
        if (!shown(el)) continue;
        const folded = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!folded || seen.has(folded)) continue;
        if (/опыт/i.test(folded) || /уровень/i.test(folded) || /\/\s*150/.test(folded) || /Выполнено:\s*0/.test(folded)) {
          seen.add(folded);
          if (hits.length < 8) hits.push(folded.slice(0, 120));
        }
      }
      const chips = [...document.querySelectorAll('#roster .chip .lv')].filter(shown).length;
      const html = ['#overlay', '#roster', '#panel', '#agentDash'].map((sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerHTML : '';
      }).join('\n');
      return {
        hits,
        chips,
        levelRow: !!document.querySelector('#panel [data-anchor="level"]'),
        dashLevel: !!document.querySelector('#agentDash .dash-level'),
        html,
      };
    });
    assert.deepEqual(noise.hits, []);
    assert.equal(noise.chips, 0);
    assert.equal(noise.levelRow, false);
    assert.equal(noise.dashLevel, false);
    assert.equal(/уровень/i.test(noise.html), false);
    assert.equal(/опыт/i.test(noise.html), false);
    assert.equal(noise.html.includes('Выполнено:'), false);
    assert.deepEqual(page.__errors, []);
    await page.screenshot({ path: '/tmp/screen-quiet-1280-card.png' });
  } finally {
    await page.close();
  }
});

test('в нижней панели сначала работающие, затем ждущие владельца', { timeout: 40000 }, async () => {
  const working = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-quiet' },
    body: JSON.stringify({ agent: 'health', status: 'working', now: 'На тренировке' }),
  });
  assert.equal(working.status, 200);
  const waiting = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-quiet' },
    body: JSON.stringify({ agent: 'routines', status: 'waiting', now: 'Жду владельца' }),
  });
  assert.equal(waiting.status, 200);

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openPage(viewport);
    try {
      await page.waitForFunction(() => {
        const health = document.querySelector('#roster .chip[data-id="health"]');
        const routines = document.querySelector('#roster .chip[data-id="routines"]');
        return health && health.classList.contains('act-working')
          && routines && routines.classList.contains('act-waiting');
      }, { timeout: 8000 });
      const order = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('#roster .chip')];
        return chips.map((chip) => {
          const badge = chip.querySelector('.await-you');
          const needs = !!(badge && !badge.hidden && !badge.classList.contains('is-off'));
          const group = chip.classList.contains('act-working')
            ? 0
            : (chip.classList.contains('act-waiting') || needs ? 1 : 2);
          const rect = chip.getBoundingClientRect();
          return { id: chip.dataset.id, group, left: rect.left, right: rect.right, width: rect.width };
        });
      });
      const ids = order.map((chip) => chip.id);
      assert.equal(ids.includes('trading'), false);
      assert.equal(ids.includes('biz'), false);
      assert.equal(ids.includes('advisor'), true);
      let prev = 0;
      for (const chip of order) {
        assert.ok(chip.group >= prev, `${viewport.width}: ${chip.id} стоит после более срочного`);
        prev = chip.group;
      }
      for (const group of [0, 1, 2]) {
        const slice = order.filter((chip) => chip.group === group).map((chip) => chip.id);
        const expect = NUMBER_ORDER.filter((id) => slice.includes(id));
        assert.deepEqual(slice, expect, `${viewport.width} группа ${group}`);
      }
      assert.equal(order[0].id, 'health');
      if (viewport.width === 390) {
        const health = order[0];
        assert.ok(health.left >= -1 && health.right <= viewport.width + 1 && health.width > 20, JSON.stringify(health));
        await page.screenshot({ path: '/tmp/screen-quiet-390-roster.png' });
      }
      assert.deepEqual(page.__errors, []);
    } finally {
      await page.close();
    }
  }
});

test('на 390 открытый журнал не перекрыт миникартой и нижней панелью', { timeout: 40000 }, async () => {
  const first = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-quiet' },
    body: JSON.stringify({ agent: 'qa', text: 'СТАРАЯ-ДОСТАВКА-1', fromAgentId: 'owner' }),
  });
  const second = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-quiet' },
    body: JSON.stringify({ agent: 'dev', text: 'СТАРАЯ-ДОСТАВКА-2', fromAgentId: 'owner' }),
  });
  const cancelled = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-quiet' },
    body: JSON.stringify({ agent: 'blog', text: 'ОТМЕНА-ЭКРАН', fromAgentId: 'owner' }),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(cancelled.status, 201);
  const dropped = await api(`/api/orders/${cancelled.body.id}/cancel`, {
    method: 'POST',
    headers: { 'x-app-password': 'pw-quiet' },
    body: '{}',
  });
  assert.equal(dropped.status, 200);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  for (const id of [first.body.id, second.body.id]) {
    const task = state.tasks.find((item) => item.id === id);
    assert.ok(task, id);
    task.createdAt = old;
    task.orderStatus = 'done';
    task.status = 'выполнена';
    for (const entry of task.history || []) entry.at = old;
  }

  const wide = await openPage({ width: 1280, height: 800 });
  try {
    await wide.waitForSelector('#journal .quest', { timeout: 8000 });
    const desk = await wide.evaluate(() => {
      const journal = document.querySelector('#journal');
      const mini = document.querySelector('#minimap');
      const jr = journal.getBoundingClientRect();
      const mr = mini.getBoundingClientRect();
      return {
        z: getComputedStyle(journal).zIndex,
        top: jr.top,
        left: jr.left,
        width: jr.width,
        mapOff: journal.classList.contains('map-off'),
        miniVisible: getComputedStyle(mini).visibility === 'visible' && mr.width > 180,
        miniRight: innerWidth - mr.right,
      };
    });
    assert.equal(desk.mapOff, false);
    assert.equal(desk.z, '4');
    assert.ok(desk.top < 160 && desk.top > 40, JSON.stringify(desk));
    assert.ok(desk.left < 30, JSON.stringify(desk));
    assert.ok(desk.width > 280 && desk.width < 360, JSON.stringify(desk));
    assert.equal(desk.miniVisible, true);
    assert.ok(desk.miniRight < 30, JSON.stringify(desk));
    assert.deepEqual(wide.__errors, []);
    await wide.screenshot({ path: '/tmp/screen-quiet-1280-journal.png' });
  } finally {
    await wide.close();
  }

  const page = await openPage({ width: 390, height: 844 });
  try {
    await page.click('#btnJournal');
    await page.waitForSelector('#journal.mobile-open', { timeout: 8000 });
    await page.waitForFunction(() => {
      const text = document.querySelector('#jList') ? document.querySelector('#jList').textContent : '';
      return text.includes('Доставленные (2)') && text.includes('Отменённые');
    }, { timeout: 8000 });
    const fit = await page.evaluate(() => {
      document.querySelectorAll('#jList details').forEach((node) => { node.open = true; });
      const list = document.querySelector('#jList');
      list.scrollTop = list.scrollHeight;
      const quests = [...list.querySelectorAll('.quest')].filter((el) => el.getClientRects().length > 0);
      const last = quests[quests.length - 1];
      const view = list.getBoundingClientRect();
      const bar = document.querySelector('#agentBar').getBoundingClientRect();
      const mini = document.querySelector('#minimap');
      const card = last.getBoundingClientRect();
      const mr = mini.getBoundingClientRect();
      const samples = [];
      const mark = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        samples.push({
          x: Math.round(x),
          y: Math.round(y),
          inList: !!(hit && (hit === list || list.contains(hit))),
          inMini: !!(hit && (hit === mini || mini.contains(hit) || hit.id === 'miniView')),
        });
      };
      const stepX = Math.max(20, (view.width - 16) / 3);
      const stepY = Math.max(20, (view.height - 16) / 3);
      for (let y = view.top + 6; y < view.bottom - 4; y += stepY) {
        for (let x = view.left + 6; x < view.right - 4; x += stepX) mark(x, y);
      }
      const overlap = mr.right > view.left && mr.left < view.right && mr.bottom > view.top && mr.top < view.bottom;
      if (overlap) {
        mark(
          Math.min(mr.right - 8, Math.max(view.left + 8, (Math.max(mr.left, view.left) + Math.min(mr.right, view.right)) / 2)),
          Math.min(mr.bottom - 8, Math.max(view.top + 8, (Math.max(mr.top, view.top) + Math.min(mr.bottom, view.bottom)) / 2)),
        );
      }
      const cx = Math.min(view.right - 6, Math.max(view.left + 6, card.left + Math.min(24, card.width / 2)));
      const cy = Math.min(view.bottom - 4, Math.max(view.top + 4, card.top + card.height / 2));
      const hitLast = document.elementFromPoint(cx, cy);
      return {
        listBottom: view.bottom,
        barTop: bar.top,
        lastTop: card.top,
        lastBottom: card.bottom,
        lastHeight: card.height,
        viewTop: view.top,
        viewBottom: view.bottom,
        samples,
        lastInList: !!(hitLast && (hitLast === last || last.contains(hitLast) || list.contains(hitLast))),
        delivered: !!list.querySelector('.j-delivered[open]'),
        cancelled: !!list.querySelector('.j-cancelled[open]'),
      };
    });
    assert.equal(fit.delivered, true);
    assert.equal(fit.cancelled, true);
    assert.ok(fit.listBottom <= fit.barTop + 1, JSON.stringify(fit));
    assert.ok(fit.lastHeight > 16, JSON.stringify(fit));
    assert.ok(fit.lastTop >= fit.viewTop - 1, JSON.stringify(fit));
    assert.ok(fit.lastBottom <= fit.viewBottom + 1, JSON.stringify(fit));
    assert.ok(fit.lastBottom <= fit.barTop + 1, JSON.stringify(fit));
    assert.equal(fit.lastInList, true, JSON.stringify(fit));
    for (const sample of fit.samples) {
      assert.equal(sample.inMini, false, JSON.stringify(sample));
      assert.equal(sample.inList, true, JSON.stringify(sample));
    }
    assert.deepEqual(page.__errors, []);
    await page.screenshot({ path: '/tmp/screen-quiet-390.png' });
  } finally {
    await page.close();
  }
});

test('счётчик шапки равен агентам нижней панели', { timeout: 40000 }, async () => {
  const deputy = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-quiet' },
    body: JSON.stringify({ agent: 'invest', status: 'working', now: 'Смотрю долю' }),
  });
  assert.equal(deputy.status, 200);
  const roster = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-quiet' },
    body: JSON.stringify({ agent: 'army', status: 'working', now: 'На линии' }),
  });
  assert.equal(roster.status, 200);
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const army = document.querySelector('#roster .chip[data-id="army"]');
      return army && army.classList.contains('act-working');
    }, { timeout: 8000 });
    const info = await page.evaluate(() => {
      const raw = document.querySelector('#stActive').textContent.trim();
      const parts = raw.split('/');
      const chips = [...document.querySelectorAll('#roster .chip')];
      return {
        raw,
        num: Number(parts[0]),
        den: Number(parts[1]),
        chips: chips.length,
        working: chips.filter((chip) => chip.classList.contains('act-working')).length,
        ids: chips.map((chip) => chip.dataset.id),
        onMap: ['invest', 'analyst', 'trading', 'biz'].filter((id) => document.querySelector(`#roster .chip[data-id="${id}"], #agents .agent[data-id="${id}"]`)),
      };
    });
    assert.equal(info.den, info.chips + 2, info.raw);
    assert.equal(info.num, info.working, info.raw);
    assert.equal(info.ids.includes('trading'), false);
    assert.equal(info.ids.includes('biz'), false);
    assert.deepEqual(info.onMap, []);
    assert.equal(info.ids.includes('army'), true);
    assert.equal(info.ids.includes('advisor'), true);
    assert.ok(info.working >= 1, info.raw);
    await page.evaluate(() => document.querySelector('#overlay .tag[data-id="finance"]').click());
    await page.waitForSelector('#room.open .room-seat[data-id="invest"]', { timeout: 4000 });
    await page.waitForSelector('#room.open .room-seat[data-id="analyst"]', { timeout: 4000 });
    assert.deepEqual(page.__errors, []);
    await page.screenshot({ path: '/tmp/screen-quiet-1280-counter.png' });
  } finally {
    await page.close();
  }
});

test('работающий советник на карте с фигуркой и подписью', { timeout: 30000 }, async () => {
  const posted = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-quiet' },
    body: JSON.stringify({ agent: 'advisor', status: 'working', now: 'Готовлю записку' }),
  });
  assert.equal(posted.status, 200);
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="advisor"] .fig-wrap');
      const name = document.querySelector('#overlay .tag[data-id="advisor"] .nm');
      return fig && name && name.textContent.includes('Советник Путина');
    }, { timeout: 8000 });
    const view = await page.evaluate(() => {
      const agent = document.querySelector('#agents .agent[data-id="advisor"]');
      const name = document.querySelector('#overlay .tag[data-id="advisor"] .nm').textContent.replace(/\s+/g, ' ').trim();
      return {
        working: agent.classList.contains('act-working') || agent.classList.contains('pulse'),
        name,
        figure: !!agent.querySelector('.fig-wrap'),
      };
    });
    assert.equal(view.figure, true);
    assert.equal(view.name, '10. Советник Путина');
    assert.equal(view.working, true);
  } finally {
    await page.close();
  }
});
