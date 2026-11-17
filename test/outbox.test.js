'use strict';

// Очередь вебхука: пустой URL, старт, ошибка доставки, лог без секретов, здоровье.
// Перезапуск с базой — отдельным процессом, как в test/store.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { activityFor } = require('../lib/activity');

const root = path.join(__dirname, '..');
const savedDatabaseUrl = process.env.DATABASE_URL || '';
const KEY = 'kremlin-key-SHOULD-NOT-LOG';
const PATH_TOKEN = 'hook-SHOULD-NOT-LOG';
const BODY_TOKEN = 'TEXT-SENTINEL-should-not-log';
const OFFLINE = 'Доставка не подключена, сообщение в очереди';
const FAILED = 'Не доставлено, в очереди';

delete process.env.DATABASE_URL;
delete process.env.STORE_SCHEMA;

const hits = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = { raw: body }; }
    hits.push({ headers: req.headers, body: parsed, url: req.url });
    const fail = String(req.url || '').includes('/fail');
    res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(fail ? '{"ok":false}' : '{"ok":true}');
  });
});

let base;
let server;
let office;
let hookUrl;

function seedItem(id, at, status, text) {
  return {
    id,
    at,
    agentId: 'advisor',
    taskId: `task-${id}`,
    status,
    lastError: null,
    attempts: 0,
    payload: {
      id,
      type: 'owner_task',
      agentId: 'advisor',
      text,
      at,
      atMsk: '17.11 12:00 МСК',
      appUrl: 'https://example.test',
      taskId: `task-${id}`,
    },
  };
}

before(async () => {
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${hook.address().port}/${PATH_TOKEN}`;
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kremlin-outbox-'));
  process.env.APP_PASSWORD = 'pw-outbox';
  process.env.AGENT_TOKEN = 'tok-outbox';
  process.env.PUBLIC_URL = 'https://example.test';
  process.env.KREMLIN_WEBHOOK_URL = hookUrl;
  process.env.KREMLIN_WEBHOOK_KEY = KEY;
  delete process.env.KREMLIN_WEBHOOK_HEADER;
  delete process.env.PORYADOK_INGEST_TOKEN;
  office = require('../server.js');
  office.state.outbox = [
    seedItem('ob-seed-new', '2026-11-17T11:00:00.000Z', 'queued', 'потом'),
    seedItem('ob-seed-done', '2026-11-17T09:00:00.000Z', 'delivered', 'уже ушло'),
    seedItem('ob-seed-old', '2026-11-17T10:00:00.000Z', 'queued', 'сначала'),
  ];
  for (const item of office.state.outbox) {
    office.state.tasks.unshift({
      id: item.taskId,
      agent: 'advisor',
      agentId: 'advisor',
      fromAgentId: 'owner',
      text: item.payload.text,
      status: 'в очереди агента',
      delivery: 'queue',
      orderStatus: 'sent',
      createdAt: item.at,
      forwardStatus: null,
      history: [],
      attachments: [],
    });
  }
  server = await new Promise((resolve) => {
    const listening = office.app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  while (Date.now() - started < 3000 && hits.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

after(() => {
  server && server.close();
  hook.close();
});

const json = (urlPath, opts = {}) =>
  fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

test('недоставленный приказ не делает агента working', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const orders = [{
    id: 't-held',
    agentId: 'advisor',
    orderStatus: 'sent',
    text: 'Ждёт доставку',
    createdAt: '2026-11-17T11:00:00.000Z',
  }];
  const held = activityFor({ id: 'advisor' }, orders, now, 60_000, {
    outbox: [{ id: 'ob-1', taskId: 't-held', status: 'queued' }],
  });
  assert.equal(held.activity, 'resting');
  assert.equal(held.currentTask, null);
  const accepted = activityFor({ id: 'advisor' }, [
    { ...orders[0], orderStatus: 'accepted' },
  ], now, 60_000, {
    outbox: [{ id: 'ob-1', taskId: 't-held', status: 'queued' }],
  });
  assert.equal(accepted.activity, 'working');
});

test('при старте очередь уходит по порядку и не дублирует delivered', async () => {
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.body && hit.body.id), ['ob-seed-old', 'ob-seed-new']);
  assert.equal(hits[0].headers['x-outbox-id'], 'ob-seed-old');
  assert.equal(hits[1].body.text, 'потом');
  assert.equal(hits.some((hit) => hit.body && hit.body.id === 'ob-seed-done'), false);
  const state = await json('/api/state');
  const old = state.body.outbox.find((item) => item.id === 'ob-seed-old');
  const done = state.body.outbox.find((item) => item.id === 'ob-seed-done');
  assert.equal(old.status, 'delivered');
  assert.equal(done.status, 'delivered');
  const task = state.body.tasks.find((item) => item.id === 'task-ob-seed-old');
  assert.equal(task.status, 'отправлена Путину');
  const advisor = state.body.agents.find((agent) => agent.id === 'advisor');
  assert.equal(advisor.status, 'working');
  const again = hits.length;
  const retry = await json('/api/outbox/retry', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-outbox' },
    body: '{}',
  });
  assert.equal(retry.status, 200);
  assert.equal(hits.length, again);
});

test('пустой URL кладёт задачу в очередь и пишет честный текст', async () => {
  delete process.env.KREMLIN_WEBHOOK_URL;
  const before = hits.length;
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-outbox' },
    body: JSON.stringify({ agent: 'blog', text: 'Сообщение Советнику не теряется' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'в очереди агента');
  assert.equal(created.body.delivery, 'queue');
  assert.equal(created.body.forwardStatus, null);
  assert.equal(created.body.deliveryLabel, OFFLINE);
  assert.equal(hits.length, before);
  const state = await json('/api/state');
  const item = state.body.outbox.find((entry) => entry.taskId === created.body.id);
  assert.ok(item);
  assert.equal(item.status, 'queued');
  assert.equal(item.agentId, 'blog');
  assert.equal(item.lastError, null);
  assert.equal(item.payload.text, 'Сообщение Советнику не теряется');
  assert.equal(item.payload.id, item.id);
  const blog = state.body.agents.find((agent) => agent.id === 'blog');
  assert.notEqual(blog.status, 'working');
  assert.notEqual(blog.activity, 'working');
  process.env.KREMLIN_WEBHOOK_URL = hookUrl;
});

test('ошибка вебхука оставляет queued, а лог не содержит URL и ключ', async () => {
  process.env.KREMLIN_WEBHOOK_URL = `${hookUrl}/fail`;
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); origLog(...args); };
  console.error = (...args) => { logs.push(args.map(String).join(' ')); origErr(...args); };
  let created;
  try {
    created = await json('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-outbox' },
      body: JSON.stringify({ agent: 'social', text: BODY_TOKEN }),
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'в очереди агента');
  assert.equal(created.body.deliveryLabel, FAILED);
  const state = await json('/api/state');
  const item = state.body.outbox.find((entry) => entry.taskId === created.body.id);
  assert.equal(item.status, 'queued');
  assert.match(item.lastError, /^HTTP 500$/);
  const social = state.body.agents.find((agent) => agent.id === 'social');
  assert.notEqual(social.activity, 'working');
  const line = logs.find((entry) => entry.startsWith('webhook attempt '));
  assert.ok(line, logs.join('\n'));
  assert.match(line, new RegExp(`id=${item.id} agent=social attempt=1 http=500 ms=\\d+`));
  assert.equal(line.includes(KEY), false);
  assert.equal(line.includes(PATH_TOKEN), false);
  assert.equal(line.includes(BODY_TOKEN), false);
  assert.equal(logs.join('\n').includes(KEY), false);
  assert.equal(logs.join('\n').includes(PATH_TOKEN), false);
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  process.env.KREMLIN_WEBHOOK_URL = `http://127.0.0.1:${deadPort}/${PATH_TOKEN}`;
  const netLogs = [];
  console.log = (...args) => { netLogs.push(args.map(String).join(' ')); };
  console.error = (...args) => { netLogs.push(args.map(String).join(' ')); };
  try {
    const broken = await json('/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-outbox' },
      body: JSON.stringify({ agent: 'temshik', text: 'сеть молчит' }),
    });
    assert.equal(broken.status, 201);
    assert.equal(broken.body.deliveryLabel, FAILED);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const netLine = netLogs.find((entry) => entry.startsWith('webhook attempt '));
  assert.match(netLine, /error=network_error ms=\d+/);
  assert.equal(netLogs.join('\n').includes(KEY), false);
  assert.equal(netLogs.join('\n').includes(PATH_TOKEN), false);
  process.env.KREMLIN_WEBHOOK_URL = hookUrl;
});

test('GET /api/health/delivery требует авторизацию и не отдаёт секреты', async () => {
  assert.equal((await json('/api/health/delivery')).status, 401);
  assert.equal((await json('/api/health/delivery', {
    headers: { authorization: 'Bearer wrong' },
  })).status, 401);
  const bearer = await json('/api/health/delivery', {
    headers: { authorization: 'Bearer tok-outbox' },
  });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.body.webhookUrlSet, true);
  assert.equal(bearer.body.webhookKeySet, true);
  assert.equal(typeof bearer.body.queued, 'number');
  assert.equal(typeof bearer.body.delivered, 'number');
  assert.ok(bearer.body.lastDelivery);
  assert.equal(typeof bearer.body.lastDelivery.at, 'string');
  assert.equal(typeof bearer.body.lastDelivery.outboxId, 'string');
  assert.ok(
    Number.isInteger(bearer.body.lastDelivery.status) || typeof bearer.body.lastDelivery.error === 'string',
  );
  const owner = await json('/api/health/delivery', {
    headers: { 'x-app-password': 'pw-outbox' },
  });
  assert.equal(owner.status, 200);
  const agent = await json('/api/health/delivery', {
    headers: { 'x-agent-token': 'tok-outbox' },
  });
  assert.equal(agent.status, 200);
  const raw = JSON.stringify(bearer.body);
  assert.equal(raw.includes(KEY), false);
  assert.equal(raw.includes(PATH_TOKEN), false);
  assert.equal(raw.includes(hookUrl), false);
});

test('на 390px карточка говорит, что доставка не подключена', { timeout: 30000 }, async () => {
  delete process.env.KREMLIN_WEBHOOK_URL;
  const created = await json('/api/task', {
    method: 'POST',
    headers: { 'x-app-password': 'pw-outbox' },
    body: JSON.stringify({ agent: 'routines', text: 'Текст для узкой карточки' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.deliveryLabel, OFFLINE);
  const puppeteer = require('puppeteer-core');
  const chrome = ['/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(chrome, 'Chrome не найден');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', (err) => { errors.push(String(err)); });
    await page.goto(`${base}/?agent=routines`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((text) => {
      const pill = document.querySelector('#panel.open .status-line');
      const badge = document.querySelector('#panel.open .quest .badge');
      return pill && badge && pill.textContent.includes(text) && badge.textContent.includes(text);
    }, { timeout: 8000 }, OFFLINE);
    assert.deepEqual(errors, []);
    const box = await page.evaluate(() => {
      const agent = document.querySelector('#agents .agent[data-id="routines"]');
      const panel = document.querySelector('#panel');
      return {
        agentClass: agent ? (agent.getAttribute('class') || '') : '',
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    assert.equal(box.agentClass.includes('pulse'), false);
    assert.equal(box.agentClass.includes('st-working'), false);
    assert.equal(box.overflow, false);
    assert.equal(box.panelOverflow, false);
  } finally {
    await browser.close();
    process.env.KREMLIN_WEBHOOK_URL = hookUrl;
  }
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
  env.APP_PASSWORD = 'pw-test';
  env.AGENT_TOKEN = 'tok-test';
  env.PUBLIC_URL = 'https://example.test';
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-outbox-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const officeBase = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let up = false;
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${officeBase}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') { up = true; break; }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!up) throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
  return { base: officeBase, child, logs, text() { return `${this.logs.out}\n${this.logs.err}`; } };
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function officeJson(officeBase, urlPath, opts = {}) {
  const res = await fetch(officeBase + urlPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function dropSchema(schema) {
  if (!savedDatabaseUrl) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) return;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch (_) { /* схема могла не создаться */ } finally {
    await pool.end();
  }
}

test('Postgres хранит outbox между процессами', { skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `o_${crypto.randomBytes(4).toString('hex')}`;
  const quiet = {
    DATABASE_URL: savedDatabaseUrl,
    STORE_SCHEMA: schema,
    KREMLIN_WEBHOOK_URL: '',
    KREMLIN_WEBHOOK_KEY: KEY,
  };
  let taskId;
  let outboxId;
  const first = await startOffice(quiet);
  try {
    const created = await officeJson(first.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-test' },
      body: JSON.stringify({ agent: 'advisor', text: 'Пережить рестарт очереди' }),
    });
    assert.equal(created.status, 201);
    taskId = created.body.id;
    assert.equal(created.body.deliveryLabel, OFFLINE);
    const state = await officeJson(first.base, '/api/state');
    const item = state.body.outbox.find((entry) => entry.taskId === taskId);
    assert.ok(item);
    assert.equal(item.status, 'queued');
    outboxId = item.id;
    assert.equal(first.text().includes(KEY), false);
  } finally {
    await stopOffice(first);
  }

  const second = await startOffice(quiet);
  try {
    const state = await officeJson(second.base, '/api/state');
    const item = state.body.outbox.find((entry) => entry.id === outboxId);
    assert.ok(item);
    assert.equal(item.status, 'queued');
    assert.equal(item.agentId, 'advisor');
    assert.equal(item.payload.text, 'Пережить рестарт очереди');
    const task = state.body.tasks.find((entry) => entry.id === taskId);
    assert.equal(task.text, 'Пережить рестарт очереди');
    const advisor = state.body.agents.find((agent) => agent.id === 'advisor');
    assert.notEqual(advisor.activity, 'working');
  } finally {
    await stopOffice(second);
  }

  const receiverHits = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
      receiverHits.push({ headers: req.headers, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const third = await startOffice({
    ...quiet,
    KREMLIN_WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/wake`,
  });
  try {
    const started = Date.now();
    while (Date.now() - started < 4000 && !receiverHits.some((hit) => hit.body && hit.body.id === outboxId)) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const hit = receiverHits.find((entry) => entry.body && entry.body.id === outboxId);
    assert.ok(hit);
    assert.equal(hit.headers['x-outbox-id'], outboxId);
    assert.equal(hit.body.text, 'Пережить рестарт очереди');
    const settled = Date.now();
    let delivered = null;
    while (Date.now() - settled < 4000) {
      const state = await officeJson(third.base, '/api/state');
      delivered = state.body.outbox.find((entry) => entry.id === outboxId);
      if (delivered && delivered.status === 'delivered') break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(delivered.status, 'delivered');
    await officeJson(third.base, '/api/outbox/retry', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-test' },
      body: '{}',
    });
    assert.equal(third.text().includes(KEY), false);
    assert.equal(third.text().includes('/wake'), false);
  } finally {
    await stopOffice(third);
    receiver.close();
  }

  const fourth = await startOffice({
    ...quiet,
    KREMLIN_WEBHOOK_URL: `http://127.0.0.1:9/closed`,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await officeJson(fourth.base, '/api/state');
    const item = state.body.outbox.find((entry) => entry.id === outboxId);
    assert.equal(item.status, 'delivered');
    assert.equal(fourth.text().includes('webhook attempt'), false);
  } finally {
    await stopOffice(fourth);
    await dropSchema(schema);
  }
});
