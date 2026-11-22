'use strict';

// Браузерные проверки на Chrome: узкая ширина, прокрутка панели, бейдж приказа.
// Переменные окружения задаются до require('../server.js').
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-ui-'));
process.env.APP_PASSWORD = 'pw-ui';
process.env.AGENT_TOKEN = 'tok-ui';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.NEEDS_DETAILS_JSON = JSON.stringify({
  'need-finance': {
    details: '## Вопросы\n\nСколько отложить?\n\nСмотрите https://example.com/budget\n\nЧат grokbot://app/v1/agent?id=demo\n\n<script>alert(1)</script>',
    answerable: true,
  },
});
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
  return list.find((p) => fs.existsSync(p));
}

let server;
let browser;
let base;

before(async () => {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome не найден. Задайте CHROME_PATH.');
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
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

async function openPage(viewport, extra = {}) {
  const page = await browser.newPage();
  if (extra.reduced) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) req.abort();
    else req.continue();
  });
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: !extra.desktop,
    hasTouch: !extra.desktop,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}${extra.path || '/'}`, { waitUntil: 'domcontentloaded' });
  return page;
}

test('на ширине 390 иерархия не прячется под панелью агента', { timeout: 30000 }, async () => {
  const page = await openPage({ width: 390, height: 844 }, { path: '/?agent=analyst' });
  try {
    await page.waitForSelector('#panel.open .p-title h2', { timeout: 8000 });
    await page.click('#btnHier');
    await page.waitForSelector('#hier.open .org-card', { timeout: 4000 });
    const hit = await page.evaluate(() => {
      const hier = document.querySelector('#hier');
      const panel = document.querySelector('#panel');
      const card = hier.querySelector('.org-card');
      const cr = card.getBoundingClientRect();
      const hr = hier.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 8, Math.max(8, cr.left + Math.min(cr.width / 2, 120)));
      const y = Math.min(window.innerHeight - 8, Math.max(8, cr.top + cr.height / 2));
      const el = document.elementFromPoint(x, y);
      const panelOpen = panel.classList.contains('open');
      const overlap = panelOpen && hr.left < pr.right && hr.right > pr.left && hr.top < pr.bottom && hr.bottom > pr.top;
      const visibleH = Math.min(hr.bottom, window.innerHeight) - Math.max(hr.top, 0);
      return {
        panelOpen,
        overlap,
        inHier: !!(el && hier.contains(el)),
        cardH: cr.height,
        visibleH,
        text: (card.textContent || '').trim().slice(0, 80),
      };
    });
    const treeText = await page.$eval('#hTree', (el) => el.textContent);
    assert.match(treeText, /1\.\s*Путин/);
    assert.doesNotMatch(treeText, /Главный агент/);
    assert.match(treeText, /8\.\s*Тестировщик ПО/);
    assert.match(treeText, /9\.\s*Technology Blog/);
    assert.match(treeText, /10\.\s*Советник Путина/);
    assert.match(treeText, /11\.\s*Соцсети/);
    assert.match(treeText, /12\.\s*Рутины/);
    assert.doesNotMatch(treeText, /Language Coach/);
    assert.doesNotMatch(treeText, /Трейдинг/);
    assert.doesNotMatch(treeText, /Business Adviser/);
    assert.match(treeText, /7\.1\s*Инвестиции/);
    assert.match(treeText, /7\.2\s*Бизнес-аналитик/);
    assert.match(treeText, /7\.3\s*Темщик/);
    assert.equal(hit.panelOpen, false);
    assert.equal(hit.overlap, false);
    assert.ok(hit.cardH > 30, 'строка иерархии не видна');
    assert.ok(hit.visibleH > 160, 'у иерархии виден почти только заголовок');
    assert.equal(hit.inHier, true, hit.text);
    await page.screenshot({ path: '/tmp/hier-390.png' });
  } finally {
    await page.close();
  }
});

test('прокрутка панели на 390px сохраняется после обновления', { timeout: 30000 }, async () => {
  const task = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-ui' },
    body: JSON.stringify({ agent: 'dev', text: 'Длинная проверка прокрутки' }),
  });
  assert.equal(task.status, 201);
  const result = Array.from({ length: 24 }, (_, i) => `Строка результата ${i + 1}. Проверка, что блок не прыгает.`).join('\n');
  const closed = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ agent: 'dev', status: 'idle', now: 'Жду задач', taskId: task.body.id, result }),
  });
  assert.equal(closed.status, 200);
  for (let i = 0; i < 8; i++) {
    const msg = await api('/api/messages', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-ui' },
      body: JSON.stringify({ id: `scroll-dev-${i}`, agentId: 'dev', role: 'agent', text: `Промежуточная реплика номер ${i}. `.repeat(6) }),
    });
    assert.equal(msg.status, 201);
  }

  const page = await openPage({ width: 390, height: 844 }, { path: '/?agent=dev' });
  try {
    await page.waitForSelector('#panel.open .qr', { timeout: 8000 });
    await page.waitForSelector('#panel.open .chat-log .msg-row', { timeout: 4000 });
    const before = await page.evaluate(() => {
      const panel = document.querySelector('#panel');
      const body = panel.querySelector('.p-body');
      const chat = panel.querySelector('[data-scroll-key="chat"]');
      const qr = panel.querySelector('.qr');
      body.scrollTop = 180;
      chat.scrollTop = 0;
      qr.scrollTop = 36;
      const anchor = body.querySelector('[data-anchor="tasks"]');
      const box = body.getBoundingClientRect();
      const r = anchor.getBoundingClientRect();
      return {
        delta: r.top - box.top,
        chat: chat.scrollTop,
        qr: qr.scrollTop,
        qrH: qr.scrollHeight,
        qrC: qr.clientHeight,
        body: body.scrollTop,
        qrText: (qr.textContent || '').slice(0, 40),
      };
    });
    assert.ok(before.body > 40, `панель не прокручивается (${before.body})`);
    assert.ok(before.qr > 10, `результат не прокручивается (scroll ${before.qr}, h ${before.qrH}/${before.qrC})`);

    await page.evaluate(() => {
      window.__officeSeen = 0;
      document.addEventListener('officestate', () => { window.__officeSeen += 1; });
    });
    const marked = await api('/api/status', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-ui' },
      body: JSON.stringify({ agent: 'dev', status: 'waiting', now: 'MARKER-NOW ждёт взгляд' }),
    });
    assert.equal(marked.status, 200);
    await page.waitForFunction(() => window.__officeSeen > 0, { timeout: 10000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const after = await page.evaluate(() => {
      const panel = document.querySelector('#panel');
      const body = panel.querySelector('.p-body');
      const chat = panel.querySelector('[data-scroll-key="chat"]');
      const qr = panel.querySelector('.qr');
      const anchor = body.querySelector('[data-anchor="tasks"]');
      const box = body.getBoundingClientRect();
      const r = anchor.getBoundingClientRect();
      return {
        delta: r.top - box.top,
        chat: chat.scrollTop,
        qr: qr.scrollTop,
        body: body.scrollTop,
      };
    });
    assert.ok(Math.abs(after.delta - before.delta) < 3, `якорь панели сдвинулся: ${before.delta} → ${after.delta}`);
    assert.equal(after.chat, before.chat);
    assert.equal(after.qr, before.qr);
  } finally {
    await page.close();
  }
});

test('бейдж, цепочка и тихий конверт при reduced-motion', { timeout: 30000 }, async () => {
  const created = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-ui' },
    body: JSON.stringify({ agent: 'qa', text: 'Проверь узкий экран', fromAgentId: 'grok' }),
  });
  assert.equal(created.status, 201);
  const accepted = await api(`/api/orders/${created.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);

  const page = await openPage({ width: 390, height: 844 }, { path: '/?agent=qa', reduced: true });
  try {
    await page.waitForFunction(() => {
      const badge = document.querySelector('.order-badge[data-id="qa"]');
      return badge && badge.textContent.includes('принял');
    }, { timeout: 8000 });
    await page.waitForSelector('#panel.open .order-chain', { timeout: 8000 });
    const chain = await page.$eval('#panel .order-chain', (el) => el.textContent);
    assert.match(chain, /1\.\s*Путин/);
    assert.doesNotMatch(chain, /Главный агент/);
    assert.match(chain, /Тестировщик/);
    const hist = await page.$eval('#panel .order-hist', (el) => el.textContent);
    assert.match(hist, /В очереди, доставка не подключена/);
    assert.match(hist, /принял/);
    const chat = await page.$eval('#panel .chat-log', (el) => el.textContent);
    assert.match(chat, /Приказ:/);
    assert.match(chat, /Принял заказ/);
    const sysCount = await page.$$eval('#panel .msg-row.system', (nodes) => nodes.length);
    assert.equal(sysCount, 2);

    const working = await api(`/api/orders/${created.body.id}`, {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-ui' },
      body: JSON.stringify({ status: 'in_progress', progress: 55, note: 'Смотрю экран' }),
    });
    assert.equal(working.status, 200);
    await page.waitForFunction(() => {
      const badge = document.querySelector('.order-badge[data-id="qa"]');
      if (!badge || !badge.textContent.includes('в работе') || !badge.querySelector('.ob-bar i')) return false;
      if (badge.classList.contains('hide')) return false;
      const r = badge.getBoundingClientRect();
      return r.top > 40 && r.left >= 0 && r.right <= window.innerWidth + 1 && r.width > 40;
    }, { timeout: 10000 });
    const bar = await page.$eval('.order-badge[data-id="qa"] .ob-bar i', (el) => el.style.width);
    assert.equal(bar, '55%');
    const vis = await page.evaluate(() => {
      const badge = document.querySelector('.order-badge[data-id="qa"]');
      const r = badge.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        hide: badge.classList.contains('hide'),
        w: r.width,
        h: r.height,
        top: r.top,
        left: r.left,
        hit: !!(hit && (hit === badge || badge.contains(hit))),
      };
    });
    assert.equal(vis.hide, false);
    assert.ok(vis.w > 40 && vis.h > 10, JSON.stringify(vis));
    assert.ok(vis.top > 40 && vis.top < 700, JSON.stringify(vis));
    assert.equal(vis.hit, true, JSON.stringify(vis));

    const second = await api('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-ui' },
      body: JSON.stringify({ agent: 'qa', text: 'Второй приказ без полёта', fromAgentId: 'grok' }),
    });
    assert.equal(second.status, 201);
    await page.waitForFunction(() => document.querySelector('#fx')?.dataset.flight === 'reduced', { timeout: 10000 });
    assert.equal(await page.$('#fx .order-flight'), null);
    await page.screenshot({ path: '/tmp/order-390.png' });
  } finally {
    await page.close();
  }
});

test('блок «Нужно от вас»: бейдж, попап и «Напомнить позже»', { timeout: 30000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      if (!sessionStorage.getItem('needsTestReady')) {
        localStorage.removeItem('needsSnoozeUntil');
        localStorage.removeItem('needsNotify');
        sessionStorage.setItem('needsTestReady', '1');
      }
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#needsPop.open .need-item', { timeout: 8000 });
    const info = await page.evaluate(() => {
      const pop = document.querySelector('#needsPop');
      const badge = document.querySelector('#needsBadge');
      const btn = document.querySelector('#btnNeeds');
      const hier = document.querySelector('#btnHier').getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const popBox = pop.getBoundingClientRect();
      const roster = document.querySelector('#roster').getBoundingClientRect();
      const items = [...document.querySelectorAll('#needsList > .need-item')].map((el) => {
        const link = el.querySelector('a.need-action');
        const hint = el.querySelector('.need-action-hint');
        const box = el.getBoundingClientRect();
        const lr = link ? link.getBoundingClientRect() : null;
        const hr = hint ? hint.getBoundingClientRect() : null;
        return {
          id: el.dataset.id,
          what: el.querySelector('.need-what').textContent,
          from: el.querySelector('.need-from').textContent,
          where: el.querySelector('.need-where').textContent,
          urg: el.className,
          label: link ? link.textContent : '',
          href: link ? link.getAttribute('href') : '',
          target: link ? link.getAttribute('target') : '',
          rel: link ? link.getAttribute('rel') : '',
          hint: hint ? hint.textContent : '',
          fits: !!(link && lr.left >= -1 && lr.right <= window.innerWidth + 1 && lr.width >= 40 && lr.height >= 36
            && lr.left >= box.left - 1 && lr.right <= box.right + 1
            && (!hint || (hr.left >= -1 && hr.right <= window.innerWidth + 1 && hr.right <= box.right + 1))),
        };
      });
      return {
        count: badge.textContent.trim(),
        label: btn.getAttribute('aria-label'),
        expanded: btn.getAttribute('aria-expanded'),
        items,
        popBottom: popBox.bottom,
        popLeft: popBox.left,
        popRight: popBox.right,
        rosterTop: roster.top,
        vw: window.innerWidth,
        btnInView: br.width > 20 && br.top >= 0 && br.left >= 0 && br.right <= window.innerWidth + 1 && br.bottom <= window.innerHeight,
        hierInView: hier.width > 20 && hier.left >= 0 && hier.right <= window.innerWidth + 1,
        notify: document.querySelector('#needsNotify').textContent,
        rowsFit: [...document.querySelectorAll('#needsList > .need-item')].every((el) => {
          const urg = el.querySelector('.need-urg').getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return el.scrollHeight <= el.clientHeight + 1 && urg.top >= box.top - 1 && urg.bottom <= box.bottom + 1;
        }),
      };
    });
    assert.equal(info.vw, 390);
    assert.ok(Number(info.count) >= 2, info.count);
    assert.equal(info.count, String(info.items.length));
    assert.match(info.label, /Нужно от вас/);
    assert.equal(info.expanded, 'true');
    assert.equal(info.btnInView, true, 'бейдж не помещается в шапку');
    assert.equal(info.hierInView, true, 'кнопка иерархии уехала с экрана');
    assert.equal(info.notify, 'Включить уведомления');
    assert.equal(info.rowsFit, true, 'строка пункта обрезана');
    const text = info.items.map((i) => `${i.what} ${i.from} ${i.where} ${i.urg}`).join('\n');
    assert.doesNotMatch(text, /Ключ Render API/);
    assert.doesNotMatch(text, /Академию агентов/);
    assert.doesNotMatch(text, /Business Adviser/);
    assert.doesNotMatch(text, /ТЕСТ:/);
    assert.equal(await page.$('#needsList .needs-test'), null);
    assert.doesNotMatch(await page.$eval('#needsList', (el) => el.textContent), /ТЕСТ:/);
    assert.match(text, /Чат Путина или Финансов/);
    assert.match(text, /Instagram и YouTube/);
    assert.match(text, /Соцсети/);
    assert.match(text, /финансовых вопросов/);
    assert.match(text, /Финансы/);
    const byId = Object.fromEntries(info.items.map((item) => [item.id, item]));
    const finance = byId['need-finance'];
    const social = byId['need-social'];
    assert.ok(finance && social);
    assert.equal(finance.label, 'Решить');
    assert.equal(finance.href, '/needs/need-finance');
    assert.equal(finance.target, null);
    assert.equal(finance.hint, '');
    assert.equal(social.href, '/needs/need-social');
    assert.equal(social.hint, '');
    assert.doesNotMatch(text, /Сколько отложить/);
    assert.doesNotMatch(text, /example\.com\/budget/);
    assert.ok(info.items.every((item) => item.fits), JSON.stringify(info.items));
    assert.ok(info.popLeft >= -1 && info.popRight <= info.vw + 1, `попап шире экрана: ${info.popLeft}..${info.popRight}`);
    assert.ok(info.popBottom <= info.rosterTop + 1, `попап перекрыл полосу: ${info.popBottom} / ${info.rosterTop}`);

    await page.click('#needsLater');
    await page.waitForFunction(() => !document.querySelector('#needsPop').classList.contains('open'));
    const after = await page.evaluate(() => {
      const until = Number(localStorage.getItem('needsSnoozeUntil') || 0);
      const badge = document.querySelector('#needsBadge');
      return {
        open: document.querySelector('#needsPop').classList.contains('open'),
        count: badge.textContent.trim(),
        until,
        badgeShown: badge.getBoundingClientRect().width > 0,
      };
    });
    assert.equal(after.open, false);
    assert.equal(after.count, info.count);
    assert.equal(after.badgeShown, true);
    assert.ok(after.until > Date.now() + 59 * 60 * 1000, String(after.until));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Number(document.querySelector('#needsBadge')?.textContent) >= 2, { timeout: 8000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#needsPop', (el) => el.classList.contains('open')), false);

    await page.click('#btnNeeds');
    await page.waitForSelector('#needsPop.open .need-item a.need-action');
    const opened = await page.evaluate(() => {
      const pop = document.querySelector('#needsPop');
      const items = [...pop.querySelectorAll('#needsList > .need-item')];
      return {
        open: pop.classList.contains('open'),
        hidden: pop.getAttribute('aria-hidden'),
        badge: document.querySelector('#needsBadge').textContent.trim(),
        buttons: items.map((el) => {
          const link = el.querySelector('a.need-action');
          const hint = el.querySelector('.need-action-hint');
          return {
            id: el.dataset.id,
            label: link ? link.textContent.trim() : '',
            href: link ? link.getAttribute('href') : '',
            hint: hint ? hint.textContent : '',
            https: link ? link.getAttribute('target') : '',
          };
        }),
      };
    });
    assert.equal(opened.open, true);
    assert.equal(opened.hidden, 'false');
    assert.equal(String(opened.buttons.length), opened.badge);
    assert.ok(opened.buttons.length >= 2, JSON.stringify(opened));
    for (const button of opened.buttons) {
      assert.equal(button.label, 'Решить', JSON.stringify(button));
      assert.equal(button.href, `/needs/${button.id}`, JSON.stringify(button));
      assert.equal(button.https, null);
    }
    const popupFinance = opened.buttons.find((button) => button.id === 'need-finance');
    const popupSocial = opened.buttons.find((button) => button.id === 'need-social');
    assert.ok(popupSocial);
    assert.equal(popupFinance.href, '/needs/need-finance');
    assert.equal(popupFinance.hint, '');
    assert.equal(popupSocial.href, '/needs/need-social');
    assert.equal(popupSocial.hint, '');
    await page.screenshot({ path: '/tmp/needs-390.png' });
  } finally {
    await page.close();
  }
});

test('«Решить» экранирует ссылку и подсказку в списке и в «Ждёт от вас»', { timeout: 30000 }, async () => {
  const created = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({
      what: 'Ссылка <script>alert(1)</script>',
      where: 'Чат <img src=x>',
      fromAgentId: 'poker',
      urgency: 'low',
      actionUrl: 'grokbot://app/v1/agent?id=1&x=<script>',
      actionLabel: 'Решить <img>',
      actionHint: 'подсказка <b>x</b> «чат»',
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    });
    await page.goto(`${base}/?agent=poker`, { waitUntil: 'domcontentloaded' });
    const sel = `.need-item[data-id="${created.body.id}"]`;
    await page.waitForSelector(`#needsList ${sel} a.need-action`, { timeout: 8000 });
    await page.waitForSelector(`#panel.open[data-agent="poker"] [data-anchor="awaits"] ${sel} a.need-action`, { timeout: 8000 });
    const cards = await page.$$eval(sel, (els) => els.map((el) => {
      const link = el.querySelector('a.need-action');
      const lr = link.getBoundingClientRect();
      return {
        html: el.innerHTML,
        label: link.textContent,
        href: link.getAttribute('href'),
        target: link.getAttribute('target'),
        right: lr.right,
        vw: window.innerWidth,
      };
    }));
    assert.equal(cards.length, 2, JSON.stringify(cards));
    for (const card of cards) {
      assert.doesNotMatch(card.html, /<script/i);
      assert.doesNotMatch(card.html, /<img/i);
      assert.match(card.html, /Ссылка &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.match(card.html, /Чат &lt;img src=x&gt;/);
      assert.match(card.html, /Решить &lt;img&gt;/);
      assert.doesNotMatch(card.href, /grokbot:/);
      assert.doesNotMatch(card.html, /grokbot:/);
      assert.doesNotMatch(card.html, /Прочитать: grokbot:/);
      assert.doesNotMatch(card.html, /подсказка <b>/);
      assert.equal(card.label, 'Решить <img>');
      assert.equal(card.href, `/needs/${created.body.id}`);
      assert.equal(card.target, null);
      assert.ok(card.right <= card.vw + 1, JSON.stringify(card));
    }
  } finally {
    await page.close();
    if (created.body && created.body.id) {
      await api(`/api/needs/${created.body.id}/close`, {
        method: 'POST',
        headers: { 'x-agent-token': 'tok-ui' },
        body: JSON.stringify({ agentId: 'grok' }),
      });
    }
  }
});

const zlib = require('zlib');

function pngCrc(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < width; x++) {
      const i = off + 1 + x * 3;
      raw[i] = (x * 17 + y * 3) & 255;
      raw[i + 1] = (y * 13 + x) & 255;
      raw[i + 2] = (x * 9 + y * 5) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function taskPage() {
  const page = await openPage({ width: 1280, height: 800 }, { path: '/?theme=day&agent=dev' });
  await page.waitForSelector('#taskForm', { timeout: 8000 });
  return page;
}

async function attachOnPage(page, filePath) {
  const input = await page.$('#fileInput');
  await input.uploadFile(filePath);
  await page.evaluate(() => {
    const el = document.querySelector('#fileInput');
    if (el.files && el.files.length) el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

test('задача из панели уходит на сервер и без файла, и с PNG', { timeout: 60000 }, async () => {
  const small = path.join(os.tmpdir(), 'image-100k.png');
  const mid = path.join(os.tmpdir(), 'image-3mb.png');
  const smallPng = makePng(256, 128);
  const midPng = makePng(1300, 768);
  assert.ok(smallPng.length > 80 * 1024 && smallPng.length < 1024 * 1024, `png ${smallPng.length}`);
  assert.ok(midPng.length > 2.5 * 1024 * 1024 && midPng.length < 8 * 1024 * 1024, `png ${midPng.length}`);
  fs.writeFileSync(small, smallPng);
  fs.writeFileSync(mid, midPng);
  const page = await taskPage();
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  const logs = [];
  page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  try {
    await page.evaluate(() => localStorage.setItem('appPassword', 'pw-ui'));
    await page.$eval('#taskText', (el) => { el.value = 'Текстовая задача без файла'; });
    await page.evaluate(() => document.querySelector('#taskForm').requestSubmit());
    await page.waitForFunction(() => /Приказ сохранён/.test(document.querySelector('#formMsg')?.textContent || ''), { timeout: 15000 });
    assert.ok(posts.includes('/api/task'), `без файла POST не ушёл: ${posts.join(',')}`);
    assert.equal(posts.includes('/api/upload'), false);
    const plain = await page.$eval('#panel', (el) => el.textContent);
    assert.match(plain, /Текстовая задача без файла/);

    posts.length = 0;
    await attachOnPage(page, small);
    await page.$eval('#taskText', (el) => { el.value = 'Посмотри image.png на сто килобайт'; });
    await page.evaluate(() => document.querySelector('#taskForm').requestSubmit());
    await page.waitForFunction(() => {
      const msg = document.querySelector('#formMsg');
      return msg && /Приказ сохранён/.test(msg.textContent);
    }, { timeout: 15000 });
    await page.waitForFunction(() => {
      const link = document.querySelector('#panel .file-link, #panel .thumb');
      return link && /image-100k\.png/.test(document.querySelector('#panel').textContent);
    }, { timeout: 8000 });
    assert.ok(posts.includes('/api/upload'));
    assert.ok(posts.includes('/api/task'));
    assert.equal(logs.some((line) => /ReferenceError|Нет связи/.test(line)), false);

    posts.length = 0;
    await attachOnPage(page, mid);
    await page.$eval('#taskText', (el) => { el.value = 'И большой скриншот на три мегабайта'; });
    await page.evaluate(() => document.querySelector('#taskForm').requestSubmit());
    await page.waitForFunction(() => /Приказ сохранён/.test(document.querySelector('#formMsg')?.textContent || ''), { timeout: 20000 });
    await page.waitForFunction(() => /image-3mb\.png/.test(document.querySelector('#panel').textContent || ''), { timeout: 8000 });
    const msg = await page.$eval('#formMsg', (el) => el.textContent);
    assert.match(msg, /Приказ сохранён/);
    assert.doesNotMatch(msg, /Нет связи/);
    assert.ok(posts.includes('/api/upload') && posts.includes('/api/task'));
  } finally {
    await page.close();
    fs.rmSync(small, { force: true });
    fs.rmSync(mid, { force: true });
  }
});

test('файл больше 10 МБ не уходит на сервер', { timeout: 30000 }, async () => {
  const big = path.join(os.tmpdir(), 'image-over.png');
  fs.writeFileSync(big, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(10 * 1024 * 1024 + 1 - 8, 0),
  ]));
  const page = await taskPage();
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  try {
    await page.evaluate(() => localStorage.setItem('appPassword', 'pw-ui'));
    await attachOnPage(page, big);
    const onAttach = await page.$eval('#formMsg', (el) => el.textContent);
    assert.equal(onAttach, 'Файл слишком большой (макс. 10 МБ)');
    await page.click('#taskSubmit');
    const after = await page.$eval('#formMsg', (el) => el.textContent);
    assert.equal(after, 'Файл слишком большой (макс. 10 МБ)');
    assert.equal(posts.some((p) => p === '/api/upload' || p === '/api/task'), false);
  } finally {
    await page.close();
    fs.rmSync(big, { force: true });
  }
});

test('неверный пароль показывает «Неверный пароль», а не обрыв связи', { timeout: 30000 }, async () => {
  const page = await taskPage();
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push(new URL(req.url()).pathname);
  });
  try {
    await page.evaluate(() => localStorage.setItem('appPassword', 'wrong-password'));
    await page.$eval('#taskText', (el) => { el.value = 'Это не должно сохраниться'; });
    await page.click('#taskSubmit');
    await page.waitForFunction(() => document.querySelector('#formMsg')?.textContent === 'Неверный пароль', { timeout: 8000 });
    assert.ok(posts.includes('/api/task'));
    assert.equal(await page.$eval('#modal', (el) => el.classList.contains('show')), true);
  } finally {
    await page.close();
  }
});

async function installFetchModes(page) {
  await page.evaluate(() => {
    if (window.__taskFetchOrig) return;
    window.__taskFetchOrig = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const mode = window.__taskFailMode;
      const u = String(url);
      const hit = u.includes('/api/task') || u.includes('/api/upload');
      if (!mode || !hit) return window.__taskFetchOrig(url, opts);
      if (mode === 'net') return Promise.reject(new TypeError('Failed to fetch'));
      if (mode === 'js') throw new ReferenceError('tier is not defined');
      const table = {
        413: { status: 413, error: 'entity.too.large' },
        401: { status: 401, error: 'Неверный пароль доступа' },
        403: { status: 403, error: 'forbidden' },
        502: { status: 502, error: 'bad gateway' },
        503: { status: 503, error: '' },
        504: { status: 504, error: 'gateway timeout' },
        400: { status: 400, error: 'Неизвестный агент' },
        500: { status: 500, error: 'Внутренняя ошибка хранилища' },
      };
      const spec = table[mode];
      const body = spec.error ? JSON.stringify({ error: spec.error }) : '';
      return Promise.resolve(new Response(body, {
        status: spec.status,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }));
    };
  });
}

test('сообщение формы совпадает с кодом ответа и типом сбоя', { timeout: 40000 }, async () => {
  const page = await taskPage();
  const logs = [];
  page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));
  const cases = [
    ['413', 'Файл слишком большой (макс. 10 МБ)'],
    ['401', 'Неверный пароль'],
    ['403', 'Неверный пароль'],
    ['502', 'Сервер перезапускается, попробуйте через минуту'],
    ['503', 'Сервер перезапускается, попробуйте через минуту'],
    ['504', 'Сервер перезапускается, попробуйте через минуту'],
    ['400', 'Неизвестный агент'],
    ['500', 'Внутренняя ошибка хранилища'],
    ['js', 'tier is not defined'],
    ['net', 'Нет связи с сервером'],
  ];
  try {
    await page.evaluate(() => localStorage.setItem('appPassword', 'pw-ui'));
    await installFetchModes(page);
    for (const [mode, expected] of cases) {
      await page.evaluate((m) => {
        localStorage.setItem('appPassword', 'pw-ui');
        window.__taskFailMode = m;
        document.querySelector('#modal').classList.remove('show');
        const box = document.querySelector('#formMsg');
        box.className = 'msg';
        box.textContent = '';
      }, mode);
      await page.$eval('#taskText', (el, value) => { el.value = value; }, `случай ${mode}`);
      await page.evaluate(() => document.querySelector('#taskForm').requestSubmit());
      await page.waitForFunction((text) => document.querySelector('#formMsg')?.textContent === text, { timeout: 8000 }, expected);
    }
    assert.ok(logs.some((line) => line.includes('tier is not defined')));
    assert.ok(logs.some((line) => /Failed to fetch|исключение в браузере/.test(line)));
  } finally {
    await page.close();
  }
});

test('остановленный сервер — это обрыв связи, а не ошибка скрипта', { timeout: 30000 }, async () => {
  const stopped = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const origin = `http://127.0.0.1:${stopped.address().port}`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  try {
    await page.goto(`${origin}/?theme=day&agent=dev`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#taskForm', { timeout: 8000 });
    await page.evaluate(() => localStorage.setItem('appPassword', 'pw-ui'));
    await page.$eval('#taskText', (el) => { el.value = 'Сервер уже ляжет'; });
    await new Promise((resolve, reject) => stopped.close((err) => (err ? reject(err) : resolve())));
    await page.click('#taskSubmit');
    await page.waitForFunction(() => document.querySelector('#formMsg')?.textContent === 'Нет связи с сервером', { timeout: 8000 });
  } finally {
    await page.close();
  }
});

test('офлайн-браузер показывает «Нет связи с сервером»', { timeout: 30000 }, async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  try {
    await page.goto(`${base}/?theme=day&agent=dev`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#taskForm', { timeout: 8000 });
    await page.evaluate(() => localStorage.setItem('appPassword', 'pw-ui'));
    await page.$eval('#taskText', (el) => { el.value = 'Сети нет'; });
    await page.setOfflineMode(true);
    await page.evaluate(() => document.querySelector('#taskForm').requestSubmit());
    await page.waitForFunction(() => document.querySelector('#formMsg')?.textContent === 'Нет связи с сервером', { timeout: 8000 });
  } finally {
    await page.setOfflineMode(false).catch(() => {});
    await page.close();
  }
});

test('без reduced-motion новый приказ запускает полёт конверта', { timeout: 30000 }, async () => {
  const page = await openPage({ width: 390, height: 844 }, { path: '/' });
  try {
    await page.waitForSelector('#roster .chip', { timeout: 8000 });
    const created = await api('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-ui' },
      body: JSON.stringify({ agent: 'army', text: 'Конверт должен полететь', fromAgentId: 'grok' }),
    });
    assert.equal(created.status, 201);
    await page.waitForFunction(() => document.querySelector('#fx')?.dataset.flight === 'play', { timeout: 10000 });
  } finally {
    await page.close();
  }
});

async function openQuiet(viewport) {
  const page = await browser.newPage();
  const narrow = viewport.width <= 700;
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: narrow,
    hasTouch: narrow,
    deviceScaleFactor: 1,
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.removeItem('needsNotify');
    localStorage.removeItem('appPassword');
  });
  await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#roster .chip[data-id="finance"]', { timeout: 8000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#roster .chip[data-id="finance"] .await-you');
    return el && !el.hidden && el.querySelector('.await-you-count')?.textContent === '1';
  }, { timeout: 8000 });
  return page;
}

test('бейдж «ждёт вас»: счётчик, нуль скрыт, тап открывает блок', { timeout: 60000 }, async () => {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ];
  for (const viewport of viewports) {
    const page = await openQuiet(viewport);
    try {
      const counts = await page.evaluate(() => {
        const read = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { missing: true };
          const r = el.getBoundingClientRect();
          return {
            hidden: !!el.hidden,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            count: el.querySelector('.await-you-count')?.textContent || '',
            w: r.width,
            h: r.height,
          };
        };
        return {
          financeRoster: read('#roster .chip[data-id="finance"] .await-you'),
          financeMap: read('#overlay .await-you[data-id="finance"]'),
          pokerRoster: read('#roster .chip[data-id="poker"] .await-you'),
          pokerMap: read('#overlay .await-you[data-id="poker"]'),
          devopsRoster: read('#roster .chip[data-id="devops"] .await-you'),
        };
      });
      assert.equal(counts.financeRoster.hidden, false, JSON.stringify(counts));
      assert.equal(counts.financeRoster.count, '1');
      assert.match(counts.financeRoster.text, /ждёт вас/);
      assert.ok(counts.financeRoster.w >= 40 && counts.financeRoster.h >= 40, JSON.stringify(counts.financeRoster));
      assert.equal(counts.financeMap.missing, undefined);
      assert.equal(counts.financeMap.hidden, false);
      assert.equal(counts.financeMap.count, '1');
      assert.equal(counts.pokerRoster.hidden, true);
      assert.equal(counts.pokerMap.hidden, true);
      assert.equal(counts.devopsRoster.hidden, true);

      await page.evaluate(() => {
        document.querySelector('#roster .chip[data-id="finance"]').scrollIntoView({ inline: 'center', block: 'nearest' });
      });
      const badge = '#roster .chip[data-id="finance"] .await-you';
      if (viewport.width <= 700) {
        const point = await page.$eval(badge, (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.touchscreen.tap(point.x, point.y);
      } else {
        await page.click(badge);
      }
      await page.waitForSelector('#panel.open[data-agent="finance"] [data-anchor="awaits"]', { timeout: 8000 });
      await page.waitForFunction(() => {
        const panel = document.querySelector('#panel.open');
        if (!panel) return false;
        const r = panel.getBoundingClientRect();
        return r.width > 200 && r.left >= -1 && r.right <= window.innerWidth + 1 && r.top < window.innerHeight && r.bottom > 0;
      }, { timeout: 3000 });
      const placed = await page.evaluate(() => {
        const body = document.querySelector('#panel .p-body');
        const el = document.querySelector('#panel [data-anchor="awaits"]');
        const close = el.querySelector('.need-close');
        const br = body.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const cr = close.getBoundingClientRect();
        const link = el.querySelector('a.need-action');
        const hint = el.querySelector('.need-action-hint');
        const lr = link ? link.getBoundingClientRect() : null;
        const hr = hint ? hint.getBoundingClientRect() : null;
        return {
          title: el.querySelector('h4').textContent,
          delta: r.top - br.top,
          visible: r.bottom > br.top && r.top < br.bottom,
          closeW: cr.width,
          closeH: cr.height,
          text: el.textContent,
          label: link ? link.textContent : '',
          href: link ? link.getAttribute('href') : '',
          target: link ? link.getAttribute('target') : '',
          hint: hint ? hint.textContent : '',
          linkRight: lr ? lr.right : 0,
          hintRight: hr ? hr.right : 0,
          vw: window.innerWidth,
        };
      });
      assert.match(placed.title, /Ждёт от вас/);
      assert.equal(placed.visible, true, JSON.stringify(placed));
      assert.ok(placed.delta < 28 && placed.delta > -2, JSON.stringify(placed));
      assert.match(placed.text, /финансовых вопросов/);
      assert.match(placed.text, /Чат Путина или Финансов/);
      assert.equal(placed.label, 'Решить');
      assert.equal(placed.href, '/needs/need-finance');
      assert.equal(placed.target, null);
      assert.equal(placed.hint, '');
      assert.ok(placed.linkRight <= placed.vw + 1 && placed.hintRight <= placed.vw + 1, JSON.stringify(placed));
      assert.ok(placed.closeW >= 40 && placed.closeH >= 40, JSON.stringify(placed));

      if (viewport.width > 700) {
        await page.click('#panel .need-close');
        await page.waitForSelector('#modal.show');
        assert.equal(await page.$eval('#mTitle', (el) => el.textContent), 'Пропуск в штаб');
        await page.click('#pwCancel');
        await page.click('#pClose');
        await page.waitForFunction(() => !document.querySelector('#panel').classList.contains('open'));
        await page.waitForFunction(() => {
          const el = document.querySelector('#overlay .await-you[data-id="finance"]');
          if (!el || el.hidden || el.classList.contains('hide')) return false;
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!(top && (top === el || el.contains(top)));
        }, { timeout: 5000 });
        const mapHit = await page.evaluate(() => {
          const el = document.querySelector('#overlay .await-you[data-id="finance"]');
          if (!el || el.hidden || el.classList.contains('hide')) return null;
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const top = document.elementFromPoint(x, y);
          return {
            x, y, w: r.width, h: r.height,
            hit: !!(top && (top === el || el.contains(top))),
          };
        });
        assert.ok(mapHit && mapHit.hit && mapHit.w >= 40 && mapHit.h >= 40, JSON.stringify(mapHit));
        await page.$eval('#overlay .await-you[data-id="finance"]', (el) => el.click());
        await page.waitForSelector('#panel.open[data-agent="finance"] [data-anchor="awaits"]');
      }
    } finally {
      await page.close();
    }
  }
});

test('панель DevOps: журнал приказов на десктопе и на 390, без ключа Render', { timeout: 60000 }, async () => {
  const incoming = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-ui' },
    body: JSON.stringify({ agent: 'devops', text: 'Проверь деплой штаба', fromAgentId: 'grok' }),
  });
  assert.equal(incoming.status, 201);
  const outgoing = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-ui' },
    body: JSON.stringify({
      agent: 'qa',
      text: 'Прогони смоук панели',
      fromAgentId: 'devops',
      parentOrderId: incoming.body.id,
    }),
  });
  assert.equal(outgoing.status, 201);
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
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      });
      await page.goto(`${base}/?theme=day&agent=devops`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#panel.open[data-agent="devops"] [data-anchor="tasks"] .quest[data-dir="in"]', { timeout: 8000 });
      const info = await page.evaluate(() => {
        const tasks = document.querySelector('[data-anchor="tasks"]');
        const dirs = [...tasks.querySelectorAll('.quest')].map((q) => ({
          dir: q.dataset.dir || '',
          text: q.querySelector('.qt').textContent,
        }));
        return {
          title: document.querySelector('.p-title h2').textContent,
          awaits: document.querySelector('[data-anchor="awaits"]')?.textContent || '',
          journal: tasks.querySelector('h4').textContent,
          dirs,
          chat: document.querySelector('[data-anchor="chat"]').textContent,
          vw: window.innerWidth,
        };
      });
      assert.equal(info.vw, viewport.width);
      assert.match(info.title, /4\./);
      assert.match(info.title, /DevOps/);
      assert.equal(info.awaits, '');
      assert.match(info.journal, /Журнал заданий/);
      assert.doesNotMatch(`${info.awaits} ${info.chat} ${info.journal}`, /Ключ Render API/);
      assert.ok(info.dirs.some((d) => d.dir === 'in' && /Проверь деплой/.test(d.text)), JSON.stringify(info.dirs));
      assert.ok(info.dirs.some((d) => d.dir === 'out' && /Прогони смоук/.test(d.text)), JSON.stringify(info.dirs));
      assert.match(info.chat, /Проверь деплой/);
      assert.match(info.chat, /Прогони смоук/);
    } finally {
      await page.close();
    }
  }
});

test('на ширине 390 архивные агенты скрыты, история в state остаётся', { timeout: 30000 }, async () => {
  const note = await api('/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ id: 'ui-archive-trading', agentId: 'trading', role: 'agent', text: 'История трейдинга на месте' }),
  });
  assert.equal(note.status, 201);
  const need = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({
      what: 'Архивный пункт трейдинга',
      where: 'Москва-Сити',
      fromAgentId: 'trading',
      urgency: 'high',
    }),
  });
  assert.equal(need.status, 201);
  const langNote = await api('/api/messages', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ id: 'ui-archive-lang', agentId: 'lang', role: 'agent', text: 'История репетитора на месте' }),
  });
  assert.equal(langNote.status, 201);
  const langNeed = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({
      what: 'Архивный пункт репетитора',
      where: 'МГУ',
      fromAgentId: 'lang',
      urgency: 'low',
    }),
  });
  assert.equal(langNeed.status, 201);
  const langTask = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-ui' },
    body: JSON.stringify({ agent: 'lang', text: 'Новый урок архивному репетитору' }),
  });
  assert.equal(langTask.status, 409);

  const page = await openPage({ width: 390, height: 844 }, { path: '/?agent=grok' });
  try {
    await page.waitForSelector('#roster .chip', { timeout: 8000 });
    await page.waitForSelector('#taskTarget option', { timeout: 8000 });
    const ui = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#roster .chip')].map((el) => ({
        id: el.dataset.id,
        text: (el.querySelector('.cn') || el).textContent.replace(/\s+/g, ' ').trim(),
      }));
      const options = [...document.querySelectorAll('#taskTarget option')].map((el) => ({
        value: el.value,
        text: el.textContent.replace(/\s+/g, ' ').trim(),
      }));
      return {
        vw: window.innerWidth,
        chips,
        mapIds: [...document.querySelectorAll('#agents .agent')].map((el) => el.dataset.id),
        tagText: [...document.querySelectorAll('#overlay .tag')].map((el) => el.textContent).join('\n'),
        options,
      };
    });
    assert.equal(ui.vw, 390);
    const chipIds = ui.chips.map((c) => c.id);
    assert.equal(chipIds.includes('trading'), false);
    assert.equal(chipIds.includes('biz'), false);
    assert.equal(chipIds.includes('lang'), false);
    assert.equal(ui.mapIds.includes('trading'), false);
    assert.equal(ui.mapIds.includes('biz'), false);
    assert.equal(ui.mapIds.includes('lang'), false);
    assert.ok(ui.mapIds.includes('devops') && ui.mapIds.includes('finance') && ui.mapIds.includes('grok'));
    assert.equal(ui.mapIds.includes('advisor'), true);
    assert.equal(ui.mapIds.includes('invest'), false);
    assert.equal(ui.mapIds.includes('temshik'), false);
    assert.equal(ui.mapIds.includes('analyst'), false);
    assert.doesNotMatch(ui.tagText, /Трейдинг|Business Adviser|Language Coach|Главный агент/);
    const chip = (id) => ui.chips.find((c) => c.id === id).text;
    assert.equal(chip('grok'), '1. Путин');
    assert.match(chip('army'), /^2\./);
    assert.match(chip('poker'), /^3\./);
    assert.match(chip('devops'), /^4\./);
    assert.match(chip('dev'), /^5\./);
    assert.equal(chipIds.includes('temshik'), false);
    assert.match(chip('finance'), /^7\./);
    assert.equal(chipIds.includes('invest'), false);
    assert.equal(chipIds.includes('analyst'), false);
    assert.equal(chipIds.includes('advisor'), true);
    assert.match(chip('qa'), /^8\./);
    assert.match(chip('blog'), /^9\./);
    assert.match(chip('social'), /^11\./);
    assert.match(chip('routines'), /^12\./);
    assert.equal(ui.options.some((o) => o.value === 'trading' || o.value === 'biz' || o.value === 'lang'), false);
    assert.equal(ui.options.find((o) => o.value === 'grok').text, '1. Путину лично');
    assert.match(ui.options.find((o) => o.value === 'devops').text, /^4\./);
    assert.match(ui.options.find((o) => o.value === 'invest').text, /7\.1/);
    assert.equal(ui.options.find((o) => o.value === 'advisor').text, '10. Советник Путина');

    const needsUi = await page.evaluate(() => ({
      text: document.querySelector('#needsList').textContent,
      badge: document.querySelector('#needsBadge').textContent.trim(),
    }));
    assert.doesNotMatch(needsUi.text, /Архивный пункт трейдинга/);
    assert.doesNotMatch(needsUi.text, /Архивный пункт репетитора/);
    assert.doesNotMatch(needsUi.text, /Трейдинг|Language Coach|Главный агент/);
    const froms = await page.$$eval('#needsList .need-from', (els) => els.map((el) => el.textContent));
    assert.ok(froms.every((text) => !/Трейдинг|Business Adviser|Language Coach|Главный агент/.test(text)), froms.join(' | '));
    assert.ok(froms.some((text) => /Соцсети|Финансы/.test(text)), froms.join(' | '));
    const apiNeeds = await api('/api/needs');
    const visibleNeeds = apiNeeds.body.needs.filter((n) => n.kind !== 'test' && n.fromAgentId !== 'trading' && n.fromAgentId !== 'biz' && n.fromAgentId !== 'lang');
    assert.ok(apiNeeds.body.needs.some((n) => n.fromAgentId === 'trading'));
    assert.equal(needsUi.badge, String(visibleNeeds.length));
    await page.waitForSelector('#panel.open[data-agent="grok"]', { timeout: 8000 });
    const hiddenUi = await page.evaluate(() => ({
      tradingBadge: !!document.querySelector('#roster .await-you[data-id="trading"]:not([hidden]), #overlay .await-you[data-id="trading"]:not([hidden])'),
      bizBadge: !!document.querySelector('#roster .await-you[data-id="biz"]:not([hidden]), #overlay .await-you[data-id="biz"]:not([hidden])'),
      awaits: document.querySelector('#panel [data-anchor="awaits"]')?.textContent || '',
    }));
    assert.equal(hiddenUi.tradingBadge, false);
    assert.equal(hiddenUi.bizBadge, false);
    assert.doesNotMatch(hiddenUi.awaits, /Архивный пункт трейдинга/);

    await page.click('#btnHier');
    await page.waitForSelector('#hier.open .org-card', { timeout: 4000 });
    const treeText = await page.$eval('#hTree', (el) => el.textContent);
    assert.match(treeText, /7\.1\s*Инвестиции/);
    assert.match(treeText, /7\.2\s*Бизнес-аналитик/);
    assert.match(treeText, /7\.3\s*Темщик/);
    assert.doesNotMatch(treeText, /Трейдинг/);
    assert.doesNotMatch(treeText, /Business Adviser/);
    assert.match(treeText, /1\.\s*Путин/);
    assert.match(treeText, /10\.\s*Советник Путина/);
    assert.doesNotMatch(treeText, /Language Coach|Главный агент/);
    const parentage = await page.evaluate(() => {
      const root = document.querySelector('#hTree > .org-item');
      const rootName = root.querySelector(':scope > .org-row .nm').textContent.replace(/\s+/g, ' ').trim();
      const kids = [...root.querySelectorAll(':scope > .org-kids > .org-item > .org-row .nm')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
      return { rootName, kids };
    });
    assert.equal(parentage.rootName, '1. Путин');
    assert.ok(parentage.kids.includes('10. Советник Путина'), parentage.kids.join(' | '));

    const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    assert.equal(state.agents.find((a) => a.id === 'trading').archived, true);
    assert.equal(state.agents.find((a) => a.id === 'biz').archived, true);
    assert.equal(state.agents.find((a) => a.id === 'lang').archived, true);
    assert.equal(state.agents.find((a) => a.id === 'advisor').number, '10');
    assert.equal(state.agents.find((a) => a.id === 'advisor').parentId, null);
    assert.ok(state.messages.some((m) => m.id === 'ui-archive-trading' && m.text === 'История трейдинга на месте'));
    assert.ok(state.messages.some((m) => m.id === 'ui-archive-lang' && m.text === 'История репетитора на месте'));
    assert.ok(state.needs.some((n) => n.fromAgentId === 'trading' && n.what === 'Архивный пункт трейдинга'));
    assert.ok(state.needs.some((n) => n.fromAgentId === 'lang' && n.what === 'Архивный пункт репетитора'));
    assert.equal(state.tasks.some((t) => t.agent === 'lang'), false);
  } finally {
    await page.close();
  }
});

test('на десктопе подписи «1. Путин» и «10. Советник Путина»', { timeout: 30000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 }, { path: '/?agent=advisor', desktop: true });
  try {
    await page.waitForSelector('#panel.open[data-agent="advisor"] h2', { timeout: 8000 });
    await page.waitForSelector('#roster .chip[data-id="grok"]', { timeout: 8000 });
    const ui = await page.evaluate(() => {
      const text = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      const advisor = document.querySelector('#agents .agent[data-id="advisor"]');
      const grok = document.querySelector('#agents .agent[data-id="grok"]');
      return {
        vw: window.innerWidth,
        touch: navigator.maxTouchPoints > 0,
        advisorTitle: text('#panel.open[data-agent="advisor"] h2'),
        advisorKicker: text('#panel.open[data-agent="advisor"] .kicker'),
        advisorRole: text('#panel.open[data-agent="advisor"] .role'),
        advisorChip: text('#roster .chip[data-id="advisor"] .cn'),
        advisorTag: text('#overlay .tag[data-id="advisor"] .nm'),
        grokChip: text('#roster .chip[data-id="grok"] .cn'),
        grokTag: text('#overlay .tag[data-id="grok"] .nm'),
        onMap: !!advisor,
        grokOnMap: !!grok,
        lang: !!document.querySelector('#agents .agent[data-id="lang"], #roster .chip[data-id="lang"], #overlay .tag[data-id="lang"]'),
        page: document.body.innerText,
      };
    });
    assert.equal(ui.vw, 1280);
    assert.equal(ui.advisorTitle, '10. Советник Путина');
    assert.equal(ui.advisorChip, '10. Советник Путина');
    assert.equal(ui.advisorTag, '10. Советник Путина');
    assert.match(ui.advisorKicker, /Кремль/);
    assert.match(ui.advisorRole, /стратегический советник Путина/i);
    assert.equal(ui.grokChip, '1. Путин');
    assert.equal(ui.grokTag, '1. Путин');
    assert.equal(ui.onMap, true);
    const advisorFig = await page.$('#agents .agent[data-id="advisor"] .fig-wrap');
    assert.ok(advisorFig);
    assert.equal(ui.grokOnMap, true);
    assert.equal(ui.lang, false);
    assert.doesNotMatch(ui.page, /Главный агент|Language Coach/);

    await page.click('#btnHier');
    await page.waitForSelector('#hier.open .org-card', { timeout: 4000 });
    const parentage = await page.evaluate(() => {
      const root = document.querySelector('#hTree > .org-item');
      const rootName = root.querySelector(':scope > .org-row .nm').textContent.replace(/\s+/g, ' ').trim();
      const kids = [...root.querySelectorAll(':scope > .org-kids > .org-item > .org-row .nm')].map((el) => el.textContent.replace(/\s+/g, ' ').trim());
      return { rootName, kids, text: document.querySelector('#hTree').textContent };
    });
    assert.equal(parentage.rootName, '1. Путин');
    assert.ok(parentage.kids.includes('10. Советник Путина'), parentage.kids.join(' | '));
    assert.doesNotMatch(parentage.text, /Language Coach|Главный агент/);

    await page.click('#roster .chip[data-id="grok"]');
    await page.waitForSelector('#panel.open[data-agent="grok"] #taskTarget', { timeout: 8000 });
    const target = await page.$eval('#taskTarget option[value="grok"]', (el) => el.textContent.trim());
    const advisorOption = await page.$eval('#taskTarget option[value="advisor"]', (el) => el.textContent.trim());
    const langOption = await page.$('#taskTarget option[value="lang"]');
    assert.equal(target, '1. Путину лично');
    assert.equal(advisorOption, '10. Советник Путина');
    assert.equal(langOption, null);
    const panelTitle = await page.$eval('#panel.open[data-agent="grok"] h2', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    assert.equal(panelTitle, '1. Путин');
  } finally {
    await page.close();
  }
});

test('страница вопроса архивного репетитора не показывает участника', { timeout: 45000 }, async () => {
  const created = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({
      what: 'Скрытый вопрос Language Coach',
      where: 'МГУ',
      fromAgentId: 'lang',
      urgency: 'low',
      answerable: true,
      details: 'Секрет урока LANG-PAGE',
    }),
  });
  assert.equal(created.status, 201);
  for (const viewport of [{ width: 390, height: 844, desktop: false }, { width: 1280, height: 800, desktop: true }]) {
    const page = await openPage(viewport, { path: `/needs/${created.body.id}`, desktop: viewport.desktop });
    try {
      await page.waitForFunction(() => (document.querySelector('#needTitle')?.textContent || '') === 'Пункт не найден', { timeout: 8000 });
      const view = await page.evaluate(() => ({
        vw: window.innerWidth,
        title: document.querySelector('#needTitle').textContent,
        who: document.querySelector('#needWho').textContent,
        formHidden: document.querySelector('#needAnswerForm').hidden,
        text: document.body.innerText,
      }));
      assert.equal(view.vw, viewport.width);
      assert.equal(view.title, 'Пункт не найден');
      assert.equal(view.who, '');
      assert.equal(view.formHidden, true);
      assert.doesNotMatch(view.text, /Language Coach|Секрет урока|LANG-PAGE|Ждёт:/);
    } finally {
      await page.close();
    }
  }
});

function moscowClock(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const hour = (parts.find((part) => part.type === 'hour') || {}).value;
  const minute = (parts.find((part) => part.type === 'minute') || {}).value;
  return `${hour}:${minute} МСК`;
}

test('страница вопроса с деталями показывает поле текста, а не «Да»/«Нет»', { timeout: 45000 }, async () => {
  const answer = 'отложить <img src=x onerror=alert(1)>';
  for (const viewport of [{ width: 390, height: 844, desktop: false }, { width: 1280, height: 800, desktop: true }]) {
    const page = await openPage(viewport, { path: '/needs/need-finance', desktop: viewport.desktop });
    try {
      if (!viewport.desktop) {
        await page.evaluate(() => localStorage.removeItem('appPassword'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
          const title = document.querySelector('#needTitle')?.textContent || '';
          const modal = document.querySelector('#modal')?.classList.contains('show');
          return modal && /финансовых вопросов/.test(title);
        }, { timeout: 8000 });
        assert.equal(await page.$eval('#needDetails', (el) => el.innerHTML), '');
        assert.equal(await page.$eval('#needAnswerForm', (el) => el.hidden), true);
        assert.equal(await page.evaluate(() => document.body.innerHTML.includes('Сколько отложить')), false);
        await page.type('#pwInput', 'pw-ui');
        await page.click('#pwForm button[type=submit]');
      }
      await page.waitForFunction(() => (document.querySelector('#needDetails')?.textContent || '').includes('Сколько отложить'), { timeout: 8000 });
      const view = await page.evaluate(() => {
        const pageEl = document.querySelector('#needPage');
        const link = document.querySelector('#needDetails a');
        const grok = document.querySelector('#needDetails .md-grok');
        const send = document.querySelector('#needSend');
        const sendBox = send.getBoundingClientRect();
        const area = document.querySelector('#needAnswer');
        return {
          vw: window.innerWidth,
          who: document.querySelector('#needWho').textContent,
          href: link ? link.getAttribute('href') : '',
          grokText: grok ? grok.textContent : '',
          grokLinks: document.querySelectorAll('a[href^="grokbot:"], a[href*="grokbot:"]').length,
          script: !!document.querySelector('#needDetails script'),
          html: document.querySelector('#needDetails').innerHTML,
          form: document.querySelector('#needAnswerForm').hidden,
          yesHidden: document.querySelector('#needYesNo').hidden,
          textHidden: document.querySelector('#needTextAnswer').hidden,
          area: area.tagName,
          send: send.textContent,
          sendH: sendBox.height,
          partial: document.querySelector('label[for="needPartial"]').textContent.replace(/\s+/g, ' ').trim(),
          overflow: pageEl.scrollWidth <= pageEl.clientWidth + 1,
          externalLink: !!document.querySelector('#needExternal a'),
        };
      });
      assert.equal(view.vw, viewport.width);
      assert.match(view.who, /7\.\s*Финансы/);
      assert.equal(view.href, 'https://example.com/budget');
      assert.equal(view.grokLinks, 0);
      assert.match(view.grokText, /чат агента/);
      assert.doesNotMatch(view.grokText, /grokbot:/);
      assert.doesNotMatch(view.grokText, /Grok/);
      assert.equal(view.script, false);
      assert.match(view.html, /&lt;script&gt;/);
      assert.equal(view.form, false);
      assert.equal(view.yesHidden, true);
      assert.equal(view.textHidden, false);
      assert.equal(view.area, 'TEXTAREA');
      assert.equal(view.send, 'Отправить');
      assert.ok(view.sendH >= 40, String(view.sendH));
      assert.equal(view.partial, 'Ответ частичный, оставить пункт открытым');
      assert.equal(view.overflow, true);
      assert.equal(view.externalLink, false);
      if (!viewport.desktop) {
        await page.type('#needAnswer', answer);
        await page.click('#needPartial');
        await page.click('#needSend');
        await page.waitForFunction(() => (document.querySelector('#needAnswerMsg')?.textContent || '').includes('Частичный ответ записан'), { timeout: 8000 });
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal(new URL(page.url()).pathname, '/needs/need-finance');
        const saved = await api('/api/needs/need-finance', { headers: { 'x-app-password': 'pw-ui' } });
        assert.equal(saved.body.closedAt, null);
        assert.equal(saved.body.answerMode, 'text');
        assert.equal(saved.body.answers.at(-1).text, answer);
        assert.equal(saved.body.answers.at(-1).by, 'owner');
        const shown = await page.evaluate(() => {
          const item = document.querySelector('.need-answer');
          return {
            html: item.innerHTML,
            text: item.querySelector('p').textContent,
            time: item.querySelector('time').textContent,
            img: !!item.querySelector('img'),
            form: document.querySelector('#needAnswerForm').hidden,
          };
        });
        assert.equal(shown.text, answer);
        assert.equal(shown.time, moscowClock(saved.body.answers.at(-1).at));
        assert.match(shown.html, /&lt;img/);
        assert.equal(shown.img, false);
        assert.equal(shown.form, false);
        const task = (await api('/api/state', { headers: { 'x-app-password': 'pw-ui' } })).body.tasks
          .find((item) => item.agent === 'finance' && item.text.includes(answer));
        assert.equal(task.text, `Ответ Арсения на «Ответить на шесть финансовых вопросов»: ${answer}`);
        const pub = (await api('/api/state')).body.needs.find((item) => item.id === 'need-finance');
        assert.equal(pub.answers, undefined);
        assert.equal(pub.details, undefined);
      } else {
        await page.waitForFunction(() => (document.querySelector('.need-answer p')?.textContent || '').includes('отложить'), { timeout: 8000 });
        const shown = await page.$eval('.need-answer time', (el) => el.textContent);
        assert.match(shown, /^\d{2}:\d{2} МСК$/);
      }
    } finally {
      await page.close();
    }
  }
});

test('одобрение показывает только «Да» и «Нет»', { timeout: 30000 }, async () => {
  const created = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({
      what: 'Одобрить черновик страницы',
      where: 'Сайт',
      fromAgentId: 'blog',
      urgency: 'low',
      kind: 'approval',
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.answerMode, 'yesno');
  for (const viewport of [{ width: 390, height: 844, desktop: false }, { width: 1280, height: 800, desktop: true }]) {
    const page = await browser.newPage();
    try {
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        isMobile: !viewport.desktop,
        hasTouch: !viewport.desktop,
        deviceScaleFactor: 1,
      });
      await page.evaluateOnNewDocument(() => localStorage.setItem('appPassword', 'pw-ui'));
      await page.goto(`${base}/needs/${created.body.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#needYesNo:not([hidden])', { timeout: 8000 });
      const view = await page.evaluate(() => ({
        vw: window.innerWidth,
        yes: document.querySelector('#needYes').textContent,
        no: document.querySelector('#needNo').textContent,
        textHidden: document.querySelector('#needTextAnswer').hidden,
        area: document.querySelector('#needAnswer').getBoundingClientRect().height,
      }));
      assert.equal(view.vw, viewport.width);
      assert.equal(view.yes, 'Да');
      assert.equal(view.no, 'Нет');
      assert.equal(view.textHidden, true);
      assert.equal(view.area, 0);
    } finally {
      await page.close();
    }
  }
});

test('после «Да» страница возвращает на карту, закрытый пункт без кнопок и повтор — 409', { timeout: 30000 }, async () => {
  const qa = state.needs.find((item) => item.id === 'need-test-qa');
  qa.closedAt = null;
  qa.closedBy = null;
  qa.answerStatus = null;
  qa.answer = null;
  qa.answers = [];
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => localStorage.removeItem('appPassword'));
    await page.goto(`${base}/needs/need-test-qa`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#needYesNo:not([hidden])', { timeout: 8000 });
    assert.equal(await page.$eval('#needTextAnswer', (el) => el.hidden), true);
    assert.equal(await page.$('#modal.show'), null);
    await page.click('#needYes');
    await page.waitForFunction(() => document.querySelector('#needAnswerMsg')?.textContent === 'Ответ записан', { timeout: 8000 });
    assert.equal(await page.$eval('#needAnswerForm', (el) => el.hidden), true);
    assert.match(page.url(), /\/needs\/need-test-qa$/);
    const shown = Date.now();
    await page.waitForFunction(() => location.pathname === '/', { timeout: 5000 });
    const elapsed = Date.now() - shown;
    assert.ok(elapsed >= 1500, String(elapsed));
    assert.ok(elapsed < 4500, String(elapsed));
    await page.waitForSelector('#needsList [data-id="need-social"]', { timeout: 8000 });
    assert.equal(await page.$('#needsList [data-id="need-test-qa"]'), null);
    const listed = await api('/api/needs');
    assert.equal(listed.body.needs.some((item) => item.id === 'need-test-qa'), false);
  } finally {
    await page.close();
  }

  const before = await api('/api/needs/need-test-qa');
  assert.equal(before.body.answer, 'yes');
  assert.equal(before.body.closedBy, 'owner-answer');
  assert.ok(before.body.closedAt);
  const again = await api('/api/needs/need-test-qa/answer', {
    method: 'POST',
    body: JSON.stringify({ answer: 'no' }),
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'Пункт уже закрыт');
  const after = await api('/api/needs/need-test-qa');
  assert.equal(after.body.closedAt, before.body.closedAt);
  assert.equal(after.body.closedBy, 'owner-answer');
  assert.equal(after.body.answer, 'yes');

  const closed = await browser.newPage();
  try {
    await closed.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await closed.goto(`${base}/needs/need-test-qa`, { waitUntil: 'domcontentloaded' });
    await closed.waitForFunction(() => (document.querySelector('.need-answer p')?.textContent || '') === 'Да', { timeout: 8000 });
    const view = await closed.evaluate(() => {
      const visible = [...document.querySelectorAll('#needPage button')].filter((btn) => {
        if (btn.closest('[hidden]')) return false;
        const box = btn.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      return {
        form: document.querySelector('#needAnswerForm').hidden,
        yes: document.querySelector('#needYesNo').hidden,
        text: document.querySelector('#needTextAnswer').hidden,
        buttons: visible.map((btn) => btn.textContent),
        answer: document.querySelector('.need-answer p').textContent,
        time: document.querySelector('.need-answer time').textContent,
        back: document.querySelector('.need-back').getAttribute('href'),
        backText: document.querySelector('.need-back').textContent,
      };
    });
    assert.equal(view.form, true);
    assert.equal(view.yes, true);
    assert.equal(view.text, true);
    assert.deepEqual(view.buttons, []);
    assert.equal(view.answer, 'Да');
    assert.equal(view.time, moscowClock(before.body.answeredAt || before.body.answers.at(-1).at));
    assert.equal(view.back, '/');
    assert.match(view.backText, /Кремль/);
  } finally {
    await closed.close();
  }
});

test('частичный текстовый тест копится и не уходит с страницы', { timeout: 30000 }, async () => {
  const question = state.needs.find((item) => item.id === 'need-test-question');
  question.closedAt = null;
  question.closedBy = null;
  question.answerStatus = null;
  question.answers = [];
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => localStorage.removeItem('appPassword'));
    await page.goto(`${base}/needs/need-test-question`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#needTextAnswer:not([hidden])', { timeout: 8000 });
    assert.equal(await page.$eval('#needYesNo', (el) => el.hidden), true);
    assert.equal(await page.$('#modal.show'), null);
    assert.equal(await page.$eval('#needTitle', (el) => el.textContent), 'ТЕСТ: вопрос с ответом текстом');
    await page.type('#needAnswer', 'первая часть');
    await page.click('#needPartial');
    await page.click('#needSend');
    await page.waitForFunction(() => (document.querySelector('#needAnswerMsg')?.textContent || '').includes('Частичный ответ записан'), { timeout: 8000 });
    await page.type('#needAnswer', 'вторая часть');
    await page.click('#needPartial');
    await page.click('#needSend');
    await page.waitForFunction(() => document.querySelectorAll('.need-answer').length === 2, { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(new URL(page.url()).pathname, '/needs/need-test-question');
    const texts = await page.$$eval('.need-answer p', (els) => els.map((el) => el.textContent));
    assert.deepEqual(texts, ['первая часть', 'вторая часть']);
    const saved = await api('/api/needs/need-test-question');
    assert.equal(saved.body.closedAt, null);
    assert.equal(saved.body.answers.length, 2);
    assert.equal((await api('/api/state')).body.tasks.some((item) => String(item.text || '').includes('первая часть')), false);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#needsList [data-id="need-social"]', { timeout: 8000 });
    assert.equal(await page.$('#needsList .needs-test'), null);
    assert.equal(await page.$('#needsList [data-id="need-test-question"]'), null);
    assert.doesNotMatch(await page.$eval('#needsList', (el) => el.textContent), /ТЕСТ:/);
    const badge = await page.$eval('#needsBadge', (el) => el.textContent.trim());
    const shown = await page.$$eval('#needsList > .need-item', (els) => els.length);
    assert.equal(badge, String(shown));
  } finally {
    await page.close();
  }
});

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/fonts\.(googleapis|gstatic)|favicon|ERR_FAILED/i.test(text)) return;
    errors.push(text);
  });
  return errors;
}

async function quietPage(viewport) {
  const page = await browser.newPage();
  const errors = trackErrors(page);
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    isMobile: viewport.width <= 700,
    hasTouch: viewport.width <= 700,
    deviceScaleFactor: 1,
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('journal', 'collapsed');
  });
  await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#agents .agent[data-id="finance"]', { timeout: 8000 });
  await page.waitForSelector('#roster .chip[data-id="finance"]', { timeout: 8000 });
  return { page, errors };
}

async function openFinanceRoom(page) {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const point = await hitAgent(page, 'finance');
      await page.mouse.click(point.x, point.y);
      try {
        await page.waitForSelector('#room.open', { timeout: 1500 });
        return;
      } catch (_) { /* точка могла уехать вместе с камерой */ }
    }
  } catch (_) { /* здание за краем экрана: откроем табличку */ }
  await page.evaluate(() => {
    const tag = document.querySelector('#overlay .tag[data-id="finance"]');
    if (tag) tag.click();
  });
  await page.waitForSelector('#room.open', { timeout: 3000 });
}

async function hitAgent(page, id) {
  for (let step = 0; step < 8; step += 1) {
    const found = await page.evaluate((agentId) => {
      const g = document.querySelector(`#agents .agent[data-id="${agentId}"]`);
      if (!g) return null;
      const r = g.getBoundingClientRect();
      for (let y = r.top + 4; y < r.bottom - 2; y += 8) {
        for (let x = r.left + 4; x < r.right - 2; x += 8) {
          if (x < 6 || y < 6 || x > innerWidth - 6 || y > innerHeight - 6) continue;
          const el = document.elementFromPoint(x, y);
          if (el && g.contains(el)) return { x, y };
        }
      }
      return { miss: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }, id);
    if (found && !found.miss) return found;
    const vw = page.viewport().width;
    const vh = page.viewport().height;
    await page.mouse.move(vw / 2, Math.min(vh / 2, vh - 180));
    await page.mouse.down();
    await page.mouse.move(found.cx < vw / 2 ? vw - 40 : 40, found.cy < vh / 2 ? vh - 180 : 140, { steps: 8 });
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`здание ${id} не попало на экран`);
}

function overlaps(a, b) {
  const gap = 1;
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

test('помещения, лента, подсказка, бейдж и зазоры', { timeout: 120000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { page, errors } = await quietPage(viewport);
    try {
      const boxes = await page.evaluate(() => {
        const read = (el, kind) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.id, kind, x: r.left, y: r.top, w: r.width, h: r.height };
        };
        const agents = [...document.querySelectorAll('#agents .agent')].map((el) => read(el, 'b'));
        const tags = [...document.querySelectorAll('#overlay .tag:not(.hide)')].map((el) => read(el, 't'));
        const chips = [...document.querySelectorAll('#roster .chip')].map((el) => el.dataset.id);
        return { agents, tags, chips };
      });
      const bad = [];
      const all = [...boxes.agents, ...boxes.tags];
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          if (all[i].id === all[j].id) continue;
          if (overlaps(all[i], all[j])) bad.push(`${all[i].id}/${all[i].kind}×${all[j].id}/${all[j].kind}`);
        }
      }
      assert.deepEqual(bad, [], `${viewport.width}: ${bad.join(', ')}`);
      assert.equal(boxes.agents.some((b) => b.id === 'invest' || b.id === 'analyst'), false);
      assert.equal(boxes.agents.some((b) => b.id === 'trading' || b.id === 'biz'), false);
      assert.equal(boxes.chips.includes('invest'), false);
      assert.equal(boxes.chips.includes('analyst'), false);
      assert.equal(boxes.chips.includes('advisor'), true);
      assert.ok(boxes.chips.includes('finance') && boxes.chips.includes('grok'));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }

  const desk = await quietPage({ width: 1280, height: 800 });
  try {
    const point = await hitAgent(desk.page, 'finance');
    await desk.page.mouse.move(point.x, point.y);
    await desk.page.waitForFunction(() => {
      const tip = document.querySelector('#tooltip');
      const text = tip ? tip.textContent : '';
      return tip && tip.classList.contains('show') && /Заместители:\s*3/.test(text) && /Инвестиции/.test(text) && /Бизнес-аналитик/.test(text) && /Темщик/.test(text) && !/Трейдинг/.test(text) && !/Business Adviser/.test(text);
    }, { timeout: 4000 });
    assert.equal(await desk.page.$eval('#room', (el) => el.classList.contains('open')), false);
    await desk.page.mouse.click(point.x, point.y);
    await desk.page.waitForSelector('#room.open .room-seat[data-id="finance"]', { timeout: 4000 });
    await desk.page.waitForSelector('#room.open .room-seat[data-id="invest"]');
    await desk.page.waitForSelector('#room.open .room-seat[data-id="analyst"]');
    const seats = await desk.page.$$eval('#room .room-seat', (els) => els.map((el) => el.dataset.id));
    assert.deepEqual(seats, ['finance', 'invest', 'analyst', 'temshik']);
    await desk.page.click('#room .room-go[data-id="invest"]');
    await desk.page.waitForSelector('#panel.open[data-agent="invest"]', { timeout: 8000 });
    assert.equal(await desk.page.$eval('#room', (el) => el.classList.contains('open')), false);
    await desk.page.click('#pClose');
    await desk.page.waitForFunction(() => !document.querySelector('#panel').classList.contains('open'));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await openFinanceRoom(desk.page);
    await desk.page.click('#roomX');
    await desk.page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));

    await openFinanceRoom(desk.page);
    await desk.page.keyboard.press('Escape');
    await desk.page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));

    await openFinanceRoom(desk.page);
    await desk.page.mouse.click(8, 8);
    await desk.page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));

    const poker = await hitAgent(desk.page, 'poker');
    await desk.page.mouse.move(poker.x, poker.y);
    await desk.page.waitForFunction(() => /Заместителей нет/.test(document.querySelector('#tooltip')?.textContent || ''), { timeout: 4000 });
    assert.deepEqual(desk.errors, []);
  } finally {
    await desk.page.close();
  }

  const phone = await quietPage({ width: 390, height: 844 });
  try {
    const point = await hitAgent(phone.page, 'finance');
    await phone.page.touchscreen.touchStart(point.x, point.y);
    await phone.page.waitForFunction(() => {
      const tip = document.querySelector('#tooltip');
      const text = tip ? tip.textContent : '';
      return tip && tip.classList.contains('show') && /Заместители:\s*3/.test(text) && /Инвестиции/.test(text) && /Бизнес-аналитик/.test(text) && /Темщик/.test(text) && !/Трейдинг/.test(text) && !/Business Adviser/.test(text);
    }, { timeout: 4000 });
    assert.equal(await phone.page.$eval('#room', (el) => el.classList.contains('open')), false);
    await phone.page.touchscreen.touchEnd();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await phone.page.$eval('#room', (el) => el.classList.contains('open')), false);

    await phone.page.touchscreen.tap(point.x, point.y);
    await phone.page.waitForSelector('#room.open .room-seat[data-id="analyst"]', { timeout: 4000 });
    const fit = await phone.page.evaluate(() => {
      const sheet = document.querySelector('.room-sheet').getBoundingClientRect();
      const seats = [...document.querySelectorAll('.room-seat')].map((el) => el.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < seats.length; i += 1) {
        for (let j = i + 1; j < seats.length; j += 1) {
          const a = seats[i], b = seats[j];
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) overlap = true;
        }
      }
      return {
        w: Math.round(sheet.width),
        h: Math.round(sheet.height),
        overlap,
        scroll: ['auto', 'scroll'].includes(getComputedStyle(document.querySelector('.room-scroll')).overflowY),
      };
    });
    assert.equal(fit.w, 390);
    assert.equal(fit.h, 844);
    assert.equal(fit.overlap, false);
    assert.equal(fit.scroll, true);
    await phone.page.click('#roomX');
    await phone.page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));
    assert.deepEqual(phone.errors, []);
  } finally {
    await phone.page.close();
  }

  const marked = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ agent: 'invest', status: 'working', now: 'Смотрю долю кэша' }),
  });
  assert.equal(marked.status, 200);
  const advised = await api('/api/status', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ agent: 'advisor', status: 'working', now: 'Готовлю сводку' }),
  });
  assert.equal(advised.status, 200);
  const investNeed = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ what: 'Подпись инвестиционной записки', where: 'Портфель', fromAgentId: 'invest', urgency: 'normal' }),
  });
  assert.equal(investNeed.status, 201);
  const analystNeed = await api('/api/needs', {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-ui' },
    body: JSON.stringify({ what: 'Сверить юнит-экономику', where: 'Модель', fromAgentId: 'analyst', urgency: 'high' }),
  });
  assert.equal(analystNeed.status, 201);
  const needs = await api('/api/needs');
  const openFor = (id) => needs.body.needs.filter((n) => !n.closedAt && n.fromAgentId === id).length;
  const sum = openFor('finance') + openFor('invest') + openFor('analyst');
  assert.ok(sum > openFor('finance'));

  const watch = await quietPage({ width: 1280, height: 800 });
  try {
    await watch.page.waitForFunction((expected) => {
      const map = document.querySelector('#overlay .await-you[data-id="finance"] .await-you-count');
      const roster = document.querySelector('#roster .chip[data-id="finance"] .await-you .await-you-count');
      return map && roster && map.textContent === expected && roster.textContent === expected;
    }, { timeout: 12000 }, String(sum));
    await watch.page.waitForFunction(() => {
      const finance = document.querySelector('#roster .chip[data-id="finance"]');
      const grok = document.querySelector('#roster .chip[data-id="grok"]');
      const advisor = document.querySelector('#roster .chip[data-id="advisor"]');
      if (!finance || !grok || !advisor) return false;
      const leaked = [...document.querySelectorAll('#roster .chip-event')].map((el) => el.textContent.trim()).join('');
      return leaked === ''
        && !grok.innerText.includes('Готовлю сводку')
        && !finance.innerText.includes('Смотрю долю кэша');
    }, { timeout: 12000 });
    assert.deepEqual(watch.errors, []);
  } finally {
    await watch.page.close();
  }
});

function ariaWarnings(page) {
  const notes = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/aria-hidden/i.test(text)) notes.push(text);
  });
  return notes;
}

async function focusHidden(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return '';
    let node = active;
    while (node && node !== document.documentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return node.id || node.getAttribute('class') || node.tagName;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return node.id || node.getAttribute('class') || node.tagName;
      node = node.parentElement;
    }
    return '';
  });
}

test('фокус уходит из попапа и помещения до aria-hidden', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage();
    const notes = ariaWarnings(page);
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.width <= 700,
      hasTouch: viewport.width <= 700,
      deviceScaleFactor: 1,
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.removeItem('needsSnoozeUntil');
      localStorage.setItem('journal', 'collapsed');
    });
    try {
      await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#roster .chip[data-id="finance"]', { timeout: 8000 });
      await page.waitForFunction(() => (document.querySelector('#needsList')?.textContent || '').length > 2, { timeout: 8000 });
      if (!await page.$('#needsPop.open')) {
        await page.click('#btnNeeds');
        await page.waitForSelector('#needsPop.open', { timeout: 4000 });
      }
      await page.click('#needsClose');
      await page.waitForFunction(() => !document.querySelector('#needsPop').classList.contains('open'));
      assert.deepEqual(notes, [], `${viewport.width} needs: ${notes.join(' | ')}`);
      assert.equal(await focusHidden(page), '', `${viewport.width} фокус внутри скрытого блока после «Нужно от вас»`);
      const needsFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(needsFocus, 'btnNeeds');

      await openFinanceRoom(page);
      await page.waitForSelector('#room.open .room-go[data-id="finance"]', { timeout: 4000 });
      await page.click('#room.open .room-go[data-id="finance"]');
      await page.waitForSelector('#panel.open[data-agent="finance"] #pClose', { timeout: 8000 });
      await page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));
      assert.deepEqual(notes, [], `${viewport.width} room: ${notes.join(' | ')}`);
      assert.equal(await focusHidden(page), '', `${viewport.width} фокус внутри скрытого блока после «Открыть»`);
      const roomFocus = await page.evaluate(() => {
        const active = document.activeElement;
        const panel = document.querySelector('#panel');
        return {
          id: active && active.id,
          inPanel: !!(active && panel && panel.contains(active)),
          inRoom: !!(active && document.querySelector('#room')?.contains(active)),
        };
      });
      assert.equal(roomFocus.inRoom, false);
      assert.equal(roomFocus.inPanel, true, JSON.stringify(roomFocus));
      assert.equal(roomFocus.id, 'pClose');
    } finally {
      await page.close();
    }
  }
});

test('фокус после панели и помещения возвращается к тому, кто открыл', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage();
    const notes = ariaWarnings(page);
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.width <= 700,
      hasTouch: viewport.width <= 700,
      deviceScaleFactor: 1,
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      localStorage.setItem('journal', 'collapsed');
      localStorage.removeItem('agentBar');
    });
    try {
      await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#roster .chip[data-id="finance"]', { timeout: 8000 });
      await page.$eval('#roster .chip[data-id="finance"]', (el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
      await page.click('#roster .chip[data-id="finance"]');
      await page.waitForFunction(() => {
        const panel = document.querySelector('#panel.open[data-agent="finance"]');
        const btn = panel && panel.querySelector('#pClose');
        if (!btn || panel.inert || panel.getAttribute('aria-hidden') === 'true') return false;
        if (getComputedStyle(panel).transform !== 'none') return false;
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) return false;
        const hit = document.elementFromPoint(x, y);
        return !!(hit && (hit === btn || btn.contains(hit)));
      }, { timeout: 4000 });
      const closeAt = await page.$eval('#panel.open[data-agent="finance"] #pClose', (btn) => {
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(closeAt.x, closeAt.y);
      try {
        await page.waitForFunction(() => !document.querySelector('#panel').classList.contains('open'), { timeout: 4000 });
      } catch (err) {
        const state = await page.evaluate((point) => {
          const panel = document.querySelector('#panel');
          const btn = document.querySelector('#pClose');
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            open: !!(panel && panel.classList.contains('open')),
            transform: panel ? getComputedStyle(panel).transform : '',
            hit: hit ? `${hit.tagName}.${hit.className}#${hit.id}` : '',
            btn: !!btn,
          };
        }, closeAt);
        throw new Error(`${viewport.width} панель не закрылась: ${JSON.stringify(state)}; ${err.message}`);
      }
      const panelBack = await page.evaluate(() => {
        const panel = document.querySelector('#panel');
        const active = document.activeElement;
        return {
          inert: panel.inert,
          hidden: panel.getAttribute('aria-hidden'),
          open: panel.classList.contains('open'),
          focusId: active && active.dataset ? active.dataset.id : '',
          focusTag: active && active.tagName,
          inPanel: !!(active && panel.contains(active)),
          body: active === document.body,
        };
      });
      assert.equal(panelBack.inert, true, `${viewport.width} закрытая панель без inert`);
      assert.equal(panelBack.hidden, 'true');
      assert.equal(panelBack.open, false);
      assert.equal(panelBack.inPanel, false);
      assert.equal(panelBack.body, false);
      assert.equal(panelBack.focusTag, 'BUTTON');
      assert.equal(panelBack.focusId, 'finance', JSON.stringify(panelBack));
      assert.equal(await focusHidden(page), '', `${viewport.width} фокус внутри скрытого блока после панели`);
      assert.deepEqual(notes, [], `${viewport.width} panel: ${notes.join(' | ')}`);

      await page.evaluate(() => document.querySelector('#overlay .tag[data-id="finance"]').click());
      await page.waitForSelector('#room.open', { timeout: 4000 });
      await page.click('#roomX');
      await page.waitForFunction(() => !document.querySelector('#room').classList.contains('open'));
      const roomBack = await page.evaluate(() => {
        const active = document.activeElement;
        return {
          id: active && active.dataset ? active.dataset.id : '',
          cls: active && active.className ? String(active.className) : '',
          body: active === document.body,
          inRoom: !!(active && document.querySelector('#room')?.contains(active)),
        };
      });
      assert.equal(roomBack.body, false, `${viewport.width} фокус ушёл в body`);
      assert.equal(roomBack.inRoom, false);
      assert.equal(roomBack.id, 'finance', JSON.stringify(roomBack));
      assert.match(roomBack.cls, /tag/);
      assert.equal(await focusHidden(page), '');
      assert.deepEqual(notes, [], `${viewport.width} room: ${notes.join(' | ')}`);
    } finally {
      await page.close();
    }
  }
});

test('нижняя панель агентов сворачивается и помнит состояние', { timeout: 90000 }, async () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' && !/fonts\.(googleapis|gstatic)|favicon|ERR_FAILED/i.test(text)) errors.push(text);
      if (/aria-hidden/i.test(text)) errors.push(text);
    });
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      isMobile: viewport.width <= 700,
      hasTouch: viewport.width <= 700,
      deviceScaleFactor: 1,
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('needsSnoozeUntil', String(Date.now() + 60 * 60 * 1000));
      localStorage.setItem('journal', 'collapsed');
      if (!sessionStorage.getItem('agentBarReady')) {
        localStorage.removeItem('agentBar');
        sessionStorage.setItem('agentBarReady', '1');
      }
    });
    try {
      await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#roster .chip[data-id="finance"]', { timeout: 8000 });
      await page.waitForFunction(() => document.querySelector('#needsBadge')?.textContent !== '', { timeout: 8000 });
      const toggle = '#agentBarToggle';
      await page.waitForSelector(toggle);
      const openMeta = await page.evaluate(() => {
        const btn = document.querySelector('#agentBarToggle');
        const bar = document.querySelector('#agentBar');
        return {
          tag: btn.tagName,
          type: btn.getAttribute('type'),
          expanded: btn.getAttribute('aria-expanded'),
          controls: btn.getAttribute('aria-controls'),
          label: btn.getAttribute('aria-label'),
          collapsed: bar.classList.contains('collapsed'),
          stored: localStorage.getItem('agentBar'),
        };
      });
      assert.equal(openMeta.tag, 'BUTTON');
      assert.equal(openMeta.type, 'button');
      assert.equal(openMeta.expanded, 'true');
      assert.equal(openMeta.controls, 'roster');
      assert.equal(openMeta.label, 'Свернуть панель агентов');
      assert.equal(openMeta.collapsed, false);
      assert.notEqual(openMeta.stored, 'collapsed');
      const tall = await page.$eval('#agentBar', (el) => el.getBoundingClientRect().height);

      await page.focus(toggle);
      const ring = await page.$eval(toggle, (el) => {
        const style = getComputedStyle(el);
        return { outline: style.outlineStyle, width: style.outlineWidth };
      });
      assert.notEqual(ring.outline, 'none', 'у шеврона не виден фокус');
      assert.notEqual(ring.width, '0px');
      await page.keyboard.press('Enter');
      await page.waitForFunction((limit) => {
        const bar = document.querySelector('#agentBar');
        return bar.classList.contains('collapsed') && bar.getBoundingClientRect().height < limit;
      }, { timeout: 2000 }, tall - 16);
      const folded = await page.evaluate(() => {
        const btn = document.querySelector('#agentBarToggle');
        const bar = document.querySelector('#agentBar');
        const peek = document.querySelector('#agentBarPeek');
        const roster = document.querySelector('#roster');
        const mini = document.querySelector('#minimap').getBoundingClientRect();
        const box = bar.getBoundingClientRect();
        const active = document.activeElement;
        let hidden = '';
        let node = active;
        while (node && node !== document.documentElement) {
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.inert) {
            hidden = node.id || node.getAttribute('class') || node.tagName;
            break;
          }
          node = node.parentElement;
        }
        const overlap = box.left < mini.right && box.right > mini.left && box.top < mini.bottom && box.bottom > mini.top;
        return {
          expanded: btn.getAttribute('aria-expanded'),
          label: btn.getAttribute('aria-label'),
          stored: localStorage.getItem('agentBar'),
          peek: peek && !peek.hidden,
          text: (peek && peek.textContent || '').replace(/\s+/g, ' ').trim(),
          count: document.querySelector('#agentBarAwait')?.textContent,
          badge: document.querySelector('#needsBadge')?.textContent.trim(),
          dots: document.querySelectorAll('#agentBarDots .agent-bar-dot').length,
          chips: document.querySelectorAll('#roster .chip').length,
          inert: roster.inert,
          focusId: active && active.id,
          hidden,
          height: box.height,
          overlap,
          box: { l: Math.round(box.left), r: Math.round(box.right), t: Math.round(box.top), b: Math.round(box.bottom), w: Math.round(box.width) },
          mini: { l: Math.round(mini.left), r: Math.round(mini.right), t: Math.round(mini.top), b: Math.round(mini.bottom) },
        };
      });
      assert.equal(folded.expanded, 'false');
      assert.equal(folded.label, 'Развернуть панель агентов');
      assert.equal(folded.stored, 'collapsed');
      assert.equal(folded.peek, true);
      assert.match(folded.text, /ждёт вас/);
      assert.equal(folded.count, folded.badge);
      assert.equal(folded.dots, folded.chips);
      assert.equal(folded.inert, true);
      assert.equal(folded.focusId, 'agentBarToggle');
      assert.equal(folded.hidden, '');
      assert.ok(folded.height < tall - 16, `полоска не стала ниже: ${folded.height} против ${tall}`);
      assert.equal(folded.overlap, false, `свёрнутая панель перекрыла мини-карту ${JSON.stringify({ box: folded.box, mini: folded.mini })}`);

      await page.keyboard.press(' ');
      await page.waitForFunction(() => !document.querySelector('#agentBar').classList.contains('collapsed'));
      assert.equal(await page.$eval(toggle, (el) => el.getAttribute('aria-expanded')), 'true');

      // Полоса раскрывается 280 мс. Клик по шеврону в это время попадает мимо кнопки.
      const waitBarStill = () => page.waitForFunction(() => {
        const bar = document.querySelector('#agentBar');
        const h = Math.round(bar.getBoundingClientRect().height);
        const now = performance.now();
        const prev = Number(bar.dataset.barH);
        const since = Number(bar.dataset.barT || 0);
        if (prev !== h) {
          bar.dataset.barH = String(h);
          bar.dataset.barT = String(now);
          return false;
        }
        return since > 0 && now - since >= 350;
      }, { timeout: 5000 });

      await waitBarStill();
      await page.click(toggle);
      await page.waitForFunction(() => document.querySelector('#agentBar').classList.contains('collapsed'));
      await waitBarStill();
      await page.click('#agentBarPeek');
      await page.waitForFunction(() => !document.querySelector('#agentBar').classList.contains('collapsed'));
      await waitBarStill();
      await page.click(toggle);
      await page.waitForFunction(() => localStorage.getItem('agentBar') === 'collapsed');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#agentBar.collapsed #agentBarAwait', { timeout: 8000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('agentBar')), 'collapsed');
      assert.equal(await page.$eval(toggle, (el) => el.getAttribute('aria-expanded')), 'false');
      assert.deepEqual(errors, [], `${viewport.width}: ${errors.join(' | ')}`);
    } finally {
      await page.close();
    }
  }
});
