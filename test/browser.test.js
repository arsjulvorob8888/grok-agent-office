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
  await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
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
    assert.match(treeText, /8\.\s*Тестировщик ПО/);
    assert.match(treeText, /9\.\s*Technology Blog/);
    assert.match(treeText, /10\.\s*Language Coach/);
    assert.doesNotMatch(treeText, /Business Adviser/);
    assert.doesNotMatch(treeText, /Трейдинг/);
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

    const marked = await api('/api/status', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-ui' },
      body: JSON.stringify({ agent: 'dev', status: 'waiting', now: 'MARKER-NOW ждёт взгляд' }),
    });
    assert.equal(marked.status, 200);
    await page.waitForFunction(() => (document.querySelector('.status-line .now') || {}).textContent?.includes('MARKER-NOW'), { timeout: 10000 });
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
    assert.match(chain, /Главный агент/);
    assert.match(chain, /Тестировщик/);
    const hist = await page.$eval('#panel .order-hist', (el) => el.textContent);
    assert.match(hist, /отправлен/);
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
      return badge && badge.textContent.includes('в работе') && badge.querySelector('.ob-bar i');
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
      const items = [...document.querySelectorAll('#needsPop .need-item')].map((el) => ({
        what: el.querySelector('.need-what').textContent,
        from: el.querySelector('.need-from').textContent,
        where: el.querySelector('.need-where').textContent,
        urg: el.className,
      }));
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
        rowsFit: [...document.querySelectorAll('#needsPop .need-item')].every((el) => {
          const urg = el.querySelector('.need-urg').getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return el.scrollHeight <= el.clientHeight + 1 && urg.top >= box.top - 1 && urg.bottom <= box.bottom + 1;
        }),
      };
    });
    assert.equal(info.vw, 390);
    assert.ok(Number(info.count) >= 4, info.count);
    assert.match(info.label, /Нужно от вас/);
    assert.equal(info.expanded, 'true');
    assert.equal(info.btnInView, true, 'бейдж не помещается в шапку');
    assert.equal(info.hierInView, true, 'кнопка иерархии уехала с экрана');
    assert.equal(info.notify, 'Включить уведомления');
    assert.equal(info.rowsFit, true, 'строка пункта обрезана');
    const text = info.items.map((i) => `${i.what} ${i.from} ${i.where} ${i.urg}`).join('\n');
    assert.match(text, /Ключ Render API/);
    assert.match(text, /DevOps/);
    assert.match(text, /urg-high/);
    assert.match(text, /Академию агентов/);
    assert.match(text, /Instagram и YouTube/);
    assert.match(text, /финансовых вопросов/);
    assert.match(text, /Финансы/);
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
    await page.waitForFunction(() => Number(document.querySelector('#needsBadge')?.textContent) >= 4, { timeout: 8000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#needsPop', (el) => el.classList.contains('open')), false);

    await page.click('#btnNeeds');
    await page.waitForSelector('#needsPop.open .need-item');
    await page.screenshot({ path: '/tmp/needs-390.png' });
  } finally {
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
    assert.equal(ui.mapIds.includes('trading'), false);
    assert.equal(ui.mapIds.includes('biz'), false);
    assert.ok(ui.mapIds.includes('devops') && ui.mapIds.includes('finance') && ui.mapIds.includes('lang'));
    assert.doesNotMatch(ui.tagText, /Трейдинг|Business Adviser/);
    const chip = (id) => ui.chips.find((c) => c.id === id).text;
    assert.match(chip('grok'), /^1\./);
    assert.match(chip('army'), /^2\./);
    assert.match(chip('poker'), /^3\./);
    assert.match(chip('devops'), /^4\./);
    assert.match(chip('dev'), /^5\./);
    assert.match(chip('temshik'), /^6\./);
    assert.match(chip('finance'), /^7\./);
    assert.match(chip('invest'), /^7\.1/);
    assert.match(chip('analyst'), /^7\.2/);
    assert.match(chip('qa'), /^8\./);
    assert.match(chip('blog'), /^9\./);
    assert.match(chip('lang'), /^10\./);
    assert.equal(ui.options.some((o) => o.value === 'trading' || o.value === 'biz'), false);
    assert.match(ui.options.find((o) => o.value === 'devops').text, /^4\./);
    assert.match(ui.options.find((o) => o.value === 'invest').text, /7\.1/);
    assert.match(ui.options.find((o) => o.value === 'lang').text, /10\./);

    const needsUi = await page.evaluate(() => ({
      text: document.querySelector('#needsList').textContent,
      badge: document.querySelector('#needsBadge').textContent.trim(),
    }));
    assert.doesNotMatch(needsUi.text, /Архивный пункт трейдинга/);
    assert.doesNotMatch(needsUi.text, /Трейдинг|Business Adviser/);
    const apiNeeds = await api('/api/needs');
    const visibleNeeds = apiNeeds.body.needs.filter((n) => n.fromAgentId !== 'trading' && n.fromAgentId !== 'biz');
    assert.ok(apiNeeds.body.needs.some((n) => n.fromAgentId === 'trading'));
    assert.equal(needsUi.badge, String(visibleNeeds.length));

    await page.click('#btnHier');
    await page.waitForSelector('#hier.open .org-card', { timeout: 4000 });
    const treeText = await page.$eval('#hTree', (el) => el.textContent);
    assert.match(treeText, /7\.1\s*Инвестиции/);
    assert.match(treeText, /7\.2\s*Бизнес-аналитик/);
    assert.match(treeText, /10\.\s*Language Coach/);
    assert.doesNotMatch(treeText, /Трейдинг|Business Adviser/);

    const state = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
    assert.equal(state.agents.find((a) => a.id === 'trading').archived, true);
    assert.equal(state.agents.find((a) => a.id === 'biz').archived, true);
    assert.ok(state.messages.some((m) => m.id === 'ui-archive-trading' && m.text === 'История трейдинга на месте'));
    assert.ok(state.needs.some((n) => n.fromAgentId === 'trading' && n.what === 'Архивный пункт трейдинга'));
  } finally {
    await page.close();
  }
});
