'use strict';

// Журнал и процессы в браузере: 1280 и 390. Доставленное не в панели, отменённые свёрнуты.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const ENV_KEY = 'browser-journal-env-key';
let hook;
let office;
let browser;
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* нет зависимости */ }

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

const CHROME = chromePath();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startOffice(extra) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-journal-ui-'));
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.DATABASE_URL;
  delete env.STORE_SCHEMA;
  delete env.PORYADOK_INGEST_TOKEN;
  env.PORT = String(port);
  env.UPLOAD_DIR = uploadDir;
  env.APP_PASSWORD = 'pw-journal-ui';
  env.AGENT_TOKEN = 'tok-journal-ui';
  env.PUBLIC_URL = 'http://127.0.0.1';
  env.GROK_WEBHOOK_URL = '';
  env.GROK_WEBHOOK_KEY = '';
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200) return { base, child, logs };
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
}

async function stopOffice(proc) {
  if (!proc || !proc.child || proc.child.exitCode != null) return;
  proc.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { proc.child.kill('SIGKILL'); resolve(); }, 3000);
    proc.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function api(urlPath, opts = {}) {
  const res = await fetch(office.base + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

if (!CHROME || !puppeteer) {
  test('браузер журнала', { skip: CHROME ? 'нет puppeteer-core' : 'Chrome не найден' }, () => {});
} else {
  before(async () => {
    hook = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${hook.address().port}`;
    office = await startOffice({
      WEBHOOK_SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
      KREMLIN_WEBHOOK_URL: `${origin}/journal-env`,
      KREMLIN_WEBHOOK_KEY: ENV_KEY,
    });
    const delivered = await api('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-journal-ui' },
      body: JSON.stringify({ agent: 'social', text: 'ЖУРНАЛ-ДОСТАВКА ответ соцсетям', fromAgentId: 'owner' }),
    });
    assert.equal(delivered.status, 201);
    assert.equal(delivered.body.deliveryLabel, 'Доставлено');
    office.deliveredId = delivered.body.id;
    for (const agent of ['advisor', 'qa']) {
      const created = await api('/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-journal-ui' },
        body: JSON.stringify({ agent, text: 'тест', fromAgentId: 'owner' }),
      });
      assert.equal(created.status, 201, agent);
      const cancelled = await api(`/api/orders/${created.body.id}/cancel`, {
        method: 'POST',
        headers: { 'x-app-password': 'pw-journal-ui' },
        body: '{}',
      });
      assert.equal(cancelled.status, 200);
    }
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    await stopOffice(office);
    if (hook) await new Promise((resolve) => hook.close(resolve));
  });

  async function openAt(viewport) {
    const page = await browser.newPage();
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.width <= 700,
      hasTouch: viewport.width <= 700,
      deviceScaleFactor: 1,
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    });
    await page.goto(`${office.base}/?theme=day&agent=social`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  test('журнал и процессы на 1280 и 390, панель сама показывает взятую задачу', { timeout: 90000 }, async () => {
    const state = await api('/api/state');
    const active = state.body.tasks.filter((task) => task.orderStatus !== 'cancelled').length;
    const cancelled = state.body.tasks.filter((task) => task.orderStatus === 'cancelled' && String(task.text || '').trim() === 'тест');
    assert.equal(cancelled.length, 2);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await openAt(viewport);
      try {
        if (viewport.width <= 900) {
          await page.click('#btnJournal');
          await page.waitForSelector('#journal.mobile-open .quest', { timeout: 8000 });
        } else {
          await page.waitForSelector('#journal .quest', { timeout: 8000 });
        }
        await page.waitForFunction(() => {
          const quest = [...document.querySelectorAll('#jList .quest')].find((node) => node.textContent.includes('ЖУРНАЛ-ДОСТАВКА'));
          const room = document.querySelector('#panel.open [data-anchor="tasks"]');
          const roomQuest = room && [...room.querySelectorAll('.quest')].find((node) => node.textContent.includes('ЖУРНАЛ-ДОСТАВКА'));
          const journalOk = quest && quest.querySelector('.badge') && quest.querySelector('.badge').textContent.includes('Доставлено');
          const roomOk = roomQuest && roomQuest.querySelector('.badge') && roomQuest.querySelector('.badge').textContent.includes('Доставлено');
          return journalOk && roomOk;
        }, { timeout: 8000 });
        const info = await page.evaluate(() => {
          const quest = [...document.querySelectorAll('#jList .quest')].find((node) => node.textContent.includes('ЖУРНАЛ-ДОСТАВКА'));
          const block = document.querySelector('#jList .j-cancelled');
          const summary = block ? block.querySelector('summary').textContent : '';
          const stubs = block ? [...block.querySelectorAll('.quest')].map((node) => node.textContent) : [];
          const room = document.querySelector('#panel.open [data-anchor="tasks"]');
          const roomQuest = room
            ? [...room.querySelectorAll('.quest')].find((node) => node.textContent.includes('ЖУРНАЛ-ДОСТАВКА'))
            : null;
          return {
            vw: window.innerWidth,
            badge: document.querySelector('#jCount').textContent,
            label: quest.querySelector('.badge').textContent,
            detail: quest.textContent,
            history: [...quest.querySelectorAll('.order-hist b')].map((node) => node.textContent).join('|'),
            summary,
            hidden: block ? !block.open : false,
            stubs,
            roomLabel: roomQuest ? roomQuest.querySelector('.badge').textContent : '',
            roomDetail: roomQuest ? roomQuest.textContent : '',
            proc: document.querySelector('#procCount').textContent,
            procBadge: document.querySelector('#procBadge').textContent,
            procText: document.querySelector('#procList').textContent,
          };
        });
        assert.equal(info.vw, viewport.width);
        assert.equal(info.badge, String(active));
        assert.equal(info.label, 'Доставлено');
        assert.equal(info.history.includes('Доставлено'), true);
        assert.match(info.detail, /Куда ушёл приказ: Адрес из окружения/);
        assert.equal(info.detail.includes(ENV_KEY), false);
        assert.equal(info.detail.includes('journal-env'), false);
        assert.equal(info.summary, `Отменённые (${cancelled.length})`);
        assert.equal(info.hidden, true);
        assert.equal(info.stubs.length, cancelled.length);
        assert.equal(info.roomLabel, 'Доставлено');
        assert.match(info.roomDetail, /Адрес из окружения/);
        assert.equal(info.roomDetail.includes(ENV_KEY), false);
        assert.equal(info.proc, '0');
        assert.equal(info.procBadge, '0');
        assert.equal(info.procText.includes('ЖУРНАЛ-ДОСТАВКА'), false);
        if (viewport.width === 1280) office.desktop = page;
        else await page.close();
      } catch (err) {
        await page.close();
        throw err;
      }
    }
    const page = office.desktop;
    try {
      const accepted = await api(`/api/orders/${office.deliveredId}`, {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-journal-ui' },
        body: JSON.stringify({ status: 'accepted', note: 'Беру в работу' }),
      });
      assert.equal(accepted.status, 200);
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('#procList .proc-row')].find((node) => node.textContent.includes('ЖУРНАЛ-ДОСТАВКА'));
        return document.querySelector('#procCount').textContent === '1' && row;
      }, { timeout: 12000 });
    } finally {
      await page.close();
    }
  });
}
