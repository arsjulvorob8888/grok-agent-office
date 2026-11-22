'use strict';

// Повтор очереди, время МСК, маршрут общего вебхука и кнопка одного приказа.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const Feed = require('../public/js/feed');
const retry = require('../lib/outbox-retry');
const savedDatabaseUrl = process.env.DATABASE_URL || '';

test('фиксированное время процессов в МСК при TZ=UTC', () => {
  const script = `
    const Feed = require('./public/js/feed');
    const iso = '2026-11-17T20:25:00.000Z';
    const now = Date.parse('2026-11-18T06:58:00.000Z');
    const stamp = Feed.formatProcessStamp(iso, now);
    if (stamp !== 'с 23:25 МСК · 10 ч 33 мин') {
      console.error(stamp);
      process.exit(1);
    }
    const clock = Feed.formatClockMsk('2026-11-18T07:15:00.000Z', Date.parse('2026-11-18T07:20:00.000Z'));
    if (clock !== '10:15 МСК') {
      console.error(clock);
      process.exit(2);
    }
    const localHour = new Date('2026-11-18T07:15:00.000Z').getHours();
    if (localHour === 10) process.exit(3);
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

test('подпись различает неподключенную доставку и ожидание отправки', () => {
  assert.equal(Feed.deliveryCaption(null), 'В очереди, доставка не подключена');
  assert.equal(Feed.deliveryCaption(null, { route: 'none' }), 'В очереди, доставка не подключена');
  assert.equal(Feed.deliveryCaption(null, { route: 'putin' }), 'В очереди, ждёт отправки');
  assert.equal(
    Feed.deliveryCaption(500, { route: 'putin', nextRetryAt: '2026-11-18T07:33:00.000Z' }),
    'Ошибка доставки, повтор в 10:33 МСК',
  );
  assert.equal(Feed.deliveryCaption(200, { route: 'putin' }), 'Отправлена');
});

test('таймер ждёт паузу после 5xx и останавливается на пределе', () => {
  const env = { OUTBOX_RETRY_BASE_MS: '5000', OUTBOX_RETRY_MAX: '2' };
  const item = {
    status: 'queued',
    attempts: 1,
    lastAttemptAt: '2026-11-18T07:00:00.000Z',
    lastError: 'HTTP 500',
  };
  assert.equal(retry.dueOnTimer(item, Date.parse('2026-11-18T07:00:04.000Z'), env), false);
  assert.equal(retry.dueOnTimer(item, Date.parse('2026-11-18T07:00:05.000Z'), env), true);
  item.attempts = 2;
  assert.equal(retry.dueOnTimer(item, Date.parse('2026-11-18T09:00:00.000Z'), env), false);
  assert.equal(retry.nextRetryAt(item, env), null);
});

test('два прохода в памяти не отправляют один заказ дважды', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const item = { id: 'ob-1', status: 'queued', attempts: 0, agentId: 'social' };
  const first = sendSlow(item);
  const second = sendSlow(item);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);

  async function sendSlow(target) {
    if (!retry.claimMemory(target)) return;
    calls += 1;
    await gate;
    target.status = 'delivered';
  }
});

test('задача «тест» без outbox отменяется и не встаёт в очередь', () => {
  const tasks = [
    { id: 't-1', agentId: 'social', text: 'Пост', orderStatus: 'sent', forwardStatus: null },
    { id: 't-4', agentId: 'advisor', text: ' тест ', orderStatus: 'sent', forwardStatus: null },
  ];
  const plan = retry.planBackfill(tasks, [], []);
  assert.equal(plan.missing.length, 1);
  assert.equal(plan.missing[0].task.id, 't-1');
  assert.equal(plan.cancelled.length, 1);
  assert.equal(tasks[1].orderStatus, 'cancelled');
  assert.equal(tasks[1].note, 'устарело');
  const again = retry.planBackfill(tasks, [{ taskId: 't-1', status: 'queued' }], []);
  assert.equal(again.missing.length, 0);
  assert.equal(again.cancelled.length, 0);
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
  env.APP_PASSWORD = 'pw-retry';
  env.AGENT_TOKEN = 'tok-retry';
  env.PUBLIC_URL = 'https://example.test';
  if (!Object.prototype.hasOwnProperty.call(extra, 'KREMLIN_WEBHOOK_URL')) env.KREMLIN_WEBHOOK_URL = '';
  if (!Object.prototype.hasOwnProperty.call(extra, 'KREMLIN_WEBHOOK_KEY')) env.KREMLIN_WEBHOOK_KEY = '';
  env.WEBHOOK_SECRETS_KEY = env.WEBHOOK_SECRETS_KEY || crypto.randomBytes(32).toString('base64');
  return env;
}

async function startOffice(extraEnv) {
  const port = await freePort();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-retry-'));
  const logs = { out: '', err: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: childEnv({ ...extraEnv, PORT: String(port), UPLOAD_DIR: uploadDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.out += chunk; });
  child.stderr.on('data', (chunk) => { logs.err += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error(`сервер завершился ${child.exitCode}\n${logs.out}\n${logs.err}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.status === 200 && (await res.text()) === 'ok') {
        return { base, child, logs, text() { return `${this.logs.out}\n${this.logs.err}`; } };
      }
    } catch (_) { /* ещё стартует */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`healthz не ответил\n${logs.out}\n${logs.err}`);
}

async function stopOffice(office) {
  if (!office || !office.child || office.child.exitCode != null) return;
  office.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { office.child.kill('SIGKILL'); resolve(); }, 3000);
    office.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function officeJson(base, urlPath, opts = {}) {
  const res = await fetch(base + urlPath, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

function listenHook(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
      const hit = { url: req.url, headers: req.headers, body: parsed };
      hits.push(hit);
      Promise.resolve(handler(hit, res)).catch(() => {
        if (!res.writableEnded) res.end();
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        hits,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('подпись ответа меняется только после 2xx', async () => {
  const hook = await listenHook((_hit, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const answered = await officeJson(office.base, '/api/needs/need-finance/answer', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ text: 'Цифры позже', partial: true }),
    });
    assert.equal(answered.status, 201);
    assert.equal(answered.body.answerDeliveryLabel, 'Сохранён, ещё не доставлен');
    assert.equal(answered.body.closedAt, null);
    const saved = await officeJson(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ url: hook.url, key: 'need-key-not-logged' }),
    });
    assert.equal(saved.status, 200);
    const state = await officeJson(office.base, '/api/state');
    const finance = state.body.needs.find((item) => item.id === 'need-finance');
    assert.equal(finance.answerDeliveryLabel, 'Ответ получен агентом');
    assert.equal(finance.closedAt, null);
    assert.equal(office.text().includes('need-key-not-logged'), false);
  } finally {
    await stopOffice(office);
    await hook.close();
  }
});

test('появление общего вебхука досылает очередь ровно один раз', async () => {
  const hook = await listenHook((_hit, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  const key = 'putin-retry-key-SHOULD-NOT-LOG';
  const foreign = 'foreign-key-SHOULD-NOT-LOG';
  try {
    const created = await officeJson(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ agent: 'social', text: 'Старый пост' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.deliveryLabel, 'нет маршрута доставки');
    assert.equal(hook.hits.length, 0);
    const saved = await officeJson(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ url: hook.url, key }),
    });
    assert.equal(saved.status, 200);
    assert.equal(hook.hits.length, 1);
    assert.equal(hook.hits[0].body.type, 'owner_task');
    assert.equal(hook.hits[0].body.agentId, 'social');
    assert.equal(hook.hits[0].headers['x-webhook-key'], key);
    assert.equal(hook.hits[0].headers['x-webhook-key'] === foreign, false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(hook.hits.length, 1);
    const state = await officeJson(office.base, '/api/state');
    const task = state.body.tasks.find((item) => item.id === created.body.id);
    assert.equal(task.deliveryLabel, 'Отправлена');
    const social = state.body.agents.find((agent) => agent.id === 'social');
    assert.equal(social.activity, 'working');
    assert.equal(office.text().includes(key), false);
    assert.equal(office.text().includes(foreign), false);
    assert.equal(office.text().includes(hook.url), false);
    const open = await officeJson(office.base, '/api/delivery/retry', { method: 'POST', body: '{}' });
    assert.equal(open.status, 401);
    const again = await officeJson(office.base, '/api/delivery/retry', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-retry' },
      body: '{}',
    });
    assert.equal(again.status, 200);
    assert.equal(hook.hits.length, 1);
    const health = await officeJson(office.base, '/api/health/delivery', {
      headers: { 'x-agent-token': 'tok-retry' },
    });
    assert.equal(typeof health.body.queued, 'number');
    assert.equal(typeof health.body.resent, 'number');
    assert.equal(typeof health.body.errors, 'number');
    assert.equal(health.body.nextRetryAt, null);
    assert.equal(JSON.stringify(health.body).includes(key), false);
  } finally {
    await stopOffice(office);
    await hook.close();
  }
});

test('общий вебхук Путина доставляет обычные приказы, не только проверку', async () => {
  const hook = await listenHook((_hit, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  const putinKey = 'shared-putin-key-PPPP';
  try {
    const saved = await officeJson(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ url: hook.url, key: putinKey }),
    });
    assert.equal(saved.status, 200);
    for (const agent of ['social', 'finance', 'qa', 'advisor']) {
      const created = await officeJson(office.base, '/api/task', {
        method: 'POST',
        headers: { 'x-app-password': 'pw-retry' },
        body: JSON.stringify({ agent, text: `Приказ ${agent}` }),
      });
      assert.equal(created.status, 201, agent);
      assert.equal(created.body.deliveryLabel, 'Отправлена');
    }
    const orders = hook.hits.filter((hit) => hit.body && hit.body.type === 'owner_task');
    assert.deepEqual(orders.map((hit) => hit.body.agentId).sort(), ['advisor', 'finance', 'qa', 'social']);
    assert.equal(orders.every((hit) => hit.headers['x-webhook-key'] === putinKey), true);
    assert.equal(hook.hits.some((hit) => hit.body && hit.body.type === 'test'), false);
    assert.equal(office.text().includes(putinKey), false);
  } finally {
    await stopOffice(office);
    await hook.close();
  }
});

test('таймер повторяет после 500 и замолкает после предела', async () => {
  let mode = 'fail';
  const hook = await listenHook((_hit, res) => {
    const status = mode === 'fail' ? 500 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? '{"ok":true}' : '{"ok":false}');
  });
  const office = await startOffice({
    DATABASE_URL: '',
    STORE_SCHEMA: '',
    KREMLIN_WEBHOOK_URL: hook.url,
    KREMLIN_WEBHOOK_KEY: 'env-retry-key',
    OUTBOX_RETRY_BASE_MS: '200',
    OUTBOX_RETRY_MAX: '3',
  });
  try {
    const created = await officeJson(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ agent: 'finance', text: 'Повторить после 500' }),
    });
    assert.equal(created.status, 201);
    assert.equal(hook.hits.length, 1);
    mode = 'ok';
    const started = Date.now();
    while (Date.now() - started < 5000 && hook.hits.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(hook.hits.length, 2);
    const state = await officeJson(office.base, '/api/state');
    const task = state.body.tasks.find((item) => item.id === created.body.id);
    assert.equal(task.deliveryLabel, 'Отправлена');
  } finally {
    await stopOffice(office);
    await hook.close();
  }

  const always = await listenHook((_hit, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
  });
  const limited = await startOffice({
    DATABASE_URL: '',
    STORE_SCHEMA: '',
    KREMLIN_WEBHOOK_URL: always.url,
    KREMLIN_WEBHOOK_KEY: 'env-retry-key',
    OUTBOX_RETRY_BASE_MS: '150',
    OUTBOX_RETRY_MAX: '2',
  });
  try {
    const created = await officeJson(limited.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ agent: 'qa', text: 'Больше не повторять' }),
    });
    assert.equal(created.status, 201);
    const started = Date.now();
    while (Date.now() - started < 4000 && always.hits.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(always.hits.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(always.hits.length, 2);
    const health = await officeJson(limited.base, '/api/health/delivery', {
      headers: { 'x-app-password': 'pw-retry' },
    });
    assert.equal(health.body.nextRetryAt, null);
    assert.ok(health.body.errors >= 1);
  } finally {
    await stopOffice(limited);
    await always.close();
  }
});

test('повтор одного приказа не создаёт второй outbox и второй запрос', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const hook = await listenHook((_hit, res) => {
    held.then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const office = await startOffice({ DATABASE_URL: '', STORE_SCHEMA: '' });
  try {
    const blocked = await officeJson(office.base, '/api/orders/t-missing/retry', {
      method: 'POST',
      headers: { 'x-agent-token': 'tok-retry' },
      body: '{}',
    });
    assert.equal(blocked.status, 401);
    const created = await officeJson(office.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ agent: 'advisor', text: 'Один повтор' }),
    });
    assert.equal(created.status, 201);
    const pending = officeJson(office.base, '/api/delivery/putin', {
      method: 'PUT',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ url: hook.url, key: 'one-order-key' }),
    });
    const started = Date.now();
    while (Date.now() - started < 3000 && hook.hits.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(hook.hits.length, 1);
    const parallel = await Promise.all([
      officeJson(office.base, `/api/orders/${created.body.id}/retry`, {
        method: 'POST',
        headers: { 'x-app-password': 'pw-retry' },
        body: '{}',
      }),
      officeJson(office.base, `/api/orders/${created.body.id}/retry`, {
        method: 'POST',
        headers: { 'x-app-password': 'pw-retry' },
        body: '{}',
      }),
    ]);
    assert.equal(parallel.every((item) => item.status === 200), true);
    assert.equal(hook.hits.length, 1);
    release();
    await pending;
    const state = await officeJson(office.base, '/api/state');
    const rows = state.body.outbox.filter((item) => item.taskId === created.body.id);
    assert.equal(rows.length, 1);
  } finally {
    release();
    await stopOffice(office);
    await hook.close();
  }
});

test('Postgres: два процесса не дублируют одну строку очереди', { skip: savedDatabaseUrl ? false : 'DATABASE_URL не задан' }, async () => {
  const schema = `r_${crypto.randomBytes(4).toString('hex')}`;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const hook = await listenHook((_hit, res) => {
    held.then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const quiet = {
    DATABASE_URL: savedDatabaseUrl,
    STORE_SCHEMA: schema,
    KREMLIN_WEBHOOK_URL: '',
    WEBHOOK_SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
  };
  let taskId;
  const first = await startOffice(quiet);
  try {
    const created = await officeJson(first.base, '/api/task', {
      method: 'POST',
      headers: { 'x-app-password': 'pw-retry' },
      body: JSON.stringify({ agent: 'social', text: 'Дослать один раз из базы' }),
    });
    assert.equal(created.status, 201);
    taskId = created.body.id;
  } finally {
    await stopOffice(first);
  }
  const env = { ...quiet, KREMLIN_WEBHOOK_URL: hook.url, KREMLIN_WEBHOOK_KEY: 'db-lock-key' };
  const left = await startOffice(env);
  const right = await startOffice(env);
  try {
    const started = Date.now();
    while (Date.now() - started < 5000 && hook.hits.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mine = hook.hits.filter((hit) => hit.body && hit.body.taskId === taskId);
    assert.equal(mine.length, 1);
  } finally {
    release();
    await stopOffice(left);
    await stopOffice(right);
    await hook.close();
    if (savedDatabaseUrl) {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: savedDatabaseUrl, max: 1 });
      try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (_) { /* схема могла не появиться */ }
      await pool.end();
    }
  }
});
