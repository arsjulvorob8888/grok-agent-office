'use strict';

// Браузерные проверки трёх QA-багов. В CI Chrome обычно нет — тогда файл пропускается.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p) => p && fs.existsSync(p));

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) { /* зависимости нет */ }

if (!CHROME || !puppeteer) {
  test('браузерные проверки панели, кнопки и полосы', { skip: CHROME ? 'нет puppeteer-core' : 'Chrome не найден' }, () => {});
} else {
  let browser;
  let server;
  let base;

  before(async () => {
    process.env.APP_PASSWORD = 'pw-ui';
    process.env.AGENT_TOKEN = 'tok-ui';
    process.env.GROK_WEBHOOK_URL = '';
    process.env.PUBLIC_URL = 'http://127.0.0.1';
    delete process.env.PORYADOK_INGEST_TOKEN;
    const { app } = require('../server.js');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function pageAt(width, height, mobile) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
    return page;
  }

  test('на ширине 390 полоса агентов листается до последнего', async () => {
    const page = await pageAt(390, 844, true);
    try {
      await page.goto(base + '/?theme=day', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#roster .chip');
      const before = await page.evaluate(() => {
        const r = document.querySelector('#roster');
        const cs = getComputedStyle(r);
        const chips = [...r.querySelectorAll('.chip')];
        const last = chips[chips.length - 1].getBoundingClientRect();
        const box = r.getBoundingClientRect();
        return {
          count: chips.length,
          ids: chips.map((el) => el.dataset.id),
          scrollbar: cs.scrollbarWidth,
          touch: cs.touchAction,
          overflow: cs.overflowX,
          max: r.scrollWidth - r.clientWidth,
          lastClipped: last.right > box.right + 1,
        };
      });
      assert.equal(before.count, 11, `в полосе только главные здания, сейчас ${before.count}`);
      assert.equal(before.ids.includes('invest') || before.ids.includes('analyst') || before.ids.includes('advisor'), false);
      assert.ok(before.max > 40, 'полоса не переполнена, листать нечего');
      assert.notEqual(before.scrollbar, 'none');
      assert.equal(before.touch, 'pan-x');
      assert.equal(before.overflow, 'auto');
      assert.equal(before.lastClipped, true);

      const box = await page.$eval('#roster', (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel({ deltaY: 400 });
      const wheeled = await page.evaluate(() => document.querySelector('#roster').scrollLeft);
      assert.ok(wheeled > 40, `колесо не сдвинуло полосу (${wheeled})`);

      const end = await page.evaluate(() => {
        const r = document.querySelector('#roster');
        r.scrollLeft = r.scrollWidth;
        const last = r.querySelector('.chip:last-child').getBoundingClientRect();
        const box = r.getBoundingClientRect();
        return {
          id: r.querySelector('.chip:last-child').dataset.id,
          inside: last.left >= box.left - 1 && last.right <= box.right + 2,
        };
      });
      assert.equal(end.id, 'routines', `последний в полосе ${end.id}, ждали Рутины`);
      assert.equal(end.inside, true, `последний агент ${end.id} не попал в видимую полосу`);
    } finally {
      await page.close();
    }
  });

  test('клик «Дать задачу» открывает пропуск так же, как Ctrl+Enter', async () => {
    const page = await pageAt(1280, 800, false);
    try {
      await page.goto(base + '/?theme=day&agent=grok', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#taskSubmit');
      const required = await page.$eval('#taskText', (el) => el.required);
      assert.equal(required, false, 'required снова блокирует submit и клик молчит');

      await page.click('#taskSubmit');
      const empty = await page.evaluate(() => ({
        modal: document.querySelector('#modal').classList.contains('show'),
        msg: document.querySelector('#formMsg').textContent,
      }));
      assert.equal(empty.modal, false);
      assert.match(empty.msg, /Напиши, что нужно сделать/);

      await page.$eval('#taskText', (el) => { el.value = 'Проверь клик по кнопке'; });
      await page.click('#taskSubmit');
      await page.waitForSelector('#modal.show');
      const title = await page.$eval('#mTitle', (el) => el.textContent);
      assert.equal(title, 'Пропуск в штаб');

      await page.click('#pwCancel');
      await page.evaluate(() => localStorage.removeItem('appPassword'));
      await page.focus('#taskText');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await page.waitForSelector('#modal.show');
    } finally {
      await page.close();
    }
  });

  const MOBILE = {
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  };

  async function tapTask(page) {
    await page.waitForSelector('#taskSubmit');
    const box = await page.$eval('#taskSubmit', (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight, vw: window.innerWidth };
    });
    assert.ok(box.top >= 0 && box.bottom <= box.vh + 1, `кнопка вне экрана ${box.top}..${box.bottom}`);
    assert.ok(box.left >= -1 && box.right <= box.vw + 1, `кнопка шире экрана ${box.left}..${box.right}`);
    await page.$eval('#taskText', (el) => { el.value = 'Проверь тап на узком экране'; });
    await page.tap('#taskSubmit');
    await page.waitForSelector('#modal.show', { timeout: 4000 });
    const title = await page.$eval('#mTitle', (el) => el.textContent);
    assert.equal(title, 'Пропуск в штаб');
  }

  test('на 390px тап «Дать задачу» у тестировщика открывает пропуск', async () => {
    const page = await browser.newPage();
    try {
      await page.emulate(MOBILE);
      await page.evaluateOnNewDocument(() => {
        localStorage.removeItem('appPassword');
        localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      });
      await page.goto(base + '/?theme=day&agent=qa', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#panel.open h2');
      const heading = await page.$eval('#panel .p-title h2', (el) => el.textContent);
      assert.match(heading, /8\.\s*Тестировщик/);
      await tapTask(page);
    } finally {
      await page.close();
    }
  });

  test('на 390px «Рутины» на карте и в полосе, тап открывает пропуск', async () => {
    const page = await browser.newPage();
    try {
      await page.emulate(MOBILE);
      await page.evaluateOnNewDocument(() => {
        localStorage.removeItem('appPassword');
        localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      });
      await page.goto(base + '/?theme=day&agent=routines', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#panel.open h2');
      const heading = await page.$eval('#panel .p-title h2', (el) => el.textContent);
      assert.match(heading, /12\.\s*Рутины/);
      const placed = await page.evaluate(() => ({
        map: !!document.querySelector('.agent[data-id="routines"]'),
        chip: (document.querySelector('#roster .chip[data-id="routines"] .cn') || {}).textContent || '',
        district: (document.querySelector('#panel .kicker') || {}).textContent || '',
      }));
      assert.equal(placed.map, true, 'домик Рутин не нарисован');
      assert.match(placed.chip, /12\./);
      assert.match(placed.chip, /Рутины/);
      assert.match(placed.district, /Хамовники/);
      await tapTask(page);
    } finally {
      await page.close();
    }
  });

  test('прокрутка панели не сбрасывается опросом и сменой статуса', { timeout: 40000 }, async () => {
    const page = await pageAt(1280, 800, false);
    try {
      await page.goto(base + '/?theme=day&agent=grok', { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('.p-body');
      const placed = await page.evaluate(() => {
        const body = document.querySelector('.p-body');
        const top = Math.min(260, body.scrollHeight - body.clientHeight);
        body.scrollTop = top;
        return { top: body.scrollTop, max: body.scrollHeight - body.clientHeight };
      });
      assert.ok(placed.max > 120, 'в панели нечего прокручивать');
      assert.ok(placed.top > 120);

      await new Promise((r) => setTimeout(r, 13000));
      const afterPolls = await page.evaluate(() => document.querySelector('.p-body').scrollTop);
      assert.ok(Math.abs(afterPolls - placed.top) < 4, `опрос сбросил прокрутку: было ${placed.top}, стало ${afterPolls}`);

      const status = await page.evaluate(async () => {
        const res = await fetch('/api/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-token': 'tok-ui' },
          body: JSON.stringify({ agent: 'grok', status: 'working', now: 'Сверяю сводку' }),
        });
        return res.status;
      });
      assert.equal(status, 200);
      await page.waitForFunction(() => {
        const now = document.querySelector('.status-line .now');
        return now && now.textContent.includes('Сверяю сводку');
      }, { timeout: 12000 });
      const afterChange = await page.evaluate(() => document.querySelector('.p-body').scrollTop);
      assert.ok(afterChange > 80, `после обновления данных панель уехала наверх (${afterChange})`);
      assert.ok(Math.abs(afterChange - placed.top) < 48, `прокрутка уехала слишком далеко: ${placed.top} → ${afterChange}`);
    } finally {
      await page.close();
    }
  });
}
