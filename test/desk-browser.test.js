'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

process.env.UPLOAD_DIR = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'kremlin-desk-'));
process.env.APP_PASSWORD = 'pw-desk';
process.env.AGENT_TOKEN = 'tok-desk';
process.env.GROK_WEBHOOK_URL = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.PORYADOK_INGEST_TOKEN;
delete process.env.DATABASE_URL;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

function chromePath() {
  return [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((p) => p && fs.existsSync(p));
}

let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден');
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  await fetch(base + '/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-desk' },
    body: JSON.stringify({ agent: 'army', text: 'Собрать сводку недели', fromAgentId: 'grok' }),
  });
  await fetch(base + '/api/agents/army/analysis', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-desk' },
    body: JSON.stringify({ text: 'План <script>alert(1)</script> держится.' }),
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openAt(width, path) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, isMobile: width < 700, hasTouch: width < 700, deviceScaleFactor: 1 });
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  return page;
}

test('пульт армии на 390px: задачи, график, анализ, форма', { timeout: 30000 }, async () => {
  const page = await openAt(390, '/agent/army');
  try {
    await page.waitForSelector('#desk.open .desk-chart svg', { timeout: 8000 });
    await page.waitForFunction(() => {
      const r = document.querySelector('#desk').getBoundingClientRect();
      return r.top >= -1 && r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    });
    const view = await page.evaluate(() => {
      const desk = document.querySelector('#desk');
      const cards = [...document.querySelectorAll('.desk-kpi')].map((el) => el.getBoundingClientRect());
      const svg = document.querySelector('.desk-chart svg').getBoundingClientRect();
      const chart = document.querySelector('.desk-chart').getBoundingClientRect();
      return {
        vw: window.innerWidth,
        text: desk.textContent,
        analysis: document.querySelector('.desk-analysis').innerHTML,
        stacked: cards.length >= 2 && cards[1].top >= cards[0].bottom - 2,
        svgW: svg.width,
        chartW: chart.width,
        form: !!document.querySelector('#deskTaskForm'),
      };
    });
    assert.equal(view.vw, 390);
    assert.match(view.text, /Собрать сводку недели/);
    assert.match(view.text, /Ждёт/);
    assert.match(view.text, /Выполнено по дням/);
    assert.match(view.text, /Время выполнения/);
    assert.match(view.analysis, /&lt;script&gt;/);
    assert.doesNotMatch(view.analysis, /<script/i);
    assert.equal(view.stacked, true);
    assert.equal(view.form, true);
    assert.ok(view.svgW > 100 && view.svgW <= view.chartW + 1);
  } finally {
    await page.close();
  }
});

test('кнопка полного экрана ведёт на /agent/:id', { timeout: 30000 }, async () => {
  const page = await openAt(1280, '/?agent=army&theme=day');
  try {
    await page.waitForSelector('#panel.open #pFull', { timeout: 8000 });
    await page.click('#pFull');
    await page.waitForSelector('#desk.open .desk-chart svg');
    const path = await page.evaluate(() => location.pathname);
    assert.equal(path, '/agent/army');
    const side = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.desk-kpi')].map((el) => el.getBoundingClientRect());
      return cards.length >= 2 && Math.abs(cards[0].top - cards[1].top) < 8;
    });
    assert.equal(side, true);
  } finally {
    await page.close();
  }
});

test('финансы закрыты без пароля, с паролем только проценты', { timeout: 30000 }, async () => {
  const locked = await openAt(390, '/agent/finance');
  try {
    await locked.waitForSelector('#desk.open .desk-lock', { timeout: 8000 });
    const text = await locked.$eval('#desk', (el) => el.textContent);
    assert.match(text, /паролем штаба/);
    assert.equal(await locked.$('.desk-kpi'), null);
    assert.equal(await locked.$('.desk-chart'), null);
  } finally {
    await locked.close();
  }
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => localStorage.setItem('appPassword', 'pw-desk'));
    await page.goto(base + '/agent/invest', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#desk.open .desk-kpi', { timeout: 8000 });
    const html = await page.$eval('.desk-wrap', (el) => el.innerHTML);
    assert.match(html, /%/);
    assert.match(html, /Прогресс по дням/);
    assert.doesNotMatch(html, /₽|руб/);
    assert.equal(html.includes('desk-lock'), false);
  } finally {
    await page.close();
  }
});

test('архивный агент не открывает пульт', { timeout: 20000 }, async () => {
  const page = await browser.newPage();
  try {
    const res = await page.goto(base + '/agent/trading', { waitUntil: 'domcontentloaded' });
    assert.equal(res.status(), 404);
    assert.match(await page.content(), /Агент в архиве/);
    assert.equal(await page.$('#desk'), null);
  } finally {
    await page.close();
  }
});
