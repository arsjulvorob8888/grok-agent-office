'use strict';

// Открытое задание одно для журнала, стрелок, процессов и счётчика.
// t-3 и t-4 переводятся в доставленные и не уходят на повторную отправку.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-open-'));
process.env.APP_PASSWORD = 'pw-open';
process.env.AGENT_TOKEN = 'tok-open';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const Feed = require('../public/js/feed');
const retry = require('../lib/outbox-retry');
const { app, state, rememberLegacyDelivered, clearTestNow } = require('../server.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-22T18:00:00.000Z');

function task(id, extra) {
  return {
    id,
    agent: 'social',
    agentId: 'social',
    fromAgentId: 'owner',
    orderStatus: 'sent',
    text: `текст ${id}`,
    createdAt: new Date(NOW - 1000).toISOString(),
    ...extra,
  };
}

test('число открытых записей журнала и счётчик совпадают с предикатом', () => {
  const tasks = [
    task('live', { text: 'живой приказ' }),
    task('fresh-done', { orderStatus: 'done', status: 'выполнена', text: 'свежее готово' }),
    task('old-done', {
      orderStatus: 'done',
      status: 'выполнена',
      text: 'старое готово',
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
    }),
    task('old-sent', {
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      text: 'старая доставка',
      createdAt: new Date(NOW - 5 * DAY).toISOString(),
    }),
    task('cancel', { orderStatus: 'cancelled', text: 'тест' }),
  ];
  const view = Feed.journalSplit(tasks, NOW);
  const open = tasks.filter((item) => Feed.isOpenOrder(item, NOW));
  assert.equal(view.badge, view.active.length);
  assert.equal(view.badge, open.length);
  assert.deepEqual(view.active.map((item) => item.id), open.map((item) => item.id));
  assert.equal(open.some((item) => item.id === 'old-sent' || item.id === 'old-done' || item.id === 'cancel'), false);
  assert.equal(tasks.length, 5);
});

test('при нуле открытых заданий предикат пуст', () => {
  const tasks = [
    task('old-sent', {
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      createdAt: new Date(NOW - 5 * DAY).toISOString(),
    }),
    task('cancel', { orderStatus: 'cancelled' }),
  ];
  const view = Feed.journalSplit(tasks, NOW);
  assert.equal(view.badge, 0);
  assert.equal(view.active.length, 0);
  assert.equal(tasks.filter((item) => Feed.isOpenOrder(item, NOW)).length, 0);
});

test('sent, но уже доставленное, не открыто и не рисует стрелку', () => {
  const delivered = task('t-arrow', {
    agent: 'finance',
    agentId: 'finance',
    orderStatus: 'sent',
    forwardStatus: 200,
    outboxStatus: 'delivered',
    deliveryLabel: 'Доставлено',
    text: 'Ответ финансам',
    createdAt: new Date(NOW - 5 * DAY).toISOString(),
  });
  assert.equal(Feed.isOpenOrder(delivered, NOW), false);
  assert.equal(Feed.journalSplit([delivered], NOW).badge, 0);
  const source = fs.readFileSync(path.join(__dirname, '../public/js/delegation.js'), 'utf8');
  assert.match(source, /isOpenOrder/);
});

test('миграция переводит t-3 и t-4 в доставленные и не удаляет записи', () => {
  const memoryTasks = [
    task('t-3', { agent: 'finance', agentId: 'finance', text: 'финансы 17.11', createdAt: '2026-11-17T14:00:00.000Z', forwardStatus: null }),
    task('t-4', { agent: 'social', agentId: 'social', text: 'соцсети 17.11', createdAt: '2026-11-17T14:05:00.000Z', forwardStatus: null }),
    task('t-keep', { text: 'чужой приказ' }),
  ];
  const memoryOutbox = [
    { id: 'ob-3', taskId: 't-3', status: 'queued', attempts: 2, lastError: 'сеть', payload: { text: 'финансы 17.11' } },
    { id: 'ob-4', taskId: 't-4', status: 'delivered', attempts: 1, payload: { text: 'соцсети 17.11' } },
    { id: 'ob-keep', taskId: 't-keep', status: 'queued', attempts: 0, payload: { text: 'чужой приказ' } },
  ];
  const before = memoryTasks.map((item) => item.id).join(',');
  const first = retry.settleLegacyDelivered(memoryTasks, memoryOutbox);
  assert.equal(memoryTasks.map((item) => item.id).join(','), before);
  assert.equal(memoryTasks.length, 3);
  assert.equal(memoryOutbox.length, 3);
  for (const id of ['t-3', 't-4']) {
    const row = memoryTasks.find((item) => item.id === id);
    assert.equal(row.text.includes('17.11'), true);
    assert.equal(Feed.taskDeliveryLabel({ ...row, outboxStatus: 'delivered' }), 'Доставлено');
    assert.equal(retry.dueOnTimer(memoryOutbox.find((item) => item.taskId === id)), false);
    assert.equal(memoryOutbox.find((item) => item.taskId === id).status, 'delivered');
  }
  assert.equal(memoryOutbox.find((item) => item.taskId === 't-keep').status, 'queued');
  assert.equal(memoryTasks.find((item) => item.id === 't-keep').forwardStatus, undefined);
  const second = retry.settleLegacyDelivered(memoryTasks, memoryOutbox);
  assert.equal(second.tasks.length, 0);
  assert.equal(second.outbox.length, 0);
  assert.ok(first.tasks.length >= 1);

  state.tasks.push(
    task('t-3', { agent: 'finance', agentId: 'finance', text: 'финансы из памяти', createdAt: '2026-11-17T14:00:00.000Z' }),
    task('t-4', { agent: 'social', agentId: 'social', text: 'соцсети из памяти', createdAt: '2026-11-17T14:05:00.000Z' }),
  );
  state.outbox.push({ id: 'ob-live-3', taskId: 't-3', status: 'queued', attempts: 1, payload: { text: 'финансы из памяти' } });
  const live = rememberLegacyDelivered();
  assert.equal(state.tasks.filter((item) => item.id === 't-3').length, 1);
  assert.equal(state.tasks.filter((item) => item.id === 't-4').length, 1);
  assert.equal(state.tasks.find((item) => item.id === 't-3').text, 'финансы из памяти');
  assert.equal(state.outbox.find((item) => item.taskId === 't-3').status, 'delivered');
  assert.equal(retry.dueOnTimer(state.outbox.find((item) => item.taskId === 't-3')), false);
  const again = rememberLegacyDelivered();
  assert.equal(again.tasks.length, 0);
  assert.equal(again.outbox.length, 0);
  assert.equal(live.tasks.length + live.outbox.length > 0, true);
  const qa = state.agents.find((agent) => agent.id === 'qa');
  const advisor = state.agents.find((agent) => agent.id === 'advisor');
  qa.now = 'тест';
  advisor.now = ' тест ';
  const cleared = clearTestNow();
  assert.equal(qa.now, '');
  assert.equal(advisor.now, '');
  assert.equal(cleared.length, 2);
  assert.equal(clearTestNow().length, 0);
  assert.ok(state.agents.some((agent) => agent.id === 'qa'));
  assert.ok(state.agents.some((agent) => agent.id === 'advisor'));
});

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].find((item) => item && fs.existsSync(item));
}

const puppeteer = (() => {
  try { return require('puppeteer-core'); } catch (_) { return null; }
})();
const chrome = chromePath();

if (!puppeteer || !chrome) {
  test('стрелки на карте', { skip: 'нет Chrome' }, () => {});
} else {
  let server;
  let browser;
  let base;

  before(async () => {
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
    await page.waitForSelector('#roster .chip[data-id="social"]', { timeout: 8000 });
    return page;
  }

  test('стрелки, открытые записи журнала и счётчик совпадают, доставленное sent стрелку не рисует', { timeout: 40000 }, async () => {
    const created = await api('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-open' },
      body: JSON.stringify({ agent: 'social', text: 'ЖИВАЯ-СТРЕЛКА соцсетям', fromAgentId: 'owner' }),
    });
    assert.equal(created.status, 201);
    const old = new Date(Date.now() - 5 * DAY).toISOString();
    state.tasks.push({
      id: 't-3',
      agent: 'finance',
      agentId: 'finance',
      fromAgentId: 'owner',
      orderStatus: 'sent',
      forwardStatus: 200,
      text: 'СТАРАЯ-СТРЕЛКА финансам',
      createdAt: old,
      history: [{ status: 'sent', at: old }],
      attachments: [],
    });
    state.outbox.push({
      id: 'ob-t3-map',
      taskId: 't-3',
      status: 'delivered',
      attempts: 1,
      lastStatus: 200,
      payload: { taskId: 't-3', type: 'owner_task', text: 'СТАРАЯ-СТРЕЛКА финансам' },
    });

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await openPage(viewport);
      try {
        await page.waitForFunction(() => {
          return document.querySelector('#jList') && document.querySelector('#jList').textContent.includes('ЖИВАЯ-СТРЕЛКА');
        }, { timeout: 8000 });
        const info = await page.evaluate(() => {
          const arrows = document.querySelectorAll('#delegations .deleg').length;
          const open = document.querySelectorAll('#jList > .quest').length;
          const badge = document.querySelector('#jCount').textContent.trim();
          return {
            arrows,
            open,
            badge,
            oldArrow: !!document.querySelector('#delegations [data-order-id="t-3"]'),
          };
        });
        assert.equal(info.oldArrow, false, `${viewport.width} старая стрелка`);
        assert.equal(String(info.arrows), info.badge, `${viewport.width} ${info.badge}`);
        assert.equal(info.arrows, info.open, `${viewport.width}`);
        assert.ok(info.arrows >= 1, `${viewport.width}`);
        if (viewport.width === 1280) {
          const hit = await page.evaluate(() => {
            const line = document.querySelector('#delegations .deleg-hit');
            if (!line) return null;
            const svg = line.ownerSVGElement;
            const len = line.getTotalLength();
            for (let i = 0; i <= 16; i += 1) {
              const point = line.getPointAtLength(len * (0.2 + (0.6 * i) / 16));
              const svgPoint = svg.createSVGPoint();
              svgPoint.x = point.x;
              svgPoint.y = point.y;
              const screen = svgPoint.matrixTransform(line.getScreenCTM());
              const el = document.elementFromPoint(screen.x, screen.y);
              if (el && el.closest && el.closest('#delegations .deleg')) return { x: screen.x, y: screen.y };
            }
            return null;
          });
          assert.ok(hit, 'стрелка не под курсором');
          await page.mouse.move(hit.x, hit.y);
          await page.waitForFunction(() => {
            const tip = document.querySelector('#tooltip');
            return tip && tip.classList.contains('show') && /Путин\s*→/.test(tip.textContent) && tip.textContent.includes('ЖИВАЯ-СТРЕЛКА');
          }, { timeout: 4000 });
          const tip = await page.$eval('#tooltip', (el) => el.textContent);
          assert.match(tip, /статус/);
        } else {
          const tapped = await page.evaluate(() => {
            const line = document.querySelector('#delegations .deleg-hit');
            if (!line) return null;
            const svg = line.ownerSVGElement;
            const len = line.getTotalLength();
            const point = line.getPointAtLength(len * 0.5);
            const svgPoint = svg.createSVGPoint();
            svgPoint.x = point.x;
            svgPoint.y = point.y;
            const screen = svgPoint.matrixTransform(line.getScreenCTM());
            return { x: screen.x, y: screen.y };
          });
          assert.ok(tapped);
          await page.touchscreen.tap(tapped.x, tapped.y);
          await page.waitForFunction(() => {
            const tip = document.querySelector('#tooltip');
            return tip && tip.classList.contains('show') && /Путин\s*→/.test(tip.textContent);
          }, { timeout: 4000 });
        }
      } finally {
        await page.close();
      }
    }
  });

  test('при нуле открытых заданий на карте нет стрелок', { timeout: 40000 }, async () => {
    const old = new Date(Date.now() - 5 * DAY).toISOString();
    if (!state.tasks.some((item) => item && item.id === 't-3')) {
      state.tasks.push({
        id: 't-3',
        agent: 'finance',
        agentId: 'finance',
        fromAgentId: 'owner',
        orderStatus: 'sent',
        forwardStatus: 200,
        text: 'СТАРАЯ-СТРЕЛКА финансам',
        createdAt: old,
        history: [],
        attachments: [],
      });
      state.outbox.push({ id: 'ob-t3-quiet', taskId: 't-3', status: 'delivered', attempts: 1, lastStatus: 200, payload: { text: 'СТАРАЯ-СТРЕЛКА финансам' } });
    }
    for (const item of state.tasks) {
      if (!item || item.id === 't-3' || item.id === 't-4') continue;
      if (item.orderStatus === 'cancelled') continue;
      item.orderStatus = 'cancelled';
      item.status = 'отменён';
    }
    const page = await openPage({ width: 390, height: 844 });
    try {
      await page.waitForFunction(() => {
        const badge = document.querySelector('#jCount');
        return badge && badge.textContent.trim() === '0';
      }, { timeout: 8000 });
      const arrows = await page.$$eval('#delegations .deleg', (nodes) => nodes.length);
      assert.equal(arrows, 0);
      assert.equal(await page.$('#delegations [data-order-id="t-3"]'), null);
    } finally {
      await page.close();
    }
  });
}
