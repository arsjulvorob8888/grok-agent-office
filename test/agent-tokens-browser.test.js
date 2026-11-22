'use strict';

// Окно токенов: без пароля кнопки нет, после входа выпуск виден один раз.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-tokens-ui-'));
process.env.APP_PASSWORD = 'pw-tokens-ui';
process.env.AGENT_TOKEN = 'tok-tokens-ui';
process.env.PUBLIC_URL = 'https://example.test';
process.env.KREMLIN_WEBHOOK_URL = '';
process.env.KREMLIN_WEBHOOK_KEY = '';
delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;
delete process.env.PORYADOK_INGEST_TOKEN;

const { app } = require('../server.js');
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

const artifacts = '/opt/cursor/artifacts';
let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  fs.mkdirSync(artifacts, { recursive: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openOffice(password, viewport) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.evaluateOnNewDocument((saved) => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('theme', 'day');
    if (saved) localStorage.setItem('appPassword', saved);
    else localStorage.removeItem('appPassword');
  }, password || '');
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width < 700,
    hasTouch: viewport.width < 700,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/?agent=dev`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panel.open', { timeout: 8000 });
  return page;
}

test('в окне агента нет токенов, уровня и опыта', async () => {
  for (const password of ['', 'pw-tokens-ui']) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await openOffice(password, viewport);
      try {
        await pageReady(page);
        const text = await page.$eval('#panel.open', (el) => el.innerText);
        assert.equal(/Токены/i.test(text), false, `${viewport.width} ${password ? 'вход' : 'гость'} ${text.slice(0, 180)}`);
        assert.equal(/Уровень/i.test(text), false, text.slice(0, 180));
        assert.equal(text.includes('/150'), false, text.slice(0, 180));
        assert.equal(text.includes('Выполнено'), false, text.slice(0, 180));
        assert.equal(await page.$('#panel [data-agent-tokens]'), null);
        assert.equal(await page.$('#panel [data-anchor="level"]'), null);
      } finally {
        await page.close();
      }
    }
  }
});

test('раздел «Служебное» под ключом свёрнут по умолчанию', async () => {
  const page = await openOffice('pw-tokens-ui', { width: 1280, height: 800 });
  try {
    await pageReady(page);
    await page.click('#btnKey');
    const fold = await page.waitForSelector('#serviceFold', { timeout: 4000 });
    const info = await page.evaluate(() => {
      const details = document.querySelector('#serviceFold');
      const key = document.querySelector('#btnKey').getBoundingClientRect();
      const pop = document.querySelector('#servicePop').getBoundingClientRect();
      const summary = details.querySelector('summary').textContent.trim();
      return {
        open: details.open,
        summary,
        below: pop.top >= key.bottom - 2,
        note: document.querySelector('#serviceFold .service-note').textContent,
        tokensInPanel: !!document.querySelector('#panel [data-agent-tokens]'),
      };
    });
    assert.equal(info.open, false);
    assert.equal(info.summary, 'Служебное');
    assert.equal(info.below, true);
    assert.match(info.note, /Личные ключи агентов/);
    assert.equal(info.tokensInPanel, false);
    const issueShown = await page.$eval('#serviceFold', (el) => {
      const button = el.querySelector('[data-token-issue]');
      if (!button) return false;
      return button.getClientRects().length > 0;
    });
    assert.equal(issueShown, false);
  } finally {
    await page.close();
  }
});

test('владелец выпускает токен в панели один раз и может отозвать', async () => {
  const locked = await openOffice('', { width: 1280, height: 800 });
  try {
    await pageReady(locked);
    assert.equal(await locked.$('[data-token-issue]'), null);
    const lockedText = await locked.evaluate(() => document.body.innerText);
    assert.equal(lockedText.includes('Выпустить токены'), false);
  } finally {
    await locked.close();
  }

  const page = await openOffice('pw-tokens-ui', { width: 1280, height: 800 });
  try {
    await openService(page);
    const box = await page.$eval('[data-token-issue]', (el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { text: el.textContent, top: r.top, left: r.left, width: r.width, height: r.height };
    });
    assert.equal(box.text, 'Выпустить токены');
    assert.ok(box.width > 40 && box.height > 20);
    assert.ok(box.top >= 0 && box.left >= 0 && box.top < 800);
    assert.equal(await page.$eval('[data-token-revoke]', (el) => el.textContent), 'Отозвать');

    let asked = '';
    page.once('dialog', async (dialog) => {
      asked = dialog.message();
      await dialog.dismiss();
    });
    await page.select('[data-token-scope]', 'all');
    await page.$eval('[data-token-issue]', (el) => el.click());
    await page.waitForFunction(() => document.querySelector('[data-token-scope]').value === 'all');
    assert.match(asked, /всем агентам/);
    assert.equal(await page.$('[data-token-value]'), null);

    await page.select('[data-token-scope]', 'one');
    await page.$eval('[data-token-issue]', (el) => el.click());
    await page.waitForSelector('[data-token-value]', { timeout: 8000 });
    const shown = await page.$eval('[data-agent-tokens]', (root) => ({
      warning: (root.querySelector('[data-token-warn]') || {}).textContent || '',
      token: (root.querySelector('[data-token-value]') || {}).value || '',
      copy: (root.querySelector('[data-token-copy]') || {}).textContent || '',
      name: (root.querySelector('.agent-token-name') || {}).textContent || '',
    }));
    assert.match(shown.warning, /один раз/);
    assert.match(shown.warning, /не увидеть/);
    assert.equal(shown.copy, 'Копировать');
    assert.equal(shown.name, 'Программирование');
    assert.ok(shown.token.length >= 32);
    await page.$eval('[data-token-copy]', (el) => el.click());
    await page.$eval('[data-token-value]', (el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(artifacts, 'agent-tokens-issued.png') });

    await page.$eval('[data-token-revoke]', (el) => el.click());
    await page.waitForFunction(() => document.body.innerText.includes('Токен отозван'));
    assert.equal(await page.$('[data-token-value]'), null);
    const afterRevoke = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input,textarea')].map((el) => el.value).join('\n');
      return `${document.body.innerText}\n${fields}`;
    });
    assert.equal(afterRevoke.includes(shown.token), false);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel.open', { timeout: 8000 });
    await openService(page);
    const reloaded = await page.evaluate(() => {
      const fields = [...document.querySelectorAll('input,textarea')].map((el) => el.value).join('\n');
      return `${document.body.innerText}\n${fields}`;
    });
    assert.equal(reloaded.includes(shown.token), false);
  } finally {
    await page.close();
  }

  const phone = await openOffice('pw-tokens-ui', { width: 390, height: 844 });
  try {
    await openService(phone);
    const fit = await phone.$eval('[data-token-issue]', (el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, inner: window.innerWidth };
    });
    assert.ok(fit.width > 40);
    assert.ok(fit.left >= 0 && fit.right <= fit.inner + 1);
  } finally {
    await phone.close();
  }
});

async function pageReady(page) {
  await page.waitForSelector('#panel.open .p-body', { timeout: 8000 });
}

async function openService(page) {
  const shown = await page.$('#servicePop:not([hidden])');
  if (!shown) await page.click('#btnKey');
  await page.waitForSelector('#serviceFold', { timeout: 4000 });
  const open = await page.$eval('#serviceFold', (el) => el.open);
  if (!open) await page.click('#serviceFold summary');
  await page.waitForSelector('#serviceFold [data-token-issue]', { timeout: 8000 });
}
