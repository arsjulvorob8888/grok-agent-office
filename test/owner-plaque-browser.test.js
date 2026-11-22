'use strict';

// Переписка: задача из окна агента не подписывается «Путин →». Настоящий приказ Путина — подписывается.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-plaque-'));
process.env.APP_PASSWORD = 'pw-plaque';
process.env.AGENT_TOKEN = 'tok-plaque';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.DATABASE_URL;
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.KREMLIN_WEBHOOK_KEY;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
const puppeteer = require('puppeteer-core');

const TITLE = 'Проверить сборку перед показом';
const PUTIN_ORDER = 'Настоящий приказ штаба';

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
let ownerTaskId;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-plaque' },
    body: JSON.stringify({ agent: 'qa', text: TITLE, fromAgentId: 'owner' }),
  });
  const task = await created.json();
  assert.equal(created.status, 201, JSON.stringify(task));
  assert.equal(task.fromAgentId, 'owner');
  ownerTaskId = task.id;
  const reply = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-plaque' },
    body: JSON.stringify({
      agentId: 'qa',
      role: 'agent',
      taskId: ownerTaskId,
      text: `Закрыл задачу ${ownerTaskId} и пункт need-finance`,
    }),
  });
  const replyBody = await reply.json();
  assert.equal(reply.status, 201, JSON.stringify(replyBody));
  const putin = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-password': 'pw-plaque' },
    body: JSON.stringify({ agent: 'qa', text: PUTIN_ORDER, fromAgentId: 'grok' }),
  });
  const putinBody = await putin.json();
  assert.equal(putin.status, 201, JSON.stringify(putinBody));
  assert.equal(putinBody.fromAgentId, 'grok');
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

async function openQa(viewport) {
  const page = await browser.newPage();
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
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
  });
  await page.goto(`${base}/?theme=day&agent=qa`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panel.open[data-agent="qa"] .chat-log', { timeout: 8000 });
  await page.waitForFunction((title) => {
    const chat = document.querySelector('#panel.open .chat-log');
    return chat && chat.innerText.includes(title);
  }, { timeout: 8000 }, TITLE);
  return page;
}

function readChat(page, selector, rowSelector) {
  return page.$eval(selector, (el, rowSel) => {
    const clean = (node) => node.textContent.replace(/\s+/g, ' ').trim();
    const rows = [...el.querySelectorAll(rowSel)].map((node) => ({
      system: node.classList.contains('system'),
      text: node.innerText.replace(/\s+/g, ' ').trim(),
    }));
    const plaques = [...el.querySelectorAll('.msg-sys, .dash-bubble.system p')].map(clean);
    return {
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      plaques,
      rows,
    };
  }, rowSelector);
}

test('плашка владельца без Путина, приказ Путина с «Путин →», номер задачи скрыт', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await openQa(viewport);
    try {
      const chat = await readChat(page, '#panel.open .chat-log', '.msg-row');
      const ownerAt = chat.rows.findIndex((row) => !row.system && row.text.includes(TITLE));
      assert.ok(ownerAt >= 0, `${viewport.width} нет реплики владельца`);
      const reply = chat.rows[ownerAt + 1];
      assert.ok(reply, `${viewport.width} после реплики владельца пусто`);
      assert.equal(reply.system, false, `${viewport.width} между репликой и ответом плашка: ${reply.text}`);
      assert.match(reply.text, /финансовых вопросов/);
      assert.equal(/\bt-\d+\b/.test(reply.text), false, reply.text);
      assert.equal(reply.text.includes('need-'), false, reply.text);
      assert.equal(reply.text.includes(ownerTaskId), false, reply.text);
      const orderPlaques = chat.plaques.filter((line) => line.startsWith('Приказ:'));
      assert.equal(orderPlaques.length, 1, `${viewport.width} ${orderPlaques.join(' | ')}`);
      assert.match(orderPlaques[0], /Путин\s*→\s*Тестировщик/);
      assert.equal(/\bПутин\b/.test(reply.text), false, reply.text);
      await page.waitForSelector('#panel.open .dash-expand', { timeout: 8000 });
      await page.evaluate(() => {
        const button = document.querySelector('#panel.open .dash-expand');
        if (!button) throw new Error('нет кнопки развернуть');
        button.click();
      });
      await page.waitForSelector('#agentDash.open', { timeout: 8000 });
      await page.click('#dashTab-chat');
      await page.waitForSelector('#dashChatLog', { timeout: 8000 });
      await page.waitForFunction((title) => {
        const log = document.querySelector('#dashChatLog');
        return log && log.innerText.includes(title);
      }, { timeout: 8000 }, TITLE);
      const dash = await readChat(page, '#dashChatLog', '.dash-bubble');
      const dashOwner = dash.rows.findIndex((row) => !row.system && row.text.includes(TITLE));
      assert.ok(dashOwner >= 0, `${viewport.width} дашборд без реплики владельца`);
      const dashReply = dash.rows[dashOwner + 1];
      assert.ok(dashReply, `${viewport.width} дашборд: нет ответа`);
      assert.equal(dashReply.system, false, `${viewport.width} дашборд плашка: ${dashReply.text}`);
      assert.match(dashReply.text, /финансовых вопросов/);
      assert.equal(/\bt-\d+\b/.test(dashReply.text), false, dashReply.text);
      assert.equal(dashReply.text.includes('need-'), false, dashReply.text);
      const dashPlaques = dash.plaques.filter((line) => line.startsWith('Приказ:'));
      assert.equal(dashPlaques.length, 1, `${viewport.width} дашборд ${dashPlaques.join(' | ')}`);
      assert.match(dashPlaques[0], /Путин\s*→/);
    } finally {
      await page.close();
    }
  }
});
