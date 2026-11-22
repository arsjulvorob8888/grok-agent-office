'use strict';

// Карта: пульс, сон, стрелка делегирования и панель «Процессы сейчас».
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-activity-ui-'));
process.env.APP_PASSWORD = 'pw-aui';
process.env.AGENT_TOKEN = 'tok-aui';
process.env.AGENT_STATUS_TOKEN = 'status-aui';
process.env.GROK_WEBHOOK_URL = '';
process.env.GROK_WEBHOOK_KEY = '';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.AGENT_ACTIVE_MINUTES;
delete process.env.ACTIVITY_WINDOW_MIN;

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
    isMobile: !!extra.touch,
    hasTouch: !!extra.touch,
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function seedOrder(text, agent = 'dev') {
  const created = await api('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-aui' },
    body: JSON.stringify({ agent, text, fromAgentId: 'grok' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const accepted = await api(`/api/orders/${created.body.id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-aui' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  assert.equal(accepted.status, 200);
  const task = state.tasks.find((item) => item.id === created.body.id);
  if (task) task.forwardStatus = 200;
  return created.body.id;
}

async function finish(id) {
  const done = await api(`/api/orders/${id}`, {
    method: 'POST',
    headers: { 'x-agent-token': 'tok-aui' },
    body: JSON.stringify({ status: 'done', result: 'Закрыто в тесте' }),
  });
  assert.equal(done.status, 200);
}

async function waitReady(page, orderId) {
  await page.waitForFunction((id) => {
    const dev = document.querySelector('#agents .agent[data-id="dev"]');
    const poker = document.querySelector('#agents .agent[data-id="poker"]');
    const chipW = document.querySelector('#roster .chip[data-id="dev"]');
    const chipR = document.querySelector('#roster .chip[data-id="poker"]');
    const line = document.querySelector(`#delegations .deleg-line[data-order-id="${id}"]`);
    return dev && dev.classList.contains('pulse')
      && poker && poker.classList.contains('sleep')
      && chipW && chipW.classList.contains('pulse')
      && chipR && chipR.classList.contains('sleep')
      && line;
  }, { timeout: 10000 }, orderId);
}

test('на широком экране пульс, сон, стрелка и «Процессы сейчас»', { timeout: 60000 }, async () => {
  state.tasks.unshift({
    id: 't-archive-hide',
    agent: 'trading',
    agentId: 'trading',
    fromAgentId: 'biz',
    parentOrderId: null,
    text: 'ARCHIVE-HIDDEN старый приказ трейдинга',
    status: 'отправлена',
    orderStatus: 'in_progress',
    progress: 40,
    note: '',
    createdAt: '2026-01-02T00:00:00.000Z',
    forwardStatus: null,
    result: null,
    history: [],
    attachments: [],
    messageId: 'task:t-archive-hide',
  });
  const text = 'ACTIVITY-DESKTOP проверка процессов на карте штаба прямо сейчас';
  const id = await seedOrder(text);
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await waitReady(page, id);
    const caption = await page.$eval('#roster .chip[data-id="dev"] .chip-task', (el) => ({
      text: el.textContent,
      full: el.getAttribute('title') || '',
    }));
    assert.equal(caption.full, text);
    assert.ok(caption.text.length < text.length, caption.text);
    assert.match(caption.text, /ACTIVITY/);
    const zzz = await page.$eval('#roster .chip[data-id="poker"] .chip-zzz', (el) => getComputedStyle(el).display);
    assert.notEqual(zzz, 'none');
    const lineBox = await page.$eval(`#delegations .deleg-line[data-order-id="${id}"]`, (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, status: el.getAttribute('data-status') };
    });
    assert.equal(lineBox.status, 'accepted');
    assert.ok(lineBox.w > 8 && lineBox.h > 8, JSON.stringify(lineBox));

    const hit = await page.evaluate((orderId) => {
      const line = document.querySelector(`#delegations .deleg-hit[data-order-id="${orderId}"]`);
      const svg = line.ownerSVGElement;
      const len = line.getTotalLength();
      for (let i = 0; i <= 24; i += 1) {
        const p = line.getPointAtLength(len * (0.15 + (0.7 * i) / 24));
        const pt = svg.createSVGPoint();
        pt.x = p.x;
        pt.y = p.y;
        const s = pt.matrixTransform(line.getScreenCTM());
        const el = document.elementFromPoint(s.x, s.y);
        if (el && el.closest && el.closest(`#delegations [data-order-id="${orderId}"]`)) {
          return { x: s.x, y: s.y };
        }
      }
      return null;
    }, id);
    assert.ok(hit, 'по линии некуда нажать');
    if (page.mouse) await page.mouse.click(hit.x, hit.y);
    await page.waitForFunction((orderId) => document.body.dataset.openOrder === orderId && document.querySelector('#panel.open'), { timeout: 8000 }, id);
    const panelText = await page.$eval('#panel', (el) => el.textContent);
    assert.match(panelText, /ACTIVITY-DESKTOP/);

    await page.click('#btnProcesses');
    await page.waitForSelector('#processes.open .proc-row');
    const listed = await page.$eval('#processes', (el) => el.innerText);
    assert.match(listed, /Процессы сейчас/);
    assert.match(listed, /1\.\s*Путин/);
    assert.doesNotMatch(listed, /Главный агент/);
    assert.match(listed, /Программирование/);
    assert.match(listed, /ACTIVITY-DESKTOP/);
    assert.match(listed, /Принято/);
    assert.match(listed, /с \d{2}:\d{2} МСК · /);
    assert.doesNotMatch(listed, /ARCHIVE-HIDDEN/);
    assert.doesNotMatch(listed, /Трейдинг/);
    assert.equal(await page.$('#agents .agent[data-id="trading"]'), null);
    assert.equal(await page.$('#agents .agent[data-id="biz"]'), null);
    assert.equal(await page.$('#roster .chip[data-id="trading"]'), null);
    assert.equal(await page.$('#roster .chip[data-id="biz"]'), null);
    assert.equal(await page.$('.act-marker[data-id="trading"]'), null);
    assert.equal(await page.$('.act-marker[data-id="biz"]'), null);
    assert.equal(await page.$('#delegations [data-order-id="t-archive-hide"]'), null);
    const newcomers = await page.evaluate(() => {
      const cls = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.getAttribute('class') || '') : '';
      };
      return {
        social: cls('#roster .chip[data-id="social"]'),
        routines: cls('#agents .agent[data-id="routines"]'),
        socialMarker: cls('.act-marker[data-id="social"]'),
        routinesChip: cls('#roster .chip[data-id="routines"]'),
      };
    });
    assert.match(newcomers.social, /\bsleep\b/, newcomers.social);
    assert.match(newcomers.routines, /\bsleep\b/, newcomers.routines);
    assert.match(newcomers.socialMarker, /\bsleep\b/, newcomers.socialMarker);
    assert.match(newcomers.routinesChip, /\bsleep\b/, newcomers.routinesChip);
    await page.emulateTimezone('UTC');
    const stamp = await page.$eval('#procList .proc-elapsed', (el) => ({
      text: el.textContent,
      datetime: el.getAttribute('datetime'),
    }));
    assert.match(stamp.text, /^с \d{2}:\d{2} МСК · /);
    assert.doesNotMatch(stamp.text, /^\d+:\d{2}/);
    const expected = await page.evaluate((iso) => window.OfficeFeed.formatProcessStamp(iso, Date.now()), stamp.datetime);
    assert.equal(stamp.text, expected);

    await finish(id);
    await page.waitForFunction((orderId) => !document.querySelector(`#delegations [data-order-id="${orderId}"]`), { timeout: 10000 }, id);
    const gone = await page.$eval('#procList', (el) => el.textContent);
    assert.doesNotMatch(gone, /ACTIVITY-DESKTOP/);
  } finally {
    await page.close();
  }
});

test('на 390px с тачем линия видна, панель нажимается, движение можно убавить', { timeout: 60000 }, async () => {
  const text = 'ACTIVITY-MOBILE узкая проверка процессов и стрелки делегирования';
  const id = await seedOrder(text);
  const page = await openPage({ width: 390, height: 844 }, { touch: true });
  try {
    await waitReady(page, id);
    const metrics = await page.evaluate((orderId) => {
      const btn = document.querySelector('#btnProcesses').getBoundingClientRect();
      const line = document.querySelector(`#delegations .deleg-line[data-order-id="${orderId}"]`).getBoundingClientRect();
      const dev = document.querySelector('#agents .agent[data-id="dev"]');
      const poker = document.querySelector('#agents .agent[data-id="poker"]');
      return {
        btnW: btn.width,
        btnH: btn.height,
        btnRight: btn.right,
        lineW: line.width,
        lineH: line.height,
        lineTop: line.top,
        lineLeft: line.left,
        vw: window.innerWidth,
        vh: window.innerHeight,
        pulse: dev.classList.contains('pulse'),
        sleep: poker.classList.contains('sleep'),
      };
    }, id);
    assert.equal(metrics.vw, 390);
    assert.equal(metrics.pulse, true);
    assert.equal(metrics.sleep, true);
    assert.ok(metrics.btnW >= 40 && metrics.btnH >= 40, JSON.stringify(metrics));
    assert.ok(metrics.btnRight <= metrics.vw + 1, JSON.stringify(metrics));
    assert.ok(metrics.lineW > 8 && metrics.lineH > 8, JSON.stringify(metrics));
    assert.ok(metrics.lineTop < metrics.vh && metrics.lineLeft < metrics.vw, JSON.stringify(metrics));

    await page.tap('#btnProcesses');
    await page.waitForSelector('#processes.open .proc-row');
    const row = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#processes .proc-row')].find((node) => node.textContent.includes('ACTIVITY-MOBILE'));
      const r = el.getBoundingClientRect();
      return { h: r.height, w: r.width, text: el.innerText, x: r.left + Math.min(r.width / 2, 120), y: r.top + Math.min(24, r.height / 2) };
    });
    assert.ok(row.h >= 40 && row.w >= 40, JSON.stringify(row));
    assert.match(row.text, /ACTIVITY-MOBILE/);
    assert.match(row.text, /→/);
    await page.touchscreen.tap(row.x, row.y);
    await page.waitForFunction((orderId) => document.body.dataset.openOrder === orderId && document.querySelector('#panel.open'), { timeout: 8000 }, id);

    const quiet = await openPage({ width: 390, height: 844 }, { touch: true, reduced: true });
    try {
      await quiet.waitForSelector(`#delegations .deleg-line[data-order-id="${id}"]`, { timeout: 10000 });
      const motion = await quiet.$eval(`#delegations .deleg-line[data-order-id="${id}"]`, (el) => getComputedStyle(el).animationName);
      const ring = await quiet.$eval('#agents .agent.pulse .pulse-ring', (el) => getComputedStyle(el).animationName);
      assert.equal(motion, 'none');
      assert.equal(ring, 'none');
    } finally {
      await quiet.close();
    }

    await finish(id);
    await page.waitForFunction((orderId) => !document.querySelector(`#delegations [data-order-id="${orderId}"]`), { timeout: 10000 }, id);
    const devSleep = await page.$eval('#agents .agent[data-id="dev"]', (el) => el.classList.contains('sleep'));
    assert.equal(devSleep, false);
  } finally {
    await page.close();
  }
});

test('живой working виден на карте быстрее чем за 3 секунды', { timeout: 60000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="blog"]');
      const chip = document.querySelector('#roster .chip[data-id="blog"]');
      return fig && fig.classList.contains('sleep')
        && chip && chip.classList.contains('sleep')
        && window.LiveStream && LiveStream.connected();
    }, { timeout: 10000 });
    const started = Date.now();
    const posted = await api('/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-aui' },
      body: JSON.stringify({ agentId: 'Technology Blog · Кремль', status: 'working', doing: 'Черчу схему' }),
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="blog"]');
      const chip = document.querySelector('#roster .chip[data-id="blog"]');
      return fig && fig.classList.contains('pulse') && chip && chip.classList.contains('pulse');
    }, { timeout: 3000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `карта обновилась за ${elapsed} мс`);
    const chipTitle = await page.$eval('#roster .chip[data-id="blog"]', (el) => el.getAttribute('title') || '');
    assert.match(chipTitle, /чем занят/);
    assert.match(chipTitle, /Черчу схему/);
    await page.$eval('#roster .chip[data-id="blog"]', (el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await page.click('#roster .chip[data-id="blog"]');
    await page.waitForSelector('#panel.open .status-line .now');
    const line = await page.$eval('#panel .status-line', (el) => el.innerText);
    assert.match(line, /чем занят/);
    assert.match(line, /Черчу схему/);
    assert.match(line, /уже/);
  } finally {
    await page.close();
  }
});

test('классы яркости: idle, working и coordinating на здании и аватарке', { timeout: 60000 }, async () => {
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="poker"]');
      const chip = document.querySelector('#roster .chip[data-id="poker"]');
      return fig && fig.classList.contains('act-idle') && chip && chip.classList.contains('act-idle');
    }, { timeout: 10000 });
    const idleLook = await page.$eval('#agents .agent[data-id="poker"] .fig-wrap', (el) => {
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, filter: cs.filter };
    });
    assert.ok(Math.abs(Number(idleLook.opacity) - 0.55) < 0.05, JSON.stringify(idleLook));
    assert.match(String(idleLook.filter), /grayscale|0\.4/);

    const posted = await api('/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-aui' },
      body: JSON.stringify({ agentId: 'poker', status: 'working', doing: 'Считаю эквити' }),
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="poker"]');
      const chip = document.querySelector('#roster .chip[data-id="poker"]');
      return fig && fig.classList.contains('act-working')
        && chip && chip.classList.contains('act-working')
        && !fig.classList.contains('act-idle')
        && !chip.classList.contains('act-idle');
    }, { timeout: 3000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#agents .agent[data-id="poker"] .fig-wrap');
      return el && Math.abs(parseFloat(getComputedStyle(el).opacity) - 1) < 0.05;
    }, { timeout: 2000 });

    const task = await api('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-aui' },
      body: JSON.stringify({ agent: 'social', text: 'Старый приказ для координации', fromAgentId: 'grok' }),
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const queued = (state.outbox || []).find((item) => item.taskId === task.body.id);
    if (queued) queued.status = 'delivered';
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const grok = state.agents.find((agent) => agent.id === 'grok');
    grok.live = null;
    grok.lastSeenAt = null;
    grok.lastStatusAt = null;
    grok.lastDashboardAt = null;
    grok.heartbeatNote = '';
    for (const item of state.tasks) {
      if (item.fromAgentId === 'grok' || item.agentId === 'grok' || item.agent === 'grok') {
        item.createdAt = old;
        for (const step of item.history || []) step.at = old;
      }
    }
    for (const message of state.messages) {
      if (message.agentId === 'grok' || message.fromAgentId === 'grok') message.createdAt = old;
    }
    const child = await api('/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-aui' },
      body: JSON.stringify({ agentId: 'social', status: 'working', doing: 'Веду приказ' }),
    });
    assert.equal(child.status, 200, JSON.stringify(child.body));
    await page.waitForFunction(() => {
      const fig = document.querySelector('#agents .agent[data-id="grok"]');
      const chip = document.querySelector('#roster .chip[data-id="grok"]');
      const social = document.querySelector('#agents .agent[data-id="social"]');
      return fig && fig.classList.contains('act-coordinating')
        && chip && chip.classList.contains('act-coordinating')
        && social && social.classList.contains('act-working');
    }, { timeout: 5000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#agents .agent[data-id="grok"] .fig-wrap');
      const style = el ? getComputedStyle(el) : null;
      return style && Math.abs(parseFloat(style.opacity) - 1) < 0.05 && !/grayscale/.test(style.filter);
    }, { timeout: 2000 });
    const clickable = await page.$eval('#agents .agent[data-id="poker"]', (el) => getComputedStyle(el).pointerEvents);
    assert.notEqual(clickable, 'none');
  } finally {
    await page.close();
  }
});

test('неактивный спящий чип серый, а reduced-motion гасит переход', { timeout: 30000 }, async () => {
  const poker = state.agents.find((agent) => agent.id === 'poker');
  if (poker) poker.live = null;
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const chip = document.querySelector('#roster .chip[data-id="poker"]');
      return chip && chip.classList.contains('sleep') && chip.classList.contains('act-idle');
    }, { timeout: 10000 });
    const look = await page.$eval('#roster .chip[data-id="poker"] .av', (el) => {
      const style = getComputedStyle(el);
      return { filter: style.filter, opacity: style.opacity };
    });
    assert.match(String(look.filter), /grayscale\(0?\.4\)/, JSON.stringify(look));
    assert.ok(Math.abs(Number(look.opacity) - 0.55) < 0.05, JSON.stringify(look));
  } finally {
    await page.close();
  }

  const quiet = await openPage({ width: 1280, height: 800 }, { reduced: true });
  try {
    await quiet.waitForSelector('#roster .chip.sleep.act-idle .av', { timeout: 10000 });
    const motion = await quiet.$eval('#roster .chip.sleep.act-idle .av', (el) => {
      const style = getComputedStyle(el);
      return { property: style.transitionProperty, duration: style.transitionDuration, filter: style.filter };
    });
    assert.ok(motion.property === 'none' || motion.duration === '0s', JSON.stringify(motion));
    assert.match(String(motion.filter), /grayscale\(0?\.4\)/, JSON.stringify(motion));
  } finally {
    await quiet.close();
  }
});

test('зелёная точка совпадает с яркостью фигурки, здания и полосы', { timeout: 30000 }, async () => {
  for (const id of ['health', 'social']) {
    const posted = await api('/api/agent-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer status-aui' },
      body: JSON.stringify({ agentId: id, status: 'working', doing: 'На линии' }),
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
  }
  const page = await openPage({ width: 1280, height: 800 });
  try {
    await page.waitForFunction(() => {
      const health = document.querySelector('#agents .agent[data-id="health"]');
      const poker = document.querySelector('#agents .agent[data-id="poker"]');
      return health && health.classList.contains('st-working') && poker && poker.classList.contains('act-idle');
    }, { timeout: 8000 });
    const look = await page.evaluate(() => {
      const green = (color) => {
        const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || '');
        if (!match) return false;
        const g = Number(match[2]);
        return g > 140 && g > Number(match[1]) + 40 && g > Number(match[3]) + 40;
      };
      const read = (id) => {
        const agent = document.querySelector(`#agents .agent[data-id="${id}"]`);
        const bld = agent.querySelector('.bld');
        const fig = agent.querySelector('.fig-wrap');
        const body = agent.querySelector('.fig-body');
        const dot = document.querySelector(`#overlay .tag[data-id="${id}"] .dot`);
        const chip = document.querySelector(`#roster .chip[data-id="${id}"]`);
        const av = chip.querySelector('.av');
        const st = chip.querySelector('.st');
        const part = (el) => {
          const style = getComputedStyle(el);
          return { opacity: style.opacity, filter: style.filter };
        };
        return {
          dot: green(getComputedStyle(dot).backgroundColor),
          chipDot: green(getComputedStyle(st).backgroundColor),
          bld: part(bld),
          fig: part(fig),
          body: body ? part(body) : null,
          av: part(av),
        };
      };
      return { health: read('health'), social: read('social'), poker: read('poker') };
    });
    for (const id of ['health', 'social']) {
      const row = look[id];
      assert.equal(row.dot, true, `${id} точка на карте`);
      assert.equal(row.chipDot, true, `${id} точка в полосе`);
      for (const part of ['bld', 'fig', 'body', 'av']) {
        assert.ok(Math.abs(Number(row[part].opacity) - 1) < 0.05, `${id} ${part} ${JSON.stringify(row[part])}`);
        assert.equal(/grayscale/.test(row[part].filter), false, `${id} ${part} ${row[part].filter}`);
      }
    }
    assert.equal(look.poker.dot, false);
    assert.equal(look.poker.chipDot, false);
    assert.ok(Math.abs(Number(look.poker.fig.opacity) - 0.55) < 0.05, JSON.stringify(look.poker.fig));
    assert.match(look.poker.bld.filter, /grayscale/);
    await page.screenshot({ path: '/tmp/wave2-map-opacity.png' });
  } finally {
    await page.close();
  }
});
