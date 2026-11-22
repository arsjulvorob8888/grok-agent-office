'use strict';

// На экране нет служебных номеров t-N и need-…. В данных они остаются.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-labels-'));
process.env.APP_PASSWORD = 'pw-labels';
process.env.AGENT_TOKEN = 'tok-labels';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

const ORDER = 'Сводка квартала для штаба';

function chromePath() {
  return [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].find((item) => item && fs.existsSync(item));
}

let server;
let browser;
let base;
let taskId;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-labels' },
    body: JSON.stringify({ agent: 'dev', text: ORDER, fromAgentId: 'owner' }),
  });
  const body = await created.json();
  assert.equal(created.status, 201);
  taskId = body.id;
  const reply = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-labels' },
    body: JSON.stringify({
      agentId: 'dev',
      role: 'agent',
      taskId,
      text: `Закрыл ${taskId} и пункт need-finance`,
    }),
  });
  assert.equal(reply.status, 201);
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

function leaks(text) {
  return {
    task: /\bt-\d+\b/.test(text || ''),
    need: /need-/.test(text || ''),
  };
}

test('карта, окно задачи, журнал, переписка и обзор не показывают t-N и need-', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        isMobile: viewport.width <= 700,
        hasTouch: viewport.width <= 700,
        deviceScaleFactor: 1,
      });
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
        else req.continue();
      });
      await page.evaluateOnNewDocument((id) => {
        localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
        localStorage.setItem('appPassword', 'pw-labels');
        localStorage.setItem('openTask', id);
      }, taskId);
      await page.goto(`${base}/?theme=day&agent=dev`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#panel.open .chat-log', { timeout: 8000 });
      await page.waitForFunction((order) => {
        const chat = document.querySelector('#panel.open .chat-log');
        return chat && chat.innerText.includes(order);
      }, { timeout: 8000 }, ORDER);
      if (viewport.width <= 900) {
        await page.click('#btnJournal');
        await page.waitForSelector('#journal.mobile-open', { timeout: 8000 });
      } else {
        await page.waitForSelector('#journal .quest', { timeout: 8000 });
      }
      const quest = await page.$('#jList .quest');
      if (quest) await quest.click();
      await page.click('#btnProcesses');
      await page.waitForSelector('#processes.open', { timeout: 8000 });
      const expand = await page.$('#panel.open .dash-expand');
      if (expand) {
        await expand.click();
        await page.waitForSelector('#agentDash.open', { timeout: 8000 });
      }
      const seen = await page.evaluate(() => {
        const textOf = (sel) => {
          const el = document.querySelector(sel);
          return el ? el.innerText : '';
        };
        return {
          body: document.body.innerText,
          map: textOf('#overlay'),
          panel: textOf('#panel.open'),
          journal: textOf('#journal'),
          processes: textOf('#processes.open'),
          dash: textOf('#agentDash.open'),
        };
      });
      for (const [name, text] of Object.entries(seen)) {
        const bad = leaks(text);
        assert.equal(bad.task, false, `${viewport.width} ${name} содержит t-N`);
        assert.equal(bad.need, false, `${viewport.width} ${name} содержит need-`);
      }
      assert.match(seen.panel, /Сводка квартала/);
      assert.match(seen.panel, /финансовых вопросов/);
    } finally {
      await page.close();
    }
  }
});
