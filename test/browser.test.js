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
    assert.match(treeText, /11\.\s*Соцсети/);
    assert.match(treeText, /12\.\s*Рутины/);
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
    assert.ok(Number(info.count) >= 3, info.count);
    assert.match(info.label, /Нужно от вас/);
    assert.equal(info.expanded, 'true');
    assert.equal(info.btnInView, true, 'бейдж не помещается в шапку');
    assert.equal(info.hierInView, true, 'кнопка иерархии уехала с экрана');
    assert.equal(info.notify, 'Включить уведомления');
    assert.equal(info.rowsFit, true, 'строка пункта обрезана');
    const text = info.items.map((i) => `${i.what} ${i.from} ${i.where} ${i.urg}`).join('\n');
    assert.doesNotMatch(text, /Ключ Render API/);
    assert.match(text, /Академию агентов/);
    assert.match(text, /Чаты агентов в Grok/);
    assert.match(text, /Instagram и YouTube/);
    assert.match(text, /Соцсети/);
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
    await page.waitForFunction(() => Number(document.querySelector('#needsBadge')?.textContent) >= 3, { timeout: 8000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#needsPop', (el) => el.classList.contains('open')), false);

    await page.click('#btnNeeds');
    await page.waitForSelector('#needsPop.open .need-item');
    await page.screenshot({ path: '/tmp/needs-390.png' });
  } finally {
    await page.close();
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
    await page.waitForFunction(() => /Готово|вебхук Grok не настроен/.test(document.querySelector('#formMsg')?.textContent || ''), { timeout: 15000 });
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
      return msg && /Готово|вебхук Grok не настроен/.test(msg.textContent);
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
    await page.waitForFunction(() => /Готово|вебхук Grok не настроен/.test(document.querySelector('#formMsg')?.textContent || ''), { timeout: 20000 });
    await page.waitForFunction(() => /image-3mb\.png/.test(document.querySelector('#panel').textContent || ''), { timeout: 8000 });
    const msg = await page.$eval('#formMsg', (el) => el.textContent);
    assert.match(msg, /Готово|вебхук Grok не настроен/);
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
      const placed = await page.evaluate(() => {
        const body = document.querySelector('#panel .p-body');
        const el = document.querySelector('#panel [data-anchor="awaits"]');
        const close = el.querySelector('.need-close');
        const br = body.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const cr = close.getBoundingClientRect();
        return {
          title: el.querySelector('h4').textContent,
          delta: r.top - br.top,
          visible: r.bottom > br.top && r.top < br.bottom,
          closeW: cr.width,
          closeH: cr.height,
          text: el.textContent,
        };
      });
      assert.match(placed.title, /Ждёт от вас/);
      assert.equal(placed.visible, true, JSON.stringify(placed));
      assert.ok(placed.delta < 28 && placed.delta > -2, JSON.stringify(placed));
      assert.match(placed.text, /финансовых вопросов/);
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
    assert.doesNotMatch(needsUi.text, /Трейдинг/);
    const froms = await page.$$eval('#needsList .need-from', (els) => els.map((el) => el.textContent));
    assert.ok(froms.every((text) => !/Трейдинг|Business Adviser/.test(text)), froms.join(' | '));
    const apiNeeds = await api('/api/needs');
    const visibleNeeds = apiNeeds.body.needs.filter((n) => n.fromAgentId !== 'trading' && n.fromAgentId !== 'biz');
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
