'use strict';

// Браузер волны 3: маршрут в форме, шапка одной строкой, без энергии и grokbot.
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
let ENV_URL = 'http://127.0.0.1/wave3-env';
let ARMY_URL = 'http://127.0.0.1/wave3-army';
let hook;
const ARMY_KEY = 'wave3-browser-army-AAAA';
const SECRETS = crypto.randomBytes(32).toString('base64');

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
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* нет зависимости */ }

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

async function startOffice() {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-wave3-ui-'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.DATABASE_URL;
  delete env.STORE_SCHEMA;
  delete env.PORYADOK_INGEST_TOKEN;
  env.PORT = String(port);
  env.UPLOAD_DIR = uploadDir;
  env.APP_PASSWORD = 'pw-wave3-ui';
  env.AGENT_TOKEN = 'tok-wave3-ui';
  env.PUBLIC_URL = 'http://127.0.0.1';
  env.WEBHOOK_SECRETS_KEY = SECRETS;
  env.KREMLIN_WEBHOOK_URL = ENV_URL;
  env.KREMLIN_WEBHOOK_KEY = 'wave3-browser-env-key';
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
      if (res.status === 200) return { base, child };
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
}

if (!CHROME || !puppeteer) {
  test('браузер волны 3', { skip: CHROME ? 'нет puppeteer-core' : 'Chrome не найден' }, () => {});
} else {
  let browser;
  let office;
  let base;

  before(async () => {
    hook = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    ENV_URL = `http://127.0.0.1:${hook.address().port}/wave3-env`;
    ARMY_URL = `http://127.0.0.1:${hook.address().port}/wave3-army`;
    office = await startOffice();
    base = office.base;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (hook) hook.close();
    if (office && office.child && office.child.exitCode == null) {
      office.child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
        office.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });

  async function openPage(width, height, urlPath) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
      else req.continue();
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('appPassword', 'pw-wave3-ui');
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    });
    await page.setViewport({
      width,
      height,
      deviceScaleFactor: 1,
      isMobile: width < 700,
      hasTouch: width < 700,
    });
    await page.goto(`${base}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  }

  async function headerBox(page) {
    return page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.hud-actions .icon-btn')].filter((el) => getComputedStyle(el).display !== 'none');
      const tops = buttons.map((el) => el.getBoundingClientRect().top);
      const brand = document.querySelector('.brand-text b').getBoundingClientRect();
      const stat = document.querySelector('.stats .stat').getBoundingClientRect();
      const hud = document.querySelector('.hud').getBoundingClientRect();
      const usage = document.querySelector('#grokUsage');
      const usageShown = usage && !usage.hidden && getComputedStyle(usage).display !== 'none';
      return {
        title: document.querySelector('.brand-text b').textContent.trim(),
        label: document.querySelector('.stat-label') ? document.querySelector('.stat-label').textContent.trim() : '',
        active: document.querySelector('#stActive') ? document.querySelector('#stActive').textContent.trim() : '',
        energy: !!document.querySelector('#stEnergy, .stat.energy'),
        tasks: !!document.querySelector('#stTasks'),
        usageShown,
        usageText: usage ? usage.innerText : '',
        grok: (document.body.innerText || '').includes('Grok'),
        oneLine: tops.length > 1 && Math.max(...tops) - Math.min(...tops) < 4
          && Math.abs(brand.top - tops[0]) < 24
          && Math.abs(stat.top - tops[0]) < 24,
        buttons: buttons.map((el) => el.id),
        buttonRight: Math.max(...buttons.map((el) => el.getBoundingClientRect().right)),
        buttonLeft: Math.min(...buttons.map((el) => el.getBoundingClientRect().left)),
        vw: window.innerWidth,
        docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        hudRight: hud.right,
        hudLeft: hud.left,
      };
    });
  }

  test('шапка на 1280 и 390 без энергии и без пустого лимита', { timeout: 60000 }, async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await openPage(viewport.width, viewport.height, '/?theme=day');
      try {
        await page.waitForSelector('#stActive');
        const box = await headerBox(page);
        assert.equal(box.vw, viewport.width);
        assert.equal(box.title, 'Кремль');
        assert.equal(box.label, 'В работе');
        assert.match(box.active, /^\d+\/\d+$/);
        assert.equal(box.energy, false);
        assert.equal(box.tasks, false);
        assert.equal(box.usageShown, false);
        assert.doesNotMatch(box.usageText, /нет данных|0%/);
        assert.equal(box.grok, false);
        assert.equal(box.oneLine, true, JSON.stringify(box));
        assert.ok(box.buttonLeft >= -1, JSON.stringify(box));
        assert.ok(box.buttonRight <= box.vw + 1, JSON.stringify(box));
        assert.equal(box.docOverflow, false);
        assert.ok(box.buttons.includes('btnNeeds') && box.buttons.includes('btnKey'));
        assert.ok(box.hudLeft >= -1 && box.hudRight <= box.vw + 1);
      } finally {
        await page.close();
      }
    }
  });

  test('форма приказа показывает вид маршрута и не показывает адрес', { timeout: 60000 }, async () => {
    const page = await openPage(1280, 800, '/?agent=army');
    try {
      await page.waitForSelector('#panel.open #taskRoute', { timeout: 8000 });
      const before = await page.$eval('#taskRoute', (el) => ({
        text: el.textContent.trim(),
        route: el.dataset.route,
      }));
      assert.equal(before.route, 'env');
      assert.equal(before.text, 'Куда уйдёт приказ: Адрес из окружения');
      const pageText = await page.evaluate(() => document.body.innerText);
      assert.equal(pageText.includes(ENV_URL), false);
      assert.equal(pageText.includes('Grok'), false);

      await page.type('#taskText', 'Короткий приказ волны 3');
      await page.click('#taskSubmit');
      await page.waitForFunction(() => {
        const msg = document.querySelector('#formMsg');
        return msg && /Приказ сохранён/.test(msg.textContent);
      }, { timeout: 8000 });
      const after = await page.$eval('#formMsg', (el) => el.textContent.trim());
      assert.match(after, /Приказ сохранён\. Куда уйдёт приказ: Адрес из окружения/);
      assert.doesNotMatch(after, /взялся за работу/);
      const afterText = await page.evaluate(() => document.body.innerText);
      assert.equal(afterText.includes(ENV_URL), false);
    } finally {
      await page.close();
    }
  });

  test('смена получателя меняет вид маршрута, дашборд без ручных статусов', { timeout: 60000 }, async () => {
    const saved = await fetch(`${base}/api/agents/army/delivery`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-wave3-ui' },
      body: JSON.stringify({ url: ARMY_URL, key: ARMY_KEY }),
    });
    assert.equal(saved.status, 200);
    const page = await openPage(1280, 800, '/?agent=grok');
    try {
      await page.waitForSelector('#panel.open #taskTarget', { timeout: 8000 });
      await page.waitForFunction(() => {
        const route = document.querySelector('#taskRoute');
        return route && route.dataset.route === 'env';
      }, { timeout: 8000 });
      await page.select('#taskTarget', 'army');
      await page.waitForFunction(() => document.querySelector('#taskRoute').dataset.route === 'agent');
      const line = await page.$eval('#taskRoute', (el) => el.textContent.trim());
      assert.equal(line, 'Куда уйдёт приказ: Свой вебхук агента');
      const visible = await page.evaluate(() => document.body.innerText);
      assert.equal(visible.includes(ARMY_URL), false);
      assert.equal(visible.includes(ARMY_KEY), false);

      await page.waitForSelector('#panel.open .dash-expand', { timeout: 8000 });
      await page.click('.dash-expand');
      await page.waitForSelector('#agentDash.open');
      await page.click('[role="tab"][data-tab="tasks"]');
      await page.waitForSelector('#dashTaskInput', { timeout: 8000 });
      const tasks = await page.evaluate(() => ({
        statuses: document.querySelectorAll('#agentDash [data-status]').length,
        route: document.querySelector('#agentDash .task-route') ? document.querySelector('#agentDash .task-route').textContent.trim() : '',
        routeKind: document.querySelector('#agentDash .task-route') ? document.querySelector('#agentDash .task-route').dataset.route : '',
      }));
      assert.equal(tasks.statuses, 0);
      assert.equal(tasks.routeKind, 'env');
      assert.equal(tasks.route, 'Куда уйдёт приказ: Адрес из окружения');
    } finally {
      await page.close();
    }
  });

  test('grokbot не становится ссылкой на странице вопроса', { timeout: 45000 }, async () => {
    const page = await openPage(390, 844, '/needs/need-finance');
    try {
      await page.waitForSelector('#needTitle', { timeout: 8000 });
      const view = await page.evaluate(() => ({
        links: [...document.querySelectorAll('a')].map((el) => el.getAttribute('href') || ''),
        text: document.body.innerText,
        html: document.body.innerHTML,
      }));
      assert.equal(view.links.some((href) => /grokbot:/i.test(href)), false);
      assert.equal(view.text.includes('grokbot://'), false);
      assert.equal(view.html.includes('href="grokbot:'), false);
      assert.equal(/Grok/.test(view.text), false);
    } finally {
      await page.close();
    }
  });
}
