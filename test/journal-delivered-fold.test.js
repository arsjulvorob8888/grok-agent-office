'use strict';

// Доставленное и отвеченное сразу в «Доставленные». Счётчик — число открытых.
// Прямое сообщение владельца в журнале без подписи «Путин →».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-fold-'));
process.env.APP_PASSWORD = 'pw-fold';
process.env.AGENT_TOKEN = 'tok-fold';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
process.env.WEBHOOK_SECRETS_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const Feed = require('../public/js/feed');
const { app } = require('../server.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-22T18:00:00.000Z');
const FRESH = 'СВЕЖАЯ-ДОСТАВКА владельца через вебхук';
const LIVE = 'ЖИВАЯ-ОЧЕРЕДЬ из окна агента';
const PUTIN = 'ПРИКАЗ-ПУТИНА штаба';

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

test('свежее «Доставлено» и «Выполнена» сразу не открыты, счётчик равен открытым', () => {
  const tasks = [
    task('fresh-sent', {
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      text: 'свежая доставка',
    }),
    task('fresh-done', { orderStatus: 'done', status: 'выполнена', text: 'свежий ответ' }),
    task('old-sent', {
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'delivered',
      deliveryLabel: 'Доставлено',
      text: 'старая доставка',
      createdAt: new Date(NOW - 5 * DAY).toISOString(),
    }),
    task('wait', {
      orderStatus: 'sent',
      forwardStatus: null,
      outboxStatus: 'queued',
      deliveryRoute: 'agent',
      text: 'Ждёт ответа',
      createdAt: new Date(NOW - 5 * DAY).toISOString(),
    }),
    task('transit', {
      orderStatus: 'sent',
      forwardStatus: 200,
      outboxStatus: 'queued',
      text: 'в пути',
    }),
    task('miss', {
      orderStatus: 'sent',
      forwardStatus: 502,
      outboxStatus: 'queued',
      text: 'не доставлено',
    }),
    task('work', { orderStatus: 'in_progress', text: 'в работе' }),
    task('cancel', { orderStatus: 'cancelled', text: 'тест' }),
  ];
  const beforeIds = tasks.map((item) => item.id).join(',');
  const view = Feed.journalSplit(tasks, NOW);
  const open = tasks.filter((item) => Feed.isOpenOrder(item, NOW));
  assert.equal(Feed.isOpenOrder(tasks[0], NOW), false);
  assert.equal(Feed.isOpenOrder(tasks[1], NOW), false);
  assert.equal(Feed.isOpenOrder(tasks[2], NOW), false);
  assert.equal(Feed.taskBadge(tasks[3])[1].includes('ждёт'), true);
  assert.equal(Feed.isOpenOrder(tasks[3], NOW), true);
  assert.equal(Feed.taskBadge(tasks[4])[1], 'Отправлена');
  assert.equal(Feed.isOpenOrder(tasks[4], NOW), true);
  assert.equal(Feed.isOpenOrder(tasks[5], NOW), true);
  assert.equal(Feed.isOpenOrder(tasks[6], NOW), true);
  assert.equal(view.badge, view.active.length);
  assert.equal(view.badge, open.length);
  assert.deepEqual(view.active.map((item) => item.id), open.map((item) => item.id));
  assert.deepEqual(view.delivered.map((item) => item.id).sort(), ['fresh-done', 'fresh-sent', 'old-sent']);
  assert.equal(view.empty, '');
  assert.equal(tasks.map((item) => item.id).join(','), beforeIds);
  const quiet = Feed.visibleJournal([tasks[0], tasks[1], tasks[2], tasks[7]], NOW);
  assert.equal(quiet.active.length, 0);
  assert.equal(quiet.total, 0);
  assert.equal(quiet.total, quiet.active.length);
  assert.equal(quiet.empty, 'Всё доставлено');
  assert.equal(quiet.delivered.length, 3);
  assert.equal(quiet.cancelled.length, 1);
});

test('прямое сообщение владельца — общий признак, приказ Путина — нет', () => {
  assert.equal(typeof Feed.ownerDirectTask, 'function');
  assert.equal(Feed.ownerDirectTask({ fromAgentId: 'owner' }), true);
  assert.equal(Feed.ownerDirectTask({ fromAgentId: '' }), true);
  assert.equal(Feed.ownerDirectTask({ fromAgentId: null }), true);
  assert.equal(Feed.ownerDirectTask({ fromAgentId: 'grok' }), false);
  assert.equal(Feed.ownerDirectTask({ fromAgentId: 'dev' }), false);
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(source, /ownerDirectTask/);
});

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((item) => item && fs.existsSync(item));
}

const puppeteer = (() => {
  try { return require('puppeteer-core'); } catch (_) { return null; }
})();
const chrome = chromePath();

if (!puppeteer || !chrome) {
  test('журнал на 1280 и 390', { skip: 'нет Chrome' }, () => {});
} else {
  const hook = http.createServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  let server;
  let browser;
  let base;
  let hookOrigin;

  before(async () => {
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookOrigin = `http://127.0.0.1:${hook.address().port}`;
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const saved = await fetch(`${base}/api/agents/qa/delivery`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-fold' },
      body: JSON.stringify({ url: `${hookOrigin}/qa`, key: 'fold-key-SHOULD-NOT-SHOW' }),
    });
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
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

  async function openPage(viewport, liveText) {
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
    await page.waitForSelector('#jList', { timeout: 8000 });
    await page.evaluate(() => {
      const journal = document.querySelector('#journal');
      const narrow = innerWidth <= 900;
      const open = narrow ? journal.classList.contains('mobile-open') : !journal.classList.contains('collapsed');
      if (!open) document.querySelector('#btnJournal').click();
      journal.dataset.userToggle = '1';
    });
    await page.waitForFunction((marker) => {
      const list = document.querySelector('#jList');
      return list && list.textContent.includes(marker);
    }, { timeout: 8000 }, liveText);
    return page;
  }

  function readJournal(page, fresh, live, putin) {
    return page.evaluate((freshText, liveText, putinText) => {
      const row = (marker) => [...document.querySelectorAll('#jList .quest')].find((node) => node.textContent.includes(marker)) || null;
      const whoOf = (marker) => {
        const quest = row(marker);
        const who = quest && quest.querySelector('.q-who');
        return who ? who.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      const top = [...document.querySelectorAll('#jList > .quest')];
      const folded = document.querySelector('#jList .j-delivered');
      const summary = folded && folded.querySelector('summary') ? folded.querySelector('summary').textContent.replace(/\s+/g, ' ').trim() : '';
      const empty = document.querySelector('#jList > .empty b');
      const emptyStyle = empty ? getComputedStyle(empty) : null;
      const emptyRect = empty ? empty.getBoundingClientRect() : null;
      const badge = document.querySelector('#jCount').textContent.trim();
      return {
        top: top.map((node) => node.textContent),
        summary,
        badge,
        open: top.length,
        freshWho: whoOf(freshText),
        liveWho: whoOf(liveText),
        putinWho: whoOf(putinText),
        freshTop: top.some((node) => node.textContent.includes(freshText)),
        liveTop: top.some((node) => node.textContent.includes(liveText)),
        freshFold: !!(folded && folded.textContent.includes(freshText)),
        liveFold: !!(folded && folded.textContent.includes(liveText)),
        empty: empty ? empty.textContent.replace(/\s+/g, ' ').trim() : '',
        emptyShown: !!(empty && emptyStyle.display !== 'none' && emptyStyle.visibility !== 'hidden' && emptyRect.height > 0 && emptyRect.width > 0),
      };
    }, fresh, live, putin);
  }

  async function postTask(agent, text, fromAgentId) {
    const res = await fetch(`${base}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-fold' },
      body: JSON.stringify({ agent, text, fromAgentId }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body;
  }

  test('на 1280 и 390 доставленное сразу в свёртке, счётчик равен открытым, без F5', { timeout: 120000 }, async () => {
    const cases = [
      { width: 1280, height: 800, liveAgent: 'dev', putinAgent: 'blog' },
      { width: 390, height: 844, liveAgent: 'social', putinAgent: 'finance' },
    ];
    for (const viewport of cases) {
      const fresh = `${FRESH} ${viewport.width}`;
      const live = `${LIVE} ${viewport.width}`;
      const putin = `${PUTIN} ${viewport.width}`;
      const freshBody = await postTask('qa', fresh, 'owner');
      assert.equal(freshBody.fromAgentId, 'owner');
      assert.equal(freshBody.sentRoute, 'agent');
      assert.equal(freshBody.deliveryLabel, 'Доставлено');
      const liveBody = await postTask(viewport.liveAgent, live, 'owner');
      assert.equal(liveBody.fromAgentId, 'owner');
      assert.notEqual(liveBody.deliveryLabel, 'Доставлено');
      const putinBody = await postTask(viewport.putinAgent, putin, 'grok');
      assert.equal(putinBody.fromAgentId, 'grok');
      const page = await openPage(viewport, live);
      try {
        const first = await readJournal(page, fresh, live, putin);
        assert.equal(first.freshTop, false, `${viewport.width} свежая доставка сверху`);
        assert.equal(first.freshFold, true, `${viewport.width} ${first.summary}`);
        assert.match(first.summary, /^Доставленные \(\d+\)$/);
        assert.equal(first.liveTop, true, `${viewport.width} живая очередь не сверху`);
        assert.equal(String(first.open), first.badge, `${viewport.width} счётчик ${first.badge}`);
        assert.ok(first.open >= 1, `${viewport.width}`);
        assert.equal(/Путин\s*→/.test(first.freshWho), false, first.freshWho);
        assert.equal(/Путин\s*→/.test(first.liveWho), false, first.liveWho);
        assert.match(first.putinWho, /Путин\s*→/);
        await page.evaluate(() => { window.__stay = 1; });
        const hooked = await fetch(`${base}/api/agents/${viewport.liveAgent}/delivery`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-fold' },
          body: JSON.stringify({ url: `${hookOrigin}/${viewport.liveAgent}`, key: 'fold-key-SHOULD-NOT-SHOW' }),
        });
        const hookedBody = await hooked.json();
        assert.equal(hooked.status, 200, JSON.stringify(hookedBody));
        await page.waitForFunction((marker) => {
          const top = [...document.querySelectorAll('#jList > .quest')];
          const folded = document.querySelector('#jList .j-delivered');
          return folded && folded.textContent.includes(marker) && !top.some((node) => node.textContent.includes(marker));
        }, { timeout: 8000 }, live);
        const stayed = await page.evaluate(() => window.__stay);
        assert.equal(stayed, 1, `${viewport.width} страница перезагрузилась`);
        const moved = await readJournal(page, fresh, live, putin);
        assert.equal(moved.liveTop, false, `${viewport.width}`);
        assert.equal(moved.liveFold, true, `${viewport.width}`);
        assert.match(moved.summary, /^Доставленные \(\d+\)$/);
        assert.equal(/Путин\s*→/.test(moved.liveWho), false, moved.liveWho);
        const cancelled = await fetch(`${base}/api/orders/${putinBody.id}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-fold' },
          body: '{}',
        });
        assert.equal(cancelled.status, 200);
        await page.waitForFunction(() => {
          const badge = document.querySelector('#jCount');
          const empty = document.querySelector('#jList > .empty b');
          return badge && badge.textContent.trim() === '0' && empty && empty.textContent.includes('Всё доставлено');
        }, { timeout: 8000 });
        const quiet = await readJournal(page, fresh, live, putin);
        assert.equal(quiet.open, 0, `${viewport.width}`);
        assert.equal(quiet.badge, '0');
        assert.equal(quiet.empty, 'Всё доставлено');
        assert.equal(quiet.emptyShown, true, `${viewport.width} строка не видна`);
        assert.equal(quiet.freshFold, true);
        assert.equal(quiet.liveFold, true);
        const kept = await fetch(`${base}/api/state`).then((res) => res.json());
        assert.equal(kept.tasks.filter((item) => item && item.text === fresh).length, 1);
        assert.equal(kept.tasks.filter((item) => item && item.text === live).length, 1);
        assert.equal(kept.tasks.filter((item) => item && item.text === putin).length, 1);
        assert.equal(kept.tasks.find((item) => item && item.text === putin).orderStatus, 'cancelled');
      } finally {
        await page.close();
      }
    }
  });
}
