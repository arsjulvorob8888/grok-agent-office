'use strict';

// Имена профилей, отказ голому «Grok», окно 15 минут, протухший status, архив.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const PROFILE_NAMES = [
  ['Путин · Кремль', 'grok'],
  ['Программирование · Кремль', 'dev'],
  ['Здоровье и спорт · Кремль', 'health'],
  ['Technology Blog · Кремль', 'blog'],
  ['Трейдинг · Кремль', 'invest'],
  ['Инвестиции · Кремль', 'invest'],
  ['Бизнес-аналитик · Кремль', 'analyst'],
  ['Language Coach', 'lang'],
  ['Темщик · Кремль', 'temshik'],
  ['Тестировщик ПО · Кремль', 'qa'],
  ['Советник · Кремль', 'advisor'],
  ['Соцсети · Кремль', 'social'],
  ['Business Adviser', 'biz'],
  ['Военная служба · Кремль', 'army'],
  ['DevOps · Кремль', 'devops'],
  ['Рутины · Кремль', 'routines'],
  ['Покер · Кремль', 'poker'],
  ['Финансы · Кремль', 'finance'],
];

const ARCHIVE_ERROR = 'агент в архиве на карте — статус не принят';
const HOLD = 15 * 60 * 1000;

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-names-'));
process.env.APP_PASSWORD = 'pw-names';
process.env.AGENT_TOKEN = 'tok-names';
process.env.AGENT_STATUS_TOKEN = 'status-names';
process.env.PUBLIC_URL = 'http://127.0.0.1';
delete process.env.KREMLIN_WEBHOOK_URL;
delete process.env.PORYADOK_INGEST_TOKEN;
delete process.env.ACTIVITY_WINDOW_MIN;

const live = require('../lib/live-status');
const activity = require('../lib/activity');
const { app, state } = require('../server.js');

let base;
let server;

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (live && live.setNow) live.setNow(null);
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(origin, urlPath, opts = {}) {
  return fetch(origin + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (r) => ({
    status: r.status,
    body: await r.json().catch(() => null),
  }));
}

const json = (urlPath, opts = {}) => request(base, urlPath, opts);

function agentOf(body, id) {
  return body.agents.find((agent) => agent.id === id);
}

function postStatus(body) {
  return json('/api/agent-status', {
    method: 'POST',
    headers: { Authorization: 'Bearer status-names' },
    body: JSON.stringify(body),
  });
}

test('окно живого статуса одно: 15 минут', () => {
  assert.equal(activity.STATUS_HOLD_MS, HOLD);
  assert.equal(live.TTL_MS, activity.STATUS_HOLD_MS);
});

test('каждое имя профиля резолвится в свой id, пробелы и точка не мешают', () => {
  for (const [name, id] of PROFILE_NAMES) {
    const found = live.resolveAgent(name, state.agents);
    assert.equal(found && found.id, id, name);
    const tight = name.replace(/\s*·\s*/g, '·');
    const spaced = `  ${name.replace(/·/g, '  ·  ')}  `;
    assert.equal(live.resolveAgent(tight, state.agents) && live.resolveAgent(tight, state.agents).id, id, tight);
    assert.equal(live.resolveAgent(spaced, state.agents) && live.resolveAgent(spaced, state.agents).id, id, spaced);
    const bare = name.replace(/\s*·\s*Кремль\s*$/u, '').trim();
    assert.equal(live.resolveAgent(bare, state.agents) && live.resolveAgent(bare, state.agents).id, id, bare);
    const lower = name.toLowerCase();
    assert.equal(live.resolveAgent(lower, state.agents) && live.resolveAgent(lower, state.agents).id, id, lower);
  }
  assert.equal(live.resolveAgent('Советник Путина', state.agents).id, 'advisor');
  assert.equal(live.resolveAgent('DEV', state.agents).id, 'dev');
  assert.equal(live.resolveAgent('grok', state.agents).id, 'grok');
  assert.equal(live.resolveAgent('grok · Кремль', state.agents).id, 'grok');
});

test('голое Grok в любом регистре, кроме точного id, не отмечает Путина', () => {
  for (const raw of ['Grok', 'GROK', 'gRoK', 'Grok · Кремль', '  GROK  ']) {
    assert.equal(live.resolveAgent(raw, state.agents), null, raw);
  }
});

test('POST по 16 именам: неархивный меняет activity, архивный — понятный 409', async () => {
  for (const [name, id] of PROFILE_NAMES) {
    const doing = `метка ${id}`;
    const posted = await postStatus({ agentId: name, status: 'working', doing });
    const view = agentOf((await json('/api/state')).body, id);
    if (id === 'lang') {
      assert.equal(posted.status, 409, name);
      assert.equal(posted.body.agentId, 'lang');
      assert.equal(posted.body.error, ARCHIVE_ERROR);
      assert.equal(posted.body.ok, undefined);
      assert.notEqual(view.doing, doing);
      assert.equal(view.archived, true);
      continue;
    }
    assert.equal(posted.status, 200, `${name} ${JSON.stringify(posted.body)}`);
    assert.equal(posted.body.ok, true, name);
    assert.equal(posted.body.id, id, name);
    assert.equal(view.activity, 'working', name);
    assert.equal(view.doing, doing, name);
    if (id === 'biz') {
      assert.equal(view.archived, true, name);
      assert.equal(view.parentId, 'finance', name);
    } else {
      assert.equal(view.archived, false, name);
    }
    assert.equal(JSON.stringify(posted.body).includes('status-names'), false);
  }
  const grok = await postStatus({ agentId: 'Grok', status: 'working', doing: 'не Путин' });
  assert.equal(grok.status, 404);
  assert.equal(JSON.stringify((await json('/api/state')).body).includes('не Путин'), false);
});

test('working без продления держится до 15 минут и гаснет на границе', async () => {
  const t0 = Date.parse('2033-03-01T00:00:00.000Z');
  let clock = t0;
  live.setNow(() => clock);
  try {
    const started = await postStatus({ agentId: 'army', status: 'working', doing: 'держу линию' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.until, new Date(t0 + HOLD).toISOString());

    clock = t0 + HOLD - 1;
    let view = agentOf((await json('/api/state')).body, 'army');
    assert.equal(view.activity, 'working');
    assert.equal(view.doing, 'держу линию');

    clock = t0 + HOLD;
    view = agentOf((await json('/api/state')).body, 'army');
    assert.equal(view.activity, 'resting');
    assert.equal(view.doing, null);
  } finally {
    live.setNow(null);
  }
});

test('протухший сырой working становится idle, свежий и живой ход остаются', () => {
  assert.equal(typeof activity.settleRawStatus, 'function');
  const t0 = Date.parse('2033-04-01T00:00:00.000Z');
  const finance = {
    id: 'finance',
    status: 'working',
    lastSeenAt: null,
    lastStatusAt: null,
    live: null,
  };
  activity.settleRawStatus([finance], t0);
  assert.equal(finance.status, 'idle');

  const qa = {
    id: 'qa',
    status: 'working',
    lastSeenAt: null,
    lastStatusAt: new Date(t0).toISOString(),
  };
  activity.settleRawStatus([qa], t0 + HOLD - 1);
  assert.equal(qa.status, 'working');
  activity.settleRawStatus([qa], t0 + HOLD);
  assert.equal(qa.status, 'idle');

  const advisor = {
    id: 'advisor',
    status: 'working',
    lastSeenAt: null,
    lastStatusAt: null,
    live: { status: 'working', until: new Date(t0 + 1000).toISOString() },
  };
  activity.settleRawStatus([advisor], t0);
  assert.equal(advisor.status, 'working');
  activity.settleRawStatus([advisor], t0 + 1000);
  assert.equal(advisor.status, 'idle');

  const social = { id: 'social', status: 'waiting', lastStatusAt: null };
  activity.settleRawStatus([social], t0 + HOLD);
  assert.equal(social.status, 'waiting');
});

test('старт приводит сохранённый working без отметки к idle', async () => {
  for (const id of ['finance', 'qa', 'advisor', 'social']) {
    const agent = state.agents.find((item) => item.id === id);
    agent.status = 'working';
    agent.lastSeenAt = null;
    agent.lastStatusAt = null;
    agent.live = null;
  }
  activity.settleRawStatus(state.agents, Date.parse('2033-05-01T00:00:00.000Z'));
  const body = (await json('/api/state')).body;
  for (const id of ['finance', 'qa', 'advisor', 'social']) {
    const view = agentOf(body, id);
    assert.equal(view.status, 'idle', id);
    assert.equal(view.activity, 'resting', id);
    assert.equal(view.lastSeenAt, null, id);
  }
});

test('архивный зам с parentId принимает статус, архив без parentId — нет', async () => {
  const trading = state.agents.find((agent) => agent.id === 'trading');
  const biz = state.agents.find((agent) => agent.id === 'biz');
  const lang = state.agents.find((agent) => agent.id === 'lang');
  assert.equal(trading.archived, true);
  assert.equal(biz.archived, true);
  assert.equal(lang.archived, true);
  assert.equal(trading.parentId, 'finance');
  assert.equal(biz.parentId, 'finance');
  assert.equal(lang.parentId, null);
  const tradingRecord = state.agents.find((agent) => agent.id === 'trading');
  const keptName = tradingRecord.name;
  const named = await postStatus({ agentId: 'Трейдинг · Кремль', status: 'working', doing: 'в комнате' });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.ok, true);
  assert.equal(named.body.id, 'invest');
  const byOldId = await postStatus({ agentId: 'trading', status: 'working', doing: 'старый id' });
  assert.ok(byOldId.status >= 200 && byOldId.status < 300, JSON.stringify(byOldId.body));
  assert.equal(byOldId.body.id, 'invest');
  const renamed = await postStatus({ agentId: 'Инвестиции · Кремль', status: 'working', doing: 'новое имя' });
  assert.ok(renamed.status >= 200 && renamed.status < 300, JSON.stringify(renamed.body));
  assert.equal(renamed.body.id, 'invest');
  const adviser = await postStatus({ agentId: 'Business Adviser', status: 'working', doing: 'совет' });
  assert.equal(adviser.status, 200, JSON.stringify(adviser.body));
  assert.equal(adviser.body.ok, true);
  const coach = await postStatus({ agentId: 'Language Coach', status: 'working', doing: 'урок' });
  assert.equal(coach.status, 409);
  assert.equal(coach.body.agentId, 'lang');
  assert.equal(coach.body.error, ARCHIVE_ERROR);
  const body = (await json('/api/state')).body;
  const card = agentOf(body, 'invest');
  assert.equal(card.activity, 'working');
  assert.equal(card.doing, 'новое имя');
  assert.equal(card.name, 'Инвестиции');
  assert.equal(card.number, '7.1');
  assert.equal(card.archived, false);
  const stored = agentOf(body, 'trading');
  assert.equal(stored.archived, true);
  assert.equal(stored.name, keptName);
  assert.equal(stored.id, 'trading');
  assert.equal(agentOf(body, 'biz').doing, 'совет');
  assert.equal(agentOf(body, 'biz').archived, true);
  assert.equal(agentOf(body, 'lang').doing, null);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_CHANNEL_FD;
  delete env.PORYADOK_INGEST_TOKEN;
  env.APP_PASSWORD = 'pw-names';
  env.AGENT_TOKEN = 'tok-names';
  env.AGENT_STATUS_TOKEN = 'status-names';
  env.PUBLIC_URL = 'http://127.0.0.1';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-names-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const officeBase = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${officeBase}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        up = true;
        break;
      }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  if (extraEnv.DATABASE_URL) {
    const waitDb = Date.now();
    while (Date.now() - waitDb < 20000 && !`${logs.out}\n${logs.err}`.includes('Postgres подключен')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    base: officeBase,
    child,
    logs,
    text() { return `${logs.out}\n${logs.err}`; },
  };
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      office.child.kill('SIGKILL');
      resolve();
    }, 3000);
    office.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('рестарт гасит старый working и оставляет замы в архиве', async () => {
  if (!process.env.DATABASE_URL) return;
  const { Pool } = require('pg');
  const schema = `n_${process.pid}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const env = { DATABASE_URL: process.env.DATABASE_URL, STORE_SCHEMA: schema };
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  const first = await startOffice(env);
  try {
    assert.match(first.text(), /Postgres подключен/);
    const body = (await request(first.base, '/api/state')).body;
    assert.equal(agentOf(body, 'trading').archived, true);
    assert.equal(agentOf(body, 'trading').parentId, 'finance');
    assert.equal(agentOf(body, 'biz').archived, true);
    assert.equal(agentOf(body, 'lang').archived, true);
    const trading = await request(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer status-names' },
      body: JSON.stringify({ agentId: 'Трейдинг · Кремль', status: 'working', doing: 'в комнате' }),
    });
    assert.equal(trading.status, 200, JSON.stringify(trading.body));
    assert.equal(trading.body.ok, true);
    const lang = await request(first.base, '/api/agent-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer status-names' },
      body: JSON.stringify({ agentId: 'Language Coach', status: 'working', doing: 'урок' }),
    });
    assert.equal(lang.status, 409);
    assert.equal(lang.body.agentId, 'lang');
    assert.equal(lang.body.error, ARCHIVE_ERROR);
  } finally {
    await stopOffice(first);
  }

  await pool.query(
    `UPDATE "${schema}".agent_state
     SET payload = COALESCE(payload, '{}'::jsonb) || '{"status":"working","lastSeenAt":null}'::jsonb
     WHERE id IN ('finance', 'qa', 'advisor', 'social')`,
  );
  const second = await startOffice(env);
  try {
    const body = (await request(second.base, '/api/state')).body;
    assert.equal(agentOf(body, 'trading').archived, true);
    assert.equal(agentOf(body, 'biz').archived, true);
    assert.equal(agentOf(body, 'lang').archived, true);
    for (const id of ['finance', 'qa', 'advisor', 'social']) {
      assert.equal(agentOf(body, id).status, 'idle', id);
    }
    assert.equal(second.text().includes('status-names'), false);
  } finally {
    await stopOffice(second);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

async function hitFinance(page) {
  for (let step = 0; step < 8; step += 1) {
    const found = await page.evaluate(() => {
      const g = document.querySelector('#agents .agent[data-id="finance"]');
      if (!g) return null;
      const rect = g.getBoundingClientRect();
      for (let y = rect.top + 4; y < rect.bottom - 2; y += 8) {
        for (let x = rect.left + 4; x < rect.right - 2; x += 8) {
          if (x < 6 || y < 6 || x > innerWidth - 6 || y > innerHeight - 6) continue;
          const el = document.elementFromPoint(x, y);
          if (el && g.contains(el)) return { x, y };
        }
      }
      return { miss: true, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
    });
    if (found && !found.miss) return found;
    const vw = page.viewport().width;
    const vh = page.viewport().height;
    await page.mouse.move(vw / 2, Math.min(vh / 2, vh - 180));
    await page.mouse.down();
    await page.mouse.move(found.cx < vw / 2 ? vw - 40 : 40, found.cy < vh / 2 ? vh - 180 : 140, { steps: 8 });
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('здание Финансов не попало на экран');
}

test('статус замов виден в помещении Финансов и их нет на общей карте', async () => {
  const fsChrome = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
  ].filter(Boolean);
  const chrome = fsChrome.find((item) => fs.existsSync(item));
  assert.ok(chrome, 'Chrome не найден');
  const trading = await postStatus({ agentId: 'trading', status: 'working', doing: 'сделка' });
  const adviser = await postStatus({ agentId: 'biz', status: 'working', doing: 'сводка' });
  assert.equal(trading.status, 200, JSON.stringify(trading.body));
  assert.equal(adviser.status, 200, JSON.stringify(adviser.body));
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/?theme=day`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agents .agent[data-id="finance"]', { timeout: 8000 });
    const map = await page.evaluate(() => ({
      trading: !!document.querySelector('#agents .agent[data-id="trading"], #roster .chip[data-id="trading"]'),
      biz: !!document.querySelector('#agents .agent[data-id="biz"], #roster .chip[data-id="biz"]'),
      lang: !!document.querySelector('#agents .agent[data-id="lang"], #roster .chip[data-id="lang"]'),
    }));
    assert.equal(map.trading, false);
    assert.equal(map.biz, false);
    assert.equal(map.lang, false);
    const point = await hitFinance(page);
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('#room.open .room-seat[data-id="invest"]', { timeout: 8000 });
    const seats = await page.$$eval('#room.open .room-seat', (els) => els.map((el) => ({
      id: el.dataset.id,
      name: el.textContent.replace(/\s+/g, ' ').trim(),
      status: el.querySelector('.room-dot') ? el.querySelector('.room-dot').getAttribute('data-status') : '',
      label: el.querySelector('.status-pill') ? el.querySelector('.status-pill').textContent : '',
    })));
    const bySeat = Object.fromEntries(seats.map((seat) => [seat.id, seat]));
    assert.equal(bySeat.trading, undefined);
    assert.equal(bySeat.biz, undefined);
    assert.equal(bySeat.lang, undefined);
    assert.match(bySeat.invest.name, /7\.1\s*Инвестиции/);
    assert.equal(bySeat.invest.status, 'working');
    assert.match(bySeat.invest.label, /Работает/);
    assert.match(bySeat.analyst.name, /7\.2\s*Бизнес-аналитик/);
    assert.equal(/Трейдинг|Business Adviser/.test(seats.map((seat) => seat.name).join('\n')), false);
    assert.equal(seats.every((seat) => seat.status), true);
  } finally {
    await browser.close();
  }
});
