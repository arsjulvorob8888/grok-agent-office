'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-dash-ui-'));
process.env.APP_PASSWORD = 'pw-dash-ui';
process.env.AGENT_TOKEN = 'tok-dash-ui';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_URL = '';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app, state } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  const list = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
  return list.find((item) => fs.existsSync(item));
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
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('appPassword', 'pw-dash-ui'));
  await page.setViewport({ width, height, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 1 });
  await page.goto(`${base}/?agent=army`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function dismissNeeds(page) {
  const close = await page.$('#needsPop.open #needsClose');
  if (close) await close.click();
}

test('дашборд раскрывается по кнопке, живёт в адресе и сворачивается Esc', { timeout: 30000 }, async () => {
  const created = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-dash-ui' },
    body: JSON.stringify({ agent: 'army', text: 'Карточка для канбана', fromAgentId: 'owner' }),
  });
  assert.equal(created.status, 201);

  const page = await openPage(1280, 800);
  try {
    await page.waitForSelector('#panel.open .dash-expand', { timeout: 8000 });
    await dismissNeeds(page);
    const before = await page.evaluate(() => history.length);
    await page.click('#panel.open .dash-expand');
    await page.waitForSelector('#agentDash.open', { timeout: 4000 });
    const opened = await page.evaluate(() => ({
      hash: location.hash,
      role: document.getElementById('agentDash').getAttribute('role'),
      modal: document.getElementById('agentDash').getAttribute('aria-modal'),
      selected: document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab,
      focus: document.activeElement && document.activeElement.id,
      history: history.length,
    }));
    assert.match(opened.hash, /agent=army/);
    assert.match(opened.hash, /view=dashboard/);
    assert.equal(opened.role, 'dialog');
    assert.equal(opened.modal, 'true');
    assert.equal(opened.selected, 'overview');
    assert.equal(opened.focus, 'dashCollapse');
    assert.ok(opened.history > before);

    await page.click('[role="tab"][data-tab="tasks"]');
    await page.waitForFunction(() => location.hash.includes('tab=tasks'));
    await page.waitForSelector('.dash-card', { timeout: 4000 });
    const cardText = await page.$eval('.dash-card', (el) => el.textContent);
    assert.match(cardText, /Карточка для канбана/);
    assert.match(cardText, /нет маршрута доставки/);
    await page.click('.dash-card [data-status="accepted"]');
    await page.waitForFunction(() => {
      const card = document.querySelector('.dash-col-work .dash-card');
      return card && card.textContent.includes('Карточка для канбана');
    }, { timeout: 4000 });

    await page.click('[role="tab"][data-tab="chat"]');
    await page.waitForSelector('#dashChatInput');
    await page.focus('#dashChatInput');
    await page.keyboard.type('Первая строка');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('вторая');
    const draft = await page.$eval('#dashChatInput', (el) => el.value);
    assert.match(draft, /Первая строка\nвторая/);
    await page.click('.dash-template');
    const templated = await page.$eval('#dashChatInput', (el) => el.value);
    assert.match(templated, /Доложи/);
    await page.click('#dashSend');
    await page.waitForFunction(() => {
      const log = document.getElementById('dashChatLog');
      return log && log.textContent.includes('Доложи');
    }, { timeout: 4000 });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !location.hash.includes('view=dashboard'), { timeout: 4000 });
    const closed = await page.$('#agentDash.open');
    assert.equal(closed, null);
    await page.goForward();
    await page.waitForSelector('#agentDash.open', { timeout: 4000 });
    assert.match(await page.evaluate(() => location.hash), /view=dashboard/);
  } finally {
    await page.close();
  }
});

test('на 390px вкладки снизу и страница не скроллится вбок', { timeout: 30000 }, async () => {
  const page = await openPage(390, 844);
  try {
    await page.goto(`${base}/#agent=army&view=dashboard&tab=analytics`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agentDash.open [role="tab"][data-tab="analytics"][aria-selected="true"]', { timeout: 8000 });
    await page.waitForFunction(() => {
      const text = document.getElementById('dashMain') ? document.getElementById('dashMain').textContent : '';
      return /Пока нет задач|Нет завершённых задач|Нет сообщений с доставкой|Задачи по дням/.test(text);
    }, { timeout: 4000 });
    const box = await page.evaluate(() => {
      const tabs = document.querySelector('.dash-tabs').getBoundingClientRect();
      const dash = document.getElementById('agentDash');
      return {
        tabBottom: tabs.bottom,
        height: window.innerHeight,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dashOverflow: dash.scrollWidth - dash.clientWidth,
        text: document.getElementById('dashMain').textContent,
      };
    });
    assert.ok(box.tabBottom >= box.height - 8, `вкладки не снизу: ${box.tabBottom} при высоте ${box.height}`);
    assert.ok(box.pageOverflow <= 1, `горизонтальный скролл страницы ${box.pageOverflow}`);
    assert.ok(box.dashOverflow <= 1, `горизонтальный скролл дашборда ${box.dashOverflow}`);
    assert.match(box.text, /Пока нет задач|Нет завершённых задач|Нет сообщений с доставкой|Задачи по дням/);
  } finally {
    await page.close();
  }
});

async function openDirectDashboard() {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('appPassword', 'pw-dash-ui'));
  await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await page.goto(`${base}/#agent=qa&view=dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#agentDash.open', { timeout: 8000 });
  await page.waitForSelector('#roster .chip[data-id="qa"]', { timeout: 8000 });
  await page.click('[role="tab"][data-tab="tasks"]');
  await page.waitForFunction(() => location.hash.includes('tab=tasks'));
  return page;
}

async function assertAgentPanel(page, how) {
  const url = page.url();
  assert.ok(url.startsWith(base), `${how}: адрес ушёл с сайта (${url})`);
  await page.waitForFunction(() => {
    const panel = document.querySelector('#panel.open');
    return location.href.startsWith('http')
      && location.hash.includes('agent=qa')
      && !location.hash.includes('view=dashboard')
      && panel
      && panel.dataset.agent === 'qa'
      && !document.querySelector('#agentDash.open');
  }, { timeout: 4000 });
}

test('прямая ссылка дашборда закрывается на панели и не уходит с сайта', { timeout: 45000 }, async () => {
  const collapse = await openDirectDashboard();
  try {
    await collapse.click('#dashCollapse');
    await assertAgentPanel(collapse, 'Свернуть');
  } finally {
    await collapse.close();
  }

  const esc = await openDirectDashboard();
  try {
    await esc.keyboard.press('Escape');
    await assertAgentPanel(esc, 'Esc');
  } finally {
    await esc.close();
  }

  const back = await openDirectDashboard();
  try {
    await back.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await assertAgentPanel(back, 'Back');
  } finally {
    await back.close();
  }
});

function quietQa() {
  const agent = state.agents.find((item) => item.id === 'qa');
  agent.now = 'тест';
  agent.status = 'idle';
  agent.live = null;
  agent.lastSeenAt = null;
  agent.lastStatusAt = null;
  agent.lastDashboardAt = null;
  agent.heartbeatNote = '';
  agent.dashboardNote = '';
  return agent;
}

test('обзор не показывает устаревший now, когда агент спит или задачи нет', { timeout: 30000 }, async () => {
  quietQa();
  const asleep = await openPage(1280, 800);
  try {
    await asleep.goto(`${base}/#agent=qa&view=dashboard&tab=overview`, { waitUntil: 'domcontentloaded' });
    await asleep.waitForFunction(() => {
      const text = document.getElementById('dashMain') ? document.getElementById('dashMain').textContent : '';
      return text.includes('Спит') && text.includes('Сейчас нет задачи');
    }, { timeout: 8000 });
    const sleeping = await asleep.evaluate(() => ({
      now: document.querySelector('.dash-now') && document.querySelector('.dash-now').textContent,
      text: document.getElementById('dashMain').textContent,
    }));
    assert.equal(sleeping.now, null);
    assert.equal(sleeping.text.includes('тест'), false);

    const agent = quietQa();
    agent.status = 'idle';
    agent.lastStatusAt = new Date().toISOString();
    await asleep.reload({ waitUntil: 'domcontentloaded' });
    await asleep.waitForFunction(() => {
      const text = document.getElementById('dashMain') ? document.getElementById('dashMain').textContent : '';
      return text.includes('Работает') && text.includes('Сейчас нет задачи') && !text.includes('Загрузка');
    }, { timeout: 8000 });
    const idleTask = await asleep.evaluate(() => ({
      now: document.querySelector('.dash-now') && document.querySelector('.dash-now').textContent,
      text: document.getElementById('dashMain').textContent,
    }));
    assert.equal(idleTask.text.includes('Работает'), true);
    assert.equal(idleTask.now, null);
    assert.equal(idleTask.text.includes('тест'), false);
  } finally {
    await asleep.close();
  }

  const agent = quietQa();
  agent.live = {
    status: 'working',
    doing: 'Гоняю регрессию',
    until: new Date(Date.now() + 60000).toISOString(),
    since: new Date().toISOString(),
  };
  agent.now = 'Свежий ход';
  const busy = await openPage(1280, 800);
  try {
    await busy.goto(`${base}/#agent=qa&view=dashboard&tab=overview`, { waitUntil: 'domcontentloaded' });
    await busy.waitForFunction(() => {
      const now = document.querySelector('.dash-now');
      const text = document.getElementById('dashMain') ? document.getElementById('dashMain').textContent : '';
      return now && now.textContent.includes('Свежий ход') && text.includes('Гоняю регрессию');
    }, { timeout: 8000 });
  } finally {
    await busy.close();
    agent.live = null;
    agent.now = 'Жду задач';
  }
});
